import { InboxAttentionKind } from '../types/inbox';

/**
 * Antigravity 2.33.0 Onyx Dark Design System tokens.
 *
 * Derived from Antigravity's native Onyx dark theme (`--background`, `--sidebar`,
 * `--card`, `--card-border`, `--onyx-well`, `--onyx-key`, `--onyx-selected`,
 * `--primary`, `--foreground`, `--secondary-foreground`, `--muted-foreground`)
 * and `antigravity.google` palette variables (`#121317`, `#18191D`, `#212226`,
 * `#3279F9`, `#8AB4F8`).
 */
export const ANTIGRAVITY_THEME = {
  colors: {
    // Core layered surfaces (deep neutral onyx charcoal — zero harsh navy cast)
    canvas: '#0B0B0E',
    sidebar: '#111114',
    well: '#0D0D11',
    surface: '#16161B',
    surfaceRaised: '#1C1C22',
    surfaceSelected: '#1F2028',
    control: '#24252A',
    popover: '#18191E',
    scrim: 'rgba(0, 0, 0, 0.68)',

    // Crisp low-opacity luminance borders
    borderSubtle: 'rgba(255, 255, 255, 0.06)',
    border: 'rgba(255, 255, 255, 0.09)',
    borderStrong: 'rgba(255, 255, 255, 0.14)',
    borderHighlight: 'rgba(255, 255, 255, 0.2)',

    // Typography hierarchy
    textPrimary: '#F4F5F7',
    textSecondary: '#BCBDC6',
    textMuted: '#87888F',
    textPlaceholder: '#636470',

    // Antigravity primary blue accents
    primary: '#2F71E3',
    primaryBright: '#3279F9',
    primaryText: '#8AB4F8',
    primarySoft: 'rgba(47, 113, 227, 0.16)',
    primarySoftStrong: 'rgba(47, 113, 227, 0.24)',
    primaryBorder: 'rgba(138, 180, 248, 0.42)',
    primaryCardBg: '#151E30',

    // Semantic status colors (shared across Inbox, Projects, Handle, & Push Notifications)
    approval: '#F59E0B',
    approvalText: '#FDE68A',
    approvalSoft: 'rgba(245, 158, 11, 0.15)',
    approvalBorder: 'rgba(245, 158, 11, 0.42)',

    error: '#EF4444',
    errorMuted: '#DE5555',
    errorText: '#FECACA',
    errorSoft: 'rgba(222, 85, 85, 0.16)',
    errorBorder: 'rgba(239, 68, 68, 0.42)',
    errorBannerBg: '#231316',
    errorBannerBorder: 'rgba(239, 68, 68, 0.36)',

    unread: '#3279F9',
    unreadText: '#BFDBFE',
    unreadSoft: 'rgba(50, 121, 249, 0.18)',
    unreadBorder: 'rgba(138, 180, 248, 0.44)',

    running: '#34D399',
    runningSolid: '#10B981',
    runningText: '#A7F3D0',
    runningSoft: 'rgba(52, 211, 153, 0.14)',
    runningBorder: 'rgba(52, 211, 153, 0.36)',

    idle: '#52545E',
    idleText: '#87888F',
    idleSoft: 'rgba(255, 255, 255, 0.05)',
    idleBorder: 'rgba(255, 255, 255, 0.1)',

    white: '#FFFFFF',
  },
  radii: {
    xs: 5,
    sm: 8,
    md: 11,
    lg: 14,
    pill: 999,
  },
} as const;

export interface AttentionVisuals {
  label: string;
  textColor: string;
  bgColor: string;
  borderColor: string;
  accentColor: string;
}

export function getAttentionVisuals(kind: InboxAttentionKind): AttentionVisuals {
  const { colors } = ANTIGRAVITY_THEME;
  switch (kind) {
    case 'approval':
      return {
        label: 'NEEDS APPROVAL',
        textColor: colors.approvalText,
        bgColor: colors.approvalSoft,
        borderColor: colors.approvalBorder,
        accentColor: colors.approval,
      };
    case 'error':
      return {
        label: 'NEEDS REVIEW',
        textColor: colors.errorText,
        bgColor: colors.errorSoft,
        borderColor: colors.errorBorder,
        accentColor: colors.error,
      };
    case 'unread':
      return {
        label: 'FINISHED',
        textColor: colors.unreadText,
        bgColor: colors.unreadSoft,
        borderColor: colors.unreadBorder,
        accentColor: colors.unread,
      };
    case 'running':
      return {
        label: 'WORKING',
        textColor: colors.runningText,
        bgColor: colors.runningSoft,
        borderColor: colors.runningBorder,
        accentColor: colors.runningSolid,
      };
    case 'idle':
    default:
      return {
        label: 'IDLE',
        textColor: colors.idleText,
        bgColor: colors.idleSoft,
        borderColor: colors.idleBorder,
        accentColor: colors.idle,
      };
  }
}

export function getQuotaVisuals(
  remainingFraction: number,
  isExhausted: boolean,
): {
  barColor: string;
  textColor: string;
  badgeBgColor: string;
  badgeBorderColor: string;
} {
  const { colors } = ANTIGRAVITY_THEME;
  if (isExhausted || remainingFraction <= 0) {
    return {
      barColor: colors.error,
      textColor: colors.errorText,
      badgeBgColor: colors.errorSoft,
      badgeBorderColor: colors.errorBorder,
    };
  }
  if (remainingFraction <= 0.2) {
    return {
      barColor: colors.error,
      textColor: '#FCA5A5',
      badgeBgColor: 'rgba(239, 68, 68, 0.14)',
      badgeBorderColor: 'rgba(248, 113, 113, 0.38)',
    };
  }
  if (remainingFraction <= 0.5) {
    return {
      barColor: colors.approval,
      textColor: colors.approvalText,
      badgeBgColor: colors.approvalSoft,
      badgeBorderColor: colors.approvalBorder,
    };
  }
  return {
    barColor: colors.runningSolid,
    textColor: colors.runningText,
    badgeBgColor: colors.runningSoft,
    badgeBorderColor: colors.runningBorder,
  };
}
