import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ANTIGRAVITY_THEME } from '../constants/theme';
import { AuthFlowStage } from '../types/session';

interface TopStatusBannerProps {
  stage: AuthFlowStage;
  onRetryPress: () => void;
}

export const TopStatusBanner: React.FC<TopStatusBannerProps> = ({
  stage,
  onRetryPress,
}) => {
  if (stage === 'authenticated' || stage === 'hydrating') {
    return null;
  }

  if (stage === 'authenticating') {
    return (
      <View style={[styles.banner, styles.authBanner]}>
        <View style={styles.dotAuth} />
        <Text style={styles.bannerText} numberOfLines={1}>
          Google Sign-In active — your session will be saved automatically
        </Text>
        <TouchableOpacity
          onPress={onRetryPress}
          style={styles.authReloadButton}
          accessibilityRole="button"
          accessibilityLabel="Reload sign-in session"
        >
          <Text style={styles.authReloadButtonText}>Reload</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.banner, styles.offlineBanner]}>
      <View style={styles.dotOffline} />
      <Text style={styles.bannerText} numberOfLines={1}>
        Network connection interrupted
      </Text>
      <TouchableOpacity
        onPress={onRetryPress}
        style={styles.retryButton}
        accessibilityRole="button"
        accessibilityLabel="Retry connection"
      >
        <Text style={styles.retryButtonText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
};

const { colors } = ANTIGRAVITY_THEME;

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  authBanner: {
    backgroundColor: colors.sidebar,
    borderBottomColor: colors.border,
  },
  offlineBanner: {
    backgroundColor: colors.errorBannerBg,
    borderBottomColor: colors.errorBannerBorder,
  },
  dotAuth: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: colors.primaryBright,
    marginRight: 8,
  },
  dotOffline: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: colors.errorMuted,
    marginRight: 8,
  },
  bannerText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '500',
  },
  retryButton: {
    marginLeft: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 7,
    backgroundColor: colors.errorSoft,
    borderWidth: 1,
    borderColor: colors.errorBorder,
  },
  retryButtonText: {
    color: colors.errorText,
    fontSize: 12,
    fontWeight: '600',
  },
  authReloadButton: {
    marginLeft: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 7,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  authReloadButtonText: {
    color: colors.primaryText,
    fontSize: 11,
    fontWeight: '600',
  },
});
