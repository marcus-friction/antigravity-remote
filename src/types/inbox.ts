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

export interface InboxSnapshot {
  instances: InboxInstanceSummary[];
  threads: InboxThreadItem[];
  fetchedAtMs: number;
  activeInstanceUuid: string | null;
  activeCascadeId: string | null;
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
    };
