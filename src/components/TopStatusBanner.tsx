import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  authBanner: {
    backgroundColor: '#101929',
    borderBottomColor: '#1E3A5F',
  },
  offlineBanner: {
    backgroundColor: '#2A1215',
    borderBottomColor: '#5C232A',
  },
  dotAuth: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#60A5FA',
    marginRight: 8,
  },
  dotOffline: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#F87171',
    marginRight: 8,
  },
  bannerText: {
    flex: 1,
    color: '#E2E8F0',
    fontSize: 12,
    fontWeight: '500',
  },
  retryButton: {
    marginLeft: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#3B1D22',
    borderWidth: 1,
    borderColor: '#F87171',
  },
  retryButtonText: {
    color: '#FCA5A5',
    fontSize: 12,
    fontWeight: '600',
  },
  authReloadButton: {
    marginLeft: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#3B82F6',
  },
  authReloadButtonText: {
    color: '#93C5FD',
    fontSize: 11,
    fontWeight: '600',
  },
});
