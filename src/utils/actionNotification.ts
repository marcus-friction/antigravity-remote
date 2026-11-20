import { ACTION_INBOX_DEEP_LINK } from '../constants/config';
import { getAttentionVisuals } from '../constants/theme';
import {
  ActionNotificationThreadItem,
  NativeActionNotificationPayload,
} from '../services/webData';
import { InboxAttentionKind, InboxThreadItem } from '../types/inbox';
import { ActionNotificationMode, AuthFlowStage } from '../types/session';

const MAX_NOTIFICATION_CARDS = 4;

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

function getNotificationStatusEmoji(kind: InboxAttentionKind): string {
  switch (kind) {
    case 'approval':
      return '🟠';
    case 'error':
      return '🔴';
    case 'unread':
      return '🔵';
    case 'running':
      return '🟢';
    default:
      return '⚪';
  }
}

function buildThreadCardItem(
  thread: InboxThreadItem,
): ActionNotificationThreadItem {
  const visuals = getAttentionVisuals(thread.attentionKind);
  const subtitle = thread.workspaceName
    ? `${thread.instanceName} • ${thread.workspaceName}`
    : thread.instanceName;
  const deepLinkUrl =
    buildThreadNotificationDeepLink(thread.targetUrl) ?? ACTION_INBOX_DEEP_LINK;

  return {
    id: thread.id,
    title: thread.title,
    attentionKind: thread.attentionKind,
    statusLabel: visuals.label,
    attentionReason: thread.attentionReason,
    subtitle,
    deepLinkUrl,
  };
}

function formatFallbackCardBlock(item: ActionNotificationThreadItem): string {
  const badge = `${getNotificationStatusEmoji(item.attentionKind)} ${item.statusLabel}`;
  const meta = item.subtitle ? ` · ${item.subtitle}` : '';
  return `${badge}${meta}\n${item.title} — ${item.attentionReason}`;
}

/**
 * Computes the single OS notification payload for currently open actions:
 * - `count === 0` (or `mode === 'off'` / unauthenticated): clears the notification.
 * - `count === 1`: renders a single color-coded thread card and links directly to that thread.
 * - `count > 1`: renders a stacked deck of color-coded thread cards (each tappable directly
 *   to its thread on Android) and links the notification container to the Inbox.
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
    // Suppress the thread currently visible in the foreground WebView; while
    // backgrounded (`!isAppForeground`) or behind an open drawer, every matching thread counts.
    const isVisibleOnScreenNow =
      isAppForeground && !isDrawerOpen && thread.isActiveThread;
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
  const items = openThreads.slice(0, MAX_NOTIFICATION_CARDS).map(buildThreadCardItem);
  const itemsSig = items
    .map(
      (it) =>
        `${it.id}:${it.attentionKind}:${it.title}:${it.attentionReason}:${it.subtitle}:${it.deepLinkUrl}`,
    )
    .join(';');

  if (count === 1) {
    const single = openThreads[0];
    const card = items[0];
    const deepLinkUrl = card.deepLinkUrl;
    const title = single.instanceName
      ? `1 action open • ${single.instanceName}`
      : '1 action open';
    const body = `${single.title} — ${single.attentionReason}`;
    const expandedBody = formatFallbackCardBlock(card);
    const signature = `1|${deepLinkUrl}|${title}|${body}|${expandedBody}|${itemsSig}`;

    return {
      signature,
      notification: {
        title,
        body,
        expandedBody,
        count: 1,
        deepLinkUrl,
        shouldAlert,
        items,
      },
      openThreadIds,
    };
  }

  const deepLinkUrl = ACTION_INBOX_DEEP_LINK;
  const title = `${count} actions open`;
  const body = `${openThreads[0].title} (+${count - 1} more) • Tap to open Inbox`;
  const blocks = items.map(formatFallbackCardBlock);
  if (count > MAX_NOTIFICATION_CARDS) {
    blocks.push(`+${count - MAX_NOTIFICATION_CARDS} more in Thread Inbox`);
  }
  const expandedBody = blocks.join('\n\n');
  const signature = `${count}|${deepLinkUrl}|${title}|${body}|${expandedBody}|${itemsSig}`;

  return {
    signature,
    notification: {
      title,
      body,
      expandedBody,
      count,
      deepLinkUrl,
      shouldAlert,
      items,
    },
    openThreadIds,
  };
}
