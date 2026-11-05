import { ACTION_INBOX_DEEP_LINK } from '../constants/config';
import { NativeActionNotificationPayload } from '../services/webData';
import { InboxThreadItem } from '../types/inbox';
import { ActionNotificationMode, AuthFlowStage } from '../types/session';

export interface ActionNotificationSyncResult {
  /** Deterministic key for deduplicating redundant native notification updates. */
  signature: string;
  /** Non-null when an OS notification should be shown/updated; null when cleared. */
  notification: NativeActionNotificationPayload | null;
  /** Open action thread IDs (`<instanceUuid>:<cascadeId>`) for new-arrival alerting. */
  openThreadIds: Set<string>;
}

/**
 * Converts a verified `https://antigravity.google.com/...` thread target URL
 * into a custom-scheme deep link (`antigravity-remote://r/<machine>?p=c%2F<id>`).
 */
export function buildThreadNotificationDeepLink(
  targetUrl: string,
): string | null {
  if (!targetUrl || typeof targetUrl !== 'string') {
    return null;
  }
  try {
    const parsed = new URL(targetUrl.trim());
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.toLowerCase() !== 'antigravity.google.com' ||
      parsed.port ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    const remainder = `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(
      /^\/+/,
      '',
    );
    if (!remainder) {
      return null;
    }
    return `antigravity-remote://${remainder}`;
  } catch {
    return null;
  }
}

/**
 * Computes the single OS notification payload for currently open actions:
 * - `count === 0` (or `mode === 'off'` / unauthenticated): clears the notification.
 * - `count === 1`: displays the single action and links directly to that thread.
 * - `count > 1`: displays the open action count and links directly to the Inbox.
 *
 * Alerts (`shouldAlert: true`) only when at least one new open-action thread ID
 * arrives while the Inbox drawer is not already open on screen; count decrements
 * and text refreshes update silently in place (`shouldAlert: false`).
 */
export function buildActionNotificationSyncState(params: {
  stage: AuthFlowStage;
  mode: ActionNotificationMode;
  threads: readonly InboxThreadItem[];
  isAppForeground: boolean;
  isDrawerOpen: boolean;
  previousOpenThreadIds: ReadonlySet<string>;
}): ActionNotificationSyncResult {
  const {
    stage,
    mode,
    threads,
    isAppForeground,
    isDrawerOpen,
    previousOpenThreadIds,
  } = params;

  if (stage !== 'authenticated' || mode === 'off') {
    return {
      signature: 'none',
      notification: null,
      openThreadIds: new Set(),
    };
  }

  const matchingThreads = threads.filter((thread) =>
    mode === 'approvals'
      ? thread.attentionKind === 'approval'
      : thread.needsAttention,
  );
  // Track all matching thread IDs (including any thread currently visible on
  // screen) so switching apps while viewing an already-open prompt updates the
  // tray count silently instead of chiming as a newly arrived action.
  const openThreadIds = new Set(matchingThreads.map((t) => t.id));

  const openThreads = matchingThreads.filter((thread) => {
    // Suppress the thread currently open in the foreground WebView; while
    // backgrounded (`!isAppForeground`), every matching thread counts.
    const isVisibleOnScreenNow = isAppForeground && thread.isActiveThread;
    return !isVisibleOnScreenNow;
  });

  if (openThreads.length === 0) {
    return {
      signature: 'none',
      notification: null,
      openThreadIds,
    };
  }

  const count = openThreads.length;
  const hasNewThread = openThreads.some((t) => !previousOpenThreadIds.has(t.id));
  const shouldAlert = hasNewThread && !(isAppForeground && isDrawerOpen);

  if (count === 1) {
    const single = openThreads[0];
    const deepLinkUrl =
      buildThreadNotificationDeepLink(single.targetUrl) ??
      ACTION_INBOX_DEEP_LINK;
    const title = single.instanceName
      ? `1 action open • ${single.instanceName}`
      : '1 action open';
    const body = `${single.title} — ${single.attentionReason}`;
    const expandedBody = `${single.title}\n${single.attentionReason}`;
    const signature = `1|${deepLinkUrl}|${title}|${body}|${expandedBody}`;

    return {
      signature,
      notification: {
        title,
        body,
        expandedBody,
        count: 1,
        deepLinkUrl,
        shouldAlert,
      },
      openThreadIds,
    };
  }

  const deepLinkUrl = ACTION_INBOX_DEEP_LINK;
  const title = `${count} actions open`;
  const body = `${openThreads[0].title} (+${count - 1} more) • Tap to open Inbox`;
  const lines = openThreads
    .slice(0, 4)
    .map((thread) => `• ${thread.title} — ${thread.attentionReason}`);
  if (count > 4) {
    lines.push(`+${count - 4} more in Thread Inbox`);
  }
  const expandedBody = lines.join('\n');
  const signature = `${count}|${deepLinkUrl}|${title}|${body}|${expandedBody}`;

  return {
    signature,
    notification: {
      title,
      body,
      expandedBody,
      count,
      deepLinkUrl,
      shouldAlert,
    },
    openThreadIds,
  };
}
