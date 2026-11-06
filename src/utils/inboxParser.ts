import { ANTIGRAVITY_DASHBOARD_URL } from '../constants/config';
import {
  InboxAttentionKind,
  InboxBridgeMessage,
  InboxInstanceStatus,
  InboxInstanceSummary,
  InboxSnapshot,
  InboxThreadItem,
  RawBridgeInstancePayload,
  RawBridgeUsagePayload,
  UsageCreditBalance,
  UsageModelQuota,
  UsageQuotaBucket,
  UsageQuotaGroup,
  UsageStatsSnapshot,
} from '../types/inbox';
import { validateNavigationUrl } from './urlValidator';

const MAX_INBOX_BRIDGE_PAYLOAD_LENGTH = 2 * 1024 * 1024;
const MAX_INSTANCES_PER_SNAPSHOT = 64;
const MAX_USAGE_GROUPS = 16;
const MAX_USAGE_BUCKETS_PER_GROUP = 16;
const MAX_USAGE_MODELS = 48;
const MAX_USAGE_CREDITS = 12;
const MAX_TRACKED_TRANSITION_ENTRIES = 500;
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
  completedUnreadAtByThreadId?: Readonly<Record<string, number>>;
  isAppForeground?: boolean;
  isDrawerOpen?: boolean;
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
    completedUnreadAtByThreadId = {},
    isAppForeground = true,
    isDrawerOpen = false,
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

    const rawStepCount = raw.stepCount ?? raw.step_count;
    const stepCount =
      typeof rawStepCount === 'number' && Number.isFinite(rawStepCount)
        ? Math.max(0, Math.floor(rawStepCount))
        : 0;

    const rawLastUserInputStepIndex =
      raw.lastUserInputStepIndex ?? raw.last_user_input_step_index;
    const lastUserInputStepIndex =
      typeof rawLastUserInputStepIndex === 'number' &&
      Number.isFinite(rawLastUserInputStepIndex)
        ? Math.floor(rawLastUserInputStepIndex)
        : null;

    const compositeId = `${instanceUuid}:${cascadeId}`;
    const locallyReadAtMs = locallyReadAtByThreadId[compositeId] ?? 0;
    const completedUnreadAtMs = completedUnreadAtByThreadId[compositeId] ?? 0;
    const seenBaselineMs = Math.max(
      lastUserViewAtMs,
      lastUserInputAtMs,
      locallyReadAtMs,
    );

    const isMarkedUnreadRemotely = Boolean(
      annotations?.markedAsUnread ?? annotations?.marked_as_unread,
    );
    const isLocallyCleared =
      locallyReadAtMs > 0 &&
      (lastModifiedAtMs > 0
        ? locallyReadAtMs >= lastModifiedAtMs
        : locallyReadAtMs >= completedUnreadAtMs);
    const hasViewedSinceLastModify =
      lastUserViewAtMs > 0 &&
      lastUserViewAtMs >= lastModifiedAtMs &&
      (lastUserInputAtMs === 0 || lastUserViewAtMs > lastUserInputAtMs);
    const hasStepsAfterUserInput =
      lastUserInputStepIndex !== null &&
      lastUserInputStepIndex >= 0 &&
      stepCount > lastUserInputStepIndex + 1 &&
      !hasViewedSinceLastModify &&
      (lastUserInputAtMs === 0 || lastModifiedAtMs >= lastUserInputAtMs);
    const hasNewOutputSinceUser =
      (seenBaselineMs > 0 && lastModifiedAtMs > seenBaselineMs) ||
      hasStepsAfterUserInput;
    const hasUnreadFinishedTransition =
      completedUnreadAtMs > 0 &&
      (locallyReadAtMs === 0 || completedUnreadAtMs > locallyReadAtMs);
    const isUnread =
      !isLocallyCleared &&
      (isMarkedUnreadRemotely ||
        hasNewOutputSinceUser ||
        hasUnreadFinishedTransition);

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

    const isActivelyViewedOnScreen =
      isAppForeground && !isDrawerOpen && isActiveThread;

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
    } else if (!isRunning && !killed && !isActivelyViewedOnScreen && isUnread) {
      attentionKind = 'unread';
      needsAttention = true;
      attentionReason =
        isMarkedUnreadRemotely &&
        !hasNewOutputSinceUser &&
        !hasUnreadFinishedTransition
          ? 'Marked as unread'
          : 'Agent finished — unread updates';
    } else if (isRunning) {
      attentionKind = 'running';
      needsAttention = false;
      attentionReason = hasRunningSubagents
        ? 'Agent & subagents working…'
        : 'Agent is working…';
    } else {
      attentionKind = 'idle';
      needsAttention = false;
      attentionReason =
        killed || Boolean(raw.interrupted) ? 'Interrupted' : 'Idle';
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

function parseOptionalNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function fractionToPercent(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return 0;
  }
  if (fraction >= 1) {
    return 100;
  }
  return Math.max(1, Math.min(99, Math.round(fraction * 100)));
}

function resolveRemainingFraction(
  rawQuota: Record<string, unknown>,
  resetTimeMs: number,
): number {
  if (rawQuota.isExhausted === true || rawQuota.is_exhausted === true) {
    return 0;
  }
  const explicitFraction = parseOptionalNumber(
    rawQuota.remainingFraction ?? rawQuota.remaining_fraction,
  );
  if (explicitFraction !== null) {
    return Math.max(0, Math.min(1, explicitFraction));
  }
  const explicitAmount = parseOptionalNumber(
    rawQuota.remainingAmount ?? rawQuota.remaining_amount,
  );
  if (explicitAmount !== null) {
    return explicitAmount <= 0 ? 0 : 1;
  }
  // In proto3 JSON, 0.0 is omitted on active cooldown buckets while resetTime is populated;
  // untouched buckets omit both remainingFraction and resetTime.
  return resetTimeMs > 0 ? 0 : 1;
}

function humanizeTierLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toUpperCase().includes('UNSPECIFIED')) {
    return null;
  }
  if (/^[A-Z0-9_]+$/.test(trimmed) && trimmed.includes('_')) {
    const stripped = trimmed.replace(/^(?:USER|TEAMS|PLAN)_TIER_/, '');
    const formatted = stripped
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
    return formatted ? truncateText(formatted, 48) : null;
  }
  return truncateText(trimmed, 48);
}

function humanizeBucketLabel(
  rawBucket: Record<string, unknown>,
  index: number,
): string {
  const direct =
    rawBucket.displayName ??
    rawBucket.display_name ??
    rawBucket.label ??
    rawBucket.name;
  if (typeof direct === 'string' && direct.trim()) {
    return truncateText(direct.trim(), 48);
  }
  const windowRaw = String(
    rawBucket.window ??
      rawBucket.windowDuration ??
      rawBucket.window_duration ??
      rawBucket.bucketId ??
      rawBucket.bucket_id ??
      '',
  ).toLowerCase();
  if (
    windowRaw.includes('5h') ||
    windowRaw.includes('5_h') ||
    windowRaw.includes('5-h') ||
    windowRaw.includes('five_hour') ||
    windowRaw.includes('18000')
  ) {
    return '5-hour window';
  }
  if (
    windowRaw.includes('week') ||
    windowRaw.includes('7d') ||
    windowRaw.includes('7_d') ||
    windowRaw.includes('7-d') ||
    windowRaw.includes('604800')
  ) {
    return 'Weekly limit';
  }
  if (
    windowRaw.includes('day') ||
    windowRaw.includes('24h') ||
    windowRaw.includes('86400')
  ) {
    return 'Daily limit';
  }
  if (windowRaw.includes('month')) {
    return 'Monthly limit';
  }
  return `Quota window ${index + 1}`;
}

function humanizeCreditLabel(rawType: unknown): string {
  if (typeof rawType !== 'string' || !rawType.trim()) {
    return 'AI Credits';
  }
  const trimmed = rawType.trim();
  const upper = trimmed.toUpperCase();
  if (upper.includes('GOOGLE_ONE') || upper.includes('G1')) {
    return 'AI Credits';
  }
  if (upper.includes('TOP_UP') || upper.includes('TOPUP')) {
    return 'Top-Up Credits';
  }
  if (upper.includes('PROMPT')) {
    return 'Prompt Credits';
  }
  if (upper.includes('FLOW')) {
    return 'Flow Credits';
  }
  if (/^[A-Z0-9_]+$/.test(trimmed)) {
    return truncateText(
      trimmed
        .split('_')
        .filter(Boolean)
        .map(
          (part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
        )
        .join(' '),
      36,
    );
  }
  return truncateText(trimmed, 36);
}

function parseQuotaBucketsList(rawBuckets: unknown[]): UsageQuotaBucket[] {
  const buckets: UsageQuotaBucket[] = [];
  for (let i = 0; i < rawBuckets.length && buckets.length < MAX_USAGE_BUCKETS_PER_GROUP; i++) {
    const raw = rawBuckets[i];
    if (!isRecord(raw)) continue;
    const resetTimeMs = parseProtoTimestampMs(raw.resetTime ?? raw.reset_time);
    const remainingFraction = resolveRemainingFraction(raw, resetTimeMs);
    const rawId = raw.bucketId ?? raw.bucket_id ?? raw.window ?? `bucket-${i}`;
    const id =
      typeof rawId === 'string' && rawId.trim()
        ? truncateText(rawId.trim(), 64)
        : `bucket-${i}`;
    const windowStr =
      typeof raw.window === 'string' && raw.window.trim()
        ? truncateText(raw.window.trim(), 24)
        : undefined;
    buckets.push({
      id,
      label: humanizeBucketLabel(raw, i),
      window: windowStr,
      remainingFraction,
      remainingPercent: fractionToPercent(remainingFraction),
      resetTimeMs,
      isExhausted: remainingFraction <= 0,
    });
  }
  return buckets;
}

function extractModelId(rawCfg: Record<string, unknown>): string | undefined {
  const modelOrAlias = isRecord(rawCfg.modelOrAlias)
    ? rawCfg.modelOrAlias
    : isRecord(rawCfg.model_or_alias)
      ? rawCfg.model_or_alias
      : null;
  const candidate =
    (modelOrAlias && (modelOrAlias.model ?? modelOrAlias.alias)) ??
    rawCfg.modelName ??
    rawCfg.model_name ??
    rawCfg.model ??
    rawCfg.id;
  return typeof candidate === 'string' && candidate.trim()
    ? truncateText(candidate.trim(), 64)
    : undefined;
}

/**
 * Parses `RetrieveUserQuotaSummary`, `GetUserStatus`, and fallback `GetCommandModelConfigs`
 * responses into a normalized `UsageStatsSnapshot` for the sidebar Usage tab.
 */
export function buildUsageSnapshot(
  rawUsage: RawBridgeUsagePayload | null | undefined,
  fallbackFetchedAtMs: number = Date.now(),
): UsageStatsSnapshot | null {
  if (!rawUsage || !isRecord(rawUsage as unknown)) {
    return null;
  }

  const sourceInstanceUuid =
    typeof rawUsage.instanceUuid === 'string' &&
    SAFE_ID_PATTERN.test(rawUsage.instanceUuid)
      ? rawUsage.instanceUuid
      : null;
  const sourceInstanceName =
    typeof rawUsage.instanceName === 'string' && rawUsage.instanceName.trim()
      ? truncateText(rawUsage.instanceName.trim(), 64)
      : sourceInstanceUuid;
  const fetchedAtMs =
    typeof rawUsage.fetchedAtMs === 'number' &&
    Number.isFinite(rawUsage.fetchedAtMs) &&
    rawUsage.fetchedAtMs > 0
      ? rawUsage.fetchedAtMs
      : fallbackFetchedAtMs;

  // 1. Parse grouped quota buckets from RetrieveUserQuotaSummary (if available).
  const groups: UsageQuotaGroup[] = [];
  if (isRecord(rawUsage.quotaSummary)) {
    const qsRoot = isRecord(rawUsage.quotaSummary.response)
      ? rawUsage.quotaSummary.response
      : isRecord(rawUsage.quotaSummary.quotaSummary)
        ? rawUsage.quotaSummary.quotaSummary
        : isRecord(rawUsage.quotaSummary.quota_summary)
          ? rawUsage.quotaSummary.quota_summary
          : rawUsage.quotaSummary;

    const rawGroups = Array.isArray(qsRoot.groups)
      ? qsRoot.groups
      : Array.isArray(qsRoot.quotaGroups)
        ? qsRoot.quotaGroups
        : Array.isArray(qsRoot.quota_groups)
          ? qsRoot.quota_groups
          : null;

    if (rawGroups) {
      for (let g = 0; g < rawGroups.length && groups.length < MAX_USAGE_GROUPS; g++) {
        const grp = rawGroups[g];
        if (!isRecord(grp)) continue;
        const rawBuckets = Array.isArray(grp.buckets)
          ? grp.buckets
          : Array.isArray(grp.quotaBuckets)
            ? grp.quotaBuckets
            : Array.isArray(grp.quota_buckets)
              ? grp.quota_buckets
              : [];
        const buckets = parseQuotaBucketsList(rawBuckets);
        if (buckets.length === 0) continue;
        const rawGroupId = grp.groupId ?? grp.group_id ?? `group-${g}`;
        const groupId =
          typeof rawGroupId === 'string' && rawGroupId.trim()
            ? truncateText(rawGroupId.trim(), 64)
            : `group-${g}`;
        const rawGroupLabel =
          grp.displayName ??
          grp.display_name ??
          grp.groupName ??
          grp.group_name ??
          grp.title ??
          grp.label ??
          grp.name ??
          groupId;
        const groupLabel =
          typeof rawGroupLabel === 'string' && rawGroupLabel.trim()
            ? truncateText(rawGroupLabel.trim(), 56)
            : `Quota Pool ${g + 1}`;
        groups.push({
          id: groupId,
          label: groupLabel,
          buckets,
        });
      }
    } else {
      const topBuckets = Array.isArray(qsRoot.buckets)
        ? qsRoot.buckets
        : Array.isArray(qsRoot.quotaBuckets)
          ? qsRoot.quotaBuckets
          : Array.isArray(qsRoot.quota_buckets)
            ? qsRoot.quota_buckets
            : null;
      if (topBuckets) {
        const parsedBuckets = parseQuotaBucketsList(topBuckets);
        if (parsedBuckets.length > 0) {
          groups.push({
            id: 'account-quota',
            label: 'Quota Limits',
            buckets: parsedBuckets,
          });
        }
      }
    }
  }

  // 2. Parse account tier, credits, and per-model configs from GetUserStatus / GetCommandModelConfigs.
  let planName: string | null = null;
  let accountEmail: string | null = null;
  const credits: UsageCreditBalance[] = [];
  const seenCreditKeys = new Set<string>();
  const models: UsageModelQuota[] = [];

  const statusWrapper = isRecord(rawUsage.userStatus)
    ? rawUsage.userStatus
    : null;
  const statusRoot =
    statusWrapper && isRecord(statusWrapper.userStatus)
      ? statusWrapper.userStatus
      : statusWrapper && isRecord(statusWrapper.user_status)
        ? statusWrapper.user_status
        : statusWrapper;

  const addCreditEntry = (entry: UsageCreditBalance) => {
    if (credits.length >= MAX_USAGE_CREDITS) return;
    if (seenCreditKeys.has(entry.id)) return;
    seenCreditKeys.add(entry.id);
    credits.push(entry);
  };

  const collectCreditsArray = (rawArr: unknown, prefix: string) => {
    if (!Array.isArray(rawArr)) return;
    for (let i = 0; i < rawArr.length; i++) {
      const item = rawArr[i];
      if (!isRecord(item)) continue;
      const available = parseOptionalNumber(
        item.creditAmount ??
          item.credit_amount ??
          item.balance ??
          item.available ??
          item.remaining,
      );
      if (available === null || available < 0) continue;
      const minUsage = parseOptionalNumber(
        item.minimumCreditAmountForUsage ??
          item.minimum_credit_amount_for_usage,
      );
      const rawType = item.creditType ?? item.credit_type ?? `${prefix}-${i}`;
      const label = humanizeCreditLabel(rawType);
      addCreditEntry({
        id: `${label.toLowerCase().replace(/\s+/g, '-')}`,
        label,
        available: Math.floor(available * 100) / 100,
        minimumForUsage:
          minUsage !== null && minUsage > 0 ? minUsage : undefined,
      });
    }
  };

  if (statusRoot) {
    if (typeof statusRoot.email === 'string' && statusRoot.email.includes('@')) {
      accountEmail = truncateText(statusRoot.email.trim(), 80);
    }

    const paidTier = isRecord(statusRoot.paidTier)
      ? statusRoot.paidTier
      : isRecord(statusRoot.paid_tier)
        ? statusRoot.paid_tier
        : isRecord(statusWrapper?.paidTier)
          ? statusWrapper.paidTier
          : null;
    const userTier = isRecord(statusRoot.userTier)
      ? statusRoot.userTier
      : isRecord(statusRoot.user_tier)
        ? statusRoot.user_tier
        : isRecord(statusRoot.currentTier)
          ? statusRoot.currentTier
          : isRecord(statusRoot.current_tier)
            ? statusRoot.current_tier
            : isRecord(statusWrapper?.currentTier)
              ? statusWrapper.currentTier
              : null;
    const planStatus = isRecord(statusRoot.planStatus)
      ? statusRoot.planStatus
      : isRecord(statusRoot.plan_status)
        ? statusRoot.plan_status
        : null;
    const planInfo =
      planStatus && isRecord(planStatus.planInfo)
        ? planStatus.planInfo
        : planStatus && isRecord(planStatus.plan_info)
          ? planStatus.plan_info
          : null;

    planName =
      humanizeTierLabel(paidTier?.name) ??
      humanizeTierLabel(userTier?.name) ??
      humanizeTierLabel(userTier?.tierType ?? userTier?.tier_type) ??
      humanizeTierLabel(planInfo?.planName ?? planInfo?.plan_name) ??
      humanizeTierLabel(planInfo?.teamsTier ?? planInfo?.teams_tier);

    collectCreditsArray(
      paidTier?.availableCredits ?? paidTier?.available_credits,
      'paid',
    );
    collectCreditsArray(
      userTier?.availableCredits ?? userTier?.available_credits,
      'tier',
    );
    collectCreditsArray(
      statusRoot.availableCredits ?? statusRoot.available_credits,
      'root',
    );

    const directG1 = parseOptionalNumber(
      statusRoot.g1Credits ?? statusRoot.g1_credits,
    );
    if (directG1 !== null && directG1 >= 0) {
      addCreditEntry({
        id: 'ai-credits',
        label: 'AI Credits',
        available: Math.floor(directG1 * 100) / 100,
      });
    }

    if (planStatus) {
      const availPrompt = parseOptionalNumber(
        planStatus.availablePromptCredits ?? planStatus.available_prompt_credits,
      );
      const monthlyPrompt = parseOptionalNumber(
        planInfo?.monthlyPromptCredits ?? planInfo?.monthly_prompt_credits,
      );
      if (availPrompt !== null && availPrompt >= 0) {
        addCreditEntry({
          id: 'prompt-credits',
          label: 'Prompt Credits',
          available: Math.floor(availPrompt),
          limit:
            monthlyPrompt !== null && monthlyPrompt > 0
              ? Math.floor(monthlyPrompt)
              : undefined,
        });
      }
      const availFlow = parseOptionalNumber(
        planStatus.availableFlowCredits ?? planStatus.available_flow_credits,
      );
      const monthlyFlow = parseOptionalNumber(
        planInfo?.monthlyFlowCredits ?? planInfo?.monthly_flow_credits,
      );
      if (availFlow !== null && availFlow >= 0) {
        addCreditEntry({
          id: 'flow-credits',
          label: 'Flow Credits',
          available: Math.floor(availFlow),
          limit:
            monthlyFlow !== null && monthlyFlow > 0
              ? Math.floor(monthlyFlow)
              : undefined,
        });
      }
    }
  }

  const extractModelsFromSource = (sourceObj: Record<string, unknown> | null) => {
    if (!sourceObj || models.length > 0) return;
    const inner = isRecord(sourceObj.userStatus)
      ? sourceObj.userStatus
      : isRecord(sourceObj.user_status)
        ? sourceObj.user_status
        : sourceObj;
    const cascadeData = isRecord(inner.cascadeModelConfigData)
      ? inner.cascadeModelConfigData
      : isRecord(inner.cascade_model_config_data)
        ? inner.cascade_model_config_data
        : inner;

    const defaultOverride = isRecord(cascadeData.defaultOverrideModelConfig)
      ? cascadeData.defaultOverrideModelConfig
      : isRecord(cascadeData.default_override_model_config)
        ? cascadeData.default_override_model_config
        : null;
    const defaultModelId =
      (defaultOverride ? extractModelId(defaultOverride) : undefined) ??
      (typeof cascadeData.defaultAgentModelId === 'string'
        ? cascadeData.defaultAgentModelId
        : undefined);
    const defaultLabel =
      defaultOverride && typeof defaultOverride.label === 'string'
        ? defaultOverride.label.trim()
        : '';

    const rawConfigs = Array.isArray(cascadeData.clientModelConfigs)
      ? cascadeData.clientModelConfigs
      : Array.isArray(cascadeData.client_model_configs)
        ? cascadeData.client_model_configs
        : Array.isArray(inner.modelConfigs)
          ? inner.modelConfigs
          : Array.isArray(inner.model_configs)
            ? inner.model_configs
            : null;

    if (rawConfigs) {
      const seenIds = new Set<string>();
      for (let i = 0; i < rawConfigs.length && models.length < MAX_USAGE_MODELS; i++) {
        const cfg = rawConfigs[i];
        if (!isRecord(cfg)) continue;
        const modelId = extractModelId(cfg);
        const rawLabel =
          cfg.label ??
          cfg.displayName ??
          cfg.display_name ??
          cfg.modelName ??
          cfg.model_name ??
          modelId;
        if (typeof rawLabel !== 'string' || !rawLabel.trim()) continue;
        const label = truncateText(rawLabel.trim(), 64);
        const dedupKey = `${modelId ?? ''}::${label}`;
        if (seenIds.has(dedupKey)) continue;
        seenIds.add(dedupKey);

        const quotaObj = isRecord(cfg.quotaInfo)
          ? cfg.quotaInfo
          : isRecord(cfg.quota_info)
            ? cfg.quota_info
            : null;
        const resetTimeMs = quotaObj
          ? parseProtoTimestampMs(quotaObj.resetTime ?? quotaObj.reset_time)
          : 0;
        const remainingFraction = quotaObj
          ? resolveRemainingFraction(quotaObj, resetTimeMs)
          : 1;

        const isDefault = Boolean(
          (defaultModelId && modelId === defaultModelId) ||
            (defaultLabel && label === defaultLabel),
        );

        models.push({
          id: modelId ? `${modelId}-${models.length}` : `model-${models.length}`,
          label,
          modelId,
          remainingFraction,
          remainingPercent: fractionToPercent(remainingFraction),
          resetTimeMs,
          isExhausted: remainingFraction <= 0,
          isRecommended: Boolean(cfg.isRecommended ?? cfg.is_recommended),
          isDefault,
          supportsImages: Boolean(cfg.supportsImages ?? cfg.supports_images),
        });
      }
      return;
    }

    if (isRecord(cascadeData.models)) {
      for (const [key, val] of Object.entries(cascadeData.models)) {
        if (models.length >= MAX_USAGE_MODELS) break;
        if (!isRecord(val)) continue;
        const rawLabel =
          val.displayName ?? val.display_name ?? val.label ?? key;
        if (typeof rawLabel !== 'string' || !rawLabel.trim()) continue;
        const label = truncateText(rawLabel.trim(), 64);
        const quotaObj = isRecord(val.quotaInfo)
          ? val.quotaInfo
          : isRecord(val.quota_info)
            ? val.quota_info
            : null;
        const resetTimeMs = quotaObj
          ? parseProtoTimestampMs(quotaObj.resetTime ?? quotaObj.reset_time)
          : 0;
        const remainingFraction = quotaObj
          ? resolveRemainingFraction(quotaObj, resetTimeMs)
          : 1;
        models.push({
          id: `${key}-${models.length}`,
          label,
          modelId: truncateText(key, 64),
          remainingFraction,
          remainingPercent: fractionToPercent(remainingFraction),
          resetTimeMs,
          isExhausted: remainingFraction <= 0,
          isRecommended: false,
          isDefault: defaultModelId === key,
          supportsImages: false,
        });
      }
    }
  };

  extractModelsFromSource(statusWrapper);
  if (models.length === 0 && isRecord(rawUsage.commandModelConfigs)) {
    extractModelsFromSource(rawUsage.commandModelConfigs);
  }

  const error =
    typeof rawUsage.error === 'string' && rawUsage.error.trim()
      ? truncateText(rawUsage.error.trim(), 160)
      : null;

  if (
    groups.length === 0 &&
    models.length === 0 &&
    !planName &&
    !accountEmail &&
    credits.length === 0 &&
    !error
  ) {
    return null;
  }

  let lowestRemainingFraction: number | null = null;
  for (const grp of groups) {
    for (const b of grp.buckets) {
      if (
        lowestRemainingFraction === null ||
        b.remainingFraction < lowestRemainingFraction
      ) {
        lowestRemainingFraction = b.remainingFraction;
      }
    }
  }
  for (const m of models) {
    if (
      lowestRemainingFraction === null ||
      m.remainingFraction < lowestRemainingFraction
    ) {
      lowestRemainingFraction = m.remainingFraction;
    }
  }

  return {
    sourceInstanceUuid,
    sourceInstanceName,
    fetchedAtMs,
    planName,
    accountEmail,
    credits,
    groups,
    models,
    lowestRemainingFraction,
    error,
  };
}

/**
 * Resolves the active workstation and cascade route from a WebView bridge message,
 * preserving explicit `null` overrides (e.g. when returning to Project Overview
 * inside the iframe while the host URL still carries a `?p=c%2F...` query) and
 * falling back to `activeUrl` / `fallbackActiveUrl` only when fields are omitted.
 */
export function resolveActiveRouteFromBridgeMessage(
  message: {
    activeUrl?: string;
    activeInstanceUuid?: string | null;
    activeCascadeId?: string | null;
  },
  fallbackActiveUrl?: string | null,
): { instanceUuid: string | null; cascadeId: string | null } {
  const referenceUrl = message.activeUrl ?? fallbackActiveUrl ?? null;
  const routeFromUrl = extractActiveRouteFromUrl(referenceUrl);
  const instanceUuid =
    message.activeInstanceUuid === null
      ? null
      : typeof message.activeInstanceUuid === 'string'
        ? SAFE_ID_PATTERN.test(message.activeInstanceUuid)
          ? message.activeInstanceUuid
          : null
        : routeFromUrl.instanceUuid;
  const cascadeId =
    message.activeCascadeId === null
      ? null
      : typeof message.activeCascadeId === 'string'
        ? SAFE_ID_PATTERN.test(message.activeCascadeId)
          ? message.activeCascadeId
          : null
        : routeFromUrl.cascadeId;
  return { instanceUuid, cascadeId };
}

/**
 * Builds a sorted, deduplicated `InboxSnapshot` from a raw WebView bridge snapshot.
 */
export function buildInboxSnapshot(
  message: Extract<InboxBridgeMessage, { type: 'AGY_INBOX_SNAPSHOT' }>,
  locallyReadAtByThreadId: Readonly<Record<string, number>> = {},
  fallbackActiveUrl?: string | null,
  isAppForeground: boolean = true,
  completedUnreadAtByThreadId: Readonly<Record<string, number>> = {},
  isDrawerOpen: boolean = false,
): InboxSnapshot {
  const referenceUrl = message.activeUrl ?? fallbackActiveUrl ?? null;
  const { instanceUuid: activeInstanceUuid, cascadeId: activeCascadeId } =
    resolveActiveRouteFromBridgeMessage(message, fallbackActiveUrl);

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
          completedUnreadAtByThreadId,
          isAppForeground,
          isDrawerOpen,
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
        completedUnreadAtByThreadId,
        isAppForeground,
        isDrawerOpen,
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

  const resolvedFetchedAtMs =
    typeof message.fetchedAtMs === 'number' &&
    Number.isFinite(message.fetchedAtMs) &&
    message.fetchedAtMs > 0
      ? message.fetchedAtMs
      : Date.now();

  return {
    instances,
    threads: allThreads,
    fetchedAtMs: resolvedFetchedAtMs,
    activeInstanceUuid,
    activeCascadeId,
    usage: buildUsageSnapshot(message.usage, resolvedFetchedAtMs),
    error:
      typeof message.error === 'string' && message.error.trim()
        ? truncateText(message.error, 160)
        : null,
  };
}

function setBoundedTransitionStamp(
  map: Record<string, number>,
  key: string,
  value: number,
): void {
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    delete map[key];
  }
  map[key] = value;
  const keys = Object.keys(map);
  if (keys.length > MAX_TRACKED_TRANSITION_ENTRIES) {
    const excess = keys.length - MAX_TRACKED_TRANSITION_ENTRIES;
    for (let i = 0; i < excess; i++) {
      delete map[keys[i]];
    }
  }
}

/**
 * Tracks live `running`/`approval` -> finished transitions across snapshots so
 * any agent run that completes while the thread is not actively visible on
 * screen enters the blue `unread` (finished) state and triggers an action
 * notification, even when `lastUserViewTime` / `lastUserInputTime` are absent,
 * sub-second, or subject to workstation clock skew.
 */
export function reconcileRunningThreadTransitions(params: {
  message: Extract<InboxBridgeMessage, { type: 'AGY_INBOX_SNAPSHOT' }>;
  knownRunningThreadIds: Set<string>;
  completedUnreadAtByThreadId: Record<string, number>;
  locallyReadAtByThreadId: Record<string, number>;
  fallbackActiveUrl?: string | null;
  isAppForeground?: boolean;
  isDrawerOpen?: boolean;
}): InboxSnapshot {
  const {
    message,
    knownRunningThreadIds,
    completedUnreadAtByThreadId,
    locallyReadAtByThreadId,
    fallbackActiveUrl,
    isAppForeground = true,
    isDrawerOpen = false,
  } = params;

  const preliminary = buildInboxSnapshot(
    message,
    locallyReadAtByThreadId,
    fallbackActiveUrl,
    isAppForeground,
    completedUnreadAtByThreadId,
    isDrawerOpen,
  );

  let needsRebuild = false;
  for (const thread of preliminary.threads) {
    const isRunActive =
      thread.attentionKind === 'running' || thread.attentionKind === 'approval';
    if (isRunActive) {
      knownRunningThreadIds.add(thread.id);
      if (
        Object.prototype.hasOwnProperty.call(
          completedUnreadAtByThreadId,
          thread.id,
        )
      ) {
        delete completedUnreadAtByThreadId[thread.id];
      }
      if (
        Object.prototype.hasOwnProperty.call(locallyReadAtByThreadId, thread.id)
      ) {
        delete locallyReadAtByThreadId[thread.id];
      }
      continue;
    }

    if (knownRunningThreadIds.delete(thread.id)) {
      const wasInterrupted = thread.attentionReason === 'Interrupted';
      if (thread.attentionKind !== 'error' && !wasInterrupted) {
        const isActivelyViewedOnScreen =
          isAppForeground && !isDrawerOpen && thread.isActiveThread;
        if (isActivelyViewedOnScreen) {
          delete completedUnreadAtByThreadId[thread.id];
          setBoundedTransitionStamp(
            locallyReadAtByThreadId,
            thread.id,
            Math.max(1, thread.lastModifiedAtMs),
          );
        } else {
          delete locallyReadAtByThreadId[thread.id];
          setBoundedTransitionStamp(
            completedUnreadAtByThreadId,
            thread.id,
            Math.max(1, thread.lastModifiedAtMs),
          );
          if (thread.attentionKind !== 'unread') {
            needsRebuild = true;
          }
        }
      }
    }
  }

  if (knownRunningThreadIds.size > MAX_TRACKED_TRANSITION_ENTRIES) {
    const presentIds = new Set(preliminary.threads.map((t) => t.id));
    for (const trackedId of Array.from(knownRunningThreadIds)) {
      if (!presentIds.has(trackedId)) {
        knownRunningThreadIds.delete(trackedId);
      }
      if (knownRunningThreadIds.size <= MAX_TRACKED_TRANSITION_ENTRIES) {
        break;
      }
    }
  }

  if (!needsRebuild) {
    return preliminary;
  }

  return buildInboxSnapshot(
    message,
    locallyReadAtByThreadId,
    fallbackActiveUrl,
    isAppForeground,
    completedUnreadAtByThreadId,
    isDrawerOpen,
  );
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
    isAppForeground?: boolean;
    isDrawerOpen?: boolean;
  },
): InboxSnapshot {
  const {
    activeInstanceUuid,
    activeCascadeId,
    locallyReadAtByThreadId,
    isAppForeground = true,
    isDrawerOpen = false,
  } = params;

  const updatedThreads = snapshot.threads.map((thread) => {
    const isActiveThread =
      activeInstanceUuid === thread.instanceUuid &&
      activeCascadeId !== null &&
      (activeCascadeId === thread.cascadeId ||
        activeCascadeId === thread.trajectoryId);

    const locallyReadAtMs = locallyReadAtByThreadId[thread.id] ?? 0;
    const isLocallyCleared =
      locallyReadAtMs > 0 &&
      (thread.lastModifiedAtMs > 0
        ? locallyReadAtMs >= thread.lastModifiedAtMs
        : true);
    const isActivelyViewedOnScreen =
      isAppForeground && !isDrawerOpen && isActiveThread;

    if (
      thread.attentionKind === 'unread' &&
      (isActivelyViewedOnScreen || isLocallyCleared)
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
        const rawUsage = isRecord(parsed.usage) ? parsed.usage : null;
        const sanitizedUsage: RawBridgeUsagePayload | null = rawUsage
          ? {
              instanceUuid:
                typeof rawUsage.instanceUuid === 'string'
                  ? rawUsage.instanceUuid
                  : null,
              instanceName:
                typeof rawUsage.instanceName === 'string'
                  ? rawUsage.instanceName
                  : null,
              fetchedAtMs:
                typeof rawUsage.fetchedAtMs === 'number'
                  ? rawUsage.fetchedAtMs
                  : undefined,
              quotaSummary: isRecord(rawUsage.quotaSummary)
                ? rawUsage.quotaSummary
                : null,
              userStatus: isRecord(rawUsage.userStatus)
                ? rawUsage.userStatus
                : null,
              commandModelConfigs: isRecord(rawUsage.commandModelConfigs)
                ? rawUsage.commandModelConfigs
                : null,
              error:
                typeof rawUsage.error === 'string' ? rawUsage.error : null,
            }
          : null;
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
            : parsed.activeInstanceUuid === null
              ? null
              : undefined,
        activeCascadeId:
          typeof parsed.activeCascadeId === 'string'
            ? parsed.activeCascadeId
            : parsed.activeCascadeId === null
              ? null
              : undefined,
        instances,
        cloudTrajectories: isRecord(parsed.cloudTrajectories)
          ? parsed.cloudTrajectories
          : null,
        usage: sanitizedUsage,
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
            : parsed.activeInstanceUuid === null
              ? null
              : undefined,
        activeCascadeId:
          typeof parsed.activeCascadeId === 'string'
            ? parsed.activeCascadeId
            : parsed.activeCascadeId === null
              ? null
              : undefined,
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

/**
 * Formats a future quota reset timestamp into a concise human countdown
 * (e.g., `Resets in 24m`, `Resets in 3h 15m`, `Resets in 4d 6h`, or `Resetting soon`).
 */
export function formatResetCountdown(
  resetTimeMs: number,
  nowMs: number = Date.now(),
): string {
  if (!resetTimeMs || !Number.isFinite(resetTimeMs) || resetTimeMs <= 0) {
    return '';
  }
  const diffMs = resetTimeMs - nowMs;
  if (diffMs <= 0) {
    return 'Resetting soon';
  }
  const totalMinutes = Math.ceil(diffMs / 60_000);
  if (totalMinutes <= 1) {
    return 'Resets in <1m';
  }
  if (totalMinutes < 60) {
    return `Resets in ${totalMinutes}m`;
  }
  const totalHours = Math.floor(diffMs / 3_600_000);
  if (totalHours < 24) {
    const remMinutes = Math.floor((diffMs % 3_600_000) / 60_000);
    return remMinutes > 0
      ? `Resets in ${totalHours}h ${remMinutes}m`
      : `Resets in ${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0
    ? `Resets in ${days}d ${remHours}h`
    : `Resets in ${days}d`;
}
