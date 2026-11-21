import { ANTIGRAVITY_DASHBOARD_URL } from '../constants/config';
import {
  ActiveThreadProjectContext,
  DirectoryEntry,
  InboxAttentionKind,
  InboxBridgeMessage,
  InboxInstanceStatus,
  InboxInstanceSummary,
  InboxProjectGroup,
  InboxServerProject,
  InboxSnapshot,
  InboxThreadItem,
  RawBridgeBackgroundTaskPayload,
  RawBridgeInstancePayload,
  RawBridgeUsagePayload,
  UsageCreditBalance,
  UsageModelQuota,
  UsageQuotaBucket,
  UsageQuotaGroup,
  UsageStatsSnapshot,
} from '../types/inbox';
import { validateNavigationUrl } from './urlValidator';

const MAX_INBOX_BRIDGE_PAYLOAD_LENGTH = 6 * 1024 * 1024;
const MAX_INSTANCES_PER_SNAPSHOT = 64;
const MAX_PROJECTS_PER_INSTANCE = 256;
const MAX_BACKGROUND_TASKS_PER_INSTANCE = 256;
const MAX_DIR_ENTRIES = 250;
const MAX_USAGE_GROUPS = 16;
const MAX_USAGE_BUCKETS_PER_GROUP = 16;
const MAX_USAGE_MODELS = 48;
const MAX_USAGE_CREDITS = 12;
const MAX_TRACKED_TRANSITION_ENTRIES = 500;
const MAX_SUBAGENT_PARENT_ENTRIES = 1000;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Matches Antigravity thinking/effort-level suffixes on model labels
 * (e.g. `Gemini 4 Neon (Low)`, `Gemini 4 Neon (Extra)`, `Gemini 3.1 Pro (High Thinking)`).
 */
const MODEL_THINKING_LEVEL_PATTERN =
  /^(.*?)\s*\((?:(?:thinking\s*[-:]?\s*)?(fast|minimal|low|medium|high|extra(?:\s+high)?|xhigh|max)(?:\s+thinking)?|no\s+thinking)\)\s*$/i;
const MODEL_THINKING_TAG_PATTERN = /^(.*?)\s*\(thinking\)\s*$/i;

function isHiddenCredit(rawIdOrLabelOrType: unknown): boolean {
  if (typeof rawIdOrLabelOrType !== 'string') return false;
  const upper = rawIdOrLabelOrType.trim().toUpperCase();
  return upper.includes('PROMPT') || upper.includes('FLOW');
}

function normalizeWorkspaceUriKey(uri: string | null | undefined): string | null {
  if (!uri || typeof uri !== 'string') return null;
  let value = uri.trim();
  if (!value) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep original string if malformed percent-escape is present.
  }
  value = value.replace(/\\/g, '/');

  // Normalize Antigravity / VS Code local & remote file URIs and bare paths to a single
  // canonical lowercase POSIX-style path so `file:///home/a`, `file://localhost/home/a`,
  // `vscode-remote://ssh-remote+box/home/a`, `/home/a`, `file:///C%3A/a`, and `C:\a` all match.
  const vscodeRemoteMatch = /^vscode-remote:\/\/[^/]+(\/.*)$/i.exec(value);
  if (vscodeRemoteMatch) {
    value = vscodeRemoteMatch[1];
  } else if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\/(?:localhost)?/i, '');
  }

  if (/^[a-zA-Z]:\//.test(value)) {
    value = `/${value}`;
  }

  if (value.startsWith('/')) {
    value = value.replace(/\/{2,}/g, '/');
    if (value.length > 1) {
      value = value.replace(/\/+$/, '');
    }
    return value.toLowerCase();
  }

  const trimmed = value.replace(/\/+$/, '');
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizeProjectSlugKey(name: string | null | undefined): string | null {
  if (!name || typeof name !== 'string') return null;
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return slug.length >= 2 ? slug : null;
}

function getCanonicalPathSegmentCount(normalizedUriKey: string): number {
  if (!normalizedUriKey.startsWith('/')) {
    return 0;
  }
  return normalizedUriKey.split('/').filter(Boolean).length;
}

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

/**
 * Extracts an explicit `project` query parameter from an `https://antigravity.google.com`
 * host URL or its nested `p` child path (e.g. `?p=c%2F<cascadeId>%3Fproject%3D<projectId>`).
 */
export function extractProjectIdFromUrl(rawUrl?: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }
  const sanitizeProjectId = (candidate: string | null): string | null => {
    if (!candidate) return null;
    const trimmed = candidate.trim();
    if (
      !trimmed ||
      trimmed === 'outside-of-project' ||
      !SAFE_ID_PATTERN.test(trimmed)
    ) {
      return null;
    }
    return trimmed;
  };
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.toLowerCase() !== 'antigravity.google.com') {
      return null;
    }
    const direct = sanitizeProjectId(parsed.searchParams.get('project'));
    if (direct) {
      return direct;
    }
    const childParam = parsed.searchParams.get('p') ?? '';
    const queryIdx = childParam.indexOf('?');
    if (queryIdx !== -1) {
      const childQuery = childParam.slice(queryIdx + 1).split('#')[0];
      const childParams = new URLSearchParams(childQuery);
      return sanitizeProjectId(childParams.get('project'));
    }
    return null;
  } catch {
    return null;
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
  const inspectWorkspaces = (list: unknown[]): string | null => {
    for (const ws of list) {
      if (!isRecord(ws)) continue;
      const folderName =
        extractLastSegmentFromUri(
          ws.workspaceFolderAbsoluteUri ?? ws.workspace_folder_absolute_uri,
        ) ??
        extractLastSegmentFromUri(
          ws.gitRootAbsoluteUri ?? ws.git_root_absolute_uri,
        ) ??
        extractLastSegmentFromUri(ws.workspaceUri ?? ws.workspace_uri ?? ws.uri);
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
    return null;
  };

  const workspaces = Array.isArray(rawTrajectory.workspaces)
    ? rawTrajectory.workspaces
    : [];
  const topLevelName = inspectWorkspaces(workspaces);
  if (topLevelName) {
    return topLevelName;
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
    const metaWorkspaces = Array.isArray(metadata.workspaces)
      ? metadata.workspaces
      : [];
    const metaWsName = inspectWorkspaces(metaWorkspaces);
    if (metaWsName) {
      return metaWsName;
    }
  }

  const directFolderName =
    extractLastSegmentFromUri(
      rawTrajectory.workspaceFolderAbsoluteUri ??
        rawTrajectory.workspace_folder_absolute_uri,
    ) ??
    extractLastSegmentFromUri(
      rawTrajectory.gitRootAbsoluteUri ?? rawTrajectory.git_root_absolute_uri,
    ) ??
    extractLastSegmentFromUri(
      rawTrajectory.workspaceUri ?? rawTrajectory.workspace_uri,
    );
  if (directFolderName) {
    return directFolderName;
  }

  return null;
}

/**
 * Extracts all distinct workspace and git-root URIs associated with a trajectory summary
 * (across `workspaces`, `trajectoryMetadata.workspaceUris`, `trajectoryMetadata.workspaces`,
 * and top-level URI fields).
 */
export function extractWorkspaceUris(
  rawTrajectory: Record<string, unknown>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const addUri = (candidate: unknown) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const cleaned = candidate.trim().replace(/\/+$/, '').slice(0, 512);
    const key = normalizeWorkspaceUriKey(cleaned);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(cleaned);
  };

  const addWorkspaceEntries = (list: unknown[]) => {
    for (const ws of list) {
      if (!isRecord(ws)) continue;
      addUri(ws.workspaceFolderAbsoluteUri ?? ws.workspace_folder_absolute_uri);
      addUri(ws.gitRootAbsoluteUri ?? ws.git_root_absolute_uri);
      addUri(ws.workspaceUri ?? ws.workspace_uri ?? ws.uri);
    }
  };

  if (Array.isArray(rawTrajectory.workspaces)) {
    addWorkspaceEntries(rawTrajectory.workspaces);
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
      addUri(uri);
    }
    if (Array.isArray(metadata.workspaces)) {
      addWorkspaceEntries(metadata.workspaces);
    }
  }

  addUri(
    rawTrajectory.workspaceFolderAbsoluteUri ??
      rawTrajectory.workspace_folder_absolute_uri,
  );
  addUri(
    rawTrajectory.gitRootAbsoluteUri ?? rawTrajectory.git_root_absolute_uri,
  );
  addUri(rawTrajectory.workspaceUri ?? rawTrajectory.workspace_uri);

  return result;
}

/**
 * Extracts the primary workspace URI (e.g. `file:///home/user/project`) from a trajectory summary.
 */
export function extractWorkspaceUri(
  rawTrajectory: Record<string, unknown>,
): string | null {
  return extractWorkspaceUris(rawTrajectory)[0] ?? null;
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

function isIdleCascadeStatus(rawStatus: unknown): boolean {
  if (rawStatus === 1) {
    return true;
  }
  if (typeof rawStatus === 'string') {
    return rawStatus.toUpperCase().includes('IDLE');
  }
  return false;
}

function isUserCanceledTerminationReason(rawReason: unknown): boolean {
  if (rawReason === 2) {
    return true;
  }
  if (typeof rawReason === 'string' && rawReason.trim()) {
    const upper = rawReason.toUpperCase();
    return upper.includes('USER_CANCELED') || upper.includes('USER_CANCELLED');
  }
  return false;
}

function parseNonNegativeInt(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) {
      return 0;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
  return 0;
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
  if (rawType === 22 || rawType === 23) {
    return true;
  }
  if (typeof rawType !== 'string') {
    return false;
  }
  const upper = rawType.toUpperCase();
  return (
    upper.includes('SIDE_QUESTION') || upper.includes('COMMIT_MESSAGE')
  );
}

function getSourceMetadataRecord(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  if (isRecord(metadata.sourceMetadata)) {
    return metadata.sourceMetadata;
  }
  if (isRecord(metadata.source_metadata)) {
    return metadata.source_metadata;
  }
  return null;
}

function isHiddenFromConversationList(
  metadata: Record<string, unknown> | null,
): boolean {
  const sourceMetadata = getSourceMetadataRecord(metadata);
  if (!sourceMetadata) {
    return false;
  }
  return Boolean(
    sourceMetadata.hideFromConversationList ??
      sourceMetadata.hide_from_conversation_list,
  );
}

function extractDirectParentId(
  metadata: Record<string, unknown> | null,
): string | null {
  if (!metadata) {
    return null;
  }
  const rawParentId =
    metadata.parentConversationId ?? metadata.parent_conversation_id;
  if (typeof rawParentId === 'string' && SAFE_ID_PATTERN.test(rawParentId)) {
    return rawParentId;
  }
  const sourceMetadata = getSourceMetadataRecord(metadata);
  if (
    sourceMetadata &&
    Boolean(
      sourceMetadata.hideFromConversationList ??
        sourceMetadata.hide_from_conversation_list,
    )
  ) {
    const toolMeta = isRecord(sourceMetadata.tool)
      ? sourceMetadata.tool
      : null;
    const toolConvId = toolMeta
      ? (toolMeta.conversationId ?? toolMeta.conversation_id)
      : null;
    if (typeof toolConvId === 'string' && SAFE_ID_PATTERN.test(toolConvId)) {
      return toolConvId;
    }
  }
  return null;
}

function isActiveBattleMode(
  battleModeInfo: Record<string, unknown> | null,
): boolean {
  if (!battleModeInfo) {
    return false;
  }
  const endType = battleModeInfo.endType ?? battleModeInfo.end_type;
  if (endType === undefined || endType === null || endType === 0) {
    return true;
  }
  if (typeof endType === 'string') {
    const upper = endType.trim().toUpperCase();
    return upper === '' || upper === '0' || upper.includes('UNSPECIFIED');
  }
  return false;
}

function hasRunningBattleChildStatus(
  battleModeInfo: Record<string, unknown> | null,
): boolean {
  if (!battleModeInfo || !isActiveBattleMode(battleModeInfo)) {
    return false;
  }
  const statuses = Array.isArray(battleModeInfo.childrenTrajectoryStatuses)
    ? battleModeInfo.childrenTrajectoryStatuses
    : Array.isArray(battleModeInfo.children_trajectory_statuses)
      ? battleModeInfo.children_trajectory_statuses
      : [];
  return statuses.some((st) => isRunningCascadeStatus(st));
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

interface ConversationBackgroundTaskInfo {
  nonDaemonCount: number;
  daemonCount: number;
  firstNonDaemonLabel: string | null;
}

interface BubbledChildInfo {
  waitingSteps: unknown[];
  subagentRole: string | null;
  hasRunningChild: boolean;
  activeBackgroundTaskCount: number;
  firstBackgroundTaskLabel: string | null;
  latestModifiedMs: number;
}

function parseTrajectoriesForSource(params: {
  source: 'remote-control' | 'cloud';
  instanceUuid: string;
  instanceName: string;
  rawTrajectories: Record<string, unknown> | null | undefined;
  rawBackgroundTasks?: readonly RawBridgeBackgroundTaskPayload[] | null;
  activeInstanceUuid: string | null;
  activeCascadeId: string | null;
  accountPrefix: string;
  preservedQueryParams: Readonly<Record<string, string>>;
  locallyReadAtByThreadId: Readonly<Record<string, number>>;
  completedUnreadAtByThreadId?: Readonly<Record<string, number>>;
  isAppForeground?: boolean;
  isDrawerOpen?: boolean;
  subagentParentByKey?: Record<string, string>;
}): InboxThreadItem[] {
  const {
    source,
    instanceUuid,
    instanceName,
    rawTrajectories,
    rawBackgroundTasks,
    activeInstanceUuid,
    activeCascadeId,
    accountPrefix,
    preservedQueryParams,
    locallyReadAtByThreadId,
    completedUnreadAtByThreadId = {},
    isAppForeground = true,
    isDrawerOpen = false,
    subagentParentByKey,
  } = params;

  const map = unwrapTrajectoryMap(rawTrajectories);
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return [];
  }

  // Index trajectoryId -> cascadeId so subagents and background tasks referencing either ID resolve cleanly.
  const trajectoryIdToCascadeId = new Map<string, string>();
  const entryCascadeIds = new Set<string>();
  for (const [cascadeId, raw] of entries) {
    entryCascadeIds.add(cascadeId);
    trajectoryIdToCascadeId.set(cascadeId, cascadeId);
    const trajId = raw.trajectoryId ?? raw.trajectory_id;
    if (typeof trajId === 'string' && SAFE_ID_PATTERN.test(trajId)) {
      trajectoryIdToCascadeId.set(trajId, cascadeId);
    }
  }

  // Index live background tasks from `ListBackgroundTasks` per conversation,
  // separating non-daemon work (commands, timers, workflows) from long-running daemons.
  const bgTasksByCascadeId = new Map<string, ConversationBackgroundTaskInfo>();
  if (Array.isArray(rawBackgroundTasks)) {
    for (const rawEntry of rawBackgroundTasks.slice(
      0,
      MAX_BACKGROUND_TASKS_PER_INSTANCE,
    )) {
      if (!isRecord(rawEntry)) {
        continue;
      }
      const rawConvId = rawEntry.conversationId ?? rawEntry.conversation_id;
      if (typeof rawConvId !== 'string' || !SAFE_ID_PATTERN.test(rawConvId)) {
        continue;
      }
      const resolvedConvId =
        trajectoryIdToCascadeId.get(rawConvId) ?? rawConvId;
      const taskObj = isRecord(rawEntry.task) ? rawEntry.task : null;
      const isDaemon = Boolean(
        taskObj?.isDaemon ??
          taskObj?.is_daemon ??
          rawEntry.isDaemon ??
          rawEntry.is_daemon,
      );
      const info = bgTasksByCascadeId.get(resolvedConvId) ?? {
        nonDaemonCount: 0,
        daemonCount: 0,
        firstNonDaemonLabel: null,
      };
      if (isDaemon) {
        info.daemonCount += 1;
      } else {
        info.nonDaemonCount += 1;
        if (!info.firstNonDaemonLabel && taskObj) {
          const rawLabel =
            taskObj.toolSummary ??
            taskObj.tool_summary ??
            taskObj.description ??
            taskObj.toolName ??
            taskObj.tool_name;
          if (typeof rawLabel === 'string' && rawLabel.trim()) {
            info.firstNonDaemonLabel = truncateText(rawLabel.trim(), 72);
          }
        }
      }
      bgTasksByCascadeId.set(resolvedConvId, info);
    }
  }

  // Build parent links across direct subagents, hidden tool-spawned trajectories, and active Battle Mode forks.
  const directParentByCascadeId = new Map<string, string>();
  const rootHintByCascadeId = new Map<string, string>();
  const battleParentForLookupByCascadeId = new Map<string, string>();

  for (const [cascadeId, raw] of entries) {
    const metadata = isRecord(raw.trajectoryMetadata)
      ? raw.trajectoryMetadata
      : isRecord(raw.trajectory_metadata)
        ? raw.trajectory_metadata
        : null;
    const rawDirectParent = extractDirectParentId(metadata);
    if (rawDirectParent) {
      const normalizedParent =
        trajectoryIdToCascadeId.get(rawDirectParent) ?? rawDirectParent;
      if (normalizedParent !== cascadeId) {
        directParentByCascadeId.set(cascadeId, normalizedParent);
      }
    }
    const rawRootId = metadata
      ? (metadata.rootConversationId ?? metadata.root_conversation_id)
      : null;
    if (typeof rawRootId === 'string' && SAFE_ID_PATTERN.test(rawRootId)) {
      const normalizedRoot = trajectoryIdToCascadeId.get(rawRootId) ?? rawRootId;
      if (normalizedRoot !== cascadeId) {
        rootHintByCascadeId.set(cascadeId, normalizedRoot);
      }
    }

    const battleModeInfo = isRecord(raw.battleModeInfo)
      ? raw.battleModeInfo
      : isRecord(raw.battle_mode_info)
        ? raw.battle_mode_info
        : null;
    if (battleModeInfo) {
      const battleChildren = Array.isArray(battleModeInfo.childrenConversationIds)
        ? battleModeInfo.childrenConversationIds
        : Array.isArray(battleModeInfo.children_conversation_ids)
          ? battleModeInfo.children_conversation_ids
          : [];
      const battleActive = isActiveBattleMode(battleModeInfo);
      for (const rawChildId of battleChildren) {
        if (typeof rawChildId !== 'string' || !SAFE_ID_PATTERN.test(rawChildId)) {
          continue;
        }
        const normalizedChild =
          trajectoryIdToCascadeId.get(rawChildId) ?? rawChildId;
        if (normalizedChild === cascadeId) {
          continue;
        }
        if (!battleParentForLookupByCascadeId.has(normalizedChild)) {
          battleParentForLookupByCascadeId.set(normalizedChild, cascadeId);
        }
        if (battleActive && !directParentByCascadeId.has(normalizedChild)) {
          directParentByCascadeId.set(normalizedChild, cascadeId);
        }
      }
    }
  }

  const resolveTopLevelParent = (startCascadeId: string): string | null => {
    const firstParent = directParentByCascadeId.get(startCascadeId);
    if (!firstParent) {
      return null;
    }
    const visited = new Set<string>([startCascadeId]);
    let current = firstParent;
    let fallbackRootHint = rootHintByCascadeId.get(startCascadeId) ?? null;

    for (let depth = 0; depth < 8; depth++) {
      if (visited.has(current)) {
        break;
      }
      visited.add(current);
      if (!fallbackRootHint) {
        fallbackRootHint = rootHintByCascadeId.get(current) ?? null;
      }
      const nextParent = directParentByCascadeId.get(current);
      if (!nextParent) {
        if (
          !entryCascadeIds.has(current) &&
          fallbackRootHint &&
          fallbackRootHint !== startCascadeId &&
          entryCascadeIds.has(fallbackRootHint) &&
          !directParentByCascadeId.has(fallbackRootHint)
        ) {
          return fallbackRootHint;
        }
        return current;
      }
      current = nextParent;
    }
    return current;
  };

  // Pass 1: Bubble child subagent / tool-child / active-battle-fork prompts, running states, and background tasks up to their top-level parent.
  const bubbledByParentCascadeId = new Map<string, BubbledChildInfo>();
  for (const [childCascadeId, raw] of entries) {
    const metadata = isRecord(raw.trajectoryMetadata)
      ? raw.trajectoryMetadata
      : isRecord(raw.trajectory_metadata)
        ? raw.trajectory_metadata
        : null;
    const directParentId =
      directParentByCascadeId.get(childCascadeId) ??
      battleParentForLookupByCascadeId.get(childCascadeId) ??
      null;
    if (
      directParentId &&
      subagentParentByKey &&
      Object.keys(subagentParentByKey).length < MAX_SUBAGENT_PARENT_ENTRIES
    ) {
      subagentParentByKey[`${instanceUuid}:${childCascadeId}`] = directParentId;
      const childTrajId = raw.trajectoryId ?? raw.trajectory_id;
      if (
        typeof childTrajId === 'string' &&
        childTrajId !== childCascadeId &&
        SAFE_ID_PATTERN.test(childTrajId) &&
        Object.keys(subagentParentByKey).length < MAX_SUBAGENT_PARENT_ENTRIES
      ) {
        subagentParentByKey[`${instanceUuid}:${childTrajId}`] = directParentId;
      }
    }

    const parentCascadeId = resolveTopLevelParent(childCascadeId);
    if (!parentCascadeId) {
      continue;
    }

    const killed = Boolean(raw.killed);
    if (killed) {
      continue;
    }
    const waitingSteps = Array.isArray(raw.waitingSteps)
      ? raw.waitingSteps
      : Array.isArray(raw.waiting_steps)
        ? raw.waiting_steps
        : [];
    const childSummaryBgCount = parseNonNegativeInt(
      raw.backgroundTaskCount ?? raw.background_task_count,
    );
    const childBgInfo = bgTasksByCascadeId.get(childCascadeId);
    const childActiveBgCount = Math.max(
      childBgInfo?.nonDaemonCount ?? 0,
      Math.max(0, childSummaryBgCount - (childBgInfo?.daemonCount ?? 0)),
    );
    const childRunning =
      Boolean(raw.notFullyIdle) ||
      Boolean(raw.not_fully_idle) ||
      isRunningCascadeStatus(raw.status) ||
      Boolean(raw.hasRunningSubagents) ||
      Boolean(raw.has_running_subagents) ||
      Boolean(raw.hasActiveChildren) ||
      Boolean(raw.has_active_children) ||
      childActiveBgCount > 0;
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
      activeBackgroundTaskCount: 0,
      firstBackgroundTaskLabel: null,
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
    if (childActiveBgCount > 0) {
      existing.activeBackgroundTaskCount += childActiveBgCount;
      if (!existing.firstBackgroundTaskLabel && childBgInfo?.firstNonDaemonLabel) {
        existing.firstBackgroundTaskLabel = childBgInfo.firstNonDaemonLabel;
      }
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
    if (isHiddenFromConversationList(metadata)) {
      continue;
    }
    const parentId = metadata
      ? (metadata.parentConversationId ?? metadata.parent_conversation_id)
      : null;
    if (
      (typeof parentId === 'string' && parentId.trim().length > 0) ||
      directParentByCascadeId.has(cascadeId)
    ) {
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

    const battleModeInfo = isRecord(raw.battleModeInfo)
      ? raw.battleModeInfo
      : isRecord(raw.battle_mode_info)
        ? raw.battle_mode_info
        : null;
    const hasRunningBattleChildren =
      !killed && hasRunningBattleChildStatus(battleModeInfo);

    const ownSummaryBgCount = killed
      ? 0
      : parseNonNegativeInt(
          raw.backgroundTaskCount ?? raw.background_task_count,
        );
    const ownBgInfo = !killed ? bgTasksByCascadeId.get(cascadeId) : undefined;
    const ownActiveBgCount = killed
      ? 0
      : Math.max(
          ownBgInfo?.nonDaemonCount ?? 0,
          Math.max(0, ownSummaryBgCount - (ownBgInfo?.daemonCount ?? 0)),
        );
    const bubbledActiveBgCount =
      !killed && bubbled ? bubbled.activeBackgroundTaskCount : 0;
    const activeBackgroundTaskCount = ownActiveBgCount + bubbledActiveBgCount;
    const firstBackgroundTaskLabel =
      ownBgInfo?.firstNonDaemonLabel ??
      bubbled?.firstBackgroundTaskLabel ??
      null;

    const hasRunningSubagents =
      !killed &&
      (Boolean(raw.hasRunningSubagents) ||
        Boolean(raw.has_running_subagents) ||
        Boolean(raw.hasActiveChildren) ||
        Boolean(raw.has_active_children) ||
        Boolean(bubbled?.hasRunningChild) ||
        hasRunningBattleChildren);

    const isMainAgentActive = !killed && isRunningCascadeStatus(raw.status);
    const isNotFullyIdle =
      !killed && (Boolean(raw.notFullyIdle) || Boolean(raw.not_fully_idle));
    const hasRunningBackgroundTasks = !killed && activeBackgroundTaskCount > 0;

    const isRunning =
      !killed &&
      (isMainAgentActive ||
        isNotFullyIdle ||
        hasRunningSubagents ||
        hasRunningBackgroundTasks);

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
    const rawTerminationReason =
      raw.latestExecutorTerminationReason ??
      raw.latest_executor_termination_reason;
    const isUserCanceled =
      isUserCanceledTerminationReason(rawTerminationReason);
    const isInterrupted = Boolean(raw.interrupted) || isUserCanceled;
    const isUnread =
      !isLocallyCleared &&
      (!isInterrupted || isMarkedUnreadRemotely) &&
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

    const terminationFailure = getTerminationFailureReason(rawTerminationReason);
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
      if (isMainAgentActive && hasRunningSubagents) {
        attentionReason = 'Agent & subagents working…';
      } else if (isMainAgentActive && hasRunningBackgroundTasks) {
        attentionReason =
          activeBackgroundTaskCount === 1
            ? 'Agent working • 1 background task'
            : `Agent working • ${activeBackgroundTaskCount} background tasks`;
      } else if (
        !isMainAgentActive &&
        hasRunningSubagents &&
        hasRunningBackgroundTasks
      ) {
        attentionReason = 'Subagents & background tasks running…';
      } else if (!isMainAgentActive && hasRunningSubagents) {
        attentionReason = 'Subagents working…';
      } else if (!isMainAgentActive && hasRunningBackgroundTasks) {
        attentionReason =
          activeBackgroundTaskCount === 1 && firstBackgroundTaskLabel
            ? `Background task: ${truncateText(firstBackgroundTaskLabel, 64)}`
            : activeBackgroundTaskCount === 1
              ? '1 background task running…'
              : `${activeBackgroundTaskCount} background tasks running…`;
      } else if (
        !isMainAgentActive &&
        isNotFullyIdle &&
        isIdleCascadeStatus(raw.status)
      ) {
        attentionReason = 'Background task running…';
      } else {
        attentionReason = 'Agent is working…';
      }
    } else {
      attentionKind = 'idle';
      needsAttention = false;
      attentionReason = killed || isInterrupted ? 'Interrupted' : 'Idle';
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
    const rawProjectId =
      metadata?.projectId ??
      metadata?.project_id ??
      raw.projectId ??
      raw.project_id;
    const projectId =
      typeof rawProjectId === 'string' &&
      rawProjectId.trim().length > 0 &&
      rawProjectId.trim() !== 'outside-of-project' &&
      SAFE_ID_PATTERN.test(rawProjectId.trim())
        ? rawProjectId.trim()
        : null;
    const workspaceUris = extractWorkspaceUris(raw);

    items.push({
      id: compositeId,
      cascadeId,
      trajectoryId,
      title,
      projectId,
      workspaceName: extractWorkspaceName(raw),
      workspaceUri: workspaceUris[0] ?? null,
      ...(workspaceUris.length > 0 ? { workspaceUris } : {}),
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
      backgroundTaskCount: activeBackgroundTaskCount,
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
      workspaceUri: null,
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
      backgroundTaskCount: bubbled.activeBackgroundTaskCount,
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
    if (isHiddenCredit(entry.id) || isHiddenCredit(entry.label)) return;
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
      if (isHiddenCredit(rawType)) continue;
      const label = humanizeCreditLabel(rawType);
      if (isHiddenCredit(label)) continue;
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

  // Combine separate thinking/effort-level entries for the same model into one row.
  const combinedModels = combineModelThinkingLevels(models);

  const error =
    typeof rawUsage.error === 'string' && rawUsage.error.trim()
      ? truncateText(rawUsage.error.trim(), 160)
      : null;

  if (
    groups.length === 0 &&
    combinedModels.length === 0 &&
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
  for (const m of combinedModels) {
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
    models: combinedModels,
    lowestRemainingFraction,
    error,
  };
}

/**
 * Combines separate thinking/effort-level entries for the same base model
 * (e.g. `Gemini 4 Neon (Low)`, `(Medium)`, `(High)`, `(Extra)`) into a single
 * consolidated quota row while preserving Antigravity's model order.
 */
export function combineModelThinkingLevels(
  rawModels: readonly UsageModelQuota[],
): UsageModelQuota[] {
  if (rawModels.length <= 1) {
    return [...rawModels];
  }

  const exactLowerLabels = new Set(
    rawModels.map((m) => m.label.trim().toLowerCase()),
  );

  const getThinkingBase = (
    label: string,
  ): { base: string; stripped: boolean } => {
    const levelMatch = MODEL_THINKING_LEVEL_PATTERN.exec(label);
    if (levelMatch && levelMatch[1].trim()) {
      return { base: levelMatch[1].trim(), stripped: true };
    }
    const thinkingTagMatch = MODEL_THINKING_TAG_PATTERN.exec(label);
    if (
      thinkingTagMatch &&
      thinkingTagMatch[1].trim() &&
      exactLowerLabels.has(thinkingTagMatch[1].trim().toLowerCase())
    ) {
      return { base: thinkingTagMatch[1].trim(), stripped: true };
    }
    return { base: label.trim(), stripped: false };
  };

  const groupCounts = new Map<string, number>();
  const parsed = rawModels.map((model) => {
    const info = getThinkingBase(model.label);
    const key = info.base.toLowerCase();
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    return { model, base: info.base, key, stripped: info.stripped };
  });

  const mergedByKey = new Map<string, UsageModelQuota>();
  const result: UsageModelQuota[] = [];

  for (const entry of parsed) {
    const count = groupCounts.get(entry.key) ?? 1;
    if (count < 2) {
      result.push(entry.model);
      continue;
    }

    const existing = mergedByKey.get(entry.key);
    if (!existing) {
      const consolidated: UsageModelQuota = {
        ...entry.model,
        label: entry.base,
      };
      mergedByKey.set(entry.key, consolidated);
      result.push(consolidated);
      continue;
    }

    const nextFraction = Math.min(
      existing.remainingFraction,
      entry.model.remainingFraction,
    );
    const nextResetMs =
      existing.resetTimeMs > 0 && entry.model.resetTimeMs > 0
        ? Math.min(existing.resetTimeMs, entry.model.resetTimeMs)
        : existing.resetTimeMs || entry.model.resetTimeMs;

    existing.remainingFraction = nextFraction;
    existing.remainingPercent = fractionToPercent(nextFraction);
    existing.resetTimeMs = nextResetMs;
    existing.isExhausted = nextFraction <= 0;
    existing.isDefault = existing.isDefault || entry.model.isDefault;
    existing.isRecommended =
      existing.isRecommended || entry.model.isRecommended;
    existing.supportsImages =
      existing.supportsImages || entry.model.supportsImages;
  }

  return result;
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

function extractProjectWorkspaceUris(rawProject: Record<string, unknown>): string[] {
  const uris: string[] = [];
  const seen = new Set<string>();
  const addUri = (candidate: unknown) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const cleaned = candidate.trim().replace(/\/+$/, '').slice(0, 512);
    const key = normalizeWorkspaceUriKey(cleaned);
    if (!key || seen.has(key)) return;
    seen.add(key);
    uris.push(cleaned);
  };

  const addResourceList = (rawResList: unknown[]) => {
    for (const res of rawResList) {
      if (!isRecord(res)) continue;
      addUri(res.folderUri ?? res.folder_uri);
      const gitFolder = isRecord(res.gitFolder)
        ? res.gitFolder
        : isRecord(res.git_folder)
          ? res.git_folder
          : null;
      if (gitFolder) {
        addUri(gitFolder.folderUri ?? gitFolder.folder_uri ?? gitFolder.uri);
      }
      if (isRecord(res.google3)) {
        addUri('file:///google/src/files/head/depot');
      }
      addUri(res.workspaceUri ?? res.workspace_uri ?? res.uri);
    }
  };

  const projectResources = isRecord(rawProject.projectResources)
    ? rawProject.projectResources
    : isRecord(rawProject.project_resources)
      ? rawProject.project_resources
      : null;
  const rawResList = Array.isArray(projectResources?.resources)
    ? projectResources.resources
    : Array.isArray(rawProject.resources)
      ? rawProject.resources
      : [];
  addResourceList(rawResList);

  const environmentsContainer = isRecord(rawProject.environments)
    ? rawProject.environments
    : null;
  const rawEnvList = Array.isArray(environmentsContainer?.environments)
    ? environmentsContainer.environments
    : Array.isArray(rawProject.environments)
      ? rawProject.environments
      : [];
  for (const env of rawEnvList) {
    if (!isRecord(env)) continue;
    const envResContainer = isRecord(env.resources) ? env.resources : null;
    if (Array.isArray(envResContainer?.resources)) {
      addResourceList(envResContainer.resources);
    } else if (Array.isArray(env.resources)) {
      addResourceList(env.resources);
    }
    if (Array.isArray(env.workspaceUris ?? env.workspace_uris)) {
      const envUris = (env.workspaceUris ?? env.workspace_uris) as unknown[];
      for (const u of envUris) addUri(u);
    }
    addUri(env.folderUri ?? env.folder_uri ?? env.workspaceUri ?? env.workspace_uri);
  }

  if (Array.isArray(rawProject.workspaces)) {
    for (const ws of rawProject.workspaces) {
      if (typeof ws === 'string') {
        addUri(ws);
      } else if (isRecord(ws)) {
        addUri(ws.workspaceFolderAbsoluteUri ?? ws.workspace_folder_absolute_uri);
        addUri(ws.gitRootAbsoluteUri ?? ws.git_root_absolute_uri);
        addUri(ws.workspaceUri ?? ws.workspace_uri ?? ws.folderUri ?? ws.folder_uri ?? ws.uri);
      }
    }
  }

  addUri(rawProject.workspaceUri ?? rawProject.workspace_uri);
  addUri(rawProject.folderUri ?? rawProject.folder_uri);
  return uris;
}

function extractProjectConversationIds(rawProject: Record<string, unknown>): string[] {
  const container = isRecord(rawProject.projectConversations)
    ? rawProject.projectConversations
    : isRecord(rawProject.project_conversations)
      ? rawProject.project_conversations
      : null;
  const rawList = Array.isArray(container?.conversations)
    ? container.conversations
    : Array.isArray(rawProject.conversations)
      ? rawProject.conversations
      : [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawList) {
    const rawId =
      typeof entry === 'string'
        ? entry
        : isRecord(entry)
          ? (entry.conversationId ?? entry.conversation_id ?? entry.cascadeId ?? entry.cascade_id)
          : null;
    if (typeof rawId === 'string' && SAFE_ID_PATTERN.test(rawId) && !seen.has(rawId)) {
      seen.add(rawId);
      ids.push(rawId);
    }
  }
  return ids;
}

function parseServerProjectsForInstance(params: {
  instanceUuid: string;
  instanceName: string;
  rawProjects: readonly Record<string, unknown>[] | null | undefined;
  rawWorkspaceInfos: readonly Record<string, unknown>[] | null | undefined;
}): InboxServerProject[] {
  const { instanceUuid, instanceName, rawProjects, rawWorkspaceInfos } = params;
  const parsed: InboxServerProject[] = [];
  const seenProjectIds = new Set<string>();
  const coveredWorkspaceUriKeys = new Set<string>();

  if (Array.isArray(rawProjects)) {
    for (const rawProj of rawProjects.slice(0, MAX_PROJECTS_PER_INSTANCE)) {
      if (!isRecord(rawProj)) continue;
      const rawId = rawProj.id ?? rawProj.projectId ?? rawProj.project_id;
      const projectId =
        typeof rawId === 'string' && rawId.trim() && SAFE_ID_PATTERN.test(rawId.trim())
          ? rawId.trim()
          : null;
      if (!projectId || seenProjectIds.has(projectId)) continue;
      if (projectId === 'outside-of-project') continue;
      seenProjectIds.add(projectId);

      const archived = Boolean(rawProj.archived);
      const workspaceUris = extractProjectWorkspaceUris(rawProj);
      for (const uri of workspaceUris) {
        const key = normalizeWorkspaceUriKey(uri);
        if (key) coveredWorkspaceUriKeys.add(key);
      }

      const rawName = rawProj.name ?? rawProj.title ?? rawProj.displayName ?? rawProj.display_name;
      const fallbackName =
        extractLastSegmentFromUri(workspaceUris[0]) ??
        `Project ${projectId.slice(0, 8)}`;
      const name =
        typeof rawName === 'string' && rawName.trim()
          ? truncateText(rawName.trim(), 72)
          : truncateText(fallbackName, 72);

      const updatedAtMs = parseProtoTimestampMs(
        rawProj.updatedAt ?? rawProj.updated_at ?? rawProj.updateTimeMicros,
      );

      parsed.push({
        id: `${instanceUuid}:project:${projectId}`,
        projectId,
        name,
        workspaceUri: workspaceUris[0] ?? null,
        workspaceUris,
        instanceUuid,
        instanceName,
        updatedAtMs,
        archived,
        conversationIds: extractProjectConversationIds(rawProj),
      });
    }
  }

  if (Array.isArray(rawWorkspaceInfos)) {
    for (const rawWs of rawWorkspaceInfos.slice(0, MAX_PROJECTS_PER_INSTANCE)) {
      if (!isRecord(rawWs)) continue;
      const candidateUris: string[] = [];
      const candidateKeys: string[] = [];
      const addWsCandidate = (rawVal: unknown) => {
        if (typeof rawVal !== 'string' || !rawVal.trim()) return;
        const cleaned = rawVal.trim().replace(/\/+$/, '').slice(0, 512);
        const key = normalizeWorkspaceUriKey(cleaned);
        if (!key || candidateKeys.includes(key)) return;
        candidateKeys.push(key);
        candidateUris.push(cleaned);
      };
      addWsCandidate(rawWs.workspaceUri ?? rawWs.workspace_uri);
      addWsCandidate(
        rawWs.workspaceFolderAbsoluteUri ?? rawWs.workspace_folder_absolute_uri,
      );
      addWsCandidate(
        rawWs.gitRootUri ??
          rawWs.git_root_uri ??
          rawWs.gitRootAbsoluteUri ??
          rawWs.git_root_absolute_uri,
      );
      if (candidateUris.length === 0) continue;
      if (candidateKeys.some((key) => coveredWorkspaceUriKeys.has(key))) continue;
      for (const key of candidateKeys) {
        coveredWorkspaceUriKeys.add(key);
      }

      const primaryUri = candidateUris[0];
      const primaryKey = candidateKeys[0];
      const folderName = extractLastSegmentFromUri(primaryUri);
      if (!folderName) continue;

      parsed.push({
        id: `${instanceUuid}:ws:${primaryKey}`,
        projectId: null,
        name: truncateText(folderName, 72),
        workspaceUri: primaryUri,
        workspaceUris: candidateUris,
        instanceUuid,
        instanceName,
        updatedAtMs: 0,
        archived: false,
        conversationIds: [],
      });
    }
  }

  return parsed;
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
  const allProjects: InboxServerProject[] = [];
  const subagentParentByKey: Record<string, string> = {};
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
    const homeDirUri =
      typeof rawInst.homeDirUri === 'string' && rawInst.homeDirUri.trim()
        ? rawInst.homeDirUri.trim().replace(/\/+$/, '').slice(0, 512)
        : undefined;

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
      homeDirUri,
    });

    if (
      (Array.isArray(rawInst.projects) && rawInst.projects.length > 0) ||
      (Array.isArray(rawInst.workspaceInfos) && rawInst.workspaceInfos.length > 0)
    ) {
      allProjects.push(
        ...parseServerProjectsForInstance({
          instanceUuid: uuid,
          instanceName: name,
          rawProjects: rawInst.projects,
          rawWorkspaceInfos: rawInst.workspaceInfos,
        }),
      );
    }

    if (rawInst.trajectories && isRecord(rawInst.trajectories)) {
      allThreads.push(
        ...parseTrajectoriesForSource({
          source: 'remote-control',
          instanceUuid: uuid,
          instanceName: name,
          rawTrajectories: rawInst.trajectories,
          rawBackgroundTasks: rawInst.backgroundTasks,
          activeInstanceUuid,
          activeCascadeId,
          accountPrefix,
          preservedQueryParams,
          locallyReadAtByThreadId,
          completedUnreadAtByThreadId,
          isAppForeground,
          isDrawerOpen,
          subagentParentByKey,
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
        subagentParentByKey,
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

  const hasSubagentParents = Object.keys(subagentParentByKey).length > 0;

  return {
    instances,
    threads: allThreads,
    projects: allProjects,
    ...(hasSubagentParents ? { subagentParentByKey } : {}),
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
 * Groups all server projects, snapshot threads, and connected workstations into
 * collapsible project groups for the drawer's `Projects` navigation tab.
 *
 * Always includes every non-archived project reported by connected servers
 * (`ListProjects`/`ReadProjects` & `GetWorkspaceInfos`), even when a project
 * currently has zero threads or no recent activity.
 */
export function buildProjectGroups(
  snapshot: InboxSnapshot,
  activeUrl?: string | null,
): InboxProjectGroup[] {
  const referenceUrl = activeUrl ?? snapshot.threads[0]?.targetUrl ?? null;
  const accountPrefix = extractAccountPathPrefix(referenceUrl);
  const preservedQueryParams = extractPreservedHostQueryParams(referenceUrl);

  const buildOverviewUrl = (
    source: 'remote-control' | 'cloud',
    instanceUuid: string,
  ): string => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(preservedQueryParams)) {
      query.set(key, value);
    }
    const querySuffix = query.toString() ? `?${query.toString()}` : '';
    const candidateUrl =
      source === 'cloud'
        ? `${ANTIGRAVITY_DASHBOARD_URL}${accountPrefix}/${querySuffix}`
        : `${ANTIGRAVITY_DASHBOARD_URL}${accountPrefix}/r/${encodeURIComponent(instanceUuid)}${querySuffix}`;
    const validation = validateNavigationUrl(candidateUrl);
    if (
      validation.isValid &&
      validation.isAllowedInApp &&
      validation.normalizedUrl
    ) {
      return validation.normalizedUrl;
    }
    return source === 'cloud'
      ? `${ANTIGRAVITY_DASHBOARD_URL}${accountPrefix}/`
      : `${ANTIGRAVITY_DASHBOARD_URL}${accountPrefix}/r/${encodeURIComponent(instanceUuid)}`;
  };

  const groupsByKey = new Map<string, InboxProjectGroup>();
  const groupByProjectId = new Map<string, InboxProjectGroup>();
  const groupByConversationId = new Map<string, InboxProjectGroup>();
  const groupByWorkspaceUri = new Map<string, InboxProjectGroup>();
  const serverUriEntriesByInstance = new Map<
    string,
    Array<{ uriKey: string; group: InboxProjectGroup }>
  >();
  const groupsByWorkspaceName = new Map<string, InboxProjectGroup[]>();
  const groupsByWorkspaceSlug = new Map<string, InboxProjectGroup[]>();
  const instancesWithProjectsOrThreads = new Set<string>();

  const indexProjectName = (
    instanceUuid: string,
    rawName: string | null | undefined,
    group: InboxProjectGroup,
  ) => {
    if (!rawName || !rawName.trim()) return;
    const key = `${instanceUuid}:${rawName.trim().toLowerCase()}`;
    const list = groupsByWorkspaceName.get(key) ?? [];
    if (!list.includes(group)) {
      list.push(group);
      groupsByWorkspaceName.set(key, list);
    }
    const slug = normalizeProjectSlugKey(rawName);
    if (slug) {
      const slugKey = `${instanceUuid}:${slug}`;
      const slugList = groupsByWorkspaceSlug.get(slugKey) ?? [];
      if (!slugList.includes(group)) {
        slugList.push(group);
        groupsByWorkspaceSlug.set(slugKey, slugList);
      }
    }
  };

  const findDeepestAncestorProjectGroup = (
    instanceUuid: string,
    threadUriKeys: readonly string[],
  ): InboxProjectGroup | undefined => {
    const entries = serverUriEntriesByInstance.get(instanceUuid);
    if (!entries || entries.length === 0 || threadUriKeys.length === 0) {
      return undefined;
    }
    let bestLength = 0;
    let bestGroups: InboxProjectGroup[] = [];
    for (const threadKey of threadUriKeys) {
      if (!threadKey.startsWith('/')) continue;
      for (const entry of entries) {
        if (
          !entry.uriKey.startsWith('/') ||
          getCanonicalPathSegmentCount(entry.uriKey) < 2
        ) {
          continue;
        }
        if (
          threadKey.length > entry.uriKey.length &&
          threadKey.startsWith(`${entry.uriKey}/`)
        ) {
          if (entry.uriKey.length > bestLength) {
            bestLength = entry.uriKey.length;
            bestGroups = [entry.group];
          } else if (
            entry.uriKey.length === bestLength &&
            !bestGroups.includes(entry.group)
          ) {
            bestGroups.push(entry.group);
          }
        }
      }
    }
    return bestGroups.length === 1 ? bestGroups[0] : undefined;
  };

  // 1. Seed all non-archived server projects FIRST so projects with zero recent
  //    activity are always listed in the Projects tab.
  const serverProjects = snapshot.projects ?? [];
  for (const proj of serverProjects) {
    if (proj.archived) {
      continue;
    }
    instancesWithProjectsOrThreads.add(proj.instanceUuid);
    const workspaceName =
      extractLastSegmentFromUri(proj.workspaceUri) ?? proj.name;
    const group: InboxProjectGroup = {
      id: proj.id,
      projectId: proj.projectId,
      name: proj.name,
      workspaceName,
      workspaceUri: proj.workspaceUri,
      instanceUuid: proj.instanceUuid,
      instanceName: proj.instanceName,
      source: 'remote-control',
      threads: [],
      latestModifiedAtMs: proj.updatedAtMs,
      attentionCount: 0,
      urgentCount: 0,
      runningCount: 0,
      hasActiveThread: false,
      newChatUrl: buildOverviewUrl('remote-control', proj.instanceUuid),
    };
    groupsByKey.set(group.id, group);
    if (proj.projectId) {
      groupByProjectId.set(`${proj.instanceUuid}:${proj.projectId}`, group);
    }
    for (const cid of proj.conversationIds) {
      groupByConversationId.set(`${proj.instanceUuid}:${cid}`, group);
    }
    const instUriEntries =
      serverUriEntriesByInstance.get(proj.instanceUuid) ?? [];
    for (const uri of proj.workspaceUris) {
      const uriKey = normalizeWorkspaceUriKey(uri);
      if (uriKey) {
        groupByWorkspaceUri.set(`${proj.instanceUuid}:${uriKey}`, group);
        instUriEntries.push({ uriKey, group });
      }
      indexProjectName(proj.instanceUuid, extractLastSegmentFromUri(uri), group);
    }
    if (instUriEntries.length > 0) {
      serverUriEntriesByInstance.set(proj.instanceUuid, instUriEntries);
    }
    indexProjectName(proj.instanceUuid, proj.name, group);
  }

  // 2. Attach all snapshot threads to their matching server project (or create a
  //    workspace-derived group for standalone / legacy / cloud threads).
  for (const thread of snapshot.threads) {
    instancesWithProjectsOrThreads.add(thread.instanceUuid);

    const threadUriKeys: string[] = [];
    const candidateThreadUris =
      thread.workspaceUris && thread.workspaceUris.length > 0
        ? thread.workspaceUris
        : thread.workspaceUri
          ? [thread.workspaceUri]
          : [];
    for (const rawUri of candidateThreadUris) {
      const key = normalizeWorkspaceUriKey(rawUri);
      if (key && !threadUriKeys.includes(key)) {
        threadUriKeys.push(key);
      }
    }

    let group: InboxProjectGroup | undefined;
    if (thread.projectId) {
      group = groupByProjectId.get(`${thread.instanceUuid}:${thread.projectId}`);
    }
    if (!group) {
      group =
        groupByConversationId.get(`${thread.instanceUuid}:${thread.cascadeId}`) ??
        groupByConversationId.get(
          `${thread.instanceUuid}:${thread.trajectoryId}`,
        );
    }
    if (!group && threadUriKeys.length > 0) {
      for (const uriKey of threadUriKeys) {
        const exactMatch = groupByWorkspaceUri.get(
          `${thread.instanceUuid}:${uriKey}`,
        );
        if (exactMatch) {
          group = exactMatch;
          break;
        }
      }
    }
    if (!group && threadUriKeys.length > 0) {
      group = findDeepestAncestorProjectGroup(
        thread.instanceUuid,
        threadUriKeys,
      );
    }
    if (!group) {
      const candidateNames: string[] = [];
      if (thread.workspaceName && thread.workspaceName.trim()) {
        candidateNames.push(thread.workspaceName.trim());
      }
      for (const rawUri of candidateThreadUris) {
        const seg = extractLastSegmentFromUri(rawUri);
        if (seg && !candidateNames.includes(seg)) {
          candidateNames.push(seg);
        }
      }
      for (const candName of candidateNames) {
        const nameCandidates = groupsByWorkspaceName.get(
          `${thread.instanceUuid}:${candName.toLowerCase()}`,
        );
        if (nameCandidates && nameCandidates.length === 1) {
          group = nameCandidates[0];
          break;
        }
      }
      if (!group) {
        for (const candName of candidateNames) {
          const slug = normalizeProjectSlugKey(candName);
          if (!slug) continue;
          const slugCandidates = groupsByWorkspaceSlug.get(
            `${thread.instanceUuid}:${slug}`,
          );
          if (slugCandidates && slugCandidates.length === 1) {
            group = slugCandidates[0];
            break;
          }
        }
      }
    }

    if (!group) {
      const workspaceKey = (
        thread.projectId ??
        thread.workspaceName ??
        thread.workspaceUri ??
        '__default__'
      )
        .trim()
        .toLowerCase();
      const groupKey = `${thread.instanceUuid}:${workspaceKey}`;

      group = groupsByKey.get(groupKey);
      if (!group) {
        const displayName =
          thread.workspaceName ??
          (thread.source === 'cloud' ? 'Cloud Agent' : thread.instanceName);
        group = {
          id: groupKey,
          projectId: thread.projectId ?? null,
          name: displayName,
          workspaceName: thread.workspaceName,
          workspaceUri: thread.workspaceUri ?? null,
          instanceUuid: thread.instanceUuid,
          instanceName: thread.instanceName,
          source: thread.source,
          threads: [],
          latestModifiedAtMs: 0,
          attentionCount: 0,
          urgentCount: 0,
          runningCount: 0,
          hasActiveThread: false,
          newChatUrl: buildOverviewUrl(thread.source, thread.instanceUuid),
        };
        groupsByKey.set(groupKey, group);
        if (thread.projectId) {
          groupByProjectId.set(`${thread.instanceUuid}:${thread.projectId}`, group);
        }
        const uriKey = normalizeWorkspaceUriKey(thread.workspaceUri);
        if (uriKey) {
          groupByWorkspaceUri.set(`${thread.instanceUuid}:${uriKey}`, group);
        }
        indexProjectName(thread.instanceUuid, thread.workspaceName, group);
      }
    }

    if (!group.workspaceUri && thread.workspaceUri) {
      group.workspaceUri = thread.workspaceUri;
    }
    if (!group.projectId && thread.projectId) {
      group.projectId = thread.projectId;
    }

    group.threads.push(thread);
    if (thread.lastModifiedAtMs > group.latestModifiedAtMs) {
      group.latestModifiedAtMs = thread.lastModifiedAtMs;
    }
    if (thread.needsAttention) {
      group.attentionCount++;
    }
    if (
      thread.attentionKind === 'approval' ||
      thread.attentionKind === 'error'
    ) {
      group.urgentCount++;
    }
    if (thread.attentionKind === 'running') {
      group.runningCount++;
    }
    if (thread.isActiveThread) {
      group.hasActiveThread = true;
    }
  }

  // 3. Fallback workstation entry only when a connected workstation reported no
  //    server projects AND no threads.
  for (const inst of snapshot.instances) {
    if (instancesWithProjectsOrThreads.has(inst.uuid)) {
      continue;
    }
    if (
      inst.status !== 'connected' &&
      inst.uuid !== snapshot.activeInstanceUuid
    ) {
      continue;
    }
    const groupKey = `${inst.uuid}:__default__`;
    groupsByKey.set(groupKey, {
      id: groupKey,
      projectId: null,
      name: inst.name,
      workspaceName: null,
      workspaceUri: null,
      instanceUuid: inst.uuid,
      instanceName: inst.name,
      source: 'remote-control',
      threads: [],
      latestModifiedAtMs: inst.updatedAtMs ?? 0,
      attentionCount: 0,
      urgentCount: 0,
      runningCount: 0,
      hasActiveThread: snapshot.activeInstanceUuid === inst.uuid,
      newChatUrl: buildOverviewUrl('remote-control', inst.uuid),
    });
  }

  const groups = Array.from(groupsByKey.values());
  for (const group of groups) {
    group.threads.sort((a, b) => {
      if (a.isActiveThread !== b.isActiveThread) {
        return a.isActiveThread ? -1 : 1;
      }
      const priorityDiff =
        ATTENTION_PRIORITY[a.attentionKind] -
        ATTENTION_PRIORITY[b.attentionKind];
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      if (a.isPinned !== b.isPinned) {
        return a.isPinned ? -1 : 1;
      }
      if (b.lastModifiedAtMs !== a.lastModifiedAtMs) {
        return b.lastModifiedAtMs - a.lastModifiedAtMs;
      }
      return a.title.localeCompare(b.title);
    });
  }

  groups.sort((a, b) => {
    if (a.hasActiveThread !== b.hasActiveThread) {
      return a.hasActiveThread ? -1 : 1;
    }
    const aHasUrgent = a.urgentCount > 0;
    const bHasUrgent = b.urgentCount > 0;
    if (aHasUrgent !== bHasUrgent) {
      return aHasUrgent ? -1 : 1;
    }
    const aHasAttention = a.attentionCount > 0;
    const bHasAttention = b.attentionCount > 0;
    if (aHasAttention !== bHasAttention) {
      return aHasAttention ? -1 : 1;
    }
    const aHasRunning = a.runningCount > 0;
    const bHasRunning = b.runningCount > 0;
    if (aHasRunning !== bHasRunning) {
      return aHasRunning ? -1 : 1;
    }
    const aIsActiveInst = a.instanceUuid === snapshot.activeInstanceUuid;
    const bIsActiveInst = b.instanceUuid === snapshot.activeInstanceUuid;
    if (aIsActiveInst !== bIsActiveInst) {
      return aIsActiveInst ? -1 : 1;
    }
    if (b.latestModifiedAtMs !== a.latestModifiedAtMs) {
      return b.latestModifiedAtMs - a.latestModifiedAtMs;
    }
    return a.name.localeCompare(b.name);
  });

  return groups;
}

export interface PendingThreadProjectFallback {
  instanceUuid: string;
  cascadeId: string | null;
  projectId: string | null;
  projectName: string;
}

/**
 * Resolves the active thread's display project context for the thread header,
 * matching server projects (`ListProjects`/`ReadProjects` & `GetWorkspaceInfos`),
 * trajectory workspace metadata, parent threads for active subagents, URL
 * `?project=` params, and newly-created thread fallbacks.
 */
export function resolveActiveThreadProject(
  snapshot: InboxSnapshot,
  options?: {
    activeUrl?: string | null;
    fallbackProject?: PendingThreadProjectFallback | null;
  },
): ActiveThreadProjectContext | null {
  const activeInstanceUuid = snapshot.activeInstanceUuid;
  const activeCascadeId = snapshot.activeCascadeId;
  if (!activeInstanceUuid || !activeCascadeId) {
    return null;
  }

  const candidateIds: string[] = [activeCascadeId];
  const subagentParents = snapshot.subagentParentByKey;
  if (subagentParents) {
    const visited = new Set<string>([activeCascadeId]);
    let cursor = activeCascadeId;
    for (let depth = 0; depth < 6; depth++) {
      const parentId = subagentParents[`${activeInstanceUuid}:${cursor}`];
      if (!parentId || visited.has(parentId)) {
        break;
      }
      visited.add(parentId);
      candidateIds.push(parentId);
      cursor = parentId;
    }
  }

  let resolvedThread: InboxThreadItem | undefined;
  for (const cid of candidateIds) {
    resolvedThread = snapshot.threads.find(
      (t) =>
        t.instanceUuid === activeInstanceUuid &&
        (t.cascadeId === cid || t.trajectoryId === cid),
    );
    if (resolvedThread) {
      break;
    }
  }

  const lookupIds = new Set<string>(candidateIds);
  if (resolvedThread) {
    lookupIds.add(resolvedThread.cascadeId);
    lookupIds.add(resolvedThread.trajectoryId);
  }

  const instanceProjects = (snapshot.projects ?? []).filter(
    (proj) => proj.instanceUuid === activeInstanceUuid,
  );
  const nonArchivedProjects = instanceProjects.filter((proj) => !proj.archived);
  const archivedProjects = instanceProjects.filter((proj) => proj.archived);

  const matchProjectForThread = (
    projects: readonly InboxServerProject[],
  ): InboxServerProject | undefined => {
    if (projects.length === 0) {
      return undefined;
    }
    if (resolvedThread?.projectId) {
      const byProjectId = projects.find(
        (proj) => proj.projectId === resolvedThread.projectId,
      );
      if (byProjectId) {
        return byProjectId;
      }
    }
    const byConversationId = projects.find((proj) =>
      proj.conversationIds.some((cid) => lookupIds.has(cid)),
    );
    if (byConversationId) {
      return byConversationId;
    }
    const threadUriKeys: string[] = [];
    const candidateThreadUris =
      resolvedThread?.workspaceUris && resolvedThread.workspaceUris.length > 0
        ? resolvedThread.workspaceUris
        : resolvedThread?.workspaceUri
          ? [resolvedThread.workspaceUri]
          : [];
    for (const rawUri of candidateThreadUris) {
      const key = normalizeWorkspaceUriKey(rawUri);
      if (key && !threadUriKeys.includes(key)) {
        threadUriKeys.push(key);
      }
    }
    if (threadUriKeys.length > 0) {
      for (const targetUriKey of threadUriKeys) {
        const byWorkspaceUri = projects.find((proj) =>
          proj.workspaceUris.some(
            (uri) => normalizeWorkspaceUriKey(uri) === targetUriKey,
          ),
        );
        if (byWorkspaceUri) {
          return byWorkspaceUri;
        }
      }
      let bestLength = 0;
      let bestMatches: InboxServerProject[] = [];
      for (const targetUriKey of threadUriKeys) {
        if (!targetUriKey.startsWith('/')) continue;
        for (const proj of projects) {
          for (const uri of proj.workspaceUris) {
            const projKey = normalizeWorkspaceUriKey(uri);
            if (
              !projKey ||
              !projKey.startsWith('/') ||
              getCanonicalPathSegmentCount(projKey) < 2
            ) {
              continue;
            }
            if (
              targetUriKey.length > projKey.length &&
              targetUriKey.startsWith(`${projKey}/`)
            ) {
              if (projKey.length > bestLength) {
                bestLength = projKey.length;
                bestMatches = [proj];
              } else if (
                projKey.length === bestLength &&
                !bestMatches.includes(proj)
              ) {
                bestMatches.push(proj);
              }
            }
          }
        }
      }
      if (bestMatches.length === 1) {
        return bestMatches[0];
      }
    }
    const candidateNames: string[] = [];
    if (resolvedThread?.workspaceName && resolvedThread.workspaceName.trim()) {
      candidateNames.push(resolvedThread.workspaceName.trim());
    }
    for (const rawUri of candidateThreadUris) {
      const seg = extractLastSegmentFromUri(rawUri);
      if (seg && !candidateNames.includes(seg)) {
        candidateNames.push(seg);
      }
    }
    for (const candName of candidateNames) {
      const targetName = candName.toLowerCase();
      const nameMatches = projects.filter((proj) => {
        if (proj.name.trim().toLowerCase() === targetName) {
          return true;
        }
        return proj.workspaceUris.some((uri) => {
          const seg = extractLastSegmentFromUri(uri);
          return seg ? seg.trim().toLowerCase() === targetName : false;
        });
      });
      if (nameMatches.length === 1) {
        return nameMatches[0];
      }
    }
    for (const candName of candidateNames) {
      const targetSlug = normalizeProjectSlugKey(candName);
      if (!targetSlug) continue;
      const slugMatches = projects.filter((proj) => {
        if (normalizeProjectSlugKey(proj.name) === targetSlug) {
          return true;
        }
        return proj.workspaceUris.some((uri) => {
          const seg = extractLastSegmentFromUri(uri);
          return seg ? normalizeProjectSlugKey(seg) === targetSlug : false;
        });
      });
      if (slugMatches.length === 1) {
        return slugMatches[0];
      }
    }
    return undefined;
  };

  let matchedServerProject =
    matchProjectForThread(nonArchivedProjects) ??
    matchProjectForThread(archivedProjects);

  if (!matchedServerProject && options?.activeUrl) {
    const urlProjectId = extractProjectIdFromUrl(options.activeUrl);
    if (urlProjectId) {
      matchedServerProject =
        nonArchivedProjects.find((proj) => proj.projectId === urlProjectId) ??
        archivedProjects.find((proj) => proj.projectId === urlProjectId);
    }
  }

  const instanceName =
    resolvedThread?.instanceName ??
    snapshot.instances.find((inst) => inst.uuid === activeInstanceUuid)?.name ??
    (activeInstanceUuid === '__cloud__' ? 'Cloud Agent' : null);

  const rawFallback = options?.fallbackProject ?? null;
  const matchingFallback =
    rawFallback &&
    rawFallback.instanceUuid === activeInstanceUuid &&
    (rawFallback.cascadeId === null ||
      lookupIds.has(rawFallback.cascadeId)) &&
    rawFallback.projectName.trim().length > 0
      ? rawFallback
      : null;

  if (matchedServerProject) {
    return {
      instanceUuid: activeInstanceUuid,
      cascadeId: activeCascadeId,
      projectId: matchedServerProject.projectId,
      projectName: truncateText(matchedServerProject.name, 72),
      instanceName,
    };
  }

  if (resolvedThread) {
    const workspaceLabel =
      resolvedThread.workspaceName ??
      extractLastSegmentFromUri(resolvedThread.workspaceUri);
    if (workspaceLabel) {
      return {
        instanceUuid: activeInstanceUuid,
        cascadeId: activeCascadeId,
        projectId: resolvedThread.projectId ?? null,
        projectName: truncateText(workspaceLabel, 72),
        instanceName,
      };
    }
    if (matchingFallback) {
      return {
        instanceUuid: activeInstanceUuid,
        cascadeId: activeCascadeId,
        projectId: matchingFallback.projectId,
        projectName: truncateText(matchingFallback.projectName, 72),
        instanceName,
      };
    }
    const fallbackDisplay =
      resolvedThread.source === 'cloud'
        ? 'Cloud Agent'
        : resolvedThread.instanceName;
    if (fallbackDisplay && fallbackDisplay.trim()) {
      return {
        instanceUuid: activeInstanceUuid,
        cascadeId: activeCascadeId,
        projectId: resolvedThread.projectId ?? null,
        projectName: truncateText(fallbackDisplay, 72),
        instanceName,
      };
    }
  }

  if (matchingFallback) {
    return {
      instanceUuid: activeInstanceUuid,
      cascadeId: activeCascadeId,
      projectId: matchingFallback.projectId,
      projectName: truncateText(matchingFallback.projectName, 72),
      instanceName,
    };
  }

  return null;
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
        const projects = Array.isArray(item.projects)
          ? item.projects
              .slice(0, MAX_PROJECTS_PER_INSTANCE)
              .filter((p): p is Record<string, unknown> => isRecord(p))
          : null;
        const workspaceInfos = Array.isArray(item.workspaceInfos)
          ? item.workspaceInfos
              .slice(0, MAX_PROJECTS_PER_INSTANCE)
              .filter((w): w is Record<string, unknown> => isRecord(w))
          : null;
        const backgroundTasks = Array.isArray(item.backgroundTasks)
          ? item.backgroundTasks
              .slice(0, MAX_BACKGROUND_TASKS_PER_INSTANCE)
              .filter(
                (t): t is RawBridgeBackgroundTaskPayload => isRecord(t),
              )
          : null;
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
          homeDirUri:
            typeof item.homeDirUri === 'string' ? item.homeDirUri : null,
          trajectories: isRecord(item.trajectories) ? item.trajectories : null,
          backgroundTasks,
          projects,
          workspaceInfos,
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

    case 'AGY_INBOX_START_CHAT_RESULT':
      if (
        typeof parsed.requestId !== 'string' ||
        typeof parsed.handled !== 'boolean' ||
        typeof parsed.targetUrl !== 'string'
      ) {
        return null;
      }
      return {
        type: 'AGY_INBOX_START_CHAT_RESULT',
        requestId: parsed.requestId,
        handled: parsed.handled,
        cascadeId:
          typeof parsed.cascadeId === 'string' &&
          SAFE_ID_PATTERN.test(parsed.cascadeId)
            ? parsed.cascadeId
            : null,
        targetUrl: parsed.targetUrl,
      };

    case 'AGY_INBOX_HOST_SETTINGS_RESULT':
      if (typeof parsed.handled !== 'boolean') {
        return null;
      }
      return {
        type: 'AGY_INBOX_HOST_SETTINGS_RESULT',
        handled: parsed.handled,
      };

    case 'AGY_INBOX_LIST_DIR_RESULT': {
      if (
        typeof parsed.requestId !== 'string' ||
        typeof parsed.ok !== 'boolean'
      ) {
        return null;
      }
      const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
      const entries: DirectoryEntry[] = [];
      for (const entry of rawEntries.slice(0, MAX_DIR_ENTRIES)) {
        if (
          !isRecord(entry) ||
          typeof entry.name !== 'string' ||
          typeof entry.uri !== 'string'
        ) {
          continue;
        }
        const name = entry.name.trim();
        const uri = entry.uri.trim();
        if (name && uri) {
          entries.push({
            name: truncateText(name, 120),
            uri: uri.slice(0, 512),
          });
        }
      }
      return {
        type: 'AGY_INBOX_LIST_DIR_RESULT',
        requestId: parsed.requestId,
        ok: parsed.ok,
        currentUri:
          typeof parsed.currentUri === 'string'
            ? parsed.currentUri.trim().slice(0, 512)
            : '',
        parentUri:
          typeof parsed.parentUri === 'string' && parsed.parentUri.trim()
            ? parsed.parentUri.trim().slice(0, 512)
            : null,
        entries,
        error:
          typeof parsed.error === 'string' && parsed.error.trim()
            ? truncateText(parsed.error, 200)
            : null,
      };
    }

    case 'AGY_INBOX_CREATE_PROJECT_RESULT': {
      if (
        typeof parsed.requestId !== 'string' ||
        typeof parsed.ok !== 'boolean'
      ) {
        return null;
      }
      return {
        type: 'AGY_INBOX_CREATE_PROJECT_RESULT',
        requestId: parsed.requestId,
        ok: parsed.ok,
        projectId:
          typeof parsed.projectId === 'string' &&
          SAFE_ID_PATTERN.test(parsed.projectId)
            ? parsed.projectId
            : null,
        projectName:
          typeof parsed.projectName === 'string' && parsed.projectName.trim()
            ? truncateText(parsed.projectName, 80)
            : null,
        workspaceUri:
          typeof parsed.workspaceUri === 'string' && parsed.workspaceUri.trim()
            ? parsed.workspaceUri.trim().slice(0, 512)
            : null,
        error:
          typeof parsed.error === 'string' && parsed.error.trim()
            ? truncateText(parsed.error, 200)
            : null,
      };
    }

    case 'AGY_INBOX_OPEN_DRAWER_REQUEST': {
      const mode =
        parsed.mode === 'projects'
          ? 'projects'
          : parsed.mode === 'inbox'
            ? 'inbox'
            : undefined;
      return {
        type: 'AGY_INBOX_OPEN_DRAWER_REQUEST',
        mode,
      };
    }

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
