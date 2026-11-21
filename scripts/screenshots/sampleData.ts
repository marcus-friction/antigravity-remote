import { InboxSnapshot, InboxThreadItem } from '../../src/types/inbox';

const now = Date.now();
const machines = [
  { uuid: 'mac-studio-demo', name: 'Mac Studio', status: 'connected' as const },
  { uuid: 'linux-devbox-demo', name: 'Linux Devbox', status: 'connected' as const },
  { uuid: 'gpu-workstation-demo', name: 'GPU Workstation', status: 'connected' as const },
];

function thread(
  cascadeId: string, title: string, projectName: string,
  attentionKind: InboxThreadItem['attentionKind'], attentionReason: string,
  machineIndex: number, minutesAgo: number,
): InboxThreadItem {
  const machine = machines[machineIndex];
  return {
    id: `${machine.uuid}:${cascadeId}`, cascadeId, trajectoryId: cascadeId,
    title, projectId: projectName, projectName, workspaceName: projectName,
    workspaceUri: `file:///home/demo/projects/${projectName}`,
    instanceUuid: machine.uuid, instanceName: machine.name, source: 'remote-control',
    targetUrl: `https://antigravity.google.com/r/${machine.uuid}?p=c%2F${cascadeId}`,
    childPath: `c/${cascadeId}`, attentionKind,
    needsAttention: ['approval', 'error', 'unread'].includes(attentionKind),
    attentionReason, stepCount: 12, waitingStepCount: attentionKind === 'approval' ? 1 : 0,
    lastModifiedAtMs: now - minutesAgo * 60_000, lastUserViewAtMs: now - 3_600_000,
    isActiveThread: cascadeId === 'workspace-search', isPinned: false,
    hasRunningSubagents: false, backgroundTaskCount: attentionKind === 'running' ? 1 : 0,
  };
}

export const sampleThreads = [
  thread('workspace-search', 'Add workspace search', 'web-dashboard', 'running', 'Running the final checks…', 0, 0),
  thread('schema-migration', 'Speed up the activity feed', 'backend-api', 'approval', 'Approve command: npx prisma migrate deploy', 0, 0),
  thread('tablet-sidebar', 'Add the tablet sidebar', 'antigravity-remote', 'unread', 'Agent finished — ready for review', 1, 2),
  thread('webhook-retries', 'Fix webhook retry handling', 'billing-worker', 'error', 'Integration test needs attention', 0, 5),
  thread('embedding-benchmark', 'Compare embedding performance', 'ml-pipeline', 'running', 'Running the benchmark suite…', 2, 1),
  thread('cache-checkpoint', 'Tune the cache checkpoint', 'backend-api', 'idle', 'All checks passed', 1, 18),
];

export const sampleSnapshot: InboxSnapshot = {
  instances: machines, threads: sampleThreads,
  projects: sampleThreads.map((item) => ({
    id: `${item.instanceUuid}:${item.projectId}`, projectId: item.projectId!,
    name: item.projectName!, workspaceUri: item.workspaceUri!, workspaceUris: [item.workspaceUri!],
    instanceUuid: item.instanceUuid, instanceName: item.instanceName,
    updatedAtMs: item.lastModifiedAtMs, archived: false, conversationIds: [item.cascadeId],
  })),
  fetchedAtMs: now, activeInstanceUuid: machines[0].uuid,
  activeCascadeId: 'workspace-search', error: null,
  usage: {
    sourceInstanceUuid: machines[0].uuid, sourceInstanceName: machines[0].name,
    fetchedAtMs: now, planName: 'Google AI Pro', accountEmail: 'alex@example.com',
    credits: [{ id: 'credits', label: 'AI credits', available: 840, limit: 1000 }],
    groups: [{ id: 'quota', label: 'Usage limits', buckets: [
      { id: 'five-hour', label: '5-hour pool', remainingFraction: 0.78, remainingPercent: 78, resetTimeMs: now + 2 * 3_600_000, isExhausted: false },
      { id: 'weekly', label: 'Weekly pool', remainingFraction: 0.64, remainingPercent: 64, resetTimeMs: now + 3 * 86_400_000, isExhausted: false },
    ] }],
    models: [
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon', remainingFraction: 0.84, remainingPercent: 84, resetTimeMs: now + 2 * 3_600_000, isExhausted: false, isRecommended: true, isDefault: true, supportsImages: true },
      { id: 'gemini-3-8-flash', label: 'Gemini 3.8 Flash', remainingFraction: 0.96, remainingPercent: 96, resetTimeMs: now + 3 * 3_600_000, isExhausted: false, isRecommended: false, isDefault: false, supportsImages: true },
      { id: 'claude-sonnet', label: 'Claude Sonnet 5.5', remainingFraction: 0.72, remainingPercent: 72, resetTimeMs: now + 3_600_000, isExhausted: false, isRecommended: false, isDefault: false, supportsImages: true },
    ],
    lowestRemainingFraction: 0.64, error: null,
  },
};
