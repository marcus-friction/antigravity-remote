import * as Linking from 'expo-linking';
import React, { useEffect, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  IOS_KEEP_ALIVE_ENABLED_MINUTES,
  KEEP_ALIVE_DURATION_OPTIONS,
} from '../constants/config';
import { ANTIGRAVITY_THEME } from '../constants/theme';
import {
  ActionNotificationMode,
  AuthFlowStage,
  KeepAliveMinutes,
} from '../types/session';

export type NotificationPermissionStatus =
  | 'granted'
  | 'denied'
  | 'undetermined'
  | 'not_required';

export interface IntroTourModalProps {
  visible: boolean;
  stage: AuthFlowStage;
  isTabletLayout: boolean;
  actionNotificationMode: ActionNotificationMode;
  keepAliveMinutes: KeepAliveMinutes;
  notificationPermissionStatus: NotificationPermissionStatus;
  onChangeActionNotificationMode: (mode: ActionNotificationMode) => void;
  onChangeKeepAliveMinutes: (minutes: KeepAliveMinutes) => void;
  onRequestNotificationPermission: () => Promise<NotificationPermissionStatus>;
  onComplete: () => void;
  onRegisterBackHandler?: (interceptor: (() => boolean) | null) => void;
}

const { colors } = ANTIGRAVITY_THEME;
const TOTAL_STEPS = 3;

export const IntroTourModal: React.FC<IntroTourModalProps> = ({
  visible,
  stage,
  isTabletLayout,
  actionNotificationMode,
  keepAliveMinutes,
  notificationPermissionStatus,
  onChangeActionNotificationMode,
  onChangeKeepAliveMinutes,
  onRequestNotificationPermission,
  onComplete,
  onRegisterBackHandler,
}) => {
  const [step, setStep] = useState<number>(0);
  const [isRequestingPermission, setIsRequestingPermission] =
    useState<boolean>(false);

  useEffect(() => {
    if (visible) {
      setStep(0);
    }
  }, [visible]);

  useEffect(() => {
    if (!onRegisterBackHandler) return;
    if (!visible) {
      onRegisterBackHandler(null);
      return;
    }
    onRegisterBackHandler(() => {
      if (step > 0) {
        setStep((prev) => Math.max(0, prev - 1));
        return true;
      }
      onComplete();
      return true;
    });
    return () => {
      onRegisterBackHandler(null);
    };
  }, [onComplete, onRegisterBackHandler, step, visible]);

  if (!visible) {
    return null;
  }

  const isAndroid = Platform.OS === 'android';
  const permissionRequired =
    notificationPermissionStatus !== 'not_required' &&
    notificationPermissionStatus !== 'granted';

  const handleRequestPermissionPress = () => {
    if (isRequestingPermission) return;
    setIsRequestingPermission(true);
    void onRequestNotificationPermission().finally(() => {
      setIsRequestingPermission(false);
    });
  };

  const handleOpenSystemSettings = () => {
    void Linking.openSettings().catch(() => undefined);
  };

  const renderPermissionCard = (contextHint: string) => {
    if (notificationPermissionStatus === 'not_required') {
      return (
        <View style={[styles.permissionCard, styles.permissionCardGranted]}>
          <View style={styles.permissionStatusRow}>
            <View style={[styles.statusDot, { backgroundColor: colors.running }]} />
            <Text style={styles.permissionTitleGranted}>
              Notifications ready on this device
            </Text>
          </View>
          <Text style={styles.permissionBody}>{contextHint}</Text>
        </View>
      );
    }

    if (notificationPermissionStatus === 'granted') {
      return (
        <View style={[styles.permissionCard, styles.permissionCardGranted]}>
          <View style={styles.permissionStatusRow}>
            <View style={[styles.statusDot, { backgroundColor: colors.running }]} />
            <Text style={styles.permissionTitleGranted}>
              Notification permission granted
            </Text>
          </View>
          <Text style={styles.permissionBody}>{contextHint}</Text>
        </View>
      );
    }

    if (notificationPermissionStatus === 'denied') {
      return (
        <View style={[styles.permissionCard, styles.permissionCardWarning]}>
          <View style={styles.permissionStatusRow}>
            <View style={[styles.statusDot, { backgroundColor: colors.approval }]} />
            <Text style={styles.permissionTitleWarning}>
              Notifications are blocked in System Settings
            </Text>
          </View>
          <Text style={styles.permissionBody}>
            {contextHint} Enable notifications in system settings whenever you
            want alerts to appear.
          </Text>
          <TouchableOpacity
            style={styles.permissionSecondaryButton}
            onPress={handleOpenSystemSettings}
            accessibilityRole="button"
            accessibilityLabel="Intro tour open settings"
          >
            <Text style={styles.permissionSecondaryButtonText}>
              Open System Settings
            </Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={styles.permissionCard}>
        <View style={styles.permissionStatusRow}>
          <View
            style={[styles.statusDot, { backgroundColor: colors.primaryBright }]}
          />
          <Text style={styles.permissionTitle}>
            Notification permission needed
          </Text>
        </View>
        <Text style={styles.permissionBody}>{contextHint}</Text>
        <TouchableOpacity
          style={styles.permissionActionButton}
          onPress={handleRequestPermissionPress}
          disabled={isRequestingPermission}
          accessibilityRole="button"
          accessibilityLabel="Intro tour allow notifications"
        >
          <Text style={styles.permissionActionButtonText}>
            {isRequestingPermission
              ? 'Requesting permission…'
              : 'Allow Notifications'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View
      testID="intro-tour-overlay"
      style={styles.backdrop}
      accessibilityViewIsModal={true}
    >
      <View
        style={[
          styles.card,
          isTabletLayout ? styles.cardTablet : styles.cardPhone,
        ]}
      >
        <View style={styles.topRow}>
          <View style={styles.stepDotsRow}>
            {[0, 1, 2].map((index) => (
              <View
                key={index}
                style={[
                  styles.stepDot,
                  index === step
                    ? styles.stepDotActive
                    : index < step
                      ? styles.stepDotDone
                      : null,
                ]}
              />
            ))}
            <Text style={styles.stepCounterText}>
              Step {step + 1} of {TOTAL_STEPS}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.skipButton}
            onPress={onComplete}
            accessibilityRole="button"
            accessibilityLabel="Intro tour skip"
          >
            <Text style={styles.skipButtonText}>Skip</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scrollBody}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {step === 0 ? (
            <View style={styles.stepContent}>
              <View style={styles.eyebrowPill}>
                <Text style={styles.eyebrowText}>
                  INDEPENDENT OPEN-SOURCE CLIENT
                </Text>
              </View>
              <Text style={styles.title}>Remote Client for Antigravity</Text>
              <Text style={styles.subtitle}>
                Control your Antigravity workstations from mobile and tablets
                with native navigation, live quotas, and optional on-device
                alerts.
              </Text>

              <View style={styles.featureList}>
                <View style={styles.featureRow}>
                  <View
                    style={[
                      styles.featureAccent,
                      { backgroundColor: colors.primaryBright },
                    ]}
                  />
                  <View style={styles.featureTextWrap}>
                    <Text style={styles.featureTitle}>
                      {isTabletLayout
                        ? 'Docked Side-by-Side Sidebar'
                        : 'Swipe-Safe Left Sidebar Handle'}
                    </Text>
                    <Text style={styles.featureBody}>
                      {isTabletLayout
                        ? 'Switch between Inbox, Projects, Usage, and Settings right alongside your active coding thread.'
                        : 'Pull or tap the vertical handle on the left edge to open your Inbox, Projects, Usage quotas, and Settings.'}
                    </Text>
                  </View>
                </View>

                <View style={styles.featureRow}>
                  <View
                    style={[
                      styles.featureAccent,
                      { backgroundColor: colors.approval },
                    ]}
                  />
                  <View style={styles.featureTextWrap}>
                    <Text style={styles.featureTitle}>
                      Cross-Workstation Inbox &amp; Projects
                    </Text>
                    <Text style={styles.featureBody}>
                      Spot pending approvals (amber), errors (red), finished
                      runs (blue), and working tasks (green) across all online
                      machines.
                    </Text>
                  </View>
                </View>

                <View style={styles.featureRow}>
                  <View
                    style={[
                      styles.featureAccent,
                      { backgroundColor: colors.runningSolid },
                    ]}
                  />
                  <View style={styles.featureTextWrap}>
                    <Text style={styles.featureTitle}>
                      Direct /remote-control Handoff
                    </Text>
                    <Text style={styles.featureBody}>
                      Paste any /remote-control URL or machine ID in Settings to
                      jump straight into a session. No developer servers or
                      tracking.
                    </Text>
                  </View>
                </View>
              </View>
            </View>
          ) : null}

          {step === 1 ? (
            <View style={styles.stepContent}>
              <Text style={styles.title}>Choose Action Notifications</Text>
              <Text style={styles.subtitle}>
                Receive color-coded on-device notification cards when an agent
                needs command approval, asks a question, or finishes. Evaluated
                100% locally on your device.
              </Text>

              <View style={styles.optionsStack}>
                {(
                  [
                    {
                      key: 'off' as const,
                      title: 'Off (Default)',
                      desc: 'No notifications. Check Inbox whenever you open the app.',
                      a11y: 'Tour notifications Off',
                    },
                    {
                      key: 'approvals' as const,
                      title: 'Approvals Only',
                      desc: 'Notify only when an agent blocks for command approval or asks a question.',
                      a11y: 'Tour notifications Approvals',
                    },
                    {
                      key: 'all_attention' as const,
                      title: 'All Attention',
                      badge: 'POPULAR',
                      desc: 'Notify for approvals, questions, errors, and finished runs with one-tap thread links.',
                      a11y: 'Tour notifications All Attention',
                    },
                  ] as const
                ).map((opt) => {
                  const selected = actionNotificationMode === opt.key;
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[
                        styles.optionCard,
                        selected ? styles.optionCardSelected : null,
                      ]}
                      onPress={() => onChangeActionNotificationMode(opt.key)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={opt.a11y}
                    >
                      <View style={styles.optionHeaderRow}>
                        <View style={styles.optionTitleRow}>
                          <View
                            style={[
                              styles.radioOuter,
                              selected ? styles.radioOuterSelected : null,
                            ]}
                          >
                            {selected ? <View style={styles.radioInner} /> : null}
                          </View>
                          <Text
                            style={[
                              styles.optionTitle,
                              selected ? styles.optionTitleSelected : null,
                            ]}
                          >
                            {opt.title}
                          </Text>
                          {'badge' in opt && opt.badge ? (
                            <View style={styles.recommendedBadge}>
                              <Text style={styles.recommendedBadgeText}>
                                {opt.badge}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      </View>
                      <Text style={styles.optionDesc}>{opt.desc}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {actionNotificationMode !== 'off'
                ? renderPermissionCard(
                    'Android/iOS notification permission lets this app display local action cards when your agent needs attention.',
                  )
                : (
                    <View style={styles.neutralInfoBox}>
                      <Text style={styles.neutralInfoText}>
                        Notifications stay off and no notification permission
                        will be requested. You can turn them on anytime in
                        Settings.
                      </Text>
                    </View>
                  )}
            </View>
          ) : null}

          {step === 2 ? (
            <View style={styles.stepContent}>
              <Text style={styles.title}>Stay Connected in Background</Text>
              <Text style={styles.subtitle}>
                Optional: keep remote workstation sessions alive while switching
                to 2FA/chat apps and keep checking for alerts while your phone
                is locked. Off by default.
              </Text>

              <View style={styles.chipRow}>
                {isAndroid
                  ? KEEP_ALIVE_DURATION_OPTIONS.map((minutes) => {
                      const selected = keepAliveMinutes === minutes;
                      const label = minutes === 0 ? 'Off' : `${minutes}m`;
                      return (
                        <TouchableOpacity
                          key={minutes}
                          style={[
                            styles.durationChip,
                            selected ? styles.durationChipSelected : null,
                          ]}
                          onPress={() => onChangeKeepAliveMinutes(minutes)}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`Tour keep-alive ${label}`}
                        >
                          <Text
                            style={[
                              styles.durationChipText,
                              selected ? styles.durationChipTextSelected : null,
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
                          label: 'Off (Default)',
                          value: 0 as KeepAliveMinutes,
                          selected: keepAliveMinutes === 0,
                          a11y: 'Tour keep-alive Off',
                        },
                        {
                          label: 'On (~30s)',
                          value:
                            IOS_KEEP_ALIVE_ENABLED_MINUTES as KeepAliveMinutes,
                          selected: keepAliveMinutes > 0,
                          a11y: 'Tour keep-alive On',
                        },
                      ] as const
                    ).map((opt) => (
                      <TouchableOpacity
                        key={opt.label}
                        style={[
                          styles.durationChip,
                          opt.selected ? styles.durationChipSelected : null,
                        ]}
                        onPress={() => onChangeKeepAliveMinutes(opt.value)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: opt.selected }}
                        accessibilityLabel={opt.a11y}
                      >
                        <Text
                          style={[
                            styles.durationChipText,
                            opt.selected
                              ? styles.durationChipTextSelected
                              : null,
                          ]}
                        >
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
              </View>

              <View style={styles.disclosureBox}>
                {keepAliveMinutes === 0 ? (
                  <>
                    <Text style={styles.disclosureTitle}>
                      Off (Default — No background battery use)
                    </Text>
                    <Text style={styles.disclosureBody}>
                      Connections pause when you leave or lock your phone and
                      reconnect automatically when you return.
                      {actionNotificationMode !== 'off'
                        ? ' Action alerts will appear while the app is open; pick a timer above if you also want locked-screen alerts.'
                        : ''}
                    </Text>
                  </>
                ) : isAndroid ? (
                  <>
                    <Text style={styles.disclosureTitle}>
                      Bounded Keep-Alive ({keepAliveMinutes}m max)
                    </Text>
                    <Text style={styles.disclosureBody}>
                      When you leave the app or lock your phone while signed in,
                      Android shows an ongoing status notification with a
                      one-tap Stop Keep-Alive button and automatically stops
                      after {keepAliveMinutes} minutes. Uses slightly more
                      battery while active.
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.disclosureTitle}>
                      Brief Background Keep-Alive (~30s)
                    </Text>
                    <Text style={styles.disclosureBody}>
                      Uses iOS background time to keep sessions open across
                      quick 2FA or browser switches. Uses slightly more battery.
                    </Text>
                  </>
                )}
              </View>

              {isAndroid && keepAliveMinutes > 0 && permissionRequired
                ? renderPermissionCard(
                    'Notification permission lets Android show the ongoing Keep-Alive status notification and Stop Keep-Alive button.',
                  )
                : null}

              <Text style={styles.revisitHint}>
                You can change any preference or replay this tour anytime in
                Settings.
              </Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.footerRow}>
          {step > 0 ? (
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => setStep((prev) => Math.max(0, prev - 1))}
              accessibilityRole="button"
              accessibilityLabel="Intro tour back"
            >
              <Text style={styles.backButtonText}>Back</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.backSpacer} />
          )}

          {step < TOTAL_STEPS - 1 ? (
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() =>
                setStep((prev) => Math.min(TOTAL_STEPS - 1, prev + 1))
              }
              accessibilityRole="button"
              accessibilityLabel="Intro tour next"
            >
              <Text style={styles.primaryButtonText}>
                {step === 0 ? 'Next: Notifications' : 'Next: Background'}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={onComplete}
              accessibilityRole="button"
              accessibilityLabel="Intro tour finish"
            >
              <Text style={styles.primaryButtonText}>
                {stage === 'authenticated' ? 'Done' : 'Continue to Sign In'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
    backgroundColor: 'rgba(6, 7, 10, 0.86)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  card: {
    backgroundColor: colors.sidebar,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 20,
    maxHeight: '92%',
    overflow: 'hidden',
  },
  cardPhone: {
    width: '100%',
    maxWidth: 440,
  },
  cardTablet: {
    width: '100%',
    maxWidth: 520,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  stepDotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.control,
  },
  stepDotActive: {
    width: 22,
    backgroundColor: colors.primaryBright,
  },
  stepDotDone: {
    backgroundColor: colors.primaryText,
  },
  stepCounterText: {
    marginLeft: 6,
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  skipButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  skipButtonText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  scrollBody: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  stepContent: {
    gap: 14,
  },
  eyebrowPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  eyebrowText: {
    color: colors.primaryText,
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 21,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 13.5,
    lineHeight: 20,
  },
  featureList: {
    gap: 10,
    marginTop: 2,
  },
  featureRow: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
  featureAccent: {
    width: 4,
    borderRadius: 2,
  },
  featureTextWrap: {
    flex: 1,
    gap: 3,
  },
  featureTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  featureBody: {
    color: colors.textMuted,
    fontSize: 12.5,
    lineHeight: 18,
  },
  optionsStack: {
    gap: 9,
  },
  optionCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  optionCardSelected: {
    backgroundColor: colors.surfaceSelected,
    borderColor: colors.primaryBorder,
  },
  optionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  radioOuter: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOuterSelected: {
    borderColor: colors.primaryBright,
  },
  radioInner: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: colors.primaryBright,
  },
  optionTitle: {
    color: colors.textPrimary,
    fontSize: 14.5,
    fontWeight: '700',
  },
  optionTitleSelected: {
    color: colors.primaryText,
  },
  recommendedBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  recommendedBadgeText: {
    color: colors.primaryText,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  optionDesc: {
    color: colors.textMuted,
    fontSize: 12.5,
    lineHeight: 18,
    paddingLeft: 27,
  },
  permissionCard: {
    backgroundColor: colors.primaryCardBg,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    borderRadius: 12,
    padding: 13,
    gap: 8,
  },
  permissionCardGranted: {
    backgroundColor: colors.runningSoft,
    borderColor: colors.runningBorder,
  },
  permissionCardWarning: {
    backgroundColor: colors.approvalSoft,
    borderColor: colors.approvalBorder,
  },
  permissionStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  permissionTitle: {
    color: colors.primaryText,
    fontSize: 13.5,
    fontWeight: '700',
  },
  permissionTitleGranted: {
    color: colors.runningText,
    fontSize: 13.5,
    fontWeight: '700',
  },
  permissionTitleWarning: {
    color: colors.approvalText,
    fontSize: 13.5,
    fontWeight: '700',
  },
  permissionBody: {
    color: colors.textSecondary,
    fontSize: 12.5,
    lineHeight: 18,
  },
  permissionActionButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 9,
    marginTop: 2,
  },
  permissionActionButtonText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '700',
  },
  permissionSecondaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.control,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 9,
    marginTop: 2,
  },
  permissionSecondaryButtonText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  neutralInfoBox: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 11,
    padding: 12,
  },
  neutralInfoText: {
    color: colors.textMuted,
    fontSize: 12.5,
    lineHeight: 18,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
  },
  durationChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  durationChipSelected: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primaryBorder,
  },
  durationChipText: {
    color: colors.textSecondary,
    fontSize: 13.5,
    fontWeight: '700',
  },
  durationChipTextSelected: {
    color: colors.primaryText,
  },
  disclosureBox: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 13,
    gap: 5,
  },
  disclosureTitle: {
    color: colors.textPrimary,
    fontSize: 13.5,
    fontWeight: '700',
  },
  disclosureBody: {
    color: colors.textMuted,
    fontSize: 12.5,
    lineHeight: 18,
  },
  revisitHint: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.well,
    gap: 12,
  },
  backSpacer: {
    width: 64,
  },
  backButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.control,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  backButtonText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
  primaryButton: {
    flex: 1,
    maxWidth: 230,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: colors.primary,
  },
  primaryButtonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '700',
  },
});
