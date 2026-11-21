export type InboxAttentionKind =
  | 'approval'
  | 'error'
  | 'unread'
  | 'running'
  | 'idle';

export type InboxFilterTab = 'attention' | 'running' | 'all';

export type InboxInstanceStatus =
  | 'connected'
  | 'disconnected'
  | 'idle'
  | 'unknown';

export interface InboxInstanceSummary {
  uuid: string;
  name: string;
  status: InboxInstanceStatus;
  version?: string;
  updatedAtMs?: number;
  homeDirUri?: string;
}

export interface InboxServerProject {
  /** Stable composite key (`<instanceUuid>:<projectId-or-workspaceKey>`). */
  id: string;
  /** Antigravity server Project UUID when returned by `ListProjects`/`ReadProjects`. */
  projectId: string | null;
  name: string;
  workspaceUri: string | null;
  workspaceUris: string[];
  instanceUuid: string;
  instanceName: string;
  updatedAtMs: number;
  archived: boolean;
  /** Conversation IDs explicitly associated with this project on the server. */
  conversationIds: string[];
}

export interface InboxThreadItem {
  /** Stable composite key (`<instanceUuid>:<cascadeId>`). */
  id: string;
  cascadeId: string;
  trajectoryId: string;
  title: string;
  projectId?: string | null;
  workspaceName: string | null;
  workspaceUri?: string | null;
  /** All distinct workspace / git-root URIs associated with this conversation (for project matching). */
  workspaceUris?: string[];
  instanceUuid: string;
  instanceName: string;
  source: 'remote-control' | 'cloud';
  /** Verified in-app `https://antigravity.google.com/...` deep link. */
  targetUrl: string;
  /** Child path inside the instance iframe (e.g. `c/<cascadeId>`). */
  childPath: string;
  attentionKind: InboxAttentionKind;
  needsAttention: boolean;
  attentionReason: string;
  stepCount: number;
  waitingStepCount: number;
  lastModifiedAtMs: number;
  lastUserViewAtMs: number;
  isActiveThread: boolean;
  isPinned: boolean;
  hasRunningSubagents: boolean;
  /** Number of active non-daemon background tasks running on this thread (or its subagents). */
  backgroundTaskCount?: number;
}

export interface InboxProjectGroup {
  /** Stable composite key (`<instanceUuid>:<projectId-or-workspaceKey>`). */
  id: string;
  /** Server-side Antigravity Project UUID when known (`ListProjects`/`ReadProjects` or trajectory metadata). */
  projectId: string | null;
  /** Primary display name (project name, workspace folder/repo name, or workstation name when unscoped). */
  name: string;
  workspaceName: string | null;
  workspaceUri: string | null;
  instanceUuid: string;
  instanceName: string;
  source: 'remote-control' | 'cloud';
  threads: InboxThreadItem[];
  latestModifiedAtMs: number;
  attentionCount: number;
  urgentCount: number;
  runningCount: number;
  hasActiveThread: boolean;
  /** Verified in-app URL to open the workstation overview / new chat for this project. */
  newChatUrl: string;
}

export interface DirectoryEntry {
  name: string;
  uri: string;
}

export interface DirectoryListingResult {
  ok: boolean;
  currentUri: string;
  parentUri: string | null;
  entries: DirectoryEntry[];
  error?: string | null;
}

export interface CreateProjectRequestParams {
  instanceUuid: string;
  mode: 'existing' | 'scratch';
  name: string;
  folderPathOrUri?: string | null;
}

export interface CreateProjectResult {
  ok: boolean;
  projectId?: string | null;
  projectName?: string | null;
  workspaceUri?: string | null;
  error?: string | null;
}

export interface UsageQuotaBucket {
  id: string;
  label: string;
  window?: string;
  remainingFraction: number;
  remainingPercent: number;
  resetTimeMs: number;
  isExhausted: boolean;
}

export interface UsageQuotaGroup {
  id: string;
  label: string;
  buckets: UsageQuotaBucket[];
}

export interface UsageModelQuota {
  id: string;
  label: string;
  modelId?: string;
  remainingFraction: number;
  remainingPercent: number;
  resetTimeMs: number;
  isExhausted: boolean;
  isRecommended: boolean;
  isDefault: boolean;
  supportsImages: boolean;
}

export interface UsageCreditBalance {
  id: string;
  label: string;
  available: number;
  limit?: number;
  minimumForUsage?: number;
}

export interface UsageStatsSnapshot {
  sourceInstanceUuid: string | null;
  sourceInstanceName: string | null;
  fetchedAtMs: number;
  planName: string | null;
  accountEmail: string | null;
  credits: UsageCreditBalance[];
  groups: UsageQuotaGroup[];
  models: UsageModelQuota[];
  lowestRemainingFraction: number | null;
  error: string | null;
}

export interface RawBridgeUsagePayload {
  instanceUuid?: string | null;
  instanceName?: string | null;
  fetchedAtMs?: number;
  quotaSummary?: Record<string, unknown> | null;
  userStatus?: Record<string, unknown> | null;
  commandModelConfigs?: Record<string, unknown> | null;
  error?: string | null;
}

export interface ActiveThreadProjectContext {
  instanceUuid: string;
  cascadeId: string;
  projectId: string | null;
  projectName: string;
  instanceName: string | null;
}

export interface InboxSnapshot {
  instances: InboxInstanceSummary[];
  threads: InboxThreadItem[];
  /** All projects/workspaces discovered from connected servers (including projects with no recent threads). */
  projects?: InboxServerProject[];
  /** Maps `<instanceUuid>:<subagentCascadeOrTrajectoryId>` to its parent `cascadeId`. */
  subagentParentByKey?: Record<string, string>;
  fetchedAtMs: number;
  activeInstanceUuid: string | null;
  activeCascadeId: string | null;
  usage?: UsageStatsSnapshot | null;
  error: string | null;
}

export interface RawBridgeBackgroundTaskSnapshot {
  taskId?: string;
  task_id?: string;
  toolName?: string;
  tool_name?: string;
  toolSummary?: string;
  tool_summary?: string;
  description?: string;
  isDaemon?: boolean;
  is_daemon?: boolean;
}

export interface RawBridgeBackgroundTaskPayload {
  conversationId?: string;
  conversation_id?: string;
  task?: RawBridgeBackgroundTaskSnapshot | null;
}

export interface RawBridgeInstancePayload {
  uuid: string;
  name?: string;
  status?: number | string;
  version?: string;
  updatedAtMs?: number;
  homeDirUri?: string | null;
  trajectories?: Record<string, unknown> | null;
  backgroundTasks?: RawBridgeBackgroundTaskPayload[] | null;
  projects?: Record<string, unknown>[] | null;
  workspaceInfos?: Record<string, unknown>[] | null;
  error?: string;
}

export type InboxBridgeMessage =
  | {
      type: 'AGY_INBOX_SNAPSHOT';
      fetchedAtMs: number;
      activeUrl?: string;
      activeInstanceUuid?: string | null;
      activeCascadeId?: string | null;
      instances: RawBridgeInstancePayload[];
      cloudTrajectories?: Record<string, unknown> | null;
      usage?: RawBridgeUsagePayload | null;
      error?: string | null;
    }
  | {
      type: 'AGY_INBOX_ACTIVE_ROUTE';
      activeUrl?: string;
      activeInstanceUuid?: string | null;
      activeCascadeId?: string | null;
    }
  | {
      type: 'AGY_INBOX_REALTIME_HINT';
      reason: 'notification' | 'badge' | 'port';
      cascadeId?: string | null;
      title?: string | null;
      body?: string | null;
    }
  | {
      type: 'AGY_INBOX_FAST_NAV_RESULT';
      requestId: string;
      handled: boolean;
      targetUrl: string;
    }
  | {
      type: 'AGY_INBOX_START_CHAT_RESULT';
      requestId: string;
      handled: boolean;
      cascadeId?: string | null;
      targetUrl: string;
    }
  | {
      type: 'AGY_INBOX_HOST_SETTINGS_RESULT';
      handled: boolean;
    }
  | {
      type: 'AGY_INBOX_LIST_DIR_RESULT';
      requestId: string;
      ok: boolean;
      currentUri: string;
      parentUri: string | null;
      entries: DirectoryEntry[];
      error?: string | null;
    }
  | {
      type: 'AGY_INBOX_CREATE_PROJECT_RESULT';
      requestId: string;
      ok: boolean;
      projectId?: string | null;
      projectName?: string | null;
      workspaceUri?: string | null;
      error?: string | null;
    }
  | {
      type: 'AGY_INBOX_OPEN_DRAWER_REQUEST';
      mode?: 'inbox' | 'projects';
    };
