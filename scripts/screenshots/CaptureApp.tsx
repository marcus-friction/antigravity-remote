import React, { useCallback, useEffect, useState } from 'react';
import { Linking, PermissionsAndroid, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { DrawerMode, LeftNavigationDrawer } from '../../src/components/LeftNavigationDrawer';
import { ANTIGRAVITY_THEME } from '../../src/constants/theme';
import { configureNativeKeepAlive, syncNativeActionNotification } from '../../src/services/webData';
import { ActionNotificationMode, KeepAliveMinutes } from '../../src/types/session';
import { InboxThreadItem } from '../../src/types/inbox';
import { computeDrawerWidth, isTabletViewport } from '../../src/utils/layout';
import { sampleSnapshot, sampleThreads } from './sampleData';

export default function CaptureApp(): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<DrawerMode>('inbox');
  const [requestKey, setRequestKey] = useState(0);
  const [keepAliveMinutes, setKeepAliveMinutes] = useState<KeepAliveMinutes>(30);
  const [actionNotificationMode, setActionNotificationMode] = useState<ActionNotificationMode>('all_attention');
  const [threads, setThreads] = useState(sampleThreads);
  const { width, height } = useWindowDimensions();
  const docked = isTabletViewport(width, height);
  const open = useCallback((next: DrawerMode = 'inbox') => {
    setMode(next); setRequestKey(key => key + 1); setVisible(true);
  }, []);
  const handleUrl = useCallback(async (url: string | null) => {
    const screen = /[?&]screen=([^&]+)/.exec(url ?? '')?.[1] ?? 'thread';
    if (['inbox', 'projects', 'usage', 'settings'].includes(screen)) open(screen as DrawerMode);
    else setVisible(false);
    if (screen === 'notifications') {
      if (Platform.OS === 'android') await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      const attention = sampleThreads.filter(item => item.needsAttention);
      await configureNativeKeepAlive(true, 30, true);
      await syncNativeActionNotification({
        title: 'Antigravity Remote', body: '3 threads need your attention',
        expandedBody: attention.map(item => item.title).join('\n'), count: attention.length,
        deepLinkUrl: 'antigravity-remote://inbox', shouldAlert: false,
        items: attention.map(item => ({
          id: item.id, title: item.title, attentionKind: item.attentionKind,
          statusLabel: item.attentionKind === 'approval' ? 'NEEDS APPROVAL' : item.attentionKind === 'unread' ? 'FINISHED' : 'NEEDS REVIEW',
          attentionReason: item.attentionReason, projectName: item.projectName,
          instanceName: item.instanceName, subtitle: item.instanceName,
          deepLinkUrl: `antigravity-remote://r/${item.instanceUuid}?p=c%2F${item.cascadeId}`,
        })),
      });
    }
  }, [open]);
  useEffect(() => {
    void Linking.getInitialURL().then(handleUrl);
    const sub = Linking.addEventListener('url', event => { void handleUrl(event.url); });
    return () => sub.remove();
  }, [handleUrl]);
  const markRead = (selected: InboxThreadItem) => setThreads(items => items.map(item => item.id === selected.id ? { ...item, attentionKind: 'idle', needsAttention: false } : item));
  return <SafeAreaProvider><SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
    <StatusBar style="light" backgroundColor={ANTIGRAVITY_THEME.colors.canvas} />
    <View style={styles.root}>
      <View style={[styles.root, docked ? { marginLeft: computeDrawerWidth(width, true) } : null]}>
        <WebView source={{ uri: 'http://127.0.0.1:5187/' }} style={styles.root} scrollEnabled javaScriptEnabled />
      </View>
      <LeftNavigationDrawer visible={visible || docked} docked={docked} initialMode={mode}
        drawerModeRequestKey={requestKey} hasSeenGuidance stage="authenticated"
        activeUrl={sampleThreads[0].targetUrl} snapshot={{ ...sampleSnapshot, threads }} isRefreshing={false}
        attentionCount={3} urgentAttentionCount={2} runningCount={2}
        keepAliveMinutes={keepAliveMinutes} actionNotificationMode={actionNotificationMode}
        onOpen={open} onClose={() => setVisible(false)} onRefreshInbox={() => {}}
        onSelectThread={() => setVisible(false)} onStartProjectThread={() => setVisible(false)}
        onMarkThreadRead={markRead} onMarkAllRead={() => setThreads(items => items.map(item => ({ ...item, needsAttention: false, attentionKind: item.attentionKind === 'running' ? 'running' : 'idle' })))}
        onChangeKeepAliveMinutes={setKeepAliveMinutes} onChangeActionNotificationMode={setActionNotificationMode}
        onNavigateToUrl={() => setVisible(false)} onOpenHostSettings={() => {}}
        onOpenIntroTour={() => {}}
        onListDirectory={async () => ({ ok: true, currentUri: 'file:///home/demo/projects', parentUri: 'file:///home/demo', entries: [{ name: 'web-dashboard', uri: 'file:///home/demo/projects/web-dashboard' }] })}
        onCreateProject={async () => ({ ok: true, projectId: 'new-project', projectName: 'New project', workspaceUri: 'file:///home/demo/projects/new-project' })}
        onReloadSession={() => {}} onSignOut={() => {}} />
    </View>
  </SafeAreaView></SafeAreaProvider>;
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: ANTIGRAVITY_THEME.colors.canvas } });
