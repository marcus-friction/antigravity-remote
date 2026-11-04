import * as Linking from 'expo-linking';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ANTIGRAVITY_DASHBOARD_URL,
  DEFAULT_KEEP_ALIVE_MINUTES,
  IOS_KEEP_ALIVE_ENABLED_MINUTES,
  KEEP_ALIVE_DURATION_OPTIONS,
  PRIVACY_POLICY_URL,
  SOURCE_REPO_URL,
} from '../constants/config';
import {
  InboxAttentionKind,
  InboxFilterTab,
  InboxSnapshot,
  InboxThreadItem,
} from '../types/inbox';
import { AuthFlowStage, KeepAliveMinutes } from '../types/session';
import { formatRelativeTime } from '../utils/inboxParser';
import { parseHandoffInput } from '../utils/urlValidator';

export type DrawerMode = 'inbox' | 'session';

/**
 * Shared handle line geometry so the closed pull-in handle and the inner-right
 * handle inside the open drawer match 1:1 in height, thickness, vertical
 * alignment, rounded caps, and color/glow, while leaving a back-gesture-safe
 * gap (`20dp` touch start, `22dp` visual bar) from the physical left bezel.
 */
export const HANDLE_LINE_WIDTH = 4;
export const HANDLE_LINE_HEIGHT = 112;
export const HANDLE_TOUCH_ZONE_HEIGHT = 148;
export const CLOSED_HANDLE_TOUCH_LEFT = 20;
export const CLOSED_HANDLE_BAR_INSET = 2; // Visual bar sits at 22dp from left edge
export const OPEN_HANDLE_RIGHT_INSET = 10;
const HANDLE_ALIGNMENT_OFFSET =
  CLOSED_HANDLE_TOUCH_LEFT +
  CLOSED_HANDLE_BAR_INSET +
  OPEN_HANDLE_RIGHT_INSET +
  HANDLE_LINE_WIDTH; // 36dp so bar starts at exact 22dp when pulling open

export interface LeftNavigationDrawerProps {
  visible: boolean;
  initialMode?: DrawerMode;
  isKeyboardVisible?: boolean;
  keyboardBottomPadding?: number;
  stage: AuthFlowStage;
  snapshot: InboxSnapshot;
  isRefreshing: boolean;
  attentionCount: number;
  urgentAttentionCount: number;
  runningCount: number;
  lastSyncedCookieCount: number;
  keepAliveMinutes?: KeepAliveMinutes;
  onOpen: (preferredMode?: DrawerMode) => void;
  onClose: () => void;
  onRefreshInbox: () => void;
  onSelectThread: (thread: InboxThreadItem) => void;
  onMarkThreadRead: (thread: InboxThreadItem) => void;
  onMarkAllRead: () => void;
  onChangeKeepAliveMinutes?: (minutes: KeepAliveMinutes) => void;
  onNavigateToUrl: (targetUrl: string) => void;
  onReloadSession: () => void;
  onSignOut: () => void;
}

function getBadgeVisuals(kind: InboxAttentionKind): {
  label: string;
  textColor: string;
  bgColor: string;
  borderColor: string;
  accentColor: string;
} {
  switch (kind) {
    case 'approval':
      return {
        label: 'NEEDS APPROVAL',
        textColor: '#FDE68A',
        bgColor: 'rgba(245, 158, 11, 0.18)',
        borderColor: 'rgba(245, 158, 11, 0.45)',
        accentColor: '#F59E0B',
      };
    case 'error':
      return {
        label: 'NEEDS REVIEW',
        textColor: '#FECACA',
        bgColor: 'rgba(239, 68, 68, 0.18)',
        borderColor: 'rgba(239, 68, 68, 0.45)',
        accentColor: '#EF4444',
      };
    case 'unread':
      return {
        label: 'UNREAD',
        textColor: '#BFDBFE',
        bgColor: 'rgba(59, 130, 246, 0.2)',
        borderColor: 'rgba(96, 165, 250, 0.45)',
        accentColor: '#3B82F6',
      };
    case 'running':
      return {
        label: 'WORKING',
        textColor: '#A7F3D0',
        bgColor: 'rgba(16, 185, 129, 0.16)',
        borderColor: 'rgba(52, 211, 153, 0.4)',
        accentColor: '#10B981',
      };
    case 'idle':
    default:
      return {
        label: 'IDLE',
        textColor: '#94A3B8',
        bgColor: 'rgba(51, 65, 85, 0.45)',
        borderColor: 'rgba(100, 116, 139, 0.35)',
        accentColor: '#475569',
      };
  }
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
      lineColor: '#F59E0B',
      glowColor: '#F59E0B',
    };
  }
  if (stage === 'authenticated' && attentionCount > 0) {
    return {
      lineColor: '#3B82F6',
      glowColor: '#3B82F6',
    };
  }
  if (stage === 'authenticated' && runningCount > 0) {
    return {
      lineColor: 'rgba(52, 211, 153, 0.72)',
      glowColor: null,
    };
  }
  if (stage === 'offline') {
    return {
      lineColor: 'rgba(248, 113, 113, 0.78)',
      glowColor: null,
    };
  }
  if (stage === 'authenticating') {
    return {
      lineColor: 'rgba(96, 165, 250, 0.65)',
      glowColor: null,
    };
  }
  return {
    lineColor: 'rgba(148, 163, 184, 0.52)',
    glowColor: null,
  };
}

export const LeftNavigationDrawer: React.FC<LeftNavigationDrawerProps> = ({
  visible,
  initialMode,
  isKeyboardVisible = false,
  keyboardBottomPadding = 0,
  stage,
  snapshot,
  isRefreshing,
  attentionCount,
  urgentAttentionCount,
  runningCount,
  lastSyncedCookieCount,
  keepAliveMinutes = DEFAULT_KEEP_ALIVE_MINUTES,
  onOpen,
  onClose,
  onRefreshInbox,
  onSelectThread,
  onMarkThreadRead,
  onMarkAllRead,
  onChangeKeepAliveMinutes,
  onNavigateToUrl,
  onReloadSession,
  onSignOut,
}) => {
  const insets = useSafeAreaInsets();
  const { width: rawWindowWidth } = useWindowDimensions();
  const safeWindowWidth = rawWindowWidth > 0 ? rawWindowWidth : 390;
  const drawerWidth = Math.min(
    344,
    Math.max(296, Math.round(safeWindowWidth * 0.86)),
  );
  const drawerWidthRef = useRef<number>(drawerWidth);
  drawerWidthRef.current = drawerWidth;

  const defaultMode: DrawerMode =
    initialMode ?? (stage === 'authenticated' ? 'inbox' : 'session');
  const defaultModeRef = useRef<DrawerMode>(defaultMode);
  defaultModeRef.current = defaultMode;
  const [activeMode, setActiveMode] = useState<DrawerMode>(defaultMode);
  const [selectedTab, setSelectedTab] = useState<InboxFilterTab>('attention');
  const [searchQuery, setSearchQuery] = useState('');
  const [handoffText, setHandoffText] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [isDraggingOpen, setIsDraggingOpen] = useState(false);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);

  const wasVisibleRef = useRef<boolean>(visible);
  const translateX = useRef(
    new Animated.Value(visible ? 0 : -drawerWidth),
  ).current;

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      const nextMode =
        initialMode ?? (stage === 'authenticated' ? 'inbox' : 'session');
      setActiveMode(nextMode);
    }
  }, [initialMode, stage, visible]);

  useEffect(() => {
    if (visible) {
      setIsDraggingOpen(false);
      setIsAnimatingOut(false);
      translateX.stopAnimation?.();
      Animated.spring(translateX, {
        toValue: 0,
        damping: 26,
        stiffness: 280,
        mass: 0.9,
        useNativeDriver: true,
      }).start();
    } else if (wasVisibleRef.current) {
      setIsDraggingOpen(false);
      setIsAnimatingOut(true);
      translateX.stopAnimation?.();
      Animated.timing(translateX, {
        toValue: -drawerWidth,
        duration: 180,
        useNativeDriver: true,
      }).start((result) => {
        if (!result || result.finished !== false) {
          setIsAnimatingOut(false);
        }
      });
    } else if (!isDraggingOpen) {
      translateX.setValue(-drawerWidth);
    }
    wasVisibleRef.current = visible;
  }, [drawerWidth, isDraggingOpen, translateX, visible]);

  const resetTransientInputs = useCallback(() => {
    setSearchQuery('');
    setValidationError(null);
    setConfirmingSignOut(false);
  }, []);

  const handleClose = useCallback(() => {
    resetTransientInputs();
    setIsDraggingOpen(false);
    setIsAnimatingOut(false);
    onClose();
  }, [onClose, resetTransientInputs]);

  const handleTapOpen = useCallback(() => {
    setActiveMode(defaultModeRef.current);
    const startOffset = -drawerWidthRef.current + HANDLE_ALIGNMENT_OFFSET;
    translateX.stopAnimation?.();
    translateX.setValue(startOffset);
    onOpen();
  }, [onOpen, translateX]);

  // Pull-right gesture on the closed handle strip (starts 20dp inside the screen
  // bezel so iOS and Android edge-back gestures at 0..20dp are never triggered).
  // Capture-phase takeover lets horizontal drags take responder ownership from
  // the inner TouchableOpacity while preserving simple taps.
  const closedHandlePanResponder = useMemo(() => {
    const shouldClaimPullRight = (gestureState: { dx: number; dy: number }) =>
      gestureState.dx > 6 &&
      Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.15;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_evt, gestureState) =>
        shouldClaimPullRight(gestureState),
      onMoveShouldSetPanResponderCapture: (_evt, gestureState) =>
        shouldClaimPullRight(gestureState),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        translateX.stopAnimation?.();
        setActiveMode(defaultModeRef.current);
        const width = drawerWidthRef.current;
        translateX.setValue(-width + HANDLE_ALIGNMENT_OFFSET);
        setIsDraggingOpen(true);
      },
      onPanResponderMove: (_evt, gestureState) => {
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
          gestureState.dx > width * 0.24 ||
          (gestureState.dx > 22 && gestureState.vx > 0.35);
        if (shouldOpen) {
          setIsDraggingOpen(false);
          onOpen();
        } else {
          Animated.timing(translateX, {
            toValue: -width,
            duration: 150,
            useNativeDriver: true,
          }).start(() => {
            setIsDraggingOpen(false);
          });
        }
      },
      onPanResponderTerminate: () => {
        const width = drawerWidthRef.current;
        Animated.timing(translateX, {
          toValue: -width,
          duration: 150,
          useNativeDriver: true,
        }).start(() => {
          setIsDraggingOpen(false);
        });
      },
    });
  }, [onOpen, translateX]);

  // Push/swipe-left gesture on the open drawer or its inner-right handle line.
  const openDrawerPanResponder = useMemo(() => {
    const shouldClaimSwipeLeft = (gestureState: { dx: number; dy: number }) =>
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
        translateX.stopAnimation?.();
      },
      onPanResponderMove: (_evt, gestureState) => {
        const width = drawerWidthRef.current;
        const clampedX = Math.max(-width, Math.min(0, gestureState.dx));
        translateX.setValue(clampedX);
      },
      onPanResponderRelease: (_evt, gestureState) => {
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
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateX, {
          toValue: 0,
          damping: 26,
          stiffness: 280,
          mass: 0.9,
          useNativeDriver: true,
        }).start();
      },
    });
  }, [handleClose, translateX]);

  const connectedInstances = useMemo(
    () => snapshot.instances.filter((inst) => inst.status === 'connected'),
    [snapshot.instances],
  );

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
        (thread.workspaceName?.toLowerCase().includes(query) ?? false) ||
        thread.attentionReason.toLowerCase().includes(query)
      );
    });
  }, [searchQuery, selectedTab, snapshot.threads]);

  const inboxSubtitleText = useMemo(() => {
    if (stage !== 'authenticated') {
      return stage === 'authenticating'
        ? 'Sign in to view workstation threads'
        : 'Waiting for connection…';
    }
    const machineCount = connectedInstances.length;
    const machineLabel =
      machineCount === 1
        ? `1 machine (${connectedInstances[0].name})`
        : `${machineCount} machines`;
    const updatedLabel =
      snapshot.fetchedAtMs > 0 ? formatRelativeTime(snapshot.fetchedAtMs) : '';
    if (snapshot.fetchedAtMs === 0) {
      return isRefreshing
        ? 'Syncing threads from Antigravity…'
        : 'Waiting for workstation…';
    }
    return updatedLabel ? `${machineLabel} • ${updatedLabel}` : machineLabel;
  }, [connectedInstances, isRefreshing, snapshot.fetchedAtMs, stage]);

  const handleConnectHandoff = () => {
    const parsedUrl = parseHandoffInput(handoffText);
    if (!parsedUrl) {
      setValidationError(
        'Enter a valid antigravity.google.com/r/<instance-id> link or instance name.',
      );
      return;
    }

    setValidationError(null);
    setHandoffText('');
    setConfirmingSignOut(false);
    onNavigateToUrl(parsedUrl);
    onClose();
  };

  const handleOpenDashboard = () => {
    setValidationError(null);
    setConfirmingSignOut(false);
    onNavigateToUrl(ANTIGRAVITY_DASHBOARD_URL);
    onClose();
  };

  const handleConfirmSignOut = () => {
    setConfirmingSignOut(false);
    setHandoffText('');
    setValidationError(null);
    setSearchQuery('');
    onSignOut();
    onClose();
  };

  const sessionStatusDotColor =
    stage === 'authenticated'
      ? '#34D399'
      : stage === 'authenticating'
        ? '#60A5FA'
        : '#F87171';

  const sessionStatusText =
    stage === 'authenticated'
      ? `Session active (${lastSyncedCookieCount} cookies on this device)`
      : stage === 'authenticating'
        ? 'Google Sign-In in progress'
        : 'Waiting for connection';

  const isAndroid = Platform.OS === 'android';
  const keepAliveHint = isAndroid
    ? keepAliveMinutes > 0
      ? `Active for up to ${keepAliveMinutes}m in background: shows a silent ongoing notification with a Stop Keep-Alive button and uses slightly more battery until the timer expires.`
      : 'Off by default (no background battery use): sessions pause in the background and reconnect when you return. Choosing a timer shows a silent ongoing notification with a Stop Keep-Alive button.'
    : keepAliveMinutes > 0
      ? 'Active: holds the connection across quick app switches (up to the ~30s iOS background limit) using slightly more battery during switches.'
      : 'Off by default (no background battery use): sessions pause immediately when switching apps and reconnect when you return.';

  const handleVisuals = getHandleVisualState({
    stage,
    attentionCount,
    urgentAttentionCount,
    runningCount,
  });

  const isDrawerRendered = visible || isDraggingOpen || isAnimatingOut;

  const backdropOpacity = useMemo(
    () =>
      translateX.interpolate({
        inputRange: [-drawerWidth, 0],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
    [drawerWidth, translateX],
  );

  if (!isDrawerRendered && isKeyboardVisible) {
    return null;
  }

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

  return (
    <View style={styles.overlayRoot} pointerEvents="box-none">
      {isDrawerRendered ? (
        <View
          style={styles.openOverlay}
          pointerEvents={visible ? 'auto' : 'none'}
        >
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

          <Animated.View
            style={[
              styles.drawerPanel,
              {
                width: drawerWidth,
                bottom: keyboardBottomPadding,
                paddingTop: Math.max(insets.top + 12, 20),
                paddingBottom:
                  keyboardBottomPadding > 0
                    ? 12
                    : Math.max(insets.bottom + 14, 20),
                transform: [{ translateX }],
              },
            ]}
            {...openDrawerPanResponder.panHandlers}
          >
            {/* Segmented Mode Switcher: Inbox vs Session */}
            <View style={styles.modeSwitchTrack}>
              <TouchableOpacity
                style={[
                  styles.modeSwitchBtn,
                  activeMode === 'inbox' ? styles.modeSwitchBtnActive : null,
                ]}
                onPress={() => {
                  setActiveMode('inbox');
                  if (stage === 'authenticated' && !isRefreshing) {
                    onRefreshInbox();
                  }
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: activeMode === 'inbox' }}
                accessibilityLabel="Drawer mode Inbox"
              >
                {attentionCount === 0 && runningCount > 0 ? (
                  <View
                    style={[styles.modeStatusDot, { backgroundColor: '#10B981' }]}
                  />
                ) : null}
                <Text
                  style={[
                    styles.modeSwitchText,
                    activeMode === 'inbox' ? styles.modeSwitchTextActive : null,
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
                style={[
                  styles.modeSwitchBtn,
                  activeMode === 'session' ? styles.modeSwitchBtnActive : null,
                ]}
                onPress={() => setActiveMode('session')}
                accessibilityRole="button"
                accessibilityState={{ selected: activeMode === 'session' }}
                accessibilityLabel="Drawer mode Session"
              >
                <View
                  style={[
                    styles.modeStatusDot,
                    { backgroundColor: sessionStatusDotColor },
                  ]}
                />
                <Text
                  style={[
                    styles.modeSwitchText,
                    activeMode === 'session'
                      ? styles.modeSwitchTextActive
                      : null,
                  ]}
                >
                  Session
                </Text>
              </TouchableOpacity>
            </View>

            {activeMode === 'inbox' ? (
              <View style={styles.modeBody}>
                <View style={styles.inboxSubheaderRow}>
                  <Text style={styles.inboxSubtitle} numberOfLines={1}>
                    {inboxSubtitleText}
                  </Text>
                  <TouchableOpacity
                    onPress={onRefreshInbox}
                    style={styles.refreshMiniBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Refresh Thread Inbox"
                  >
                    <Text style={styles.refreshMiniBtnText}>
                      {isRefreshing ? 'Syncing…' : 'Refresh'}
                    </Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.tabsRow}>
                  {(
                    [
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
                      {
                        key: 'all' as const,
                        label: 'All',
                        a11yLabel: 'All',
                        count: counts.all,
                      },
                    ] as const
                  ).map((tab) => {
                    const selected = selectedTab === tab.key;
                    return (
                      <TouchableOpacity
                        key={tab.key}
                        style={[
                          styles.tabChip,
                          selected ? styles.tabChipSelected : null,
                        ]}
                        onPress={() => setSelectedTab(tab.key)}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`Inbox tab ${tab.a11yLabel}`}
                      >
                        <Text
                          style={[
                            styles.tabChipText,
                            selected ? styles.tabChipTextSelected : null,
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

                {counts.all > 0 ? (
                  <View style={styles.toolbarRow}>
                    <TextInput
                      style={styles.searchInput}
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Filter threads…"
                      placeholderTextColor="#64748B"
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="search"
                      accessibilityLabel="Filter Inbox threads"
                    />
                    {counts.dismissible > 0 ? (
                      <TouchableOpacity
                        style={styles.markAllButton}
                        onPress={onMarkAllRead}
                        accessibilityRole="button"
                        accessibilityLabel="Mark all threads as read"
                      >
                        <Text style={styles.markAllButtonText}>Read all</Text>
                      </TouchableOpacity>
                    ) : null}
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
                  {filteredThreads.length > 0 ? (
                    filteredThreads.map((thread) => {
                      const visuals = getBadgeVisuals(thread.attentionKind);
                      const relativeTime = formatRelativeTime(
                        thread.lastModifiedAtMs,
                      );
                      const canMarkRead =
                        thread.attentionKind === 'unread' ||
                        thread.attentionKind === 'error';

                      return (
                        <TouchableOpacity
                          key={thread.id}
                          style={[
                            styles.threadCard,
                            { borderLeftColor: visuals.accentColor },
                            thread.isActiveThread
                              ? styles.threadCardActive
                              : null,
                          ]}
                          activeOpacity={0.82}
                          onPress={() => onSelectThread(thread)}
                          accessibilityRole="button"
                          accessibilityLabel={`Open thread ${thread.title}`}
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
                                  style={[
                                    styles.kindBadgeText,
                                    { color: visuals.textColor },
                                  ]}
                                >
                                  {visuals.label}
                                </Text>
                              </View>

                              {thread.isActiveThread ? (
                                <View style={styles.currentBadge}>
                                  <Text style={styles.currentBadgeText}>
                                    OPEN
                                  </Text>
                                </View>
                              ) : null}
                            </View>

                            {relativeTime ? (
                              <Text style={styles.timestampText}>
                                {relativeTime}
                              </Text>
                            ) : null}
                          </View>

                          <Text style={styles.threadTitle} numberOfLines={2}>
                            {thread.title}
                          </Text>

                          {thread.needsAttention ||
                          thread.attentionKind === 'running' ? (
                            <Text
                              style={[
                                styles.reasonText,
                                thread.attentionKind === 'approval'
                                  ? styles.reasonTextApproval
                                  : thread.attentionKind === 'error'
                                    ? styles.reasonTextError
                                    : null,
                              ]}
                              numberOfLines={2}
                            >
                              {thread.attentionReason}
                            </Text>
                          ) : null}

                          <View style={styles.cardFooterRow}>
                            <Text style={styles.metaText} numberOfLines={1}>
                              {thread.workspaceName
                                ? `${thread.instanceName} • ${thread.workspaceName}`
                                : thread.instanceName}
                            </Text>

                            {canMarkRead ? (
                              <TouchableOpacity
                                style={styles.markReadChip}
                                onPress={() => onMarkThreadRead(thread)}
                                accessibilityRole="button"
                                accessibilityLabel={`Mark ${thread.title} as read`}
                              >
                                <Text style={styles.markReadChipText}>
                                  Mark read
                                </Text>
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        </TouchableOpacity>
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
                            Session controls to manage your connection.
                          </Text>
                          <TouchableOpacity
                            style={styles.emptyActionBtn}
                            onPress={() => setActiveMode('session')}
                            accessibilityRole="button"
                            accessibilityLabel="Open Session controls from Inbox"
                          >
                            <Text style={styles.emptyActionBtnText}>
                              Session & Handoff
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
                            Run agy --remote-control on your computer or paste a
                            handoff link in Session controls.
                          </Text>
                          <TouchableOpacity
                            style={styles.emptyActionBtn}
                            onPress={() => setActiveMode('session')}
                            accessibilityRole="button"
                            accessibilityLabel="Open Session controls from Inbox"
                          >
                            <Text style={styles.emptyActionBtnText}>
                              Open Session Controls
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
            ) : (
              <ScrollView
                style={styles.flexScroll}
                contentContainerStyle={styles.sessionScrollContent}
                bounces={false}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={styles.statusCard}>
                  <Text style={styles.statusLabel}>SESSION VAULT STATUS</Text>
                  <Text style={styles.statusValue}>{sessionStatusText}</Text>
                </View>

                <View style={styles.keepAliveSection}>
                  <Text style={styles.sectionLabel}>Background Keep-Alive</Text>
                  <Text style={styles.keepAliveDescription}>
                    Keeps your live workstation stream connected while you switch
                    to other apps (2FA, browser, chat) so returning is instant
                    instead of reconnecting.
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

                <Text style={styles.sectionLabel}>
                  CLI / Desktop Handoff
                </Text>
                <Text style={styles.sectionHint}>
                  Paste a /remote-control link or enter your instance ID:
                </Text>

                <View style={styles.inputRow}>
                  <TextInput
                    style={styles.handoffInput}
                    value={handoffText}
                    onChangeText={(text) => {
                      setHandoffText(text);
                      if (validationError) {
                        setValidationError(null);
                      }
                    }}
                    placeholder="antigravity.google.com/r/devbox-..."
                    placeholderTextColor="#64748B"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={handleConnectHandoff}
                    accessibilityLabel="CLI handoff link or instance ID"
                  />
                  <TouchableOpacity
                    style={styles.connectButton}
                    onPress={handleConnectHandoff}
                    accessibilityRole="button"
                    accessibilityLabel="Connect to handoff instance"
                  >
                    <Text style={styles.connectButtonText}>Go</Text>
                  </TouchableOpacity>
                </View>

                {validationError ? (
                  <Text style={styles.errorText}>{validationError}</Text>
                ) : null}

                <View style={styles.actionsGroup}>
                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={handleOpenDashboard}
                    accessibilityRole="button"
                  >
                    <Text style={styles.actionButtonText}>
                      All Machines Dashboard
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => {
                      onReloadSession();
                      handleClose();
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.actionButtonText}>
                      Reload & Sync Session Cookies
                    </Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.sessionBottomSection}>
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
                        Wipe saved Google session cookies from this device?
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
      ) : null}

      <View
        style={[
          styles.closedHandleZone,
          isDrawerRendered ? styles.closedHandleZoneHidden : null,
        ]}
        pointerEvents={visible && !isDraggingOpen ? 'none' : 'auto'}
        importantForAccessibility={
          isDrawerRendered ? 'no-hide-descendants' : 'auto'
        }
        {...closedHandlePanResponder.panHandlers}
      >
        {!visible || isDraggingOpen ? (
          <TouchableOpacity
            style={styles.closedHandleButton}
            activeOpacity={0.8}
            onPress={handleTapOpen}
            accessibilityRole="button"
            accessibilityLabel="Open Antigravity drawer"
            accessibilityHint={closedHandleAccessibilityLabel}
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
    width: 28,
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
    backgroundColor: 'rgba(2, 6, 23, 0.68)',
  },
  drawerPanel: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#0F172A',
    borderRightWidth: 1,
    borderRightColor: '#1E293B',
    paddingLeft: 16,
    paddingRight: 26,
    shadowColor: '#000',
    shadowOffset: { width: 8, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 16,
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
  },
  modeSwitchTrack: {
    flexDirection: 'row',
    backgroundColor: '#090D16',
    borderRadius: 11,
    padding: 3,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 12,
  },
  modeSwitchBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
    gap: 6,
  },
  modeSwitchBtnActive: {
    backgroundColor: '#1E293B',
  },
  modeSwitchText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '600',
  },
  modeSwitchTextActive: {
    color: '#F8FAFC',
    fontWeight: '700',
  },
  modeStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  modeCountBadge: {
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeCountBadgeUnread: {
    backgroundColor: '#2563EB',
  },
  modeCountBadgeUrgent: {
    backgroundColor: '#D97706',
  },
  modeCountBadgeText: {
    color: '#FFFFFF',
    fontSize: 10.5,
    fontWeight: '800',
  },
  modeBody: {
    flex: 1,
  },
  inboxSubheaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 8,
  },
  inboxSubtitle: {
    flex: 1,
    color: '#94A3B8',
    fontSize: 11.5,
  },
  refreshMiniBtn: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 7,
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#334155',
  },
  refreshMiniBtnText: {
    color: '#CBD5E1',
    fontSize: 11.5,
    fontWeight: '600',
  },
  tabsRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 9,
  },
  tabChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 6,
    borderRadius: 9,
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#334155',
    gap: 5,
  },
  tabChipSelected: {
    backgroundColor: '#1D4ED8',
    borderColor: '#60A5FA',
  },
  tabChipText: {
    color: '#CBD5E1',
    fontSize: 11.5,
    fontWeight: '600',
    flexShrink: 1,
  },
  tabChipTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  tabCountBadge: {
    minWidth: 17,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: '#0F172A',
    alignItems: 'center',
  },
  tabCountBadgeSelected: {
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  tabCountText: {
    color: '#94A3B8',
    fontSize: 10.5,
    fontWeight: '700',
  },
  tabCountTextSelected: {
    color: '#FFFFFF',
  },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 9,
  },
  searchInput: {
    flex: 1,
    backgroundColor: '#020617',
    color: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 12.5,
  },
  markAllButton: {
    paddingHorizontal: 9,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#334155',
  },
  markAllButtonText: {
    color: '#93C5FD',
    fontSize: 11.5,
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: 'rgba(127, 29, 29, 0.28)',
    borderColor: 'rgba(248, 113, 113, 0.35)',
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 9,
  },
  errorBannerText: {
    color: '#FCA5A5',
    fontSize: 11.5,
  },
  flexScroll: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 8,
    gap: 8,
  },
  threadCard: {
    backgroundColor: '#1E293B',
    borderRadius: 11,
    paddingHorizontal: 11,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#334155',
    borderLeftWidth: 4,
  },
  threadCardActive: {
    borderColor: '#60A5FA',
    backgroundColor: '#172554',
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
    backgroundColor: 'rgba(96, 165, 250, 0.2)',
  },
  currentBadgeText: {
    color: '#93C5FD',
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  timestampText: {
    color: '#94A3B8',
    fontSize: 10.5,
    fontWeight: '500',
  },
  threadTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  reasonText: {
    color: '#CBD5E1',
    fontSize: 11.5,
    marginTop: 3,
    lineHeight: 16,
  },
  reasonTextApproval: {
    color: '#FDE68A',
    fontWeight: '500',
  },
  reasonTextError: {
    color: '#FCA5A5',
  },
  cardFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 7,
    gap: 6,
  },
  metaText: {
    flex: 1,
    color: '#94A3B8',
    fontSize: 10.5,
  },
  markReadChip: {
    paddingHorizontal: 7,
    paddingVertical: 3.5,
    borderRadius: 6,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
  },
  markReadChipText: {
    color: '#93C5FD',
    fontSize: 10.5,
    fontWeight: '600',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 14,
  },
  emptyTitle: {
    color: '#F1F5F9',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 8,
    marginBottom: 5,
    textAlign: 'center',
  },
  emptySubtitle: {
    color: '#94A3B8',
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  emptyActionBtn: {
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#3B82F6',
  },
  emptyActionBtnText: {
    color: '#93C5FD',
    fontSize: 12,
    fontWeight: '600',
  },
  sessionScrollContent: {
    flexGrow: 1,
  },
  statusCard: {
    backgroundColor: '#1E293B',
    borderRadius: 11,
    padding: 11,
    marginBottom: 13,
    borderWidth: 1,
    borderColor: '#334155',
  },
  statusLabel: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.7,
    marginBottom: 3,
  },
  statusValue: {
    color: '#E2E8F0',
    fontSize: 12.5,
    fontWeight: '500',
  },
  keepAliveSection: {
    marginBottom: 13,
  },
  keepAliveDescription: {
    color: '#94A3B8',
    fontSize: 11.5,
    lineHeight: 16,
    marginBottom: 6,
  },
  keepAliveRow: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 2,
    marginBottom: 6,
  },
  keepAliveChip: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
  },
  keepAliveChipSelected: {
    backgroundColor: '#1D4ED8',
    borderColor: '#60A5FA',
  },
  keepAliveChipText: {
    color: '#CBD5E1',
    fontSize: 11.5,
    fontWeight: '600',
  },
  keepAliveChipTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  keepAliveHint: {
    color: '#94A3B8',
    fontSize: 11,
    lineHeight: 15,
  },
  sectionLabel: {
    color: '#F1F5F9',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 3,
  },
  sectionHint: {
    color: '#94A3B8',
    fontSize: 11.5,
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 7,
  },
  handoffInput: {
    flex: 1,
    backgroundColor: '#020617',
    color: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 12.5,
  },
  connectButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: 9,
  },
  connectButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  errorText: {
    color: '#F87171',
    fontSize: 11.5,
    marginBottom: 8,
  },
  actionsGroup: {
    marginTop: 6,
    gap: 8,
  },
  actionButton: {
    backgroundColor: '#1E293B',
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
  },
  actionButtonText: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '600',
  },
  sessionBottomSection: {
    marginTop: 'auto',
    paddingTop: 14,
  },
  signOutButton: {
    paddingVertical: 11,
    borderRadius: 9,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.35)',
    backgroundColor: 'rgba(127, 29, 29, 0.2)',
  },
  signOutButtonText: {
    color: '#FCA5A5',
    fontSize: 13,
    fontWeight: '600',
  },
  confirmBox: {
    padding: 11,
    borderRadius: 10,
    backgroundColor: '#2A1215',
    borderWidth: 1,
    borderColor: '#7F1D1D',
  },
  confirmTitle: {
    color: '#FECACA',
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
    backgroundColor: '#1E293B',
    alignItems: 'center',
  },
  cancelConfirmText: {
    color: '#E2E8F0',
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
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '700',
  },
  footerContainer: {
    marginTop: 14,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: '#1E293B',
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
    color: '#93C5FD',
    fontSize: 11.5,
    fontWeight: '600',
  },
  footerSeparator: {
    color: '#475569',
    fontSize: 11.5,
  },
  footerDisclaimerText: {
    color: '#64748B',
    fontSize: 10.5,
    lineHeight: 14,
    textAlign: 'center',
  },
});
