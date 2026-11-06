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
}

export interface InboxThreadItem {
  /** Stable composite key (`<instanceUuid>:<cascadeId>`). */
  id: string;
  cascadeId: string;
  trajectoryId: string;
  title: string;
  workspaceName: string | null;
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

export interface InboxSnapshot {
  instances: InboxInstanceSummary[];
  threads: InboxThreadItem[];
  fetchedAtMs: number;
  activeInstanceUuid: string | null;
  activeCascadeId: string | null;
  usage?: UsageStatsSnapshot | null;
  error: string | null;
}

export interface RawBridgeInstancePayload {
  uuid: string;
  name?: string;
  status?: number | string;
  version?: string;
  updatedAtMs?: number;
  trajectories?: Record<string, unknown> | null;
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
      type: 'AGY_INBOX_HOST_SETTINGS_RESULT';
      handled: boolean;
    };
