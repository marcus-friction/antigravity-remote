import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { RemoteWebView } from './src/components/RemoteWebView';
import { parseIncomingAppLink } from './src/utils/urlValidator';

export default function App(): React.JSX.Element {
  const [incomingDeepLinkUrl, setIncomingDeepLinkUrl] = useState<string | null>(
    null
  );
  const [pendingOpenInbox, setPendingOpenInbox] = useState<boolean>(false);
  const [isInitialUrlResolved, setIsInitialUrlResolved] =
    useState<boolean>(false);

  const handleIncomingUrl = useCallback((rawUrl: string | null) => {
    const parsedAction = parseIncomingAppLink(rawUrl);
    if (!parsedAction) {
      return;
    }
    if (parsedAction.kind === 'open_inbox') {
      setPendingOpenInbox(true);
      return;
    }
    setIncomingDeepLinkUrl(parsedAction.targetUrl);
  }, []);

  useEffect(() => {
    let isMounted = true;

    Linking.getInitialURL()
      .then((initialUrl) => {
        if (isMounted) {
          if (initialUrl) {
            handleIncomingUrl(initialUrl);
          }
          setIsInitialUrlResolved(true);
        }
      })
      .catch(() => {
        if (isMounted) {
          setIsInitialUrlResolved(true);
        }
      });

    const subscription = Linking.addEventListener('url', (event) => {
      handleIncomingUrl(event.url);
    });

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, [handleIncomingUrl]);

  const handleDeepLinkConsumed = useCallback(() => {
    setIncomingDeepLinkUrl(null);
  }, []);

  const handleOpenInboxConsumed = useCallback(() => {
    setPendingOpenInbox(false);
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView
        style={styles.safeArea}
        edges={['top', 'bottom', 'left', 'right']}
      >
        <StatusBar style="light" backgroundColor="#0B0F17" />
        <RemoteWebView
          incomingDeepLinkUrl={incomingDeepLinkUrl}
          pendingOpenInbox={pendingOpenInbox}
          isInitialUrlResolved={isInitialUrlResolved}
          onDeepLinkConsumed={handleDeepLinkConsumed}
          onOpenInboxConsumed={handleOpenInboxConsumed}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0B0F17',
  },
});
