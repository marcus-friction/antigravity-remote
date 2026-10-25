import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ANTIGRAVITY_DASHBOARD_URL } from '../constants/config';
import { AuthFlowStage } from '../types/session';
import { parseHandoffInput } from '../utils/urlValidator';

interface HandoffModalProps {
  visible: boolean;
  stage: AuthFlowStage;
  lastSyncedCookieCount: number;
  onClose: () => void;
  onNavigateToUrl: (targetUrl: string) => void;
  onReloadSession: () => void;
  onSignOut: () => void;
}

export const HandoffModal: React.FC<HandoffModalProps> = ({
  visible,
  stage,
  lastSyncedCookieCount,
  onClose,
  onNavigateToUrl,
  onReloadSession,
  onSignOut,
}) => {
  const [handoffText, setHandoffText] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  const handleClose = () => {
    setValidationError(null);
    setConfirmingSignOut(false);
    onClose();
  };

  const handleConnectHandoff = () => {
    const parsedUrl = parseHandoffInput(handoffText);
    if (!parsedUrl) {
      setValidationError(
        'Enter a valid antigravity.google.com/r/<instance-id> link or instance name.'
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
    onSignOut();
    onClose();
  };

  const statusText =
    stage === 'authenticated'
      ? `Google session active (${lastSyncedCookieCount} cookies vaulted in hardware keystore)`
      : stage === 'authenticating'
        ? 'Google Sign-In in progress'
        : 'Waiting for connection';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.backdrop} onPress={handleClose} />

        <View style={styles.sheet}>
          <View style={styles.handleBar} />

          <View style={styles.headerRow}>
            <Text style={styles.title}>Antigravity Remote</Text>
            <TouchableOpacity
              onPress={handleClose}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel="Close menu"
            >
              <Text style={styles.closeButtonText}>Done</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.statusCard}>
            <Text style={styles.statusLabel}>SESSION VAULT STATUS</Text>
            <Text style={styles.statusValue}>{statusText}</Text>
          </View>

          <Text style={styles.sectionLabel}>
            Jump to CLI / Desktop Handoff Session
          </Text>
          <Text style={styles.sectionHint}>
            Paste the link printed by /remote-control or enter your instance ID:
          </Text>

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={handoffText}
              onChangeText={(text) => {
                setHandoffText(text);
                if (validationError) {
                  setValidationError(null);
                }
              }}
              placeholder="https://antigravity.google.com/r/devbox-..."
              placeholderTextColor="#64748B"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={handleConnectHandoff}
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
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(2, 6, 23, 0.65)',
  },
  sheet: {
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 34,
    borderTopWidth: 1,
    borderColor: '#1E293B',
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#334155',
    alignSelf: 'center',
    marginBottom: 14,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  title: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '700',
  },
  closeButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#1E293B',
  },
  closeButtonText: {
    color: '#93C5FD',
    fontSize: 13,
    fontWeight: '600',
  },
  statusCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 12,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: '#334155',
  },
  statusLabel: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  statusValue: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '500',
  },
  sectionLabel: {
    color: '#F1F5F9',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  sectionHint: {
    color: '#94A3B8',
    fontSize: 12,
    marginBottom: 10,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#020617',
    color: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    marginRight: 8,
  },
  connectButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
  },
  connectButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  errorText: {
    color: '#F87171',
    fontSize: 12,
    marginBottom: 10,
  },
  actionsGroup: {
    marginTop: 8,
    gap: 8,
  },
  actionButton: {
    backgroundColor: '#1E293B',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
  },
  actionButtonText: {
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '600',
  },
  signOutButton: {
    marginTop: 14,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.35)',
    backgroundColor: 'rgba(127, 29, 29, 0.2)',
  },
  signOutButtonText: {
    color: '#FCA5A5',
    fontSize: 14,
    fontWeight: '600',
  },
  confirmBox: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#2A1215',
    borderWidth: 1,
    borderColor: '#7F1D1D',
  },
  confirmTitle: {
    color: '#FECACA',
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 10,
    textAlign: 'center',
  },
  confirmButtonsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  cancelConfirmButton: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#1E293B',
    alignItems: 'center',
  },
  cancelConfirmText: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '600',
  },
  confirmDangerButton: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#DC2626',
    alignItems: 'center',
  },
  confirmDangerText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
});
