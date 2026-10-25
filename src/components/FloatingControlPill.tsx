import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AuthFlowStage } from '../types/session';

interface FloatingControlPillProps {
  stage: AuthFlowStage;
  onPress: () => void;
}

export const FloatingControlPill: React.FC<FloatingControlPillProps> = ({
  stage,
  onPress,
}) => {
  const dotColor =
    stage === 'authenticated'
      ? '#34D399'
      : stage === 'authenticating'
        ? '#60A5FA'
        : '#F87171';

  return (
    <View style={styles.container} pointerEvents="box-none">
      <TouchableOpacity
        style={styles.pill}
        onPress={onPress}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Open Antigravity Remote controls"
      >
        <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
        <Text style={styles.pillLabel}>Remote</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    right: 16,
    bottom: 24,
    zIndex: 50,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.28)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 7,
  },
  pillLabel: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
