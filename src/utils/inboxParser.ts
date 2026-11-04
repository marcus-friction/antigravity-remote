import { ANTIGRAVITY_DASHBOARD_URL } from '../constants/config';
import {
  InboxAttentionKind,
  InboxBridgeMessage,
  InboxInstanceStatus,
  InboxInstanceSummary,
  InboxSnapshot,
  InboxThreadItem,
  RawBridgeInstancePayload,
} from '../types/inbox';
import { validateNavigationUrl } from './urlValidator';

const MAX_INBOX_BRIDGE_PAYLOAD_LENGTH = 2 * 1024 * 1024;
const MAX_INSTANCES_PER_SNAPSHOT = 64;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

const ATTENTION_PRIORITY: Record<InboxAttentionKind, number> = {
  approval: 0,
  error: 1,
  unread: 2,
  running: 3,
  idle: 4,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/**
 * Parses a ProtoJSON timestamp (RFC 3339 string, `{ seconds, nanos }` object,
 * or numeric epoch seconds/milliseconds) into epoch milliseconds (`0` if unset).
 */
export function parseProtoTimestampMs(raw: unknown): number {
  if (!raw) {
    return 0;
  }

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      return 0;
    }
    return raw > 1e11 ? Math.floor(raw) : Math.floor(raw * 1000);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return 0;
    }
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return 0;
      }
      return numeric > 1e11 ? Math.floor(numeric) : Math.floor(numeric * 1000);
    }
    const parsedDate = Date.parse(trimmed);
    return Number.isFinite(parsedDate) && parsedDate > 0 ? parsedDate : 0;
  }

  if (isRecord(raw)) {
    const rawSeconds = raw.seconds ?? raw.secs;
    const rawNanos = raw.nanos ?? 0;
    const seconds =
      typeof rawSeconds === 'number'
        ? rawSeconds
        : typeof rawSeconds === 'string'
          ? Number(rawSeconds)
          : 0;
    const nanos =
      typeof rawNanos === 'number'
        ? rawNanos
        : typeof rawNanos === 'string'
          ? Number(rawNanos)
          : 0;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return 0;
    }
    const extraMs = Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0;
    return Math.floor(seconds * 1000) + extraMs;
  }

  return 0;
}

/**
 * Normalizes `ApiService` `InstanceStatus` enum values (numeric or string).
 */
export function normalizeInstanceStatus(raw: unknown): InboxInstanceStatus {
  if (raw === 1) return 'connected';
  if (raw === 2) return 'disconnected';
  if (raw === 3) return 'idle';

  if (typeof raw === 'string') {
    const upper = raw.toUpperCase();
    if (upper.includes('DISCONNECTED')) return 'disconnected';
    if (upper.includes('CONNECTED')) return 'connected';
    if (upper.includes('IDLE')) return 'idle';
  }
  return 'unknown';
}

/**
 * Preserves Google multi-account path prefixes (e.g. `/u/1`) when building
 * in-app navigation links on `https://antigravity.google.com`.
 */
export function extractAccountPathPrefix(rawUrl?: string | null): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.toLowerCase() !== 'antigravity.google.com') {
      return '';
    }
    const match = /^\/u\/(\d+)(?:\/|$)/.exec(parsed.pathname);
    return match ? `/u/${match[1]}` : '';
  } catch {
    return '';
  }
}

/**
 * Extracts the currently open Remote Control instance UUID and conversation ID
 * from an `https://antigravity.google.com` URL.
 */
export function extractActiveRouteFromUrl(rawUrl?: string | null): {
  instanceUuid: string | null;
  cascadeId: string | null;
} {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { instanceUuid: null, cascadeId: null };
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.toLowerCase() !== 'antigravity.google.com') {
      return { instanceUuid: null, cascadeId: null };
    }
    const strippedPath = parsed.pathname.replace(/^\/u\/\d+(?=\/|$)/, '');

    const remoteHostMatch = /^\/r\/([^/?#]+)/.exec(strippedPath);
    if (remoteHostMatch) {
      const instanceUuid = decodeURIComponent(remoteHostMatch[1]);
      const childParam = parsed.searchParams.get('p') ?? '';
      const cleanChild = childParam.replace(/^\/+/, '');
      const cascadeMatch = /^c\/([a-zA-Z0-9._-]+)(?:[/?#]|$)/.exec(cleanChild);
      return {
        instanceUuid: SAFE_ID_PATTERN.test(instanceUuid) ? instanceUuid : null,
        cascadeId: cascadeMatch ? cascadeMatch[1] : null,
      };
    }

    const cloudMatch = /^\/remote\/c\/([a-zA-Z0-9._-]+)(?:[/?#]|$)/.exec(
      strippedPath,
    );
    if (cloudMatch) {
      return {
        instanceUuid: '__cloud__',
        cascadeId: cloudMatch[1],
      };
    }

    return { instanceUuid: null, cascadeId: null };
  } catch {
    return { instanceUuid: null, cascadeId: null };
  }
}

function extractLastSegmentFromUri(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.trim()) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(uri.trim()).replace(/\/+$/, '');
    const withoutScheme = decoded.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
    const candidate = withoutScheme || decoded;
    const parts = candidate.split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  } catch {
    const cleaned = uri.trim().replace(/\/+$/, '');
    const parts = cleaned.split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  }
}

/**
 * Extracts a concise workspace or repository folder label from a trajectory summary.
 */
export function extractWorkspaceName(
  rawTrajectory: Record<string, unknown>,
): string | null {
  const workspaces = Array.isArray(rawTrajectory.workspaces)
    ? rawTrajectory.workspaces
    : [];

  for (const ws of workspaces) {
    if (!isRecord(ws)) continue;
    const folderName =
      extractLastSegmentFromUri(
        ws.workspaceFolderAbsoluteUri ?? ws.workspace_folder_absolute_uri,
      ) ??
      extractLastSegmentFromUri(
        ws.gitRootAbsoluteUri ?? ws.git_root_absolute_uri,
      );
    if (folderName) {
      return folderName;
    }
    if (isRecord(ws.repository)) {
      const repoName =
        ws.repository.computedName ?? ws.repository.computed_name;
      if (typeof repoName === 'string' && repoName.trim()) {
        return repoName.trim();
      }
    }
  }

  const metadata = isRecord(rawTrajectory.trajectoryMetadata)
    ? rawTrajectory.trajectoryMetadata
    : isRecord(rawTrajectory.trajectory_metadata)
      ? rawTrajectory.trajectory_metadata
      : null;

  if (metadata) {
    const uris = Array.isArray(metadata.workspaceUris)
      ? metadata.workspaceUris
      : Array.isArray(metadata.workspace_uris)
        ? metadata.workspace_uris
        : [];
    for (const uri of uris) {
      const folderName = extractLastSegmentFromUri(uri);
      if (folderName) {
        return folderName;
      }
    }
  }

  return null;
}

/**
 * Produces an actionable human-readable summary for pending `waitingSteps` prompts.
 */
export function describeWaitingSteps(
  waitingSteps: unknown[],
  subagentRole?: string | null,
): string {
  const prefix = subagentRole ? `${truncateText(subagentRole, 28)}: ` : '';
  if (!Array.isArray(waitingSteps) || waitingSteps.length === 0) {
    return `${prefix}Waiting for your approval or input`;
  }

  const firstEntry = isRecord(waitingSteps[0]) ? waitingSteps[0] : null;
  const step =
    firstEntry && isRecord(firstEntry.step) ? firstEntry.step : firstEntry;

  if (step) {
    const runCommand = isRecord(step.runCommand)
      ? step.runCommand
      : isRecord(step.run_command)
        ? step.run_command
        : null;
    if (runCommand) {
      const cmd =
        runCommand.commandLine ??
        runCommand.command_line ??
        runCommand.proposedCommandLine ??
        runCommand.command;
      if (typeof cmd === 'string' && cmd.trim()) {
        return `${prefix}Approve command: ${truncateText(cmd, 68)}`;
      }
      return `${prefix}Approve terminal command`;
    }

    const askQuestion = isRecord(step.askQuestion)
      ? step.askQuestion
      : isRecord(step.ask_question)
        ? step.ask_question
        : null;
    if (askQuestion) {
      const questions = Array.isArray(askQuestion.questions)
        ? askQuestion.questions
        : [];
      const firstQ =
        questions.length > 0 && isRecord(questions[0])
          ? questions[0].question
          : askQuestion.question;
      if (typeof firstQ === 'string' && firstQ.trim()) {
        return `${prefix}Question: ${truncateText(firstQ, 72)}`;
      }
      return `${prefix}Agent asked a clarifying question`;
    }

    const openBrowser = isRecord(step.openBrowserUrl)
      ? step.openBrowserUrl
      : isRecord(step.open_browser_url)
        ? step.open_browser_url
        : null;
    if (openBrowser) {
      const url = openBrowser.url;
      if (typeof url === 'string' && url.trim()) {
        return `${prefix}Approve opening URL: ${truncateText(url, 60)}`;
      }
      return `${prefix}Approve browser navigation`;
    }

    const browserJs = isRecord(step.executeBrowserJavascript)
      ? step.executeBrowserJavascript
      : isRecord(step.execute_browser_javascript)
        ? step.execute_browser_javascript
        : null;
    if (browserJs) {
      const desc =
        browserJs.javascriptDescription ?? browserJs.javascript_description;
      if (typeof desc === 'string' && desc.trim()) {
        return `${prefix}Approve browser action: ${truncateText(desc, 60)}`;
      }
      return `${prefix}Approve browser script execution`;
    }

    const filePerm = isRecord(step.filePermission)
      ? step.filePermission
      : isRecord(step.file_permission)
        ? step.file_permission
        : null;
    if (filePerm) {
      return `${prefix}Approve file access request`;
    }

    const metadata = isRecord(step.metadata) ? step.metadata : null;
    const toolSummary = metadata
      ? (metadata.toolSummary ?? metadata.tool_summary)
      : null;
    if (typeof toolSummary === 'string' && toolSummary.trim()) {
      return `${prefix}Approval needed: ${truncateText(toolSummary, 68)}`;
    }
  }

  if (waitingSteps.length > 1) {
    return `${prefix}Waiting for your approval (${waitingSteps.length} prompts)`;
  }
  return `${prefix}Waiting for your approval or input`;
}

function isRunningCascadeStatus(rawStatus: unknown): boolean {
  if (rawStatus === 2 || rawStatus === 3 || rawStatus === 4) {
    return true;
  }
  if (typeof rawStatus === 'string') {
    const upper = rawStatus.toUpperCase();
    return (
      upper.includes('RUNNING') ||
      upper.includes('BUSY') ||
      upper.includes('CANCELING')
    );
  }
  return false;
}

function getTerminationFailureReason(rawReason: unknown): string | null {
  if (rawReason === 1) {
    return 'Stopped due to an execution error';
  }
  if (rawReason === 3) {
    return 'Paused after reaching step limit';
  }
  if (rawReason === 11) {
    return 'Paused after reaching token budget';
  }
  if (typeof rawReason === 'string' && rawReason.trim()) {
    const upper = rawReason.toUpperCase();
    if (upper.includes('UNSPECIFIED') || upper.includes('NO_ERROR')) {
      return null;
    }
    if (upper.includes('MAX_TOKEN')) {
      return 'Paused after reaching token budget';
    }
    if (upper.includes('MAX_INVOCATIONS') || upper.includes('STEP_LIMIT')) {
      return 'Paused after reaching step limit';
    }
    if (upper.includes('ERROR') || upper.includes('FAILED')) {
      return 'Stopped due to an execution error';
    }
  }
  return null;
}

function isFilteredTrajectoryType(rawType: unknown): boolean {
  if (typeof rawType !== 'string') {
    return false;
  }
  const upper = rawType.toUpperCase();
  return (
    upper.includes('SIDE_QUESTION') || upper.includes('COMMIT_MESSAGE')
  );
}

function unwrapTrajectoryMap(
  rawContainer: Record<string, unknown> | null | undefined,
): Record<string, Record<string, unknown>> {
  if (!isRecord(rawContainer)) {
    return {};
  }
  const candidate = isRecord(rawContainer.trajectorySummaries)
    ? rawContainer.trajectorySummaries
    : isRecord(rawContainer.trajectory_summaries)
      ? rawContainer.trajectory_summaries
      : rawContainer;

  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (SAFE_ID_PATTERN.test(key) && isRecord(value)) {
      result[key] = value;
    }
  }
  return result;
}

function extractPreservedHostQueryParams(
  rawUrl?: string | null,
): Record<string, string> {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return {};
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.toLowerCase() !== 'antigravity.google.com') {
      return {};
    }
    const preserved: Record<string, string> = {};
    const authuser = parsed.searchParams.get('authuser');
    if (authuser && /^\d+$/.test(authuser)) {
      preserved.authuser = authuser;
    }
    if (parsed.searchParams.get('enableBusinessSignIn') === 'true') {
      preserved.enableBusinessSignIn = 'true';
    }
    return preserved;
  } catch {
    return {};
  }
}

function buildVerifiedTargetUrl(
  source: 'remote-control' | 'cloud',
  instanceUuid: string,
  cascadeId: string,
  accountPrefix: string,
  preservedQueryParams: Readonly<Record<string, string>> = {},
): { targetUrl: string; childPath: string } | null {
  const childPath = `c/${cascadeId}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(preservedQueryParams)) {
    query.set(key, value);
  }
  if (source !== 'cloud') {
    query.set('p', childPath);
  }
  const querySuffix = query.toString() ? `?${query.toString()}` : '';
  const candidateUrl =
    source === 'cloud'
      ? `${ANTIGRAVITY_DASHBOARD_URL}${accountPrefix}/remote/c/${encodeURIComponent(cascadeId)}${querySuffix}`
      : `${ANTIGRAVITY_DASHBOARD_URL}${accountPrefix}/r/${encodeURIComponent(instanceUuid)}${querySuffix}`;

  const validation = validateNavigationUrl(candidateUrl);
  if (!validation.isValid || !validation.isAllowedInApp || !validation.normalizedUrl) {
    return null;
  }
  return {
    targetUrl: validation.normalizedUrl,
    childPath,
  };
}

interface BubbledChildInfo {
  waitingSteps: unknown[];
  subagentRole: string | null;
  hasRunningChild: boolean;
  latestModifiedMs: number;
}

function parseTrajectoriesForSource(params: {
  source: 'remote-control' | 'cloud';
  instanceUuid: string;
  instanceName: string;
  rawTrajectories: Record<string, unknown> | null | undefined;
  activeInstanceUuid: string | null;
  activeCascadeId: string | null;
  accountPrefix: string;
  preservedQueryParams: Readonly<Record<string, string>>;
  locallyReadAtByThreadId: Readonly<Record<string, number>>;
}): InboxThreadItem[] {
  const {
    source,
    instanceUuid,
    instanceName,
    rawTrajectories,
    activeInstanceUuid,
    activeCascadeId,
    accountPrefix,
    preservedQueryParams,
    locallyReadAtByThreadId,
  } = params;

  const map = unwrapTrajectoryMap(rawTrajectories);
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return [];
  }

  // Index trajectoryId -> cascadeId so subagents referencing either ID resolve cleanly.
  const trajectoryIdToCascadeId = new Map<string, string>();
  for (const [cascadeId, raw] of entries) {
    trajectoryIdToCascadeId.set(cascadeId, cascadeId);
    const trajId = raw.trajectoryId ?? raw.trajectory_id;
    if (typeof trajId === 'string' && SAFE_ID_PATTERN.test(trajId)) {
      trajectoryIdToCascadeId.set(trajId, cascadeId);
    }
  }

  // Pass 1: Bubble child subagent waiting prompts and running states up to their parent conversation.
  const bubbledByParentCascadeId = new Map<string, BubbledChildInfo>();
  for (const [, raw] of entries) {
    const metadata = isRecord(raw.trajectoryMetadata)
      ? raw.trajectoryMetadata
      : isRecord(raw.trajectory_metadata)
        ? raw.trajectory_metadata
        : null;
    const rawParentId = metadata
      ? (metadata.parentConversationId ?? metadata.parent_conversation_id)
      : null;
    if (typeof rawParentId !== 'string' || !SAFE_ID_PATTERN.test(rawParentId)) {
      continue;
    }

    const killed = Boolean(raw.killed);
    if (killed) {
      continue;
    }

    const parentCascadeId =
      trajectoryIdToCascadeId.get(rawParentId) ?? rawParentId;
    const waitingSteps = Array.isArray(raw.waitingSteps)
      ? raw.waitingSteps
      : Array.isArray(raw.waiting_steps)
        ? raw.waiting_steps
        : [];
    const childRunning =
      Boolean(raw.notFullyIdle ?? raw.not_fully_idle) ||
      isRunningCascadeStatus(raw.status);
    const childModifiedMs = parseProtoTimestampMs(
      raw.lastModifiedTime ?? raw.last_modified_time,
    );

    if (waitingSteps.length === 0 && !childRunning) {
      continue;
    }

    const subagentSpec =
      metadata && isRecord(metadata.subagentSpec)
        ? metadata.subagentSpec
        : metadata && isRecord(metadata.subagent_spec)
          ? metadata.subagent_spec
          : null;
    const roleLabel =
      subagentSpec && typeof subagentSpec.role === 'string' && subagentSpec.role.trim()
        ? subagentSpec.role.trim()
        : subagentSpec &&
            typeof subagentSpec.typeName === 'string' &&
            subagentSpec.typeName.trim()
          ? subagentSpec.typeName.trim()
          : 'Subagent';

    const existing = bubbledByParentCascadeId.get(parentCascadeId) ?? {
      waitingSteps: [],
      subagentRole: null,
      hasRunningChild: false,
      latestModifiedMs: 0,
    };
    if (waitingSteps.length > 0) {
      existing.waitingSteps.push(...waitingSteps);
      if (!existing.subagentRole) {
        existing.subagentRole = roleLabel;
      }
    }
    if (childRunning) {
      existing.hasRunningChild = true;
    }
    if (childModifiedMs > existing.latestModifiedMs) {
      existing.latestModifiedMs = childModifiedMs;
    }
    bubbledByParentCascadeId.set(parentCascadeId, existing);
  }

  // Pass 2: Build top-level thread items.
  const items: InboxThreadItem[] = [];
  const emittedParentIds = new Set<string>();

  for (const [cascadeId, raw] of entries) {
    const annotations = isRecord(raw.annotations) ? raw.annotations : null;
    if (annotations?.archived === true) {
      continue;
    }

    const metadata = isRecord(raw.trajectoryMetadata)
      ? raw.trajectoryMetadata
      : isRecord(raw.trajectory_metadata)
        ? raw.trajectory_metadata
        : null;
    if (
      metadata?.isBattleModeFork === true ||
      metadata?.is_battle_mode_fork === true
    ) {
      continue;
    }
    const parentId = metadata
      ? (metadata.parentConversationId ?? metadata.parent_conversation_id)
      : null;
    if (typeof parentId === 'string' && parentId.trim().length > 0) {
      continue;
    }

    if (isFilteredTrajectoryType(raw.trajectoryType ?? raw.trajectory_type)) {
      continue;
    }

    const navTarget = buildVerifiedTargetUrl(
      source,
      instanceUuid,
      cascadeId,
      accountPrefix,
      preservedQueryParams,
    );
    if (!navTarget) {
      continue;
    }

    emittedParentIds.add(cascadeId);
    const bubbled = bubbledByParentCascadeId.get(cascadeId);
    const killed = Boolean(raw.killed);

    const ownWaitingSteps = killed
      ? []
      : Array.isArray(raw.waitingSteps)
        ? raw.waitingSteps
        : Array.isArray(raw.waiting_steps)
          ? raw.waiting_steps
          : [];
    const bubbledWaitingSteps =
      !killed && bubbled ? bubbled.waitingSteps : [];
    const effectiveWaitingSteps = [...ownWaitingSteps, ...bubbledWaitingSteps];

    const hasRunningSubagents =
      !killed &&
      Boolean(
        raw.hasRunningSubagents ??
          raw.has_running_subagents ??
          raw.hasActiveChildren ??
          raw.has_active_children ??
          bubbled?.hasRunningChild,
      );

    const isRunning =
      !killed &&
      (Boolean(raw.notFullyIdle ?? raw.not_fully_idle) ||
        hasRunningSubagents ||
        isRunningCascadeStatus(raw.status));

    const lastModifiedAtMs = Math.max(
      parseProtoTimestampMs(raw.lastModifiedTime ?? raw.last_modified_time),
      parseProtoTimestampMs(raw.createdTime ?? raw.created_time),
      bubbled?.latestModifiedMs ?? 0,
    );
    const lastUserViewAtMs = parseProtoTimestampMs(
      annotations?.lastUserViewTime ?? annotations?.last_user_view_time,
    );
    const lastUserInputAtMs = parseProtoTimestampMs(
      raw.lastUserInputTime ?? raw.last_user_input_time,
    );

    const compositeId = `${instanceUuid}:${cascadeId}`;
    const locallyReadAtMs = locallyReadAtByThreadId[compositeId] ?? 0;
    const seenBaselineMs = Math.max(
      lastUserViewAtMs,
      lastUserInputAtMs,
      locallyReadAtMs,
    );

    const isMarkedUnreadRemotely = Boolean(
      annotations?.markedAsUnread ?? annotations?.marked_as_unread,
    );
    const isLocallyCleared =
      locallyReadAtMs > 0 && locallyReadAtMs >= lastModifiedAtMs;
    const hasNewOutputSinceUser =
      seenBaselineMs > 0 && lastModifiedAtMs > seenBaselineMs + 1_000;
    const isUnread =
      !isLocallyCleared && (isMarkedUnreadRemotely || hasNewOutputSinceUser);

    const rawTrajectoryId = raw.trajectoryId ?? raw.trajectory_id;
    const trajectoryId =
      typeof rawTrajectoryId === 'string' && SAFE_ID_PATTERN.test(rawTrajectoryId)
        ? rawTrajectoryId
        : cascadeId;

    const isActiveThread =
      activeInstanceUuid === instanceUuid &&
      activeCascadeId !== null &&
      (activeCascadeId === cascadeId || activeCascadeId === trajectoryId);

    const terminationFailure = getTerminationFailureReason(
      raw.latestExecutorTerminationReason ??
        raw.latest_executor_termination_reason,
    );
    const hasUnresolvedError =
      !isRunning &&
      !killed &&
      terminationFailure !== null &&
      !isLocallyCleared &&
      (seenBaselineMs === 0 || lastModifiedAtMs >= seenBaselineMs - 1_000);

    let attentionKind: InboxAttentionKind;
    let needsAttention: boolean;
    let attentionReason: string;

    if (effectiveWaitingSteps.length > 0) {
      attentionKind = 'approval';
      needsAttention = true;
      attentionReason =
        ownWaitingSteps.length > 0
          ? describeWaitingSteps(ownWaitingSteps, null)
          : describeWaitingSteps(
              bubbledWaitingSteps,
              bubbled?.subagentRole ?? 'Subagent',
            );
    } else if (hasUnresolvedError && terminationFailure) {
      attentionKind = 'error';
      needsAttention = true;
      attentionReason = terminationFailure;
    } else if (!isRunning && !killed && !isActiveThread && isUnread) {
      attentionKind = 'unread';
      needsAttention = true;
      attentionReason = 'Finished — unread updates';
    } else if (isRunning) {
      attentionKind = 'running';
      needsAttention = false;
      attentionReason = hasRunningSubagents
        ? 'Agent & subagents working…'
        : 'Agent is working…';
    } else {
      attentionKind = 'idle';
      needsAttention = false;
      attentionReason = Boolean(raw.interrupted) ? 'Interrupted' : 'Idle';
    }

    const annotationTitle =
      annotations && typeof annotations.title === 'string'
        ? annotations.title.trim()
        : '';
    const summaryTitle =
      typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const title = truncateText(
      annotationTitle || summaryTitle || `Conversation ${cascadeId.slice(0, 8)}`,
      110,
    );

    const rawStepCount = raw.stepCount ?? raw.step_count;
    const stepCount =
      typeof rawStepCount === 'number' && Number.isFinite(rawStepCount)
        ? Math.max(0, Math.floor(rawStepCount))
        : 0;

    const isPinned = Boolean(annotations?.pinned || annotations?.starred);

    items.push({
      id: compositeId,
      cascadeId,
      trajectoryId,
      title,
      workspaceName: extractWorkspaceName(raw),
      instanceUuid,
      instanceName,
      source,
      targetUrl: navTarget.targetUrl,
      childPath: navTarget.childPath,
      attentionKind,
      needsAttention,
      attentionReason,
      stepCount,
      waitingStepCount: effectiveWaitingSteps.length,
      lastModifiedAtMs,
      lastUserViewAtMs,
      isActiveThread,
      isPinned,
      hasRunningSubagents,
    });
  }

  // Synthesize parent entry if a child subagent awaits approval whose parent wasn't in the summary map.
  for (const [parentCascadeId, bubbled] of bubbledByParentCascadeId.entries()) {
    if (emittedParentIds.has(parentCascadeId) || bubbled.waitingSteps.length === 0) {
      continue;
    }
    const navTarget = buildVerifiedTargetUrl(
      source,
      instanceUuid,
      parentCascadeId,
      accountPrefix,
      preservedQueryParams,
    );
    if (!navTarget) {
      continue;
    }
    items.push({
      id: `${instanceUuid}:${parentCascadeId}`,
      cascadeId: parentCascadeId,
      trajectoryId: parentCascadeId,
      title: `Conversation ${parentCascadeId.slice(0, 8)}`,
      workspaceName: null,
      instanceUuid,
      instanceName,
      source,
      targetUrl: navTarget.targetUrl,
      childPath: navTarget.childPath,
      attentionKind: 'approval',
      needsAttention: true,
      attentionReason: describeWaitingSteps(
        bubbled.waitingSteps,
        bubbled.subagentRole ?? 'Subagent',
      ),
      stepCount: 0,
      waitingStepCount: bubbled.waitingSteps.length,
      lastModifiedAtMs: bubbled.latestModifiedMs,
      lastUserViewAtMs: 0,
      isActiveThread:
        activeInstanceUuid === instanceUuid &&
        activeCascadeId === parentCascadeId,
      isPinned: false,
      hasRunningSubagents: true,
    });
  }

  return items;
}

/**
 * Builds a sorted, deduplicated `InboxSnapshot` from a raw WebView bridge snapshot.
 */
export function buildInboxSnapshot(
  message: Extract<InboxBridgeMessage, { type: 'AGY_INBOX_SNAPSHOT' }>,
  locallyReadAtByThreadId: Readonly<Record<string, number>> = {},
  fallbackActiveUrl?: string | null,
): InboxSnapshot {
  const referenceUrl = message.activeUrl ?? fallbackActiveUrl ?? null;
  const routeFromUrl = extractActiveRouteFromUrl(referenceUrl);
  const activeInstanceUuid =
    typeof message.activeInstanceUuid === 'string' &&
    SAFE_ID_PATTERN.test(message.activeInstanceUuid)
      ? message.activeInstanceUuid
      : routeFromUrl.instanceUuid;
  const activeCascadeId =
    typeof message.activeCascadeId === 'string' &&
    SAFE_ID_PATTERN.test(message.activeCascadeId)
      ? message.activeCascadeId
      : routeFromUrl.cascadeId;

  const accountPrefix = extractAccountPathPrefix(referenceUrl);
  const preservedQueryParams = extractPreservedHostQueryParams(referenceUrl);

  const instances: InboxInstanceSummary[] = [];
  const allThreads: InboxThreadItem[] = [];
  const seenInstanceUuids = new Set<string>();

  for (const rawInst of message.instances.slice(0, MAX_INSTANCES_PER_SNAPSHOT)) {
    if (!rawInst || typeof rawInst.uuid !== 'string') {
      continue;
    }
    const uuid = rawInst.uuid.trim();
    if (!SAFE_ID_PATTERN.test(uuid) || seenInstanceUuids.has(uuid)) {
      continue;
    }
    seenInstanceUuids.add(uuid);

    const name =
      typeof rawInst.name === 'string' && rawInst.name.trim()
        ? truncateText(rawInst.name, 64)
        : uuid;
    const status = normalizeInstanceStatus(rawInst.status);

    instances.push({
      uuid,
      name,
      status,
      version:
        typeof rawInst.version === 'string' && rawInst.version.trim()
          ? truncateText(rawInst.version, 32)
          : undefined,
      updatedAtMs:
        typeof rawInst.updatedAtMs === 'number' &&
        Number.isFinite(rawInst.updatedAtMs)
          ? rawInst.updatedAtMs
          : undefined,
    });

    if (rawInst.trajectories && isRecord(rawInst.trajectories)) {
      allThreads.push(
        ...parseTrajectoriesForSource({
          source: 'remote-control',
          instanceUuid: uuid,
          instanceName: name,
          rawTrajectories: rawInst.trajectories,
          activeInstanceUuid,
          activeCascadeId,
          accountPrefix,
          preservedQueryParams,
          locallyReadAtByThreadId,
        }),
      );
    }
  }

  if (message.cloudTrajectories && isRecord(message.cloudTrajectories)) {
    allThreads.push(
      ...parseTrajectoriesForSource({
        source: 'cloud',
        instanceUuid: '__cloud__',
        instanceName: 'Cloud Agent',
        rawTrajectories: message.cloudTrajectories,
        activeInstanceUuid,
        activeCascadeId,
        accountPrefix,
        preservedQueryParams,
        locallyReadAtByThreadId,
      }),
    );
  }

  allThreads.sort((a, b) => {
    const priorityDiff =
      ATTENTION_PRIORITY[a.attentionKind] - ATTENTION_PRIORITY[b.attentionKind];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    if (!a.needsAttention && a.isPinned !== b.isPinned) {
      return a.isPinned ? -1 : 1;
    }
    if (b.lastModifiedAtMs !== a.lastModifiedAtMs) {
      return b.lastModifiedAtMs - a.lastModifiedAtMs;
    }
    return a.title.localeCompare(b.title);
  });

  return {
    instances,
    threads: allThreads,
    fetchedAtMs:
      typeof message.fetchedAtMs === 'number' &&
      Number.isFinite(message.fetchedAtMs) &&
      message.fetchedAtMs > 0
        ? message.fetchedAtMs
        : Date.now(),
    activeInstanceUuid,
    activeCascadeId,
    error:
      typeof message.error === 'string' && message.error.trim()
        ? truncateText(message.error, 160)
        : null,
  };
}

/**
 * Re-applies active thread & local read state onto an existing `InboxSnapshot`
 * without waiting for a network poll round-trip.
 */
export function applyLocalStateToSnapshot(
  snapshot: InboxSnapshot,
  params: {
    activeInstanceUuid: string | null;
    activeCascadeId: string | null;
    locallyReadAtByThreadId: Readonly<Record<string, number>>;
  },
): InboxSnapshot {
  const { activeInstanceUuid, activeCascadeId, locallyReadAtByThreadId } =
    params;

  const updatedThreads = snapshot.threads.map((thread) => {
    const isActiveThread =
      activeInstanceUuid === thread.instanceUuid &&
      activeCascadeId !== null &&
      (activeCascadeId === thread.cascadeId ||
        activeCascadeId === thread.trajectoryId);

    const locallyReadAtMs = locallyReadAtByThreadId[thread.id] ?? 0;
    const isLocallyCleared =
      locallyReadAtMs > 0 && locallyReadAtMs >= thread.lastModifiedAtMs;

    if (
      thread.attentionKind === 'unread' &&
      (isActiveThread || isLocallyCleared)
    ) {
      return {
        ...thread,
        isActiveThread,
        attentionKind: 'idle' as const,
        needsAttention: false,
        attentionReason: 'Idle',
      };
    }

    if (thread.attentionKind === 'error' && isLocallyCleared) {
      return {
        ...thread,
        isActiveThread,
        attentionKind: 'idle' as const,
        needsAttention: false,
        attentionReason: 'Idle',
      };
    }

    if (thread.isActiveThread !== isActiveThread) {
      return {
        ...thread,
        isActiveThread,
      };
    }

    return thread;
  });

  updatedThreads.sort((a, b) => {
    const priorityDiff =
      ATTENTION_PRIORITY[a.attentionKind] - ATTENTION_PRIORITY[b.attentionKind];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    if (!a.needsAttention && a.isPinned !== b.isPinned) {
      return a.isPinned ? -1 : 1;
    }
    if (b.lastModifiedAtMs !== a.lastModifiedAtMs) {
      return b.lastModifiedAtMs - a.lastModifiedAtMs;
    }
    return a.title.localeCompare(b.title);
  });

  return {
    ...snapshot,
    activeInstanceUuid,
    activeCascadeId,
    threads: updatedThreads,
  };
}

/**
 * Validates and parses a JSON string posted from `WebView.onMessage`.
 */
export function parseInboxBridgeMessage(
  rawData: unknown,
): InboxBridgeMessage | null {
  if (
    typeof rawData !== 'string' ||
    !rawData ||
    rawData.length > MAX_INBOX_BRIDGE_PAYLOAD_LENGTH
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return null;
  }

  switch (parsed.type) {
    case 'AGY_INBOX_SNAPSHOT': {
      const rawInstances = Array.isArray(parsed.instances)
        ? parsed.instances
        : [];
      const instances: RawBridgeInstancePayload[] = [];
      for (const item of rawInstances.slice(0, MAX_INSTANCES_PER_SNAPSHOT)) {
        if (!isRecord(item) || typeof item.uuid !== 'string') continue;
        instances.push({
          uuid: item.uuid,
          name: typeof item.name === 'string' ? item.name : undefined,
          status:
            typeof item.status === 'number' || typeof item.status === 'string'
              ? item.status
              : undefined,
          version: typeof item.version === 'string' ? item.version : undefined,
          updatedAtMs:
            typeof item.updatedAtMs === 'number' ? item.updatedAtMs : undefined,
          trajectories: isRecord(item.trajectories) ? item.trajectories : null,
          error: typeof item.error === 'string' ? item.error : undefined,
        });
      }
      return {
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs:
          typeof parsed.fetchedAtMs === 'number'
            ? parsed.fetchedAtMs
            : Date.now(),
        activeUrl:
          typeof parsed.activeUrl === 'string' ? parsed.activeUrl : undefined,
        activeInstanceUuid:
          typeof parsed.activeInstanceUuid === 'string'
            ? parsed.activeInstanceUuid
            : null,
        activeCascadeId:
          typeof parsed.activeCascadeId === 'string'
            ? parsed.activeCascadeId
            : null,
        instances,
        cloudTrajectories: isRecord(parsed.cloudTrajectories)
          ? parsed.cloudTrajectories
          : null,
        error: typeof parsed.error === 'string' ? parsed.error : null,
      };
    }

    case 'AGY_INBOX_ACTIVE_ROUTE':
      return {
        type: 'AGY_INBOX_ACTIVE_ROUTE',
        activeUrl:
          typeof parsed.activeUrl === 'string' ? parsed.activeUrl : undefined,
        activeInstanceUuid:
          typeof parsed.activeInstanceUuid === 'string'
            ? parsed.activeInstanceUuid
            : null,
        activeCascadeId:
          typeof parsed.activeCascadeId === 'string'
            ? parsed.activeCascadeId
            : null,
      };

    case 'AGY_INBOX_REALTIME_HINT': {
      const reason = parsed.reason;
      if (
        reason !== 'notification' &&
        reason !== 'badge' &&
        reason !== 'port'
      ) {
        return null;
      }
      return {
        type: 'AGY_INBOX_REALTIME_HINT',
        reason,
        cascadeId:
          typeof parsed.cascadeId === 'string' ? parsed.cascadeId : null,
        title: typeof parsed.title === 'string' ? parsed.title : null,
        body: typeof parsed.body === 'string' ? parsed.body : null,
      };
    }

    case 'AGY_INBOX_FAST_NAV_RESULT':
      if (
        typeof parsed.requestId !== 'string' ||
        typeof parsed.handled !== 'boolean' ||
        typeof parsed.targetUrl !== 'string'
      ) {
        return null;
      }
      return {
        type: 'AGY_INBOX_FAST_NAV_RESULT',
        requestId: parsed.requestId,
        handled: parsed.handled,
        targetUrl: parsed.targetUrl,
      };

    default:
      return null;
  }
}

/**
 * Formats a compact relative timestamp (e.g., `Just now`, `4m ago`, `2h ago`, `3d ago`).
 */
export function formatRelativeTime(
  timestampMs: number,
  nowMs: number = Date.now(),
): string {
  if (!timestampMs || !Number.isFinite(timestampMs) || timestampMs <= 0) {
    return '';
  }
  const diffSeconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSeconds < 60) {
    return 'Just now';
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 14) {
    return `${diffDays}d ago`;
  }
  const diffWeeks = Math.floor(diffDays / 7);
  return `${diffWeeks}w ago`;
}
