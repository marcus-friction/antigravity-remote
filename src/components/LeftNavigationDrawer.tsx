import * as Linking from 'expo-linking';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Keyboard,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  ANTIGRAVITY_DASHBOARD_URL,
  DEFAULT_ACTION_NOTIFICATION_MODE,
  DEFAULT_KEEP_ALIVE_MINUTES,
  IOS_KEEP_ALIVE_ENABLED_MINUTES,
  KEEP_ALIVE_DURATION_OPTIONS,
  PRIVACY_POLICY_URL,
  SOURCE_REPO_URL,
} from '../constants/config';
import {
  ANTIGRAVITY_THEME,
  getAttentionVisuals,
  getQuotaVisuals,
} from '../constants/theme';
import {
  CreateProjectRequestParams,
  CreateProjectResult,
  DirectoryEntry,
  DirectoryListingResult,
  InboxFilterTab,
  InboxInstanceSummary,
  InboxProjectGroup,
  InboxSnapshot,
  InboxThreadItem,
} from '../types/inbox';
import {
  ActionNotificationMode,
  AuthFlowStage,
  KeepAliveMinutes,
} from '../types/session';
import {
  buildProjectGroups,
  extractAccountPathPrefix,
  formatRelativeTime,
  formatResetCountdown,
  resolveThreadProjectName,
} from '../utils/inboxParser';
import { computeDrawerWidth } from '../utils/layout';
import { parseHandoffInput } from '../utils/urlValidator';

export type DrawerMode = 'inbox' | 'projects' | 'usage' | 'settings';

/**
 * Shared handle line geometry so the closed pull-in handle and the inner-right
 * handle inside the open drawer match 1:1 in height, thickness, vertical
 * alignment, rounded caps, and color/glow, while leaving a back-gesture-safe
 * gap (`20dp` touch start, `22dp` visual bar) from the physical left bezel.
 */
export const HANDLE_LINE_WIDTH = 4;
export const HANDLE_LINE_HEIGHT = 112;
export const HANDLE_LINE_HEIGHT_KEYBOARD = 76;
export const HANDLE_TOUCH_ZONE_HEIGHT = 216;
export const HANDLE_TOUCH_ZONE_HEIGHT_KEYBOARD = 148;
export const CLOSED_HANDLE_TOUCH_WIDTH = 44;
export const CLOSED_HANDLE_TOUCH_LEFT = 20;
export const CLOSED_HANDLE_BAR_INSET = 2; // Visual bar sits at 22dp from left edge
export const OPEN_HANDLE_RIGHT_INSET = 10;
const HANDLE_ALIGNMENT_OFFSET =
  CLOSED_HANDLE_TOUCH_LEFT +
  CLOSED_HANDLE_BAR_INSET +
  OPEN_HANDLE_RIGHT_INSET +
  HANDLE_LINE_WIDTH; // 36dp so bar starts at exact 22dp when pulling open
const CLOSED_PARK_EXTRA_OFFSET = 16; // Extra off-screen margin so no subpixel border peeks at x=0

const { colors } = ANTIGRAVITY_THEME;

export interface LeftNavigationDrawerProps {
  visible: boolean;
  /** When true (tablet viewports), renders as a docked side-by-side sidebar without a dimming backdrop. */
  docked?: boolean;
  initialMode?: DrawerMode;
  /** Monotonic counter incremented when a caller explicitly requests switching to `initialMode` (including while docked & already visible). */
  drawerModeRequestKey?: number;
  focusInboxRequestKey?: number;
  isKeyboardVisible?: boolean;
  keyboardBottomPadding?: number;
  hasSeenGuidance?: boolean;
  stage: AuthFlowStage;
  activeUrl?: string | null;
  snapshot: InboxSnapshot;
  isRefreshing: boolean;
  attentionCount: number;
  urgentAttentionCount: number;
  runningCount: number;
  keepAliveMinutes?: KeepAliveMinutes;
  actionNotificationMode?: ActionNotificationMode;
  onOpen: (preferredMode?: DrawerMode) => void;
  onClose: () => void;
  onDismissGuidance?: () => void;
  onRegisterBackHandler?: (interceptor: (() => boolean) | null) => void;
  onRefreshInbox: (forceUsage?: boolean) => void;
  onSelectThread: (thread: InboxThreadItem) => void;
  onStartProjectThread?: (project: InboxProjectGroup) => void;
  onListDirectory?: (
    instanceUuid: string,
    uri?: string | null,
  ) => Promise<DirectoryListingResult>;
  onCreateProject?: (
    params: CreateProjectRequestParams,
  ) => Promise<CreateProjectResult>;
  onMarkThreadRead: (thread: InboxThreadItem) => void;
  onMarkAllRead: () => void;
  onChangeKeepAliveMinutes?: (minutes: KeepAliveMinutes) => void;
  onChangeActionNotificationMode?: (mode: ActionNotificationMode) => void;
  onNavigateToUrl: (targetUrl: string) => void;
  onOpenHostSettings?: () => void;
  onReloadSession: () => void;
  onSignOut: () => void;
}

function formatUriAsDisplayPath(rawUri: string): string {
  const trimmed = rawUri.trim();
  if (!trimmed) {
    return '';
  }
  const stripped = trimmed.replace(/^file:\/\//i, '');
  let decoded = stripped;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    decoded = stripped;
  }
  // Convert `/C:/Users/...` to `C:/Users/...` on Windows workstations
  return decoded.replace(/^\/([a-zA-Z]:\/)/, '$1');
}

function deriveFolderBasename(rawPathOrUri: string): string {
  const cleaned = rawPathOrUri
    .trim()
    .replace(/^file:\/\//i, '')
    .replace(/[\\/]+$/, '');
  if (!cleaned) {
    return '';
  }
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function formatNumberWithCommas(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded =
    Math.abs(value % 1) > 0.001
      ? String(Math.round(value * 100) / 100)
      : String(Math.round(value));
  const [intPart, decPart] = rounded.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${withCommas}.${decPart}` : withCommas;
}

function getHandleVisualState(params: {
  stage: AuthFlowStage;
  attentionCount: number;
  urgentAttentionCount: number;
  runningCount: number;
}): {
  lineColor: string;
  glowColor: string | null;
} {
  const { stage, attentionCount, urgentAttentionCount, runningCount } = params;
  if (stage === 'authenticated' && urgentAttentionCount > 0) {
    return {
      lineColor: colors.approval,
      glowColor: colors.approval,
    };
  }
  if (stage === 'authenticated' && attentionCount > 0) {
    return {
      lineColor: colors.primaryBright,
      glowColor: colors.primaryBright,
    };
  }
  if (stage === 'authenticated' && runningCount > 0) {
    return {
      lineColor: 'rgba(52, 211, 153, 0.78)',
      glowColor: null,
    };
  }
  if (stage === 'offline') {
    return {
      lineColor: 'rgba(222, 85, 85, 0.82)',
      glowColor: null,
    };
  }
  if (stage === 'authenticating') {
    return {
      lineColor: 'rgba(138, 180, 248, 0.72)',
      glowColor: null,
    };
  }
  return {
    lineColor: 'rgba(188, 189, 198, 0.56)',
    glowColor: null,
  };
}

const ChevronIcon: React.FC<{ expanded: boolean; color?: string }> = ({
  expanded,
  color = colors.textMuted,
}) => (
  <View style={styles.chevronBox}>
    <View
      style={[
        styles.chevronGlyph,
        { borderColor: color },
        expanded ? styles.chevronGlyphUp : styles.chevronGlyphDown,
      ]}
    />
  </View>
);

const SearchIcon: React.FC<{ color?: string; compact?: boolean }> = ({
  color = colors.textMuted,
  compact = false,
}) => (
  <View
    style={compact ? styles.searchIconBoxCompact : styles.searchIconBox}
  >
    <View
      style={[
        compact ? styles.searchIconLensCompact : styles.searchIconLens,
        { borderColor: color },
      ]}
    />
    <View
      style={[
        compact ? styles.searchIconHandleCompact : styles.searchIconHandle,
        { backgroundColor: color },
      ]}
    />
  </View>
);

const InboxNavIcon: React.FC<{ color: string }> = ({ color }) => (
  <View style={styles.navIconFrame}>
    <View style={[styles.inboxIconOuter, { borderColor: color }]}>
      <View style={[styles.inboxIconShelf, { backgroundColor: color }]} />
    </View>
  </View>
);

const ProjectsNavIcon: React.FC<{ color: string }> = ({ color }) => (
  <View style={styles.navIconFrame}>
    <View style={styles.projectsIconWrapper}>
      <View style={[styles.projectsIconTab, { borderColor: color }]} />
      <View style={[styles.projectsIconFolder, { borderColor: color }]} />
    </View>
  </View>
);

const CompactFolderIcon: React.FC<{ color: string }> = ({ color }) => (
  <View style={styles.cardProjectIconWrapper}>
    <View style={[styles.cardProjectIconTab, { borderColor: color }]} />
    <View style={[styles.cardProjectIconBody, { borderColor: color }]} />
  </View>
);

const UsageNavIcon: React.FC<{ color: string }> = ({ color }) => (
  <View style={[styles.navIconFrame, styles.usageIconRow]}>
    <View
      style={[styles.usageIconBar, { height: 5, backgroundColor: color }]}
    />
    <View
      style={[styles.usageIconBar, { height: 9, backgroundColor: color }]}
    />
    <View
      style={[styles.usageIconBar, { height: 13, backgroundColor: color }]}
    />
  </View>
);

const SettingsNavIcon: React.FC<{ color: string }> = ({ color }) => (
  <View style={[styles.navIconFrame, styles.settingsIconStack]}>
    <View style={styles.settingsSliderRow}>
      <View
        style={[styles.settingsSliderTrack, { backgroundColor: color }]}
      />
      <View
        style={[
          styles.settingsSliderKnob,
          styles.settingsSliderKnobLeft,
          { borderColor: color },
        ]}
      />
    </View>
    <View style={styles.settingsSliderRow}>
      <View
        style={[styles.settingsSliderTrack, { backgroundColor: color }]}
      />
      <View
        style={[
          styles.settingsSliderKnob,
          styles.settingsSliderKnobRight,
          { borderColor: color },
        ]}
      />
    </View>
  </View>
);

export const LeftNavigationDrawer: React.FC<LeftNavigationDrawerProps> = ({
  visible,
  docked = false,
  initialMode,
  drawerModeRequestKey = 0,
  focusInboxRequestKey = 0,
  isKeyboardVisible = false,
  keyboardBottomPadding = 0,
  hasSeenGuidance = false,
  stage,
  activeUrl,
  snapshot,
  isRefreshing,
  attentionCount,
  urgentAttentionCount,
  runningCount,
  keepAliveMinutes = DEFAULT_KEEP_ALIVE_MINUTES,
  actionNotificationMode = DEFAULT_ACTION_NOTIFICATION_MODE,
  onOpen,
  onClose,
  onDismissGuidance,
  onRegisterBackHandler,
  onRefreshInbox,
  onSelectThread,
  onStartProjectThread,
  onListDirectory,
  onCreateProject,
  onMarkThreadRead,
  onMarkAllRead,
  onChangeKeepAliveMinutes,
  onChangeActionNotificationMode,
  onNavigateToUrl,
  onOpenHostSettings,
  onReloadSession,
  onSignOut,
}) => {
  const { width: rawWindowWidth, height: rawWindowHeight } =
    useWindowDimensions();
  const safeWindowWidth = rawWindowWidth > 0 ? rawWindowWidth : 390;
  const safeWindowHeight = rawWindowHeight > 0 ? rawWindowHeight : 680;
  const drawerWidth = computeDrawerWidth(safeWindowWidth, docked);
  const drawerWidthRef = useRef<number>(drawerWidth);
  drawerWidthRef.current = drawerWidth;
  const dockedRef = useRef<boolean>(docked);
  dockedRef.current = docked;

  const lastPrimaryNavModeRef = useRef<'inbox' | 'projects'>(
    initialMode === 'projects' ? 'projects' : 'inbox',
  );
  const defaultMode: DrawerMode =
    stage === 'authenticated'
      ? (initialMode ?? lastPrimaryNavModeRef.current)
      : 'settings';
  const defaultModeRef = useRef<DrawerMode>(defaultMode);
  defaultModeRef.current = defaultMode;
  const [activeMode, setActiveMode] = useState<DrawerMode>(defaultMode);
  const [selectedTab, setSelectedTab] = useState<InboxFilterTab>('all');
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<
    Record<string, boolean>
  >({});
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const [isMachineMenuOpen, setIsMachineMenuOpen] = useState(false);
  const [headerRowBottom, setHeaderRowBottom] = useState<number>(48);
  const [drawerPanelHeight, setDrawerPanelHeight] = useState<number>(0);
  const [handoffText, setHandoffText] = useState('');
  const [isHandoffExpanded, setIsHandoffExpanded] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [isDraggingOpen, setIsDraggingOpen] = useState(false);
  const [isAddProjectOpen, setIsAddProjectOpen] = useState(false);
  const [addProjectMode, setAddProjectMode] = useState<'existing' | 'scratch'>(
    'existing',
  );
  const [addProjectInstanceUuid, setAddProjectInstanceUuid] = useState('');
  const [addProjectPath, setAddProjectPath] = useState('');
  const [addProjectName, setAddProjectName] = useState('');
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const [isSubmittingProject, setIsSubmittingProject] = useState(false);
  const [isLoadingDir, setIsLoadingDir] = useState(false);
  const [dirCurrentUri, setDirCurrentUri] = useState<string | null>(null);
  const [dirCurrentPath, setDirCurrentPath] = useState('');
  const [dirParentUri, setDirParentUri] = useState<string | null>(null);
  const [dirEntries, setDirEntries] = useState<DirectoryEntry[]>([]);
  const [dirError, setDirError] = useState<string | null>(null);
  const [localGuidanceDismissed, setLocalGuidanceDismissed] = useState<boolean>(
    Boolean(hasSeenGuidance || visible),
  );

  const visibleRef = useRef<boolean>(visible);
  visibleRef.current = visible;
  const localGuidanceDismissedRef = useRef<boolean>(localGuidanceDismissed);
  localGuidanceDismissedRef.current = localGuidanceDismissed;
  const onDismissGuidanceRef = useRef<(() => void) | undefined>(
    onDismissGuidance,
  );
  onDismissGuidanceRef.current = onDismissGuidance;
  const isMachineMenuOpenRef = useRef<boolean>(isMachineMenuOpen);
  isMachineMenuOpenRef.current = isMachineMenuOpen;
  const isAddProjectOpenRef = useRef<boolean>(isAddProjectOpen);
  isAddProjectOpenRef.current = isAddProjectOpen;
  const dirRequestSeqRef = useRef<number>(0);
  const createProjectSeqRef = useRef<number>(0);
  const handoffTextRef = useRef<string>(handoffText);
  handoffTextRef.current = handoffText;
  const isDraggingOpenRef = useRef<boolean>(isDraggingOpen);
  isDraggingOpenRef.current = isDraggingOpen;
  const wasVisibleRef = useRef<boolean>(visible);
  const searchInputRef = useRef<TextInput | null>(null);
  const handoffInputRef = useRef<TextInput | null>(null);
  const inboxScrollViewRef = useRef<ScrollView | null>(null);
  const inboxScrollViewportHeightRef = useRef<number>(0);
  const selectedTabRef = useRef<InboxFilterTab>(selectedTab);
  selectedTabRef.current = selectedTab;
  const inboxScrollOffsetsRef = useRef<Record<InboxFilterTab, number>>({
    all: 0,
    attention: 0,
    running: 0,
  });
  const pendingInboxScrollRestoreRef = useRef<number | null>(null);
  const closedParkX = -(drawerWidth + CLOSED_PARK_EXTRA_OFFSET);
  const translateX = useRef(
    new Animated.Value(visible ? 0 : closedParkX),
  ).current;
  const handleNudgeX = useRef(new Animated.Value(0)).current;

  const dismissGuidancePermanently = useCallback(() => {
    if (!localGuidanceDismissedRef.current) {
      localGuidanceDismissedRef.current = true;
      setLocalGuidanceDismissed(true);
      onDismissGuidanceRef.current?.();
    }
  }, []);

  useEffect(() => {
    if (hasSeenGuidance && !localGuidanceDismissedRef.current) {
      localGuidanceDismissedRef.current = true;
      setLocalGuidanceDismissed(true);
    }
  }, [hasSeenGuidance]);

  useEffect(() => {
    if (visible) {
      dismissGuidancePermanently();
    }
  }, [dismissGuidancePermanently, visible]);

  const showGuidanceHint =
    !docked &&
    !hasSeenGuidance &&
    !localGuidanceDismissed &&
    !visible &&
    !isDraggingOpen &&
    !isKeyboardVisible;

  useEffect(() => {
    if (!showGuidanceHint) {
      handleNudgeX.stopAnimation?.();
      handleNudgeX.setValue(0);
      return;
    }
    const anyAnimated = Animated as unknown as {
      loop?: (anim: unknown) => { start: () => void; stop?: () => void };
      sequence?: (anims: unknown[]) => unknown;
    };
    if (
      typeof anyAnimated.loop === 'function' &&
      typeof anyAnimated.sequence === 'function'
    ) {
      const pulse = anyAnimated.loop(
        anyAnimated.sequence([
          Animated.timing(handleNudgeX, {
            toValue: 5,
            duration: 950,
            useNativeDriver: true,
          }),
          Animated.timing(handleNudgeX, {
            toValue: 0,
            duration: 950,
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      return () => {
        pulse.stop?.();
        handleNudgeX.stopAnimation?.();
        handleNudgeX.setValue(0);
      };
    }
    return undefined;
  }, [handleNudgeX, showGuidanceHint]);

  const resetInboxScrollState = useCallback(() => {
    inboxScrollOffsetsRef.current = { all: 0, attention: 0, running: 0 };
    pendingInboxScrollRestoreRef.current = null;
    inboxScrollViewRef.current?.scrollTo?.({ y: 0, animated: false });
  }, []);

  useEffect(() => {
    if (stage === 'hydrating') {
      lastPrimaryNavModeRef.current = 'inbox';
      setCollapsedProjectIds({});
      resetInboxScrollState();
    }
  }, [resetInboxScrollState, stage]);

  useEffect(() => {
    if (activeMode !== 'inbox' || searchQuery.trim().length > 0) {
      pendingInboxScrollRestoreRef.current = null;
      return;
    }
    const targetY = inboxScrollOffsetsRef.current[selectedTab] ?? 0;
    pendingInboxScrollRestoreRef.current = targetY > 0 ? targetY : null;
    inboxScrollViewRef.current?.scrollTo?.({ y: targetY, animated: false });
  }, [activeMode, searchQuery, selectedTab, visible]);

  const handleInboxScrollLayout = useCallback(
    (event: { nativeEvent?: { layout?: { height?: number } } }) => {
      const measuredHeight = event?.nativeEvent?.layout?.height ?? 0;
      if (measuredHeight > 0) {
        inboxScrollViewportHeightRef.current = measuredHeight;
      }
    },
    [],
  );

  const handleInboxScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (searchQuery.trim().length > 0) {
        return;
      }
      const nextY = event?.nativeEvent?.contentOffset?.y;
      if (typeof nextY === 'number' && Number.isFinite(nextY)) {
        pendingInboxScrollRestoreRef.current = null;
        inboxScrollOffsetsRef.current[selectedTab] = Math.max(0, nextY);
      }
    },
    [searchQuery, selectedTab],
  );

  const handleInboxContentSizeChange = useCallback(
    (_contentWidth: number, contentHeight: number) => {
      const targetY = pendingInboxScrollRestoreRef.current;
      if (targetY !== null && contentHeight > 0) {
        pendingInboxScrollRestoreRef.current = null;
        const viewportHeight = inboxScrollViewportHeightRef.current;
        const clampedY =
          viewportHeight > 0
            ? Math.min(targetY, Math.max(0, contentHeight - viewportHeight))
            : targetY;
        inboxScrollOffsetsRef.current[selectedTabRef.current] = clampedY;
        inboxScrollViewRef.current?.scrollTo?.({ y: clampedY, animated: false });
      }
    },
    [],
  );

  const handleDrawerPanelLayout = useCallback(
    (event: { nativeEvent?: { layout?: { height?: number } } }) => {
      const measuredHeight = event?.nativeEvent?.layout?.height ?? 0;
      if (measuredHeight > 0) {
        setDrawerPanelHeight(Math.round(measuredHeight));
      }
    },
    [],
  );

  const handleHeaderRowLayout = useCallback(
    (event: {
      nativeEvent?: { layout?: { y?: number; height?: number } };
    }) => {
      const measuredHeight = event?.nativeEvent?.layout?.height ?? 0;
      const measuredY = event?.nativeEvent?.layout?.y ?? 10;
      if (measuredHeight > 0) {
        setHeaderRowBottom(Math.max(40, Math.round(measuredY + measuredHeight)));
      }
    },
    [],
  );

  const resetTransientInputs = useCallback(() => {
    setSearchQuery('');
    setIsSearchExpanded(false);
    setIsMachineMenuOpen(false);
    setIsAddProjectOpen(false);
    setAddProjectError(null);
    setDirError(null);
    setValidationError(null);
    setConfirmingSignOut(false);
    setIsHandoffExpanded((prev) =>
      handoffTextRef.current.trim().length > 0 ? prev : false,
    );
  }, []);

  useEffect(() => {
    if (!onRegisterBackHandler) {
      return;
    }
    onRegisterBackHandler(() => {
      if (isMachineMenuOpenRef.current) {
        isMachineMenuOpenRef.current = false;
        setIsMachineMenuOpen(false);
        return true;
      }
      if (isAddProjectOpenRef.current) {
        isAddProjectOpenRef.current = false;
        setIsAddProjectOpen(false);
        setAddProjectError(null);
        return true;
      }
      return false;
    });
    return () => {
      onRegisterBackHandler(null);
    };
  }, [onRegisterBackHandler]);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      const nextMode =
        initialMode ??
        (stage === 'authenticated' ? lastPrimaryNavModeRef.current : 'settings');
      setActiveMode(nextMode);
      setIsMachineMenuOpen(false);
    } else if (!visible && wasVisibleRef.current) {
      resetTransientInputs();
    }
  }, [initialMode, resetTransientInputs, stage, visible]);

  const lastHandledModeRequestKeyRef = useRef<number>(drawerModeRequestKey);
  useEffect(() => {
    if (drawerModeRequestKey <= lastHandledModeRequestKeyRef.current) {
      return;
    }
    lastHandledModeRequestKeyRef.current = drawerModeRequestKey;
    if (!initialMode) {
      return;
    }
    if (initialMode === 'inbox' || initialMode === 'projects') {
      lastPrimaryNavModeRef.current = initialMode;
    }
    setActiveMode(initialMode);
    setIsMachineMenuOpen(false);
  }, [drawerModeRequestKey, initialMode]);

  useEffect(() => {
    if (focusInboxRequestKey > 0) {
      lastPrimaryNavModeRef.current = 'inbox';
      setActiveMode('inbox');
      setIsMachineMenuOpen(false);
      setSelectedTab((prev) => (prev === 'running' ? 'all' : prev));
    }
  }, [focusInboxRequestKey]);

  useEffect(() => {
    const parkedX = -(drawerWidth + CLOSED_PARK_EXTRA_OFFSET);
    let closeSafetyTimer: ReturnType<typeof setTimeout> | null = null;
    if (visible) {
      isDraggingOpenRef.current = false;
      setIsDraggingOpen(false);
      translateX.stopAnimation?.();
      Animated.spring(translateX, {
        toValue: 0,
        damping: 26,
        stiffness: 280,
        mass: 0.9,
        useNativeDriver: true,
      }).start((result) => {
        if (result && result.finished === false && visibleRef.current) {
          translateX.setValue(0);
        }
      });
    } else if (wasVisibleRef.current) {
      searchInputRef.current?.blur?.();
      handoffInputRef.current?.blur?.();
      isDraggingOpenRef.current = false;
      setIsDraggingOpen(false);
      translateX.stopAnimation?.();
      Animated.timing(translateX, {
        toValue: parkedX,
        duration: 180,
        useNativeDriver: true,
      }).start(() => {
        if (!visibleRef.current && !isDraggingOpenRef.current) {
          translateX.setValue(
            -(drawerWidthRef.current + CLOSED_PARK_EXTRA_OFFSET),
          );
        }
      });
      closeSafetyTimer = setTimeout(() => {
        if (!visibleRef.current && !isDraggingOpenRef.current) {
          translateX.stopAnimation?.();
          translateX.setValue(
            -(drawerWidthRef.current + CLOSED_PARK_EXTRA_OFFSET),
          );
        }
      }, 260);
      (closeSafetyTimer as { unref?: () => void })?.unref?.();
    } else if (!isDraggingOpenRef.current) {
      translateX.setValue(parkedX);
    }
    wasVisibleRef.current = visible;
    return () => {
      if (closeSafetyTimer) {
        clearTimeout(closeSafetyTimer);
      }
    };
  }, [drawerWidth, translateX, visible]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', () => {
      if (!visibleRef.current) {
        isDraggingOpenRef.current = false;
        setIsDraggingOpen(false);
        translateX.stopAnimation?.();
        translateX.setValue(
          -(drawerWidthRef.current + CLOSED_PARK_EXTRA_OFFSET),
        );
      } else {
        translateX.stopAnimation?.();
        translateX.setValue(0);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [translateX]);

  const handleClose = useCallback(() => {
    resetTransientInputs();
    isDraggingOpenRef.current = false;
    setIsDraggingOpen(false);
    onClose();
  }, [onClose, resetTransientInputs]);

  const handleTapOpen = useCallback(() => {
    if (!dockedRef.current) {
      Keyboard.dismiss?.();
    }
    dismissGuidancePermanently();
    setActiveMode(defaultModeRef.current);
    const startOffset = -drawerWidthRef.current + HANDLE_ALIGNMENT_OFFSET;
    translateX.stopAnimation?.();
    translateX.setValue(startOffset);
    onOpen();
  }, [dismissGuidancePermanently, onOpen, translateX]);

  // Pull-right gesture on the closed handle strip (starts 20dp inside the screen
  // bezel so iOS and Android edge-back gestures at 0..20dp are never triggered).
  // Capture-phase takeover lets horizontal drags take responder ownership from
  // the inner TouchableOpacity while preserving simple taps.
  const closedHandlePanResponder = useMemo(() => {
    const shouldClaimPullRight = (gestureState: { dx: number; dy: number }) =>
      !visibleRef.current &&
      gestureState.dx > 6 &&
      Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 0.55;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_evt, gestureState) =>
        shouldClaimPullRight(gestureState),
      onMoveShouldSetPanResponderCapture: (_evt, gestureState) =>
        shouldClaimPullRight(gestureState),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        if (visibleRef.current) return;
        if (!dockedRef.current) {
          Keyboard.dismiss?.();
        }
        isDraggingOpenRef.current = true;
        translateX.stopAnimation?.();
        setActiveMode(defaultModeRef.current);
        const width = drawerWidthRef.current;
        translateX.setValue(-width + HANDLE_ALIGNMENT_OFFSET);
        setIsDraggingOpen(true);
      },
      onPanResponderMove: (_evt, gestureState) => {
        if (visibleRef.current) return;
        const width = drawerWidthRef.current;
        const clampedX = Math.max(
          -width,
          Math.min(0, -width + HANDLE_ALIGNMENT_OFFSET + gestureState.dx),
        );
        translateX.setValue(clampedX);
      },
      onPanResponderRelease: (_evt, gestureState) => {
        const width = drawerWidthRef.current;
        const shouldOpen =
          gestureState.dx > Math.min(28, width * 0.1) ||
          (gestureState.dx > 14 && gestureState.vx >= 0.12);
        if (shouldOpen) {
          dismissGuidancePermanently();
          isDraggingOpenRef.current = false;
          setIsDraggingOpen(false);
          onOpen();
        } else {
          const parkedX = -(width + CLOSED_PARK_EXTRA_OFFSET);
          Animated.timing(translateX, {
            toValue: parkedX,
            duration: 150,
            useNativeDriver: true,
          }).start(() => {
            isDraggingOpenRef.current = false;
            setIsDraggingOpen(false);
            if (!visibleRef.current) {
              translateX.setValue(
                -(drawerWidthRef.current + CLOSED_PARK_EXTRA_OFFSET),
              );
            }
          });
        }
      },
      onPanResponderTerminate: () => {
        isDraggingOpenRef.current = false;
        setIsDraggingOpen(false);
        if (!visibleRef.current) {
          translateX.stopAnimation?.();
          translateX.setValue(
            -(drawerWidthRef.current + CLOSED_PARK_EXTRA_OFFSET),
          );
        }
      },
    });
  }, [dismissGuidancePermanently, onOpen, translateX]);

  // Push/swipe-left gesture on the open drawer or its inner-right handle line.
  const openDrawerPanResponder = useMemo(() => {
    const shouldClaimSwipeLeft = (gestureState: { dx: number; dy: number }) =>
      visibleRef.current &&
      gestureState.dx < -8 &&
      Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.2;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_evt, gestureState) =>
        shouldClaimSwipeLeft(gestureState),
      onMoveShouldSetPanResponderCapture: (_evt, gestureState) =>
        shouldClaimSwipeLeft(gestureState),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        if (!visibleRef.current) return;
        translateX.stopAnimation?.();
      },
      onPanResponderMove: (_evt, gestureState) => {
        if (!visibleRef.current) return;
        const width = drawerWidthRef.current;
        const clampedX = Math.max(-width, Math.min(0, gestureState.dx));
        translateX.setValue(clampedX);
      },
      onPanResponderRelease: (_evt, gestureState) => {
        if (!visibleRef.current) return;
        const width = drawerWidthRef.current;
        const shouldClose =
          gestureState.dx < -width * 0.22 ||
          (gestureState.dx < -20 && gestureState.vx < -0.35);
        if (shouldClose) {
          handleClose();
        } else {
          Animated.spring(translateX, {
            toValue: 0,
            damping: 26,
            stiffness: 280,
            mass: 0.9,
            useNativeDriver: true,
          }).start((result) => {
            if (result && result.finished === false && visibleRef.current) {
              translateX.setValue(0);
            }
          });
        }
      },
      onPanResponderTerminate: () => {
        if (visibleRef.current) {
          Animated.spring(translateX, {
            toValue: 0,
            damping: 26,
            stiffness: 280,
            mass: 0.9,
            useNativeDriver: true,
          }).start((result) => {
            if (result && result.finished === false && visibleRef.current) {
              translateX.setValue(0);
            }
          });
        } else {
          translateX.stopAnimation?.();
          translateX.setValue(
            -(drawerWidthRef.current + CLOSED_PARK_EXTRA_OFFSET),
          );
        }
      },
    });
  }, [handleClose, translateX]);

  const connectedInstances = useMemo(
    () => snapshot.instances.filter((inst) => inst.status === 'connected'),
    [snapshot.instances],
  );

  const sortedInstances = useMemo((): InboxInstanceSummary[] => {
    const rank = (inst: InboxInstanceSummary): number => {
      if (
        inst.uuid === snapshot.activeInstanceUuid &&
        inst.status === 'connected'
      ) {
        return 0;
      }
      if (inst.status === 'connected') return 1;
      if (inst.uuid === snapshot.activeInstanceUuid) return 2;
      if (inst.status === 'idle') return 3;
      return 4;
    };
    return [...snapshot.instances].sort((a, b) => rank(a) - rank(b));
  }, [snapshot.activeInstanceUuid, snapshot.instances]);

  const activeInstance = useMemo((): InboxInstanceSummary | null => {
    if (
      !snapshot.activeInstanceUuid ||
      snapshot.activeInstanceUuid === '__cloud__'
    ) {
      return null;
    }
    return (
      snapshot.instances.find(
        (inst) => inst.uuid === snapshot.activeInstanceUuid,
      ) ?? null
    );
  }, [snapshot.activeInstanceUuid, snapshot.instances]);

  const machineSelectorVisuals = useMemo((): {
    label: string;
    dotColor: string;
  } => {
    if (stage === 'authenticating') {
      return { label: 'Sign in…', dotColor: '#60A5FA' };
    }
    if (stage === 'offline') {
      return {
        label:
          activeInstance?.name ||
          (snapshot.activeInstanceUuid &&
          snapshot.activeInstanceUuid !== '__cloud__'
            ? snapshot.activeInstanceUuid
            : connectedInstances[0]?.name || 'Offline'),
        dotColor: '#F87171',
      };
    }
    if (stage !== 'authenticated') {
      return { label: 'Connecting…', dotColor: '#94A3B8' };
    }
    if (activeInstance) {
      const dotColor =
        activeInstance.status === 'connected'
          ? '#34D399'
          : activeInstance.status === 'disconnected'
            ? '#F87171'
            : '#94A3B8';
      return { label: activeInstance.name, dotColor };
    }
    if (snapshot.activeInstanceUuid === '__cloud__') {
      return { label: 'Cloud Agent', dotColor: '#60A5FA' };
    }
    if (snapshot.activeInstanceUuid) {
      return {
        label: snapshot.activeInstanceUuid,
        dotColor: isRefreshing ? '#60A5FA' : '#94A3B8',
      };
    }
    if (connectedInstances.length > 0) {
      return {
        label: 'All Machines',
        dotColor: '#34D399',
      };
    }
    if (snapshot.instances.length > 0) {
      return {
        label: 'All Machines',
        dotColor: '#94A3B8',
      };
    }
    if (isRefreshing) {
      return { label: 'Syncing…', dotColor: '#60A5FA' };
    }
    return { label: 'Workstations', dotColor: '#64748B' };
  }, [
    activeInstance,
    connectedInstances,
    isRefreshing,
    snapshot.activeInstanceUuid,
    snapshot.instances.length,
    stage,
  ]);

  const accountPathPrefix = useMemo(() => {
    const fromActiveUrl = extractAccountPathPrefix(activeUrl);
    if (fromActiveUrl) {
      return fromActiveUrl;
    }
    for (const thread of snapshot.threads) {
      const fromThread = extractAccountPathPrefix(thread.targetUrl);
      if (fromThread) {
        return fromThread;
      }
    }
    return '';
  }, [activeUrl, snapshot.threads]);

  const dashboardUrl = accountPathPrefix
    ? `${ANTIGRAVITY_DASHBOARD_URL}${accountPathPrefix}/`
    : ANTIGRAVITY_DASHBOARD_URL;

  const counts = useMemo(() => {
    let attention = 0;
    let running = 0;
    let dismissible = 0;
    for (const thread of snapshot.threads) {
      if (thread.needsAttention) {
        attention++;
      }
      if (thread.attentionKind === 'running') {
        running++;
      }
      if (
        thread.attentionKind === 'unread' ||
        thread.attentionKind === 'error'
      ) {
        dismissible++;
      }
    }
    return {
      attention,
      running,
      all: snapshot.threads.length,
      dismissible,
    };
  }, [snapshot.threads]);

  const filteredThreads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return snapshot.threads.filter((thread) => {
      if (selectedTab === 'attention' && !thread.needsAttention) {
        return false;
      }
      if (selectedTab === 'running' && thread.attentionKind !== 'running') {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        thread.title.toLowerCase().includes(query) ||
        thread.instanceName.toLowerCase().includes(query) ||
        (thread.projectName?.toLowerCase().includes(query) ?? false) ||
        (thread.workspaceName?.toLowerCase().includes(query) ?? false) ||
        thread.attentionReason.toLowerCase().includes(query)
      );
    });
  }, [searchQuery, selectedTab, snapshot.threads]);

  const projectGroups = useMemo(
    () => buildProjectGroups(snapshot, activeUrl),
    [activeUrl, snapshot],
  );

  const filteredProjectGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return projectGroups;
    }
    const result: InboxProjectGroup[] = [];
    for (const group of projectGroups) {
      const groupMatches =
        group.name.toLowerCase().includes(query) ||
        group.instanceName.toLowerCase().includes(query) ||
        (group.workspaceUri?.toLowerCase().includes(query) ?? false);
      const matchingThreads = group.threads.filter(
        (thread) =>
          thread.title.toLowerCase().includes(query) ||
          thread.attentionReason.toLowerCase().includes(query) ||
          thread.instanceName.toLowerCase().includes(query) ||
          (thread.projectName?.toLowerCase().includes(query) ?? false) ||
          (thread.workspaceName?.toLowerCase().includes(query) ?? false),
      );
      if (groupMatches || matchingThreads.length > 0) {
        result.push({
          ...group,
          threads:
            matchingThreads.length > 0 ? matchingThreads : group.threads,
        });
      }
    }
    return result;
  }, [projectGroups, searchQuery]);

  const allProjectsCollapsed = useMemo(
    () =>
      projectGroups.length > 0 &&
      projectGroups.every((group) => Boolean(collapsedProjectIds[group.id])),
    [collapsedProjectIds, projectGroups],
  );

  const toggleProjectCollapsed = useCallback((projectId: string) => {
    setCollapsedProjectIds((prev) => ({
      ...prev,
      [projectId]: !prev[projectId],
    }));
  }, []);

  const toggleAllProjectsCollapsed = useCallback(() => {
    setCollapsedProjectIds(() => {
      if (allProjectsCollapsed) {
        return {};
      }
      const next: Record<string, boolean> = {};
      for (const group of projectGroups) {
        next[group.id] = true;
      }
      return next;
    });
  }, [allProjectsCollapsed, projectGroups]);

  const handleStartNewProjectChat = useCallback(
    (project: InboxProjectGroup) => {
      resetTransientInputs();
      isDraggingOpenRef.current = false;
      setIsDraggingOpen(false);
      if (onStartProjectThread) {
        onStartProjectThread(project);
      } else {
        onNavigateToUrl(project.newChatUrl);
        if (!docked) {
          onClose();
        }
      }
    },
    [docked, onClose, onNavigateToUrl, onStartProjectThread, resetTransientInputs],
  );

  const loadDirectoryForInstance = useCallback(
    async (instanceUuid: string, targetUri?: string | null) => {
      if (!onListDirectory || !instanceUuid) {
        return;
      }
      const seq = ++dirRequestSeqRef.current;
      setIsLoadingDir(true);
      setDirError(null);
      try {
        const result = await onListDirectory(instanceUuid, targetUri ?? null);
        if (dirRequestSeqRef.current !== seq) {
          return;
        }
        setIsLoadingDir(false);
        if (!result.ok) {
          setDirError(result.error || 'Could not browse remote folders.');
          return;
        }
        setDirCurrentUri(result.currentUri || null);
        const displayPath = formatUriAsDisplayPath(result.currentUri || '');
        setDirCurrentPath(displayPath);
        setDirParentUri(result.parentUri ?? null);
        setDirEntries(result.entries);
        if (displayPath) {
          setAddProjectPath(displayPath);
        }
      } catch {
        if (dirRequestSeqRef.current === seq) {
          setIsLoadingDir(false);
          setDirError('Could not browse remote folders.');
        }
      }
    },
    [onListDirectory],
  );

  const handleOpenAddProject = useCallback(() => {
    setIsMachineMenuOpen(false);
    const preferredInstance =
      (activeInstance && activeInstance.status === 'connected'
        ? activeInstance
        : null) ??
      connectedInstances[0] ??
      null;
    const nextUuid = preferredInstance?.uuid ?? '';
    setAddProjectInstanceUuid(nextUuid);
    setAddProjectMode('existing');
    setAddProjectPath('');
    setAddProjectName('');
    setAddProjectError(null);
    setDirCurrentUri(null);
    setDirCurrentPath('');
    setDirParentUri(null);
    setDirEntries([]);
    setDirError(null);
    setIsAddProjectOpen(true);
    if (nextUuid && onListDirectory) {
      void loadDirectoryForInstance(nextUuid, null);
    }
  }, [
    activeInstance,
    connectedInstances,
    loadDirectoryForInstance,
    onListDirectory,
  ]);

  const handleCloseAddProject = useCallback(() => {
    dirRequestSeqRef.current++;
    createProjectSeqRef.current++;
    setIsAddProjectOpen(false);
    setAddProjectError(null);
    setDirError(null);
    setIsLoadingDir(false);
    setIsSubmittingProject(false);
  }, []);

  const handleSelectAddProjectInstance = useCallback(
    (instanceUuid: string) => {
      setAddProjectInstanceUuid(instanceUuid);
      setAddProjectPath('');
      setAddProjectError(null);
      setDirCurrentUri(null);
      setDirCurrentPath('');
      setDirParentUri(null);
      setDirEntries([]);
      setDirError(null);
      if (addProjectMode === 'existing' && onListDirectory) {
        void loadDirectoryForInstance(instanceUuid, null);
      }
    },
    [addProjectMode, loadDirectoryForInstance, onListDirectory],
  );

  const handleSubmitAddProject = useCallback(async () => {
    if (!onCreateProject || isSubmittingProject) {
      return;
    }
    const isSelectedStillConnected =
      Boolean(addProjectInstanceUuid) &&
      connectedInstances.some((inst) => inst.uuid === addProjectInstanceUuid);
    const targetUuid =
      (isSelectedStillConnected ? addProjectInstanceUuid : '') ||
      (activeInstance && activeInstance.status === 'connected'
        ? activeInstance.uuid
        : connectedInstances[0]?.uuid) ||
      '';
    if (!targetUuid) {
      setAddProjectError('No connected workstation available.');
      return;
    }

    if (addProjectMode === 'existing') {
      const effectivePath = addProjectPath.trim() || (dirCurrentUri ?? '');
      if (!effectivePath) {
        setAddProjectError('Select a remote folder or enter a folder path.');
        return;
      }
      const effectiveName =
        addProjectName.trim() || deriveFolderBasename(effectivePath);
      if (!effectiveName) {
        setAddProjectError('Enter a project name.');
        return;
      }
      const submitSeq = ++createProjectSeqRef.current;
      setIsSubmittingProject(true);
      setAddProjectError(null);
      try {
        const result = await onCreateProject({
          instanceUuid: targetUuid,
          mode: 'existing',
          name: effectiveName,
          folderPathOrUri: effectivePath,
        });
        if (createProjectSeqRef.current !== submitSeq) {
          return;
        }
        setIsSubmittingProject(false);
        if (!result.ok) {
          setAddProjectError(
            result.error || 'Could not add this folder as a project.',
          );
          return;
        }
        handleCloseAddProject();
        setAddProjectPath('');
        setAddProjectName('');
        onRefreshInbox(false);
      } catch {
        if (createProjectSeqRef.current === submitSeq) {
          setIsSubmittingProject(false);
          setAddProjectError('Could not add this folder as a project.');
        }
      }
      return;
    }

    const scratchName = addProjectName.trim();
    if (!scratchName) {
      setAddProjectError('Enter a name for the new project folder.');
      return;
    }
    const submitSeq = ++createProjectSeqRef.current;
    setIsSubmittingProject(true);
    setAddProjectError(null);
    try {
      const result = await onCreateProject({
        instanceUuid: targetUuid,
        mode: 'scratch',
        name: scratchName,
      });
      if (createProjectSeqRef.current !== submitSeq) {
        return;
      }
      setIsSubmittingProject(false);
      if (!result.ok) {
        setAddProjectError(result.error || 'Could not create new project.');
        return;
      }
      handleCloseAddProject();
      setAddProjectPath('');
      setAddProjectName('');
      onRefreshInbox(false);
    } catch {
      if (createProjectSeqRef.current === submitSeq) {
        setIsSubmittingProject(false);
        setAddProjectError('Could not create new project.');
      }
    }
  }, [
    activeInstance,
    addProjectInstanceUuid,
    addProjectMode,
    addProjectName,
    addProjectPath,
    connectedInstances,
    dirCurrentUri,
    handleCloseAddProject,
    isSubmittingProject,
    onCreateProject,
    onRefreshInbox,
  ]);

  const usage = snapshot.usage ?? null;
  const visibleUsageCredits = useMemo(
    () =>
      (usage?.credits ?? []).filter(
        (credit) =>
          credit.id !== 'prompt-credits' &&
          credit.id !== 'flow-credits' &&
          !/\b(prompt|flow)\s*credits?\b/i.test(credit.label),
      ),
    [usage?.credits],
  );

  const snapshotUpdatedLabel = useMemo(
    () =>
      snapshot.fetchedAtMs > 0 ? formatRelativeTime(snapshot.fetchedAtMs) : '',
    [snapshot.fetchedAtMs],
  );

  const usageUpdatedLabel = useMemo(() => {
    if (stage !== 'authenticated') {
      return '';
    }
    if (usage && usage.fetchedAtMs > 0) {
      return formatRelativeTime(usage.fetchedAtMs);
    }
    return snapshotUpdatedLabel;
  }, [snapshotUpdatedLabel, stage, usage]);

  const activityStats = useMemo(() => {
    let totalSteps = 0;
    let budgetPausedCount = 0;
    let firstBudgetPausedThread: InboxThreadItem | null = null;
    for (const thread of snapshot.threads) {
      totalSteps += Math.max(0, thread.stepCount || 0);
      const reasonLower = thread.attentionReason.toLowerCase();
      if (
        thread.attentionKind === 'error' &&
        (reasonLower.includes('budget') || reasonLower.includes('limit'))
      ) {
        budgetPausedCount++;
        if (!firstBudgetPausedThread) {
          firstBudgetPausedThread = thread;
        }
      }
    }
    return {
      totalSteps,
      budgetPausedCount,
      firstBudgetPausedThread,
    };
  }, [snapshot.threads]);

  const usageStatusDotColor = useMemo(() => {
    if (stage !== 'authenticated' || !usage) {
      return null;
    }
    if (
      typeof usage.lowestRemainingFraction === 'number' &&
      Number.isFinite(usage.lowestRemainingFraction)
    ) {
      if (usage.lowestRemainingFraction <= 0) {
        return '#EF4444';
      }
      if (usage.lowestRemainingFraction <= 0.2) {
        return '#F59E0B';
      }
    }
    return null;
  }, [stage, usage]);

  const handleConnectHandoff = () => {
    const parsedUrl = parseHandoffInput(handoffText);
    if (!parsedUrl) {
      setValidationError(
        'Enter a valid antigravity.google.com/r/<machine> link or machine ID.',
      );
      return;
    }

    setValidationError(null);
    setHandoffText('');
    setIsHandoffExpanded(false);
    setConfirmingSignOut(false);
    isDraggingOpenRef.current = false;
    setIsDraggingOpen(false);
    onNavigateToUrl(parsedUrl);
    if (!docked) {
      onClose();
    }
  };

  const handleOpenDashboard = () => {
    setIsMachineMenuOpen(false);
    setValidationError(null);
    setConfirmingSignOut(false);
    isDraggingOpenRef.current = false;
    setIsDraggingOpen(false);
    onNavigateToUrl(dashboardUrl);
    if (!docked) {
      onClose();
    }
  };

  const handleSelectWorkstation = (inst: InboxInstanceSummary) => {
    const targetUrl = `https://antigravity.google.com${accountPathPrefix}/r/${encodeURIComponent(
      inst.uuid,
    )}`;
    resetTransientInputs();
    isDraggingOpenRef.current = false;
    setIsDraggingOpen(false);
    onNavigateToUrl(targetUrl);
  };

  const handleTriggerHostSettings = () => {
    resetTransientInputs();
    isDraggingOpenRef.current = false;
    setIsDraggingOpen(false);
    if (onOpenHostSettings) {
      onOpenHostSettings();
    } else {
      onNavigateToUrl(dashboardUrl);
    }
    if (!docked) {
      onClose();
    }
  };

  const handleConfirmSignOut = () => {
    setConfirmingSignOut(false);
    setHandoffText('');
    setIsHandoffExpanded(false);
    setIsMachineMenuOpen(false);
    setIsAddProjectOpen(false);
    setAddProjectError(null);
    setIsSearchExpanded(false);
    setValidationError(null);
    setSearchQuery('');
    setSelectedTab('all');
    lastPrimaryNavModeRef.current = 'inbox';
    setCollapsedProjectIds({});
    resetInboxScrollState();
    isDraggingOpenRef.current = false;
    setIsDraggingOpen(false);
    onSignOut();
  };

  const accountStatusDotColor =
    stage === 'authenticated'
      ? '#34D399'
      : stage === 'authenticating'
        ? '#60A5FA'
        : '#F87171';

  const accountStatusText = useMemo(() => {
    if (stage === 'authenticating') {
      return 'Google Sign-In in progress';
    }
    if (stage === 'offline') {
      return 'Connection interrupted';
    }
    if (stage !== 'authenticated') {
      return 'Restoring session…';
    }
    const machineCount = connectedInstances.length;
    if (machineCount === 1) {
      return `Signed in • 1 machine online (${connectedInstances[0].name})`;
    }
    if (machineCount > 1) {
      return `Signed in • ${machineCount} machines online`;
    }
    return 'Signed in with Google';
  }, [connectedInstances, stage]);

  const isAndroid = Platform.OS === 'android';
  const keepAliveHint = isAndroid
    ? keepAliveMinutes > 0
      ? `Active for up to ${keepAliveMinutes}m • Shows a silent stoppable notification and uses slightly more battery.`
      : 'Off (no background battery use) • Pauses in background and reconnects on return.'
    : keepAliveMinutes > 0
      ? 'Active across quick app switches (~30s iOS limit) • Uses slightly more battery.'
      : 'Off (no background battery use) • Pauses when switching apps and reconnects on return.';

  const handleVisuals = getHandleVisualState({
    stage,
    attentionCount,
    urgentAttentionCount,
    runningCount,
  });

  const isDrawerInteractiveOrDragging = visible || isDraggingOpen;
  // Keep the pull-open handle accessible even while the software keyboard is showing!
  const isClosedHandleHidden = visible || isDraggingOpen;
  const closedHandleTouchHeight = isKeyboardVisible
    ? HANDLE_TOUCH_ZONE_HEIGHT_KEYBOARD
    : HANDLE_TOUCH_ZONE_HEIGHT;
  const closedHandleLineHeight = isKeyboardVisible
    ? HANDLE_LINE_HEIGHT_KEYBOARD
    : HANDLE_LINE_HEIGHT;
  const closedHandleDynamicStyle =
    keyboardBottomPadding > 0
      ? {
          top: Math.max(
            48,
            Math.round((safeWindowHeight - keyboardBottomPadding) / 2),
          ),
          height: closedHandleTouchHeight,
          marginTop: -(closedHandleTouchHeight / 2),
        }
      : isKeyboardVisible
        ? {
            height: closedHandleTouchHeight,
            marginTop: -(closedHandleTouchHeight / 2),
          }
        : null;

  const renderThreadCard = (
    thread: InboxThreadItem,
    variant: 'inbox' | 'project',
  ): React.JSX.Element => {
    const visuals = getAttentionVisuals(thread.attentionKind);
    const relativeTime = formatRelativeTime(thread.lastModifiedAtMs);
    const canMarkRead =
      thread.attentionKind === 'unread' || thread.attentionKind === 'error';
    const isCurrentThread =
      thread.isActiveThread ||
      (snapshot.activeInstanceUuid === thread.instanceUuid &&
        snapshot.activeCascadeId !== null &&
        (snapshot.activeCascadeId === thread.cascadeId ||
          snapshot.activeCascadeId === thread.trajectoryId)) ||
      Boolean(activeUrl && activeUrl === thread.targetUrl);
    const isProjectVariant = variant === 'project';
    const projectLabel = !isProjectVariant
      ? resolveThreadProjectName(thread)
      : null;
    const showReason =
      thread.needsAttention ||
      thread.attentionKind === 'running' ||
      (isProjectVariant && Boolean(thread.attentionReason));

    return (
      <TouchableOpacity
        key={thread.id}
        style={[
          isProjectVariant ? styles.projectThreadCard : styles.threadCard,
          { borderLeftColor: visuals.accentColor },
          isCurrentThread
            ? isProjectVariant
              ? styles.projectThreadCardActive
              : styles.threadCardActive
            : null,
        ]}
        activeOpacity={0.82}
        onPress={() => {
          resetTransientInputs();
          isDraggingOpenRef.current = false;
          setIsDraggingOpen(false);
          onSelectThread(thread);
        }}
        accessibilityRole="button"
        accessibilityLabel={
          isProjectVariant
            ? `Open project thread ${thread.title}`
            : `Open thread ${thread.title}`
        }
      >
        <View style={styles.cardTopRow}>
          <View style={styles.badgesRow}>
            <View
              style={[
                styles.kindBadge,
                {
                  backgroundColor: visuals.bgColor,
                  borderColor: visuals.borderColor,
                },
              ]}
            >
              <Text
                style={[styles.kindBadgeText, { color: visuals.textColor }]}
              >
                {visuals.label}
              </Text>
            </View>

            {isCurrentThread ? (
              <View style={styles.currentBadge}>
                <Text style={styles.currentBadgeText}>OPEN</Text>
              </View>
            ) : null}
          </View>

          {relativeTime ? (
            <Text style={styles.timestampText}>{relativeTime}</Text>
          ) : null}
        </View>

        {projectLabel ? (
          <View style={styles.cardProjectRow} testID="inbox-card-project-row">
            <CompactFolderIcon color={colors.textSecondary} />
            <Text style={styles.cardProjectText} numberOfLines={1}>
              {projectLabel}
            </Text>
          </View>
        ) : null}

        <Text style={styles.threadTitle} numberOfLines={2}>
          {thread.title}
        </Text>

        {showReason ? (
          <Text
            style={[
              styles.reasonText,
              thread.attentionKind === 'approval'
                ? styles.reasonTextApproval
                : thread.attentionKind === 'error'
                  ? styles.reasonTextError
                  : thread.attentionKind === 'unread'
                    ? styles.reasonTextUnread
                    : thread.attentionKind === 'idle'
                      ? styles.reasonTextIdle
                      : null,
            ]}
            numberOfLines={2}
          >
            {thread.attentionReason}
          </Text>
        ) : null}

        {!isProjectVariant || canMarkRead ? (
          <View
            style={[
              styles.cardFooterRow,
              isProjectVariant ? styles.projectCardFooterRow : null,
            ]}
          >
            {!isProjectVariant ? (
              <Text style={styles.metaText} numberOfLines={1}>
                {thread.instanceName}
              </Text>
            ) : (
              <View style={styles.projectFooterSpacer} />
            )}

            {canMarkRead ? (
              <TouchableOpacity
                style={styles.markReadChip}
                onPress={() => onMarkThreadRead(thread)}
                accessibilityRole="button"
                accessibilityLabel={
                  isProjectVariant
                    ? `Mark project thread ${thread.title} as read`
                    : `Mark ${thread.title} as read`
                }
              >
                <Text style={styles.markReadChipText}>Mark read</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </TouchableOpacity>
    );
  };

  const backdropOpacity = useMemo(
    () =>
      translateX.interpolate({
        inputRange: [-drawerWidth, 0],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
    [drawerWidth, translateX],
  );

  const badgeCountLabel =
    attentionCount > 99
      ? '99+'
      : attentionCount > 0
        ? String(attentionCount)
        : null;

  const closedHandleAccessibilityLabel =
    attentionCount > 0
      ? `Open Antigravity drawer (${attentionCount} need attention)`
      : 'Open Antigravity drawer';

  const isSearchVisible = isSearchExpanded || searchQuery.trim().length > 0;
  const effectiveDrawerHeight =
    drawerPanelHeight > 0
      ? drawerPanelHeight
      : Math.max(240, safeWindowHeight - keyboardBottomPadding);
  const menuTopOffset = headerRowBottom + 2;
  const menuBottomReserved = isKeyboardVisible ? 12 : 64;
  const menuCardMaxHeight = Math.min(
    420,
    Math.max(148, effectiveDrawerHeight - menuTopOffset - menuBottomReserved),
  );
  const menuScrollMaxHeight = Math.max(120, menuCardMaxHeight - 14);
  const isAllMachinesActive =
    stage === 'authenticated' &&
    snapshot.activeInstanceUuid === null &&
    snapshot.instances.length > 0;

  return (
    <View style={styles.overlayRoot} pointerEvents="box-none">
      <View
        testID={docked ? 'docked-drawer-overlay' : 'modal-drawer-overlay'}
        style={styles.openOverlay}
        pointerEvents={visible ? (docked ? 'box-none' : 'auto') : 'none'}
        importantForAccessibility={visible ? 'yes' : 'no-hide-descendants'}
      >
        {!docked ? (
          <Animated.View
            style={[styles.backdrop, { opacity: backdropOpacity }]}
          >
            <Pressable
              style={StyleSheet.absoluteFillObject}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close drawer backdrop"
            />
          </Animated.View>
        ) : null}

        <Animated.View
          testID="navigation-drawer-panel"
          style={[
            styles.drawerPanel,
            !docked && isDrawerInteractiveOrDragging
              ? styles.drawerPanelElevated
              : null,
            {
              width: drawerWidth,
              bottom: keyboardBottomPadding,
              paddingTop: 10,
              paddingBottom: isKeyboardVisible ? 10 : 0,
              transform: [{ translateX }],
            },
          ]}
          onLayout={handleDrawerPanelLayout}
          {...openDrawerPanResponder.panHandlers}
        >
            {/* Row 1: Compact Workstation Selector + Contextual Header Actions */}
            <View
              style={styles.sidebarHeaderRow}
              onLayout={handleHeaderRowLayout}
            >
              <TouchableOpacity
                style={[
                  styles.machineSelectorPill,
                  isMachineMenuOpen ? styles.machineSelectorPillOpen : null,
                ]}
                activeOpacity={0.82}
                onPress={() => setIsMachineMenuOpen((prev) => !prev)}
                accessibilityRole="button"
                accessibilityState={{ expanded: isMachineMenuOpen }}
                accessibilityLabel="Select workstation"
              >
                <View
                  style={[
                    styles.machineSelectorDot,
                    { backgroundColor: machineSelectorVisuals.dotColor },
                  ]}
                />
                <Text style={styles.machineSelectorLabel} numberOfLines={1}>
                  {machineSelectorVisuals.label}
                </Text>
                <ChevronIcon
                  expanded={isMachineMenuOpen}
                  color={
                    isMachineMenuOpen ? colors.primaryText : colors.textMuted
                  }
                />
              </TouchableOpacity>

              <View style={styles.headerActionsRow}>
                {activeMode === 'inbox' || activeMode === 'projects' ? (
                  <>
                    <TouchableOpacity
                      style={[
                        styles.headerIconBtn,
                        isSearchVisible ? styles.headerIconBtnActive : null,
                      ]}
                      onPress={() => {
                        setIsMachineMenuOpen(false);
                        if (isSearchVisible) {
                          setSearchQuery('');
                          setIsSearchExpanded(false);
                          searchInputRef.current?.blur?.();
                        } else {
                          setIsSearchExpanded(true);
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: isSearchVisible }}
                      accessibilityLabel="Toggle thread search"
                    >
                      <SearchIcon
                        color={
                          isSearchVisible
                            ? colors.primaryText
                            : colors.textMuted
                        }
                      />
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.headerIconBtn}
                      onPress={() => {
                        setIsMachineMenuOpen(false);
                        onRefreshInbox(false);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={
                        activeMode === 'projects'
                          ? 'Refresh Projects'
                          : 'Refresh Thread Inbox'
                      }
                    >
                      {isRefreshing ? (
                        <ActivityIndicator
                          size="small"
                          color={colors.primaryText}
                        />
                      ) : (
                        <Text style={styles.headerSyncGlyph}>↻</Text>
                      )}
                    </TouchableOpacity>
                  </>
                ) : activeMode === 'usage' ? (
                  <>
                    {usageUpdatedLabel ? (
                      <Text style={styles.headerFreshnessText} numberOfLines={1}>
                        {usageUpdatedLabel}
                      </Text>
                    ) : null}
                    <TouchableOpacity
                      style={styles.headerIconBtn}
                      onPress={() => {
                        setIsMachineMenuOpen(false);
                        onRefreshInbox(true);
                      }}
                      disabled={isRefreshing || stage !== 'authenticated'}
                      accessibilityRole="button"
                      accessibilityLabel="Refresh Usage Stats"
                    >
                      {isRefreshing ? (
                        <ActivityIndicator
                          size="small"
                          color={colors.primaryText}
                        />
                      ) : (
                        <Text style={styles.headerSyncGlyph}>↻</Text>
                      )}
                    </TouchableOpacity>
                  </>
                ) : (
                  <Text style={styles.headerModeLabel}>Settings</Text>
                )}
              </View>
            </View>

            {activeMode === 'inbox' ? (
              <View style={styles.modeBody}>
                {/* Row 2: Clean Underline Filter Strip + Contextual Read All */}
                <View style={styles.filterStrip}>
                  <View style={styles.filterTabsGroup}>
                    {(
                      [
                        {
                          key: 'all' as const,
                          label: 'All',
                          a11yLabel: 'All',
                          count: counts.all,
                        },
                        {
                          key: 'attention' as const,
                          label: 'Attention',
                          a11yLabel: 'Needs Attention',
                          count: counts.attention,
                        },
                        {
                          key: 'running' as const,
                          label: 'Running',
                          a11yLabel: 'Running',
                          count: counts.running,
                        },
                      ] as const
                    ).map((tab) => {
                      const selected = selectedTab === tab.key;
                      return (
                        <TouchableOpacity
                          key={tab.key}
                          style={[
                            styles.filterTabBtn,
                            selected ? styles.filterTabBtnSelected : null,
                          ]}
                          onPress={() => setSelectedTab(tab.key)}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`Inbox tab ${tab.a11yLabel}`}
                        >
                          <Text
                            style={[
                              styles.filterTabText,
                              selected ? styles.filterTabTextSelected : null,
                            ]}
                            numberOfLines={1}
                          >
                            {tab.label}
                          </Text>
                          <View
                            style={[
                              styles.tabCountBadge,
                              selected ? styles.tabCountBadgeSelected : null,
                            ]}
                          >
                            <Text
                              style={[
                                styles.tabCountText,
                                selected ? styles.tabCountTextSelected : null,
                              ]}
                            >
                              {tab.count}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {counts.dismissible > 0 ? (
                    <TouchableOpacity
                      style={styles.readAllInlineBtn}
                      onPress={onMarkAllRead}
                      accessibilityRole="button"
                      accessibilityLabel="Mark all threads as read"
                    >
                      <Text style={styles.readAllInlineText}>Read all</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>

                {isSearchVisible ? (
                  <View style={styles.searchBarRow}>
                    <SearchIcon color={colors.textMuted} compact />
                    <TextInput
                      ref={searchInputRef}
                      style={styles.searchInput}
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Filter threads…"
                      placeholderTextColor={colors.textPlaceholder}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoFocus={visible && isSearchExpanded}
                      returnKeyType="search"
                      accessibilityLabel="Filter Inbox threads"
                    />
                    <TouchableOpacity
                      style={styles.searchClearBtn}
                      onPress={() => {
                        setSearchQuery('');
                        setIsSearchExpanded(false);
                        searchInputRef.current?.blur?.();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Close thread search"
                    >
                      <Text style={styles.searchClearText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}

                {snapshot.error ? (
                  <View style={styles.errorBanner}>
                    <Text style={styles.errorBannerText} numberOfLines={2}>
                      {snapshot.error}
                    </Text>
                  </View>
                ) : null}

                <ScrollView
                  ref={inboxScrollViewRef}
                  style={styles.flexScroll}
                  contentContainerStyle={styles.listContent}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                  scrollEventThrottle={16}
                  onLayout={handleInboxScrollLayout}
                  onScroll={handleInboxScroll}
                  onContentSizeChange={handleInboxContentSizeChange}
                >
                  {filteredThreads.length > 0 ? (
                    filteredThreads.map((thread) =>
                      renderThreadCard(thread, 'inbox'),
                    )
                  ) : (
                    <View style={styles.emptyState}>
                      {stage !== 'authenticated' ? (
                        <>
                          <Text style={styles.emptyTitle}>
                            Sign in required
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            Complete Google Sign-In in the workspace or open
                            Settings to reload or manage your connection.
                          </Text>
                          <TouchableOpacity
                            style={styles.emptyActionBtn}
                            onPress={() => setActiveMode('settings')}
                            accessibilityRole="button"
                            accessibilityLabel="Open Settings from Inbox"
                          >
                            <Text style={styles.emptyActionBtnText}>
                              Open Settings
                            </Text>
                          </TouchableOpacity>
                        </>
                      ) : isRefreshing && snapshot.fetchedAtMs === 0 ? (
                        <>
                          <ActivityIndicator size="small" color="#60A5FA" />
                          <Text style={styles.emptyTitle}>
                            Checking connected workstations…
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            Querying active Antigravity conversations across
                            your machines.
                          </Text>
                        </>
                      ) : counts.all === 0 &&
                        connectedInstances.length === 0 ? (
                        <>
                          <Text style={styles.emptyTitle}>
                            No connected workstations
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            Run agy --remote-control on your computer, or open a
                            machine link directly.
                          </Text>
                          <TouchableOpacity
                            style={styles.emptyActionBtn}
                            onPress={() => {
                              setActiveMode('settings');
                              setIsHandoffExpanded(true);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="Open machine link from Inbox"
                          >
                            <Text style={styles.emptyActionBtnText}>
                              Open Link or Machine ID
                            </Text>
                          </TouchableOpacity>
                        </>
                      ) : searchQuery.trim().length > 0 ? (
                        <>
                          <Text style={styles.emptyTitle}>
                            No matching threads
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            No conversations matched &ldquo;
                            {searchQuery.trim()}&rdquo; in this view.
                          </Text>
                        </>
                      ) : selectedTab === 'attention' ? (
                        <>
                          <Text style={styles.emptyTitle}>All caught up</Text>
                          <Text style={styles.emptySubtitle}>
                            No threads are waiting for approval or unread across
                            your connected machines.
                          </Text>
                          {counts.all > 0 ? (
                            <TouchableOpacity
                              style={styles.emptyActionBtn}
                              onPress={() => setSelectedTab('all')}
                              accessibilityRole="button"
                              accessibilityLabel="Browse all threads"
                            >
                              <Text style={styles.emptyActionBtnText}>
                                Browse all {counts.all}{' '}
                                {counts.all === 1 ? 'thread' : 'threads'}
                              </Text>
                            </TouchableOpacity>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <Text style={styles.emptyTitle}>
                            {selectedTab === 'running'
                              ? 'No agents currently running'
                              : 'No recent threads found'}
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            {selectedTab === 'running'
                              ? 'Active agent runs will appear here automatically.'
                              : 'Start a conversation on a connected workstation to track it here.'}
                          </Text>
                        </>
                      )}
                    </View>
                  )}
                </ScrollView>
              </View>
            ) : activeMode === 'projects' ? (
              <View style={styles.modeBody}>
                <View style={styles.projectsSummaryBar}>
                  <Text style={styles.projectsSummaryText} numberOfLines={1}>
                    {projectGroups.length}{' '}
                    {projectGroups.length === 1 ? 'project' : 'projects'} •{' '}
                    {counts.all} {counts.all === 1 ? 'thread' : 'threads'}
                  </Text>
                  <View style={styles.projectsSummaryActionsRow}>
                    {counts.dismissible > 0 ? (
                      <TouchableOpacity
                        style={styles.readAllInlineBtn}
                        onPress={onMarkAllRead}
                        accessibilityRole="button"
                        accessibilityLabel="Mark all project notifications as read"
                      >
                        <Text style={styles.readAllInlineText}>Read all</Text>
                      </TouchableOpacity>
                    ) : null}
                    {projectGroups.length > 1 ? (
                      <TouchableOpacity
                        style={styles.readAllInlineBtn}
                        onPress={toggleAllProjectsCollapsed}
                        accessibilityRole="button"
                        accessibilityLabel={
                          allProjectsCollapsed
                            ? 'Expand all projects'
                            : 'Collapse all projects'
                        }
                      >
                        <Text style={styles.readAllInlineText}>
                          {allProjectsCollapsed ? 'Expand all' : 'Collapse all'}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    {stage === 'authenticated' &&
                    connectedInstances.length > 0 &&
                    onCreateProject ? (
                      <TouchableOpacity
                        style={[
                          styles.addProjectHeaderBtn,
                          isAddProjectOpen
                            ? styles.addProjectHeaderBtnActive
                            : null,
                        ]}
                        onPress={() => {
                          if (isAddProjectOpen) {
                            handleCloseAddProject();
                          } else {
                            handleOpenAddProject();
                          }
                        }}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: isAddProjectOpen }}
                        accessibilityLabel="Add new project"
                      >
                        <Text style={styles.addProjectHeaderBtnText}>
                          {isAddProjectOpen ? 'Cancel' : '+ Project'}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>

                {isSearchVisible ? (
                  <View style={styles.searchBarRow}>
                    <SearchIcon color={colors.textMuted} compact />
                    <TextInput
                      ref={searchInputRef}
                      style={styles.searchInput}
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Filter projects or threads…"
                      placeholderTextColor={colors.textPlaceholder}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoFocus={visible && isSearchExpanded}
                      returnKeyType="search"
                      accessibilityLabel="Filter Projects"
                    />
                    <TouchableOpacity
                      style={styles.searchClearBtn}
                      onPress={() => {
                        setSearchQuery('');
                        setIsSearchExpanded(false);
                        searchInputRef.current?.blur?.();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Close thread search"
                    >
                      <Text style={styles.searchClearText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}

                {snapshot.error ? (
                  <View style={styles.errorBanner}>
                    <Text style={styles.errorBannerText} numberOfLines={2}>
                      {snapshot.error}
                    </Text>
                  </View>
                ) : null}

                <ScrollView
                  style={styles.flexScroll}
                  contentContainerStyle={styles.listContent}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {isAddProjectOpen && onCreateProject ? (
                    <View
                      testID="add-project-panel"
                      style={styles.addProjectCard}
                    >
                      <View style={styles.addProjectHeaderRow}>
                        <Text style={styles.addProjectTitle}>Add Project</Text>
                        <TouchableOpacity
                          style={styles.searchClearBtn}
                          onPress={handleCloseAddProject}
                          accessibilityRole="button"
                          accessibilityLabel="Close add project panel"
                        >
                          <Text style={styles.searchClearText}>✕</Text>
                        </TouchableOpacity>
                      </View>

                      {connectedInstances.length > 1 ? (
                        <View style={styles.addProjectWorkstationRow}>
                          {connectedInstances.map((inst) => {
                            const selected =
                              (addProjectInstanceUuid ||
                                connectedInstances[0]?.uuid) === inst.uuid;
                            return (
                              <TouchableOpacity
                                key={inst.uuid}
                                style={[
                                  styles.addProjectWorkstationChip,
                                  selected
                                    ? styles.addProjectWorkstationChipSelected
                                    : null,
                                ]}
                                onPress={() =>
                                  handleSelectAddProjectInstance(inst.uuid)
                                }
                                accessibilityRole="button"
                                accessibilityState={{ selected }}
                                accessibilityLabel={`Target workstation ${inst.name}`}
                              >
                                <Text
                                  style={[
                                    styles.addProjectWorkstationChipText,
                                    selected
                                      ? styles.addProjectWorkstationChipTextSelected
                                      : null,
                                  ]}
                                  numberOfLines={1}
                                >
                                  {inst.name}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      ) : null}

                      <View style={styles.addProjectModeWell}>
                        <TouchableOpacity
                          style={[
                            styles.addProjectModeKey,
                            addProjectMode === 'existing'
                              ? styles.addProjectModeKeyActive
                              : null,
                          ]}
                          onPress={() => {
                            setAddProjectMode('existing');
                            setAddProjectError(null);
                            const targetUuid =
                              addProjectInstanceUuid ||
                              connectedInstances[0]?.uuid ||
                              '';
                            if (
                              targetUuid &&
                              onListDirectory &&
                              dirEntries.length === 0 &&
                              !isLoadingDir
                            ) {
                              void loadDirectoryForInstance(targetUuid, null);
                            }
                          }}
                          accessibilityRole="button"
                          accessibilityState={{
                            selected: addProjectMode === 'existing',
                          }}
                          accessibilityLabel="Add existing folder"
                        >
                          <Text
                            style={[
                              styles.addProjectModeKeyText,
                              addProjectMode === 'existing'
                                ? styles.addProjectModeKeyTextActive
                                : null,
                            ]}
                          >
                            Existing Folder
                          </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={[
                            styles.addProjectModeKey,
                            addProjectMode === 'scratch'
                              ? styles.addProjectModeKeyActive
                              : null,
                          ]}
                          onPress={() => {
                            setAddProjectMode('scratch');
                            setAddProjectError(null);
                          }}
                          accessibilityRole="button"
                          accessibilityState={{
                            selected: addProjectMode === 'scratch',
                          }}
                          accessibilityLabel="Create new folder"
                        >
                          <Text
                            style={[
                              styles.addProjectModeKeyText,
                              addProjectMode === 'scratch'
                                ? styles.addProjectModeKeyTextActive
                                : null,
                            ]}
                          >
                            New Folder
                          </Text>
                        </TouchableOpacity>
                      </View>

                      {addProjectMode === 'existing' ? (
                        <>
                          {onListDirectory ? (
                            <View style={styles.dirBrowserBox}>
                              <View style={styles.dirBrowserToolbar}>
                                {dirParentUri ? (
                                  <TouchableOpacity
                                    style={styles.dirUpBtn}
                                    onPress={() => {
                                      const targetUuid =
                                        addProjectInstanceUuid ||
                                        connectedInstances[0]?.uuid ||
                                        '';
                                      if (targetUuid) {
                                        void loadDirectoryForInstance(
                                          targetUuid,
                                          dirParentUri,
                                        );
                                      }
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel="Parent folder"
                                  >
                                    <Text style={styles.dirUpBtnText}>
                                      ↑ Up
                                    </Text>
                                  </TouchableOpacity>
                                ) : null}
                                <Text
                                  style={styles.dirCurrentPathText}
                                  numberOfLines={1}
                                >
                                  {dirCurrentPath || 'Remote directories'}
                                </Text>
                                <TouchableOpacity
                                  style={styles.dirRefreshBtn}
                                  onPress={() => {
                                    const targetUuid =
                                      addProjectInstanceUuid ||
                                      connectedInstances[0]?.uuid ||
                                      '';
                                    if (targetUuid) {
                                      void loadDirectoryForInstance(
                                        targetUuid,
                                        dirCurrentUri,
                                      );
                                    }
                                  }}
                                  accessibilityRole="button"
                                  accessibilityLabel="Refresh folder listing"
                                >
                                  <Text style={styles.dirRefreshGlyph}>↻</Text>
                                </TouchableOpacity>
                              </View>

                              {isLoadingDir ? (
                                <View style={styles.dirStatusRow}>
                                  <ActivityIndicator
                                    size="small"
                                    color={colors.primaryText}
                                  />
                                  <Text style={styles.dirStatusText}>
                                    Browsing workstation folders…
                                  </Text>
                                </View>
                              ) : dirError ? (
                                <Text style={styles.dirErrorText}>
                                  {dirError} Enter a folder path below.
                                </Text>
                              ) : dirEntries.length > 0 ? (
                                <ScrollView
                                  style={styles.dirListScroll}
                                  nestedScrollEnabled={true}
                                  keyboardShouldPersistTaps="handled"
                                  showsVerticalScrollIndicator={false}
                                >
                                  {dirEntries.map((entry) => (
                                    <TouchableOpacity
                                      key={entry.uri}
                                      style={styles.dirEntryRow}
                                      onPress={() => {
                                        const targetUuid =
                                          addProjectInstanceUuid ||
                                          connectedInstances[0]?.uuid ||
                                          '';
                                        setAddProjectPath(
                                          formatUriAsDisplayPath(entry.uri),
                                        );
                                        if (targetUuid) {
                                          void loadDirectoryForInstance(
                                            targetUuid,
                                            entry.uri,
                                          );
                                        }
                                      }}
                                      accessibilityRole="button"
                                      accessibilityLabel={`Open folder ${entry.name}`}
                                    >
                                      <Text style={styles.dirEntryIcon}>▸</Text>
                                      <Text
                                        style={styles.dirEntryName}
                                        numberOfLines={1}
                                      >
                                        {entry.name}
                                      </Text>
                                    </TouchableOpacity>
                                  ))}
                                </ScrollView>
                              ) : (
                                <Text style={styles.dirStatusText}>
                                  No subfolders here — add this folder or enter
                                  a path below.
                                </Text>
                              )}
                            </View>
                          ) : null}

                          <Text style={styles.addProjectFieldLabel}>
                            Folder path
                          </Text>
                          <TextInput
                            style={styles.addProjectInput}
                            value={addProjectPath}
                            onChangeText={(text) => {
                              setAddProjectPath(text);
                              if (addProjectError) setAddProjectError(null);
                            }}
                            placeholder="/path/to/project"
                            placeholderTextColor={colors.textPlaceholder}
                            autoCapitalize="none"
                            autoCorrect={false}
                            accessibilityLabel="Project folder path"
                          />

                          <Text style={styles.addProjectFieldLabel}>
                            Display name (optional)
                          </Text>
                          <TextInput
                            style={styles.addProjectInput}
                            value={addProjectName}
                            onChangeText={(text) => {
                              setAddProjectName(text);
                              if (addProjectError) setAddProjectError(null);
                            }}
                            placeholder={
                              deriveFolderBasename(addProjectPath) ||
                              'Auto-detected from folder'
                            }
                            placeholderTextColor={colors.textPlaceholder}
                            autoCapitalize="none"
                            autoCorrect={false}
                            accessibilityLabel="Project name"
                          />
                        </>
                      ) : (
                        <>
                          <Text style={styles.addProjectFieldLabel}>
                            New project name
                          </Text>
                          <TextInput
                            style={styles.addProjectInput}
                            value={addProjectName}
                            onChangeText={(text) => {
                              setAddProjectName(text);
                              if (addProjectError) setAddProjectError(null);
                            }}
                            placeholder="my-new-project"
                            placeholderTextColor={colors.textPlaceholder}
                            autoCapitalize="none"
                            autoCorrect={false}
                            returnKeyType="done"
                            onSubmitEditing={() => {
                              void handleSubmitAddProject();
                            }}
                            accessibilityLabel="New project name"
                          />
                          <Text style={styles.addProjectHelperText}>
                            Creates a new folder in the workstation&apos;s
                            default projects directory.
                          </Text>
                        </>
                      )}

                      {addProjectError ? (
                        <Text style={styles.errorText}>{addProjectError}</Text>
                      ) : null}

                      <View style={styles.addProjectFooterRow}>
                        <TouchableOpacity
                          style={styles.addProjectCancelBtn}
                          onPress={handleCloseAddProject}
                          disabled={isSubmittingProject}
                          accessibilityRole="button"
                          accessibilityLabel="Cancel adding project"
                        >
                          <Text style={styles.addProjectCancelText}>
                            Cancel
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[
                            styles.addProjectSubmitBtn,
                            isSubmittingProject
                              ? styles.addProjectSubmitBtnDisabled
                              : null,
                          ]}
                          onPress={() => {
                            void handleSubmitAddProject();
                          }}
                          disabled={isSubmittingProject}
                          accessibilityRole="button"
                          accessibilityLabel={
                            addProjectMode === 'existing'
                              ? 'Confirm add project'
                              : 'Confirm create project'
                          }
                        >
                          {isSubmittingProject ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.white}
                            />
                          ) : (
                            <Text style={styles.addProjectSubmitText}>
                              {addProjectMode === 'existing'
                                ? 'Add Project'
                                : 'Create Project'}
                            </Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : null}

                  {filteredProjectGroups.length > 0 ? (
                    filteredProjectGroups.map((group) => {
                      const isCollapsed =
                        Boolean(collapsedProjectIds[group.id]) &&
                        searchQuery.trim().length === 0;
                      const isExpanded = !isCollapsed;
                      return (
                        <View
                          key={group.id}
                          style={[
                            styles.projectCard,
                            group.hasActiveThread
                              ? styles.projectCardActive
                              : null,
                          ]}
                        >
                          <View style={styles.projectHeaderRow}>
                            <TouchableOpacity
                              style={styles.projectHeaderToggle}
                              activeOpacity={0.82}
                              onPress={() => toggleProjectCollapsed(group.id)}
                              accessibilityRole="button"
                              accessibilityState={{ expanded: isExpanded }}
                              accessibilityLabel={`Project ${group.name}`}
                            >
                              <ChevronIcon
                                expanded={isExpanded}
                                color={
                                  group.hasActiveThread
                                    ? colors.primaryText
                                    : colors.textMuted
                                }
                              />
                              <View style={styles.projectHeaderMeta}>
                                <View style={styles.projectTitleRow}>
                                  <Text
                                    style={styles.projectTitleText}
                                    numberOfLines={1}
                                  >
                                    {group.name}
                                  </Text>
                                  {group.attentionCount > 0 ? (
                                    <View
                                      style={[
                                        styles.projectStatusBadge,
                                        group.urgentCount > 0
                                          ? styles.projectStatusBadgeUrgent
                                          : styles.projectStatusBadgeUnread,
                                      ]}
                                    >
                                      <Text
                                        style={styles.projectStatusBadgeText}
                                      >
                                        {group.attentionCount}
                                      </Text>
                                    </View>
                                  ) : group.runningCount > 0 ? (
                                    <View style={styles.projectRunningDot} />
                                  ) : null}
                                </View>
                                <Text
                                  style={styles.projectSubtitleText}
                                  numberOfLines={1}
                                >
                                  {group.instanceName} • {group.threads.length}{' '}
                                  {group.threads.length === 1
                                    ? 'thread'
                                    : 'threads'}
                                  {group.latestModifiedAtMs > 0
                                    ? ` • ${formatRelativeTime(group.latestModifiedAtMs)}`
                                    : ''}
                                </Text>
                              </View>
                            </TouchableOpacity>

                            <TouchableOpacity
                              style={styles.projectNewChatBtn}
                              activeOpacity={0.82}
                              onPress={() => handleStartNewProjectChat(group)}
                              accessibilityRole="button"
                              accessibilityLabel={`New chat in ${group.name}`}
                            >
                              <Text style={styles.projectNewChatBtnText}>
                                + New
                              </Text>
                            </TouchableOpacity>
                          </View>

                          {isExpanded ? (
                            <View style={styles.projectThreadsTray}>
                              {group.threads.length > 0 ? (
                                group.threads.map((thread) =>
                                  renderThreadCard(thread, 'project'),
                                )
                              ) : (
                                <View style={styles.projectEmptyThreadsRow}>
                                  <Text style={styles.projectEmptyThreadsText}>
                                    No conversations yet — tap + New to start
                                    one on {group.instanceName}.
                                  </Text>
                                </View>
                              )}
                            </View>
                          ) : null}
                        </View>
                      );
                    })
                  ) : (
                    <View style={styles.emptyState}>
                      {stage !== 'authenticated' ? (
                        <>
                          <Text style={styles.emptyTitle}>
                            Sign in required
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            Complete Google Sign-In in the workspace or open
                            Settings to reload or manage your connection.
                          </Text>
                          <TouchableOpacity
                            style={styles.emptyActionBtn}
                            onPress={() => setActiveMode('settings')}
                            accessibilityRole="button"
                            accessibilityLabel="Open Settings from Projects"
                          >
                            <Text style={styles.emptyActionBtnText}>
                              Open Settings
                            </Text>
                          </TouchableOpacity>
                        </>
                      ) : isRefreshing && snapshot.fetchedAtMs === 0 ? (
                        <>
                          <ActivityIndicator
                            size="small"
                            color={colors.primaryText}
                          />
                          <Text style={styles.emptyTitle}>
                            Checking connected workstations…
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            Loading all Antigravity projects across your
                            machines.
                          </Text>
                        </>
                      ) : projectGroups.length === 0 &&
                        connectedInstances.length === 0 ? (
                        <>
                          <Text style={styles.emptyTitle}>
                            No connected workstations
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            Run agy --remote-control on your computer, or open a
                            machine link directly.
                          </Text>
                          <TouchableOpacity
                            style={styles.emptyActionBtn}
                            onPress={() => {
                              setActiveMode('settings');
                              setIsHandoffExpanded(true);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="Open machine link from Projects"
                          >
                            <Text style={styles.emptyActionBtnText}>
                              Open Link or Machine ID
                            </Text>
                          </TouchableOpacity>
                        </>
                      ) : searchQuery.trim().length > 0 ? (
                        <>
                          <Text style={styles.emptyTitle}>
                            No matching projects
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            No projects or threads matched &ldquo;
                            {searchQuery.trim()}&rdquo;.
                          </Text>
                        </>
                      ) : (
                        <>
                          <Text style={styles.emptyTitle}>
                            No projects found
                          </Text>
                          <Text style={styles.emptySubtitle}>
                            Add a project folder on your connected workstation
                            to start browsing and launching conversations here.
                          </Text>
                          {onCreateProject ? (
                            <TouchableOpacity
                              style={styles.emptyActionBtn}
                              onPress={handleOpenAddProject}
                              accessibilityRole="button"
                              accessibilityLabel="Add first project"
                            >
                              <Text style={styles.emptyActionBtnText}>
                                + Add Project
                              </Text>
                            </TouchableOpacity>
                          ) : null}
                        </>
                      )}
                    </View>
                  )}
                </ScrollView>
              </View>
            ) : activeMode === 'usage' ? (
              <View style={styles.modeBody}>
                <ScrollView
                  style={styles.flexScroll}
                  contentContainerStyle={styles.usageScrollContent}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {stage !== 'authenticated' ? (
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyTitle}>Sign in required</Text>
                      <Text style={styles.emptySubtitle}>
                        Complete Google Sign-In to view your Antigravity model
                        quotas and credits.
                      </Text>
                      <TouchableOpacity
                        style={styles.emptyActionBtn}
                        onPress={() => setActiveMode('settings')}
                        accessibilityRole="button"
                        accessibilityLabel="Open Settings from Usage"
                      >
                        <Text style={styles.emptyActionBtnText}>
                          Open Settings
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : isRefreshing && snapshot.fetchedAtMs === 0 && !usage ? (
                    <View style={styles.emptyState}>
                      <ActivityIndicator size="small" color="#60A5FA" />
                      <Text style={styles.emptyTitle}>
                        Loading usage stats…
                      </Text>
                      <Text style={styles.emptySubtitle}>
                        Querying quota windows and credits from your connected
                        workstation.
                      </Text>
                    </View>
                  ) : !usage &&
                    counts.all === 0 &&
                    connectedInstances.length === 0 ? (
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyTitle}>
                        No connected workstations
                      </Text>
                      <Text style={styles.emptySubtitle}>
                        Run agy --remote-control on your computer, or open a
                        machine link directly to inspect live quotas.
                      </Text>
                      <TouchableOpacity
                        style={styles.emptyActionBtn}
                        onPress={() => {
                          setActiveMode('settings');
                          setIsHandoffExpanded(true);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Open machine link from Usage"
                      >
                        <Text style={styles.emptyActionBtnText}>
                          Open Link or Machine ID
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <>
                      {usage &&
                      (usage.planName ||
                        usage.accountEmail ||
                        visibleUsageCredits.length > 0) ? (
                        <View style={styles.usageCard}>
                          {usage.planName || usage.accountEmail ? (
                            <View style={styles.usagePlanRow}>
                              {usage.planName ? (
                                <View style={styles.usageTierPill}>
                                  <Text
                                    style={styles.usageTierPillText}
                                    numberOfLines={1}
                                  >
                                    {usage.planName}
                                  </Text>
                                </View>
                              ) : null}
                              {usage.accountEmail ? (
                                <Text
                                  style={styles.usageAccountEmail}
                                  numberOfLines={1}
                                >
                                  {usage.accountEmail}
                                </Text>
                              ) : null}
                            </View>
                          ) : null}

                          {visibleUsageCredits.map((credit, idx) => (
                            <View
                              key={credit.id}
                              style={[
                                styles.usageCreditRow,
                                idx > 0 || usage.planName || usage.accountEmail
                                  ? styles.usageCreditRowBorder
                                  : null,
                              ]}
                            >
                              <Text
                                style={styles.usageCreditLabel}
                                numberOfLines={1}
                              >
                                {credit.label}
                              </Text>
                              <Text style={styles.usageCreditValue}>
                                {formatNumberWithCommas(credit.available)}
                                {credit.limit
                                  ? ` / ${formatNumberWithCommas(credit.limit)}`
                                  : ''}
                              </Text>
                            </View>
                          ))}
                        </View>
                      ) : null}

                      {usage && usage.groups.length > 0 ? (
                        <View style={styles.usageSection}>
                          <Text style={styles.usageSectionTitle}>
                            QUOTA POOLS
                          </Text>
                          {usage.groups.map((group) => (
                            <View key={group.id} style={styles.usageCard}>
                              <Text
                                style={styles.usageGroupTitle}
                                numberOfLines={1}
                              >
                                {group.label}
                              </Text>
                              {group.buckets.map((bucket, idx) => {
                                const clamped = Math.max(
                                  0,
                                  Math.min(1, bucket.remainingFraction),
                                );
                                const pct = Math.round(clamped * 100);
                                const visuals = getQuotaVisuals(
                                  clamped,
                                  bucket.isExhausted,
                                );
                                const countdown = formatResetCountdown(
                                  bucket.resetTimeMs,
                                );
                                return (
                                  <View
                                    key={bucket.id}
                                    style={[
                                      styles.usageQuotaItem,
                                      idx > 0
                                        ? styles.usageQuotaItemDivider
                                        : null,
                                    ]}
                                  >
                                    <View style={styles.usageQuotaHeaderRow}>
                                      <Text
                                        style={styles.usageQuotaLabel}
                                        numberOfLines={1}
                                      >
                                        {bucket.label}
                                      </Text>
                                      <View
                                        style={[
                                          styles.usagePctBadge,
                                          {
                                            backgroundColor:
                                              visuals.badgeBgColor,
                                            borderColor:
                                              visuals.badgeBorderColor,
                                          },
                                        ]}
                                      >
                                        <Text
                                          style={[
                                            styles.usagePctBadgeText,
                                            { color: visuals.textColor },
                                          ]}
                                        >
                                          {bucket.isExhausted || pct === 0
                                            ? 'Exhausted'
                                            : `${pct}% left`}
                                        </Text>
                                      </View>
                                    </View>
                                    <View style={styles.usageProgressTrack}>
                                      <View
                                        style={[
                                          styles.usageProgressFill,
                                          {
                                            width: `${pct}%`,
                                            backgroundColor: visuals.barColor,
                                          },
                                        ]}
                                      />
                                    </View>
                                    <Text style={styles.usageResetText}>
                                      {countdown ||
                                        (bucket.isExhausted
                                          ? 'Quota exhausted'
                                          : 'Full quota available')}
                                    </Text>
                                  </View>
                                );
                              })}
                            </View>
                          ))}
                        </View>
                      ) : null}

                      {usage && usage.models.length > 0 ? (
                        <View style={styles.usageSection}>
                          <Text style={styles.usageSectionTitle}>
                            MODEL QUOTAS
                          </Text>
                          <View style={styles.usageCard}>
                            {usage.models.map((model, idx) => {
                              const clamped = Math.max(
                                0,
                                Math.min(1, model.remainingFraction),
                              );
                              const pct = Math.round(clamped * 100);
                              const visuals = getQuotaVisuals(
                                clamped,
                                model.isExhausted,
                              );
                              const countdown = formatResetCountdown(
                                model.resetTimeMs,
                              );
                              return (
                                <View
                                  key={model.id}
                                  style={[
                                    styles.usageQuotaItem,
                                    idx > 0
                                      ? styles.usageQuotaItemDivider
                                      : null,
                                  ]}
                                >
                                  <View style={styles.usageQuotaHeaderRow}>
                                    <View style={styles.usageModelTitleRow}>
                                      <Text
                                        style={styles.usageQuotaLabel}
                                        numberOfLines={1}
                                      >
                                        {model.label}
                                      </Text>
                                      {model.isDefault ||
                                      model.isRecommended ? (
                                        <View style={styles.usageDefaultTag}>
                                          <Text
                                            style={styles.usageDefaultTagText}
                                          >
                                            {model.isDefault
                                              ? 'DEFAULT'
                                              : 'REC'}
                                          </Text>
                                        </View>
                                      ) : null}
                                    </View>
                                    <View
                                      style={[
                                        styles.usagePctBadge,
                                        {
                                          backgroundColor: visuals.badgeBgColor,
                                          borderColor: visuals.badgeBorderColor,
                                        },
                                      ]}
                                    >
                                      <Text
                                        style={[
                                          styles.usagePctBadgeText,
                                          { color: visuals.textColor },
                                        ]}
                                      >
                                        {model.isExhausted || pct === 0
                                          ? 'Exhausted'
                                          : `${pct}%`}
                                      </Text>
                                    </View>
                                  </View>
                                  <View style={styles.usageProgressTrack}>
                                    <View
                                      style={[
                                        styles.usageProgressFill,
                                        {
                                          width: `${pct}%`,
                                          backgroundColor: visuals.barColor,
                                        },
                                      ]}
                                    />
                                  </View>
                                  <Text style={styles.usageResetText}>
                                    {countdown ||
                                      (model.isExhausted
                                        ? 'Quota exhausted'
                                        : 'Available')}
                                  </Text>
                                </View>
                              );
                            })}
                          </View>
                        </View>
                      ) : null}

                      {usage?.error ? (
                        <View style={styles.errorBanner}>
                          <Text style={styles.errorBannerText}>
                            {usage.error}
                          </Text>
                        </View>
                      ) : !usage && !isRefreshing ? (
                        <View style={styles.usageInfoBanner}>
                          <Text style={styles.usageInfoBannerText}>
                            Live model quota windows appear automatically when a
                            connected Antigravity workstation responds. Tap
                            Refresh to query now.
                          </Text>
                        </View>
                      ) : null}

                      <View style={styles.usageSection}>
                        <Text style={styles.usageSectionTitle}>
                          WORKSTATION ACTIVITY
                        </Text>
                        <View style={styles.usageMetricsGrid}>
                          <View style={styles.usageMetricTile}>
                            <Text style={styles.usageMetricValue}>
                              {connectedInstances.length}
                            </Text>
                            <Text style={styles.usageMetricLabel}>
                              {connectedInstances.length === 1
                                ? 'Machine'
                                : 'Machines'}
                            </Text>
                          </View>
                          <View style={styles.usageMetricTile}>
                            <Text
                              style={[
                                styles.usageMetricValue,
                                counts.running > 0
                                  ? styles.usageMetricValueActive
                                  : null,
                              ]}
                            >
                              {counts.running}
                            </Text>
                            <Text style={styles.usageMetricLabel}>Running</Text>
                          </View>
                          <View style={styles.usageMetricTile}>
                            <Text style={styles.usageMetricValue}>
                              {formatNumberWithCommas(activityStats.totalSteps)}
                            </Text>
                            <Text
                              style={styles.usageMetricLabel}
                              numberOfLines={1}
                            >
                              {counts.all === 1
                                ? 'Steps (1 chat)'
                                : `Steps (${counts.all})`}
                            </Text>
                          </View>
                        </View>

                        {activityStats.firstBudgetPausedThread ? (
                          <TouchableOpacity
                            style={styles.usageBudgetAlertBtn}
                            onPress={() => {
                              resetTransientInputs();
                              isDraggingOpenRef.current = false;
                              setIsDraggingOpen(false);
                              onSelectThread(
                                activityStats.firstBudgetPausedThread!,
                              );
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="Open budget-paused thread"
                          >
                            <Text style={styles.usageBudgetAlertText}>
                              {activityStats.budgetPausedCount === 1
                                ? '1 thread paused on token/step budget — tap to open'
                                : `${activityStats.budgetPausedCount} threads paused on token/step budget — tap to open`}
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    </>
                  )}
                </ScrollView>
              </View>
            ) : (
              <ScrollView
                style={styles.flexScroll}
                contentContainerStyle={styles.sessionScrollContent}
                bounces={false}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={styles.keepAliveSection}>
                  <Text style={styles.sectionLabel}>Action Notifications</Text>
                  <Text style={styles.keepAliveDescription}>
                    Notify when an agent needs approval, asks a question, or
                    finishes. Updates with open action count; opens the thread
                    (if 1) or Inbox (if multiple).
                  </Text>
                  <View style={styles.keepAliveRow}>
                    {(
                      [
                        {
                          key: 'off' as const,
                          label: 'Off',
                          a11yLabel: 'Action notifications Off',
                        },
                        {
                          key: 'approvals' as const,
                          label: 'Approvals',
                          a11yLabel: 'Action notifications Approvals',
                        },
                        {
                          key: 'all_attention' as const,
                          label: 'All Attention',
                          a11yLabel: 'Action notifications All Attention',
                        },
                      ] as const
                    ).map((option) => {
                      const selected = actionNotificationMode === option.key;
                      return (
                        <TouchableOpacity
                          key={option.key}
                          style={[
                            styles.keepAliveChip,
                            selected ? styles.keepAliveChipSelected : null,
                          ]}
                          onPress={() =>
                            onChangeActionNotificationMode?.(option.key)
                          }
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={option.a11yLabel}
                        >
                          <Text
                            style={[
                              styles.keepAliveChipText,
                              selected
                                ? styles.keepAliveChipTextSelected
                                : null,
                            ]}
                            numberOfLines={1}
                          >
                            {option.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <Text style={styles.keepAliveHint}>
                    {actionNotificationMode === 'off'
                      ? 'Notifications disabled.'
                      : keepAliveMinutes > 0
                        ? actionNotificationMode === 'approvals'
                          ? 'Active for blocking approvals & questions • Background updates enabled.'
                          : 'Active for approvals, questions & finished runs • Background updates enabled.'
                        : 'Alerts while connected • Select a background timer below to receive alerts after switching apps.'}
                  </Text>
                </View>

                <View style={styles.sectionDivider} />

                <View style={styles.keepAliveSection}>
                  <Text style={styles.sectionLabel}>
                    Stay Connected in Background
                  </Text>
                  <Text style={styles.keepAliveDescription}>
                    Avoid reconnecting while switching to 2FA, chat, or browser
                    apps, and keep updating state for alerts while the phone is
                    locked.
                  </Text>
                  <View style={styles.keepAliveRow}>
                    {isAndroid
                      ? KEEP_ALIVE_DURATION_OPTIONS.map((minutes) => {
                          const selected = keepAliveMinutes === minutes;
                          const label = minutes === 0 ? 'Off' : `${minutes}m`;
                          return (
                            <TouchableOpacity
                              key={minutes}
                              style={[
                                styles.keepAliveChip,
                                selected ? styles.keepAliveChipSelected : null,
                              ]}
                              onPress={() =>
                                onChangeKeepAliveMinutes?.(minutes)
                              }
                              accessibilityRole="button"
                              accessibilityState={{ selected }}
                              accessibilityLabel={`Keep-alive ${label}`}
                            >
                              <Text
                                style={[
                                  styles.keepAliveChipText,
                                  selected
                                    ? styles.keepAliveChipTextSelected
                                    : null,
                                ]}
                              >
                                {label}
                              </Text>
                            </TouchableOpacity>
                          );
                        })
                      : (
                          [
                            {
                              label: 'Off',
                              value: 0 as KeepAliveMinutes,
                              selected: keepAliveMinutes === 0,
                            },
                            {
                              label: 'On (~30s)',
                              value:
                                IOS_KEEP_ALIVE_ENABLED_MINUTES as KeepAliveMinutes,
                              selected: keepAliveMinutes > 0,
                            },
                          ] as const
                        ).map((option) => (
                          <TouchableOpacity
                            key={option.label}
                            style={[
                              styles.keepAliveChip,
                              option.selected
                                ? styles.keepAliveChipSelected
                                : null,
                            ]}
                            onPress={() =>
                              onChangeKeepAliveMinutes?.(option.value)
                            }
                            accessibilityRole="button"
                            accessibilityState={{ selected: option.selected }}
                            accessibilityLabel={`Keep-alive ${
                              option.value === 0 ? 'Off' : 'On'
                            }`}
                          >
                            <Text
                              style={[
                                styles.keepAliveChipText,
                                option.selected
                                  ? styles.keepAliveChipTextSelected
                                  : null,
                              ]}
                            >
                              {option.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                  </View>
                  <Text style={styles.keepAliveHint}>{keepAliveHint}</Text>
                </View>

                <View style={styles.sectionDivider} />

                <Text style={styles.sectionLabel}>
                  Workspace & Troubleshooting
                </Text>

                <View style={styles.actionsGroup}>
                  <TouchableOpacity
                    style={styles.settingActionRow}
                    onPress={() => {
                      onReloadSession();
                      if (!docked) {
                        handleClose();
                      }
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Reload current page"
                  >
                    <Text style={styles.settingActionIcon}>↻</Text>
                    <Text style={styles.settingActionText}>
                      Reload Current Page
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.settingActionRow}
                    onPress={handleOpenDashboard}
                    accessibilityRole="button"
                    accessibilityLabel="Open All Machines overview"
                  >
                    <Text style={styles.settingActionIcon}>⊞</Text>
                    <Text style={styles.settingActionText}>
                      All Machines Overview
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.settingActionRow,
                      isHandoffExpanded ? styles.settingActionRowExpanded : null,
                    ]}
                    onPress={() => {
                      setIsHandoffExpanded((prev) => {
                        const next = !prev;
                        if (!next) {
                          setValidationError(null);
                          handoffInputRef.current?.blur?.();
                        }
                        return next;
                      });
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isHandoffExpanded }}
                    accessibilityLabel="Toggle machine link input"
                  >
                    <Text style={styles.settingActionIcon}>🔗</Text>
                    <Text style={styles.settingActionText}>
                      Open Link or Machine ID
                    </Text>
                    <Text style={styles.settingActionChevron}>
                      {isHandoffExpanded ? '▾' : '›'}
                    </Text>
                  </TouchableOpacity>

                  {isHandoffExpanded ? (
                    <View style={styles.handoffExpandedCard}>
                      <Text style={styles.sectionHint}>
                        Paste a /remote-control link or machine ID:
                      </Text>
                      <View style={styles.inputRow}>
                        <TextInput
                          ref={handoffInputRef}
                          style={styles.handoffInput}
                          value={handoffText}
                          onChangeText={(text) => {
                            setHandoffText(text);
                            if (validationError) {
                              setValidationError(null);
                            }
                          }}
                          placeholder="antigravity.google.com/r/devbox-..."
                          placeholderTextColor={colors.textPlaceholder}
                          autoCapitalize="none"
                          autoCorrect={false}
                          autoFocus={visible}
                          returnKeyType="go"
                          onSubmitEditing={handleConnectHandoff}
                          accessibilityLabel="Machine link or ID"
                        />
                        <TouchableOpacity
                          style={styles.connectButton}
                          onPress={handleConnectHandoff}
                          accessibilityRole="button"
                          accessibilityLabel="Connect to machine"
                        >
                          <Text style={styles.connectButtonText}>Go</Text>
                        </TouchableOpacity>
                      </View>
                      {validationError ? (
                        <Text style={styles.errorText}>{validationError}</Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>

                <View style={styles.sessionBottomSection}>
                  <View style={styles.accountStatusRow}>
                    <View
                      style={[
                        styles.accountStatusDot,
                        { backgroundColor: accountStatusDotColor },
                      ]}
                    />
                    <Text style={styles.accountStatusText} numberOfLines={1}>
                      {accountStatusText}
                    </Text>
                  </View>

                  {!confirmingSignOut ? (
                    <TouchableOpacity
                      style={styles.signOutButton}
                      onPress={() => setConfirmingSignOut(true)}
                      accessibilityRole="button"
                    >
                      <Text style={styles.signOutButtonText}>
                        Sign Out of Google Account
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={styles.confirmBox}>
                      <Text style={styles.confirmTitle}>
                        Sign out of your Google account on this device?
                      </Text>
                      <View style={styles.confirmButtonsRow}>
                        <TouchableOpacity
                          style={styles.cancelConfirmButton}
                          onPress={() => setConfirmingSignOut(false)}
                          accessibilityRole="button"
                        >
                          <Text style={styles.cancelConfirmText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.confirmDangerButton}
                          onPress={handleConfirmSignOut}
                          accessibilityRole="button"
                        >
                          <Text style={styles.confirmDangerText}>
                            Confirm Sign Out
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}

                  <View style={styles.footerContainer}>
                    <View style={styles.footerLinksRow}>
                      <TouchableOpacity
                        onPress={() =>
                          void Linking.openURL(PRIVACY_POLICY_URL).catch(
                            () => undefined,
                          )
                        }
                        accessibilityRole="link"
                        accessibilityLabel="Privacy Policy"
                      >
                        <Text style={styles.footerLinkText}>
                          Privacy Policy
                        </Text>
                      </TouchableOpacity>
                      <Text style={styles.footerSeparator}>•</Text>
                      <TouchableOpacity
                        onPress={() =>
                          void Linking.openURL(SOURCE_REPO_URL).catch(
                            () => undefined,
                          )
                        }
                        accessibilityRole="link"
                        accessibilityLabel="Open Source Repository"
                      >
                        <Text style={styles.footerLinkText}>
                          Open Source (MIT)
                        </Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.footerDisclaimerText}>
                      Independent client wrapper by Friction Ventures • Not
                      affiliated with Google LLC
                    </Text>
                  </View>
                </View>
              </ScrollView>
            )}

            {/* Workstation Switcher & Host Controls Popover */}
            {isMachineMenuOpen ? (
              <>
                <Pressable
                  style={[
                    styles.machineMenuScrim,
                    { top: headerRowBottom },
                    isKeyboardVisible
                      ? styles.machineMenuScrimKeyboard
                      : null,
                  ]}
                  onPress={() => setIsMachineMenuOpen(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss workstation menu"
                />
                <View
                  style={[
                    styles.machineMenuCard,
                    {
                      top: menuTopOffset,
                      maxHeight: menuCardMaxHeight,
                    },
                  ]}
                >
                  <ScrollView
                    style={{ maxHeight: menuScrollMaxHeight }}
                    bounces={false}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                  >
                    <Text style={styles.machineMenuSectionLabel}>
                      WORKSTATIONS
                    </Text>
                    {sortedInstances.length > 0 ? (
                      sortedInstances.map((inst) => {
                        const isCurrent =
                          snapshot.activeInstanceUuid !== null &&
                          snapshot.activeInstanceUuid === inst.uuid;
                        const statusColor =
                          inst.status === 'connected'
                            ? '#34D399'
                            : inst.status === 'disconnected'
                              ? '#F87171'
                              : '#94A3B8';
                        const statusLabel =
                          inst.status === 'connected'
                            ? snapshotUpdatedLabel
                              ? `Connected • Synced ${snapshotUpdatedLabel}`
                              : 'Connected'
                            : inst.status === 'disconnected'
                              ? 'Offline'
                              : 'Idle';
                        return (
                          <TouchableOpacity
                            key={inst.uuid}
                            style={[
                              styles.machineMenuItem,
                              isCurrent ? styles.machineMenuItemActive : null,
                            ]}
                            onPress={() => handleSelectWorkstation(inst)}
                            accessibilityRole="button"
                            accessibilityState={{ selected: isCurrent }}
                            accessibilityLabel={`Switch to workstation ${inst.name}`}
                          >
                            <View
                              style={[
                                styles.machineSelectorDot,
                                { backgroundColor: statusColor },
                              ]}
                            />
                            <View style={styles.machineMenuItemMeta}>
                              <Text
                                style={[
                                  styles.machineMenuItemTitle,
                                  isCurrent
                                    ? styles.machineMenuItemTitleActive
                                    : null,
                                ]}
                                numberOfLines={1}
                              >
                                {inst.name}
                              </Text>
                              <Text
                                style={styles.machineMenuItemSub}
                                numberOfLines={1}
                              >
                                {statusLabel}
                              </Text>
                            </View>
                            {isCurrent ? (
                              <Text style={styles.machineMenuCheck}>✓</Text>
                            ) : null}
                          </TouchableOpacity>
                        );
                      })
                    ) : (
                      <Text style={styles.machineMenuEmptyText}>
                        {stage !== 'authenticated'
                          ? 'Sign in to view connected workstations'
                          : 'No workstations online yet'}
                      </Text>
                    )}

                    <View style={styles.machineMenuDivider} />

                    <TouchableOpacity
                      style={[
                        styles.machineMenuActionRow,
                        isAllMachinesActive
                          ? styles.machineMenuItemActive
                          : null,
                      ]}
                      onPress={handleOpenDashboard}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isAllMachinesActive }}
                      accessibilityLabel="Open All Machines overview"
                    >
                      <Text style={styles.machineMenuActionIcon}>⊞</Text>
                      <Text style={styles.machineMenuActionText}>
                        All Machines Overview
                      </Text>
                      {isAllMachinesActive ? (
                        <Text style={styles.machineMenuCheck}>✓</Text>
                      ) : null}
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.machineMenuActionRow}
                      onPress={() => {
                        setIsMachineMenuOpen(false);
                        setActiveMode('settings');
                        setIsHandoffExpanded(true);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Connect link or machine ID"
                    >
                      <Text style={styles.machineMenuActionIcon}>＋</Text>
                      <Text style={styles.machineMenuActionText}>
                        Connect Link or Machine ID…
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.machineMenuActionRow}
                      onPress={() => {
                        setIsMachineMenuOpen(false);
                        onReloadSession();
                        if (!docked) {
                          handleClose();
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Reload workstation page"
                    >
                      <Text style={styles.machineMenuActionIcon}>↻</Text>
                      <Text style={styles.machineMenuActionText}>
                        Reload Workstation Page
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.machineMenuActionRow}
                      onPress={handleTriggerHostSettings}
                      accessibilityRole="button"
                      accessibilityLabel="Open workstation host settings"
                    >
                      <Text style={styles.machineMenuActionIcon}>⚙</Text>
                      <Text style={styles.machineMenuActionText}>
                        Workstation Host Settings…
                      </Text>
                    </TouchableOpacity>
                  </ScrollView>
                </View>
              </>
            ) : null}

            {/* Docked Thumb-Zone Mode Bar: Inbox | Projects | Usage | Settings */}
            {!isKeyboardVisible ? (
              <View style={styles.bottomModeBar}>
                <TouchableOpacity
                  style={styles.bottomModeBtn}
                  onPress={() => {
                    setIsMachineMenuOpen(false);
                    lastPrimaryNavModeRef.current = 'inbox';
                    setActiveMode('inbox');
                    if (stage === 'authenticated' && !isRefreshing) {
                      onRefreshInbox(false);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeMode === 'inbox' }}
                  accessibilityLabel="Drawer mode Inbox"
                >
                  {attentionCount === 0 && runningCount > 0 ? (
                    <View
                      style={[
                        styles.modeStatusDot,
                        styles.modeStatusDotOverlay,
                        { backgroundColor: colors.runningSolid },
                      ]}
                    />
                  ) : null}
                  <InboxNavIcon
                    color={
                      activeMode === 'inbox'
                        ? colors.primaryText
                        : colors.textMuted
                    }
                  />
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.modeSwitchText,
                      activeMode === 'inbox'
                        ? styles.modeSwitchTextActive
                        : null,
                    ]}
                  >
                    Inbox
                  </Text>
                  {badgeCountLabel ? (
                    <View
                      style={[
                        styles.modeCountBadge,
                        urgentAttentionCount > 0
                          ? styles.modeCountBadgeUrgent
                          : styles.modeCountBadgeUnread,
                      ]}
                    >
                      <Text style={styles.modeCountBadgeText}>
                        {badgeCountLabel}
                      </Text>
                    </View>
                  ) : null}
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.bottomModeBtn}
                  onPress={() => {
                    setIsMachineMenuOpen(false);
                    lastPrimaryNavModeRef.current = 'projects';
                    setActiveMode('projects');
                    if (stage === 'authenticated' && !isRefreshing) {
                      onRefreshInbox(false);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeMode === 'projects' }}
                  accessibilityLabel="Drawer mode Projects"
                >
                  <ProjectsNavIcon
                    color={
                      activeMode === 'projects'
                        ? colors.primaryText
                        : colors.textMuted
                    }
                  />
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.modeSwitchText,
                      activeMode === 'projects'
                        ? styles.modeSwitchTextActive
                        : null,
                    ]}
                  >
                    Projects
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.bottomModeBtn}
                  onPress={() => {
                    setIsMachineMenuOpen(false);
                    setActiveMode('usage');
                    if (stage === 'authenticated' && !isRefreshing) {
                      onRefreshInbox(true);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeMode === 'usage' }}
                  accessibilityLabel="Drawer mode Usage"
                >
                  {usageStatusDotColor ? (
                    <View
                      style={[
                        styles.modeStatusDot,
                        styles.modeStatusDotOverlay,
                        { backgroundColor: usageStatusDotColor },
                      ]}
                    />
                  ) : null}
                  <UsageNavIcon
                    color={
                      activeMode === 'usage'
                        ? colors.primaryText
                        : colors.textMuted
                    }
                  />
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.modeSwitchText,
                      activeMode === 'usage'
                        ? styles.modeSwitchTextActive
                        : null,
                    ]}
                  >
                    Usage
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.bottomModeBtn}
                  onPress={() => {
                    setIsMachineMenuOpen(false);
                    setActiveMode('settings');
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeMode === 'settings' }}
                  accessibilityLabel="Drawer mode Settings"
                >
                  <SettingsNavIcon
                    color={
                      activeMode === 'settings'
                        ? colors.primaryText
                        : colors.textMuted
                    }
                  />
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.modeSwitchText,
                      activeMode === 'settings'
                        ? styles.modeSwitchTextActive
                        : null,
                    ]}
                  >
                    Settings
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {/* Matching 4px × 112px handle line inside the right edge of the open drawer */}
            <TouchableOpacity
              style={styles.openHandleZone}
              activeOpacity={0.8}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close Antigravity drawer"
            >
              <View
                style={[
                  styles.handleLine,
                  { backgroundColor: handleVisuals.lineColor },
                  handleVisuals.glowColor
                    ? {
                        shadowColor: handleVisuals.glowColor,
                        shadowOpacity: 0.7,
                        shadowRadius: 7,
                        elevation: 5,
                      }
                    : null,
                ]}
              />
            </TouchableOpacity>
          </Animated.View>
      </View>

      <View
        testID="closed-drawer-handle-zone"
        style={[
          styles.closedHandleZone,
          closedHandleDynamicStyle,
          isClosedHandleHidden ? styles.closedHandleZoneHidden : null,
        ]}
        hitSlop={{ top: 24, bottom: 24, left: 16, right: 24 }}
        pointerEvents={visible && !isDraggingOpen ? 'none' : 'auto'}
        importantForAccessibility={
          isClosedHandleHidden ? 'no-hide-descendants' : 'auto'
        }
        {...closedHandlePanResponder.panHandlers}
      >
        {!visible || isDraggingOpen ? (
          <TouchableOpacity
            style={styles.closedHandleButton}
            activeOpacity={0.8}
            hitSlop={{ top: 24, bottom: 24, left: 16, right: 24 }}
            onPress={handleTapOpen}
            accessibilityRole="button"
            accessibilityLabel="Open Antigravity drawer"
            accessibilityHint={closedHandleAccessibilityLabel}
          >
            <Animated.View
              style={[
                styles.closedHandleVisualGroup,
                { transform: [{ translateX: handleNudgeX }] },
              ]}
            >
              <View
                style={[
                  styles.handleLine,
                  {
                    height: closedHandleLineHeight,
                    backgroundColor: handleVisuals.lineColor,
                  },
                  handleVisuals.glowColor
                    ? {
                        shadowColor: handleVisuals.glowColor,
                        shadowOpacity: 0.7,
                        shadowRadius: 7,
                        elevation: 5,
                      }
                    : null,
                ]}
              />
              <View
                style={[
                  styles.closedHandleChevron,
                  { borderColor: handleVisuals.lineColor },
                ]}
              />
              {showGuidanceHint ? (
                <View
                  testID="drawer-guidance-pill"
                  style={styles.closedHandleHintPill}
                >
                  <Text style={styles.closedHandleHintText}>Swipe</Text>
                </View>
              ) : null}
            </Animated.View>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlayRoot: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 60,
  },
  closedHandleZone: {
    position: 'absolute',
    left: CLOSED_HANDLE_TOUCH_LEFT,
    top: '50%',
    marginTop: -(HANDLE_TOUCH_ZONE_HEIGHT / 2),
    width: CLOSED_HANDLE_TOUCH_WIDTH,
    height: HANDLE_TOUCH_ZONE_HEIGHT,
    justifyContent: 'center',
  },
  closedHandleZoneHidden: {
    opacity: 0,
  },
  closedHandleButton: {
    flex: 1,
    paddingLeft: CLOSED_HANDLE_BAR_INSET,
    flexDirection: 'row',
    alignItems: 'center',
  },
  closedHandleVisualGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  closedHandleChevron: {
    width: 5,
    height: 5,
    marginLeft: 3,
    borderTopWidth: 1.5,
    borderRightWidth: 1.5,
    opacity: 0.78,
    transform: [{ rotate: '45deg' }],
  },
  closedHandleHintPill: {
    marginLeft: 5,
    paddingHorizontal: 6.5,
    paddingVertical: 2.5,
    borderRadius: 999,
    backgroundColor: 'rgba(17, 17, 20, 0.92)',
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  closedHandleHintText: {
    color: colors.primaryText,
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  handleLine: {
    width: HANDLE_LINE_WIDTH,
    height: HANDLE_LINE_HEIGHT,
    borderRadius: 999,
    shadowOffset: { width: 0, height: 0 },
  },
  openOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.scrim,
  },
  drawerPanel: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.sidebar,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingLeft: 15,
    paddingRight: 25,
  },
  drawerPanelElevated: {
    shadowColor: '#000',
    shadowOffset: { width: 8, height: 0 },
    shadowOpacity: 0.58,
    shadowRadius: 22,
    elevation: 18,
  },
  openHandleZone: {
    position: 'absolute',
    right: 0,
    top: '50%',
    marginTop: -(HANDLE_TOUCH_ZONE_HEIGHT / 2),
    width: 24,
    height: HANDLE_TOUCH_ZONE_HEIGHT,
    paddingRight: OPEN_HANDLE_RIGHT_INSET,
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 40,
  },
  sidebarHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
    zIndex: 35,
  },
  machineSelectorPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: '72%',
    paddingVertical: 6.5,
    paddingHorizontal: 11,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  machineSelectorPillOpen: {
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primaryCardBg,
  },
  machineSelectorDot: {
    width: 7.5,
    height: 7.5,
    borderRadius: 999,
  },
  machineSelectorLabel: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  chevronBox: {
    width: 12,
    height: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevronGlyph: {
    width: 6,
    height: 6,
    transform: [{ rotate: '45deg' }],
  },
  chevronGlyphDown: {
    borderRightWidth: 1.6,
    borderBottomWidth: 1.6,
    marginTop: -2,
  },
  chevronGlyphUp: {
    borderLeftWidth: 1.6,
    borderTopWidth: 1.6,
    marginTop: 2,
  },
  headerActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerIconBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconBtnActive: {
    backgroundColor: colors.primarySoft,
  },
  headerSyncGlyph: {
    color: colors.textMuted,
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 18,
  },
  headerFreshnessText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '500',
    marginRight: 2,
  },
  headerModeLabel: {
    color: colors.textMuted,
    fontSize: 11.5,
    fontWeight: '600',
    paddingRight: 4,
  },
  searchIconBox: {
    width: 16,
    height: 16,
  },
  searchIconLens: {
    position: 'absolute',
    top: 1,
    left: 1,
    width: 10.5,
    height: 10.5,
    borderRadius: 999,
    borderWidth: 1.7,
  },
  searchIconHandle: {
    position: 'absolute',
    bottom: 2,
    right: 1,
    width: 5.5,
    height: 1.8,
    borderRadius: 1,
    transform: [{ rotate: '45deg' }],
  },
  searchIconBoxCompact: {
    width: 14,
    height: 14,
  },
  searchIconLensCompact: {
    position: 'absolute',
    top: 1,
    left: 1,
    width: 9,
    height: 9,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  searchIconHandleCompact: {
    position: 'absolute',
    bottom: 1.5,
    right: 1,
    width: 4.5,
    height: 1.6,
    borderRadius: 1,
    transform: [{ rotate: '45deg' }],
  },
  filterStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    marginBottom: 9,
    gap: 6,
  },
  filterTabsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexShrink: 1,
  },
  filterTabBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingTop: 4,
    paddingBottom: 8,
    marginBottom: -1,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  filterTabBtnSelected: {
    borderBottomColor: colors.primaryBright,
  },
  filterTabText: {
    color: colors.textMuted,
    fontSize: 12.5,
    fontWeight: '600',
  },
  filterTabTextSelected: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  tabCountBadge: {
    minWidth: 17,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
  },
  tabCountBadgeSelected: {
    backgroundColor: colors.primarySoft,
  },
  tabCountText: {
    color: colors.textMuted,
    fontSize: 10.5,
    fontWeight: '700',
  },
  tabCountTextSelected: {
    color: colors.primaryText,
  },
  readAllInlineBtn: {
    paddingVertical: 5,
    paddingLeft: 6,
  },
  readAllInlineText: {
    color: colors.primaryText,
    fontSize: 11.5,
    fontWeight: '600',
  },
  searchBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.well,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 9,
    paddingHorizontal: 10,
    marginBottom: 9,
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    paddingVertical: 7,
    fontSize: 12.5,
  },
  searchClearBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  searchClearText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  machineMenuScrim: {
    position: 'absolute',
    top: 48,
    left: 0,
    right: 0,
    bottom: 54,
    backgroundColor: 'rgba(0, 0, 0, 0.56)',
    zIndex: 28,
  },
  machineMenuScrimKeyboard: {
    bottom: 0,
  },
  machineMenuCard: {
    position: 'absolute',
    top: 50,
    left: 15,
    right: 25,
    backgroundColor: colors.popover,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    padding: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.58,
    shadowRadius: 20,
    elevation: 14,
    zIndex: 32,
  },
  machineMenuSectionLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    paddingHorizontal: 9,
    paddingTop: 5,
    paddingBottom: 4,
  },
  machineMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 9,
    paddingVertical: 8,
    borderRadius: 8,
  },
  machineMenuItemActive: {
    backgroundColor: colors.primarySoft,
  },
  machineMenuItemMeta: {
    flex: 1,
  },
  machineMenuItemTitle: {
    color: colors.textSecondary,
    fontSize: 12.5,
    fontWeight: '600',
  },
  machineMenuItemTitleActive: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  machineMenuItemSub: {
    color: colors.textMuted,
    fontSize: 10.5,
    marginTop: 1,
  },
  machineMenuCheck: {
    color: colors.primaryText,
    fontSize: 12.5,
    fontWeight: '700',
  },
  machineMenuEmptyText: {
    color: colors.textMuted,
    fontSize: 11.5,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  machineMenuDivider: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginVertical: 4,
  },
  machineMenuActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 9,
    paddingVertical: 8.5,
    borderRadius: 8,
  },
  machineMenuActionIcon: {
    width: 16,
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  machineMenuActionText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12.5,
    fontWeight: '500',
  },
  bottomModeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: -15,
    marginRight: -25,
    paddingLeft: 8,
    paddingRight: 18,
    paddingTop: 6,
    paddingBottom: 8,
    backgroundColor: colors.well,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  bottomModeBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 3,
    gap: 3,
  },
  navIconFrame: {
    width: 18,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inboxIconOuter: {
    width: 15,
    height: 13,
    borderRadius: 3,
    borderWidth: 1.6,
    justifyContent: 'flex-end',
    paddingBottom: 3,
  },
  inboxIconShelf: {
    width: '100%',
    height: 1.5,
  },
  projectsIconWrapper: {
    width: 15,
    height: 13,
    justifyContent: 'flex-end',
  },
  projectsIconTab: {
    width: 7,
    height: 3.5,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
    borderWidth: 1.5,
    borderBottomWidth: 0,
    marginBottom: -1,
  },
  projectsIconFolder: {
    width: 15,
    height: 10.5,
    borderRadius: 2.5,
    borderWidth: 1.6,
  },
  usageIconRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2.5,
    paddingBottom: 1,
  },
  usageIconBar: {
    width: 2.8,
    borderRadius: 1.2,
  },
  settingsIconStack: {
    gap: 4.5,
  },
  settingsSliderRow: {
    width: 15,
    height: 4,
    justifyContent: 'center',
  },
  settingsSliderTrack: {
    width: '100%',
    height: 1.5,
    borderRadius: 1,
  },
  settingsSliderKnob: {
    position: 'absolute',
    width: 5,
    height: 5,
    borderRadius: 999,
    borderWidth: 1.5,
    backgroundColor: colors.well,
  },
  settingsSliderKnobLeft: {
    left: 2,
  },
  settingsSliderKnobRight: {
    right: 2,
  },
  modeSwitchText: {
    color: colors.textMuted,
    fontSize: 10.5,
    fontWeight: '600',
  },
  modeSwitchTextActive: {
    color: colors.primaryText,
    fontWeight: '700',
  },
  modeStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  modeStatusDotOverlay: {
    position: 'absolute',
    top: 2,
    left: '56%',
    zIndex: 2,
  },
  modeCountBadge: {
    position: 'absolute',
    top: 0,
    left: '54%',
    minWidth: 16,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeCountBadgeUnread: {
    backgroundColor: colors.primary,
  },
  modeCountBadgeUrgent: {
    backgroundColor: '#D97706',
  },
  modeCountBadgeText: {
    color: colors.white,
    fontSize: 9.5,
    fontWeight: '800',
  },
  modeBody: {
    flex: 1,
  },
  errorBanner: {
    backgroundColor: colors.errorBannerBg,
    borderColor: colors.errorBannerBorder,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 9,
  },
  errorBannerText: {
    color: colors.errorText,
    fontSize: 11.5,
  },
  flexScroll: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 10,
    gap: 8,
  },
  threadCard: {
    backgroundColor: colors.surface,
    borderRadius: 11,
    paddingHorizontal: 11,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3.5,
  },
  threadCardActive: {
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primaryCardBg,
  },
  projectThreadCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3.5,
  },
  projectThreadCardActive: {
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primaryCardBg,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
    gap: 6,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
  },
  kindBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
  },
  kindBadgeText: {
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  currentBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  currentBadgeText: {
    color: colors.primaryText,
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  timestampText: {
    color: colors.textMuted,
    fontSize: 10.5,
    fontWeight: '500',
  },
  cardProjectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 2,
  },
  cardProjectIconWrapper: {
    width: 11,
    height: 10,
    justifyContent: 'flex-end',
  },
  cardProjectIconTab: {
    width: 5,
    height: 2.5,
    borderTopLeftRadius: 1.5,
    borderTopRightRadius: 1.5,
    borderWidth: 1.2,
    borderBottomWidth: 0,
    marginBottom: -0.8,
  },
  cardProjectIconBody: {
    width: 11,
    height: 8,
    borderRadius: 1.8,
    borderWidth: 1.2,
  },
  cardProjectText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 14,
    letterSpacing: 0.1,
  },
  threadTitle: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  reasonText: {
    color: colors.textSecondary,
    fontSize: 11.5,
    marginTop: 3,
    lineHeight: 16,
  },
  reasonTextApproval: {
    color: colors.approvalText,
    fontWeight: '500',
  },
  reasonTextError: {
    color: colors.errorText,
  },
  reasonTextUnread: {
    color: colors.primaryText,
    fontWeight: '500',
  },
  reasonTextIdle: {
    color: colors.textMuted,
  },
  cardFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 7,
    gap: 6,
  },
  projectCardFooterRow: {
    marginTop: 6,
  },
  projectFooterSpacer: {
    flex: 1,
  },
  metaText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 10.5,
  },
  markReadChip: {
    paddingHorizontal: 7.5,
    paddingVertical: 3.5,
    borderRadius: 6,
    backgroundColor: colors.well,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  markReadChipText: {
    color: colors.primaryText,
    fontSize: 10.5,
    fontWeight: '600',
  },
  projectsSummaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    paddingBottom: 7,
    marginBottom: 9,
    gap: 6,
  },
  projectsSummaryActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  projectsSummaryText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 11.5,
    fontWeight: '600',
  },
  addProjectHeaderBtn: {
    paddingHorizontal: 8.5,
    paddingVertical: 4,
    borderRadius: 7,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  addProjectHeaderBtnActive: {
    backgroundColor: colors.control,
    borderColor: colors.borderStrong,
  },
  addProjectHeaderBtnText: {
    color: colors.primaryText,
    fontSize: 11,
    fontWeight: '700',
  },
  addProjectCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    padding: 11,
    gap: 8,
  },
  addProjectHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  addProjectTitle: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  addProjectWorkstationRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  addProjectWorkstationChip: {
    paddingHorizontal: 9,
    paddingVertical: 4.5,
    borderRadius: 999,
    backgroundColor: colors.well,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addProjectWorkstationChipSelected: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primaryBorder,
  },
  addProjectWorkstationChipText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  addProjectWorkstationChipTextSelected: {
    color: colors.primaryText,
    fontWeight: '700',
  },
  addProjectModeWell: {
    flexDirection: 'row',
    backgroundColor: colors.well,
    borderRadius: 9,
    padding: 3,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    gap: 4,
  },
  addProjectModeKey: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 7,
    alignItems: 'center',
  },
  addProjectModeKeyActive: {
    backgroundColor: colors.control,
  },
  addProjectModeKeyText: {
    color: colors.textMuted,
    fontSize: 11.5,
    fontWeight: '600',
  },
  addProjectModeKeyTextActive: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  dirBrowserBox: {
    backgroundColor: colors.well,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  dirBrowserToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceRaised,
  },
  dirUpBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2.5,
    borderRadius: 5,
    backgroundColor: colors.control,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dirUpBtnText: {
    color: colors.primaryText,
    fontSize: 10.5,
    fontWeight: '700',
  },
  dirCurrentPathText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 10.5,
    fontWeight: '500',
  },
  dirRefreshBtn: {
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  dirRefreshGlyph: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  dirListScroll: {
    maxHeight: 142,
  },
  dirEntryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  dirEntryIcon: {
    color: colors.primaryText,
    fontSize: 11,
    fontWeight: '700',
  },
  dirEntryName: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '500',
  },
  dirStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  dirStatusText: {
    color: colors.textMuted,
    fontSize: 11,
    paddingHorizontal: 9,
    paddingVertical: 9,
  },
  dirErrorText: {
    color: colors.approvalText,
    fontSize: 11,
    paddingHorizontal: 9,
    paddingVertical: 8,
  },
  addProjectFieldLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: -4,
  },
  addProjectInput: {
    backgroundColor: colors.well,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7.5,
    fontSize: 12,
  },
  addProjectHelperText: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  addProjectFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 2,
  },
  addProjectCancelBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7.5,
    borderRadius: 8,
    backgroundColor: colors.control,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addProjectCancelText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  addProjectSubmitBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7.5,
    borderRadius: 8,
    backgroundColor: colors.primary,
    minWidth: 96,
    alignItems: 'center',
  },
  addProjectSubmitBtnDisabled: {
    opacity: 0.65,
  },
  addProjectSubmitText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '700',
  },
  projectCard: {
    backgroundColor: colors.surface,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  projectCardActive: {
    borderColor: colors.primaryBorder,
  },
  projectHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 9.5,
    gap: 8,
  },
  projectHeaderToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  projectHeaderMeta: {
    flex: 1,
  },
  projectTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  projectTitleText: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  projectStatusBadge: {
    minWidth: 17,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectStatusBadgeUnread: {
    backgroundColor: colors.primary,
  },
  projectStatusBadgeUrgent: {
    backgroundColor: '#D97706',
  },
  projectStatusBadgeText: {
    color: colors.white,
    fontSize: 9.5,
    fontWeight: '800',
  },
  projectRunningDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: colors.runningSolid,
  },
  projectSubtitleText: {
    color: colors.textMuted,
    fontSize: 10.5,
    marginTop: 2,
  },
  projectNewChatBtn: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 7,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  projectNewChatBtnText: {
    color: colors.primaryText,
    fontSize: 11,
    fontWeight: '700',
  },
  projectThreadsTray: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.well,
    padding: 8,
    gap: 7,
  },
  projectEmptyThreadsRow: {
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  projectEmptyThreadsText: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 14,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 8,
    marginBottom: 5,
    textAlign: 'center',
  },
  emptySubtitle: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  emptyActionBtn: {
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  emptyActionBtnText: {
    color: colors.primaryText,
    fontSize: 12,
    fontWeight: '600',
  },
  usageScrollContent: {
    paddingBottom: 12,
    gap: 12,
  },
  usageSection: {
    gap: 7,
  },
  usageSectionTitle: {
    color: colors.textMuted,
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.7,
    paddingHorizontal: 2,
  },
  usageCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
  },
  usagePlanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  usageTierPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    flexShrink: 1,
  },
  usageTierPillText: {
    color: colors.primaryText,
    fontSize: 11,
    fontWeight: '700',
  },
  usageAccountEmail: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'right',
  },
  usageCreditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  usageCreditRowBorder: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  usageCreditLabel: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '500',
  },
  usageCreditValue: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  usageGroupTitle: {
    color: colors.textPrimary,
    fontSize: 12.5,
    fontWeight: '700',
    marginBottom: 2,
  },
  usageQuotaItem: {
    gap: 5,
  },
  usageQuotaItemDivider: {
    paddingTop: 9,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  usageQuotaHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  usageModelTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  usageQuotaLabel: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  usageDefaultTag: {
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 4,
    backgroundColor: colors.primarySoft,
  },
  usageDefaultTagText: {
    color: colors.primaryText,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  usagePctBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  usagePctBadgeText: {
    fontSize: 10.5,
    fontWeight: '700',
  },
  usageProgressTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.well,
    overflow: 'hidden',
  },
  usageProgressFill: {
    height: '100%',
    borderRadius: 999,
  },
  usageResetText: {
    color: colors.textMuted,
    fontSize: 10.5,
  },
  usageInfoBanner: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  usageInfoBannerText: {
    color: colors.textSecondary,
    fontSize: 11.5,
    lineHeight: 16,
  },
  usageMetricsGrid: {
    flexDirection: 'row',
    gap: 7,
  },
  usageMetricTile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  usageMetricValue: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  usageMetricValueActive: {
    color: colors.running,
  },
  usageMetricLabel: {
    color: colors.textMuted,
    fontSize: 10.5,
    fontWeight: '500',
    marginTop: 2,
    textAlign: 'center',
  },
  usageBudgetAlertBtn: {
    backgroundColor: colors.errorSoft,
    borderColor: colors.errorBorder,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  usageBudgetAlertText: {
    color: colors.errorText,
    fontSize: 11.5,
    fontWeight: '600',
    lineHeight: 16,
  },
  sessionScrollContent: {
    flexGrow: 1,
  },
  keepAliveSection: {
    marginBottom: 4,
  },
  keepAliveDescription: {
    color: colors.textMuted,
    fontSize: 11.5,
    lineHeight: 16,
    marginBottom: 8,
  },
  keepAliveRow: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 2,
    marginBottom: 7,
  },
  keepAliveChip: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  keepAliveChipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primaryBorder,
  },
  keepAliveChipText: {
    color: colors.textSecondary,
    fontSize: 11.5,
    fontWeight: '600',
  },
  keepAliveChipTextSelected: {
    color: colors.white,
    fontWeight: '700',
  },
  keepAliveHint: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginVertical: 14,
  },
  sectionLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 3,
  },
  sectionHint: {
    color: colors.textMuted,
    fontSize: 11.5,
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  handoffInput: {
    flex: 1,
    backgroundColor: colors.well,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 12.5,
  },
  connectButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: 9,
  },
  connectButtonText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '700',
  },
  errorText: {
    color: colors.errorText,
    fontSize: 11.5,
    marginTop: 4,
  },
  actionsGroup: {
    marginTop: 6,
    gap: 8,
  },
  settingActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 9,
  },
  settingActionRowExpanded: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderColor: colors.borderStrong,
  },
  settingActionIcon: {
    color: colors.primaryText,
    fontSize: 13.5,
    width: 18,
    textAlign: 'center',
  },
  settingActionText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  settingActionChevron: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '700',
  },
  handoffExpandedCard: {
    marginTop: -8,
    backgroundColor: colors.well,
    paddingHorizontal: 11,
    paddingVertical: 10,
    borderBottomLeftRadius: 9,
    borderBottomRightRadius: 9,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: colors.borderStrong,
  },
  sessionBottomSection: {
    marginTop: 'auto',
    paddingTop: 16,
  },
  accountStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 9,
  },
  accountStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  accountStatusText: {
    color: colors.textMuted,
    fontSize: 11.5,
    fontWeight: '500',
  },
  signOutButton: {
    paddingVertical: 11,
    borderRadius: 9,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.errorBorder,
    backgroundColor: colors.errorSoft,
  },
  signOutButtonText: {
    color: colors.errorText,
    fontSize: 13,
    fontWeight: '600',
  },
  confirmBox: {
    padding: 11,
    borderRadius: 10,
    backgroundColor: colors.errorBannerBg,
    borderWidth: 1,
    borderColor: colors.errorBannerBorder,
  },
  confirmTitle: {
    color: colors.errorText,
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 9,
    textAlign: 'center',
  },
  confirmButtonsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  cancelConfirmButton: {
    flex: 0.85,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.control,
    alignItems: 'center',
  },
  cancelConfirmText: {
    color: colors.textPrimary,
    fontSize: 12.5,
    fontWeight: '600',
  },
  confirmDangerButton: {
    flex: 1.35,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#DC2626',
    alignItems: 'center',
  },
  confirmDangerText: {
    color: colors.white,
    fontSize: 12.5,
    fontWeight: '700',
  },
  footerContainer: {
    marginTop: 14,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    alignItems: 'center',
  },
  footerLinksRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginBottom: 4,
  },
  footerLinkText: {
    color: colors.primaryText,
    fontSize: 11.5,
    fontWeight: '600',
  },
  footerSeparator: {
    color: colors.textPlaceholder,
    fontSize: 11.5,
  },
  footerDisclaimerText: {
    color: colors.textMuted,
    fontSize: 10.5,
    lineHeight: 14,
    textAlign: 'center',
  },
});
