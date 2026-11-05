jest.mock('../src/services/webData', () => ({
  clearWebData: jest.fn(async () => undefined),
  configureNativeKeepAlive: jest.fn(async () => undefined),
  syncNativeActionNotification: jest.fn(async () => undefined),
  clearNativeActionNotification: jest.fn(async () => undefined),
  requestNativeNotificationPermission: jest.fn(async () => true),
  installNativeDocumentStartScript: jest.fn(async () => undefined),
}));

import React from 'react';
import renderer, { act, ReactTestRenderer } from 'react-test-renderer';
import vm from 'vm';

const mockSecureStoreData = new Map<string, string>();
const mockCookieStore = new Map<string, Record<string, any>>();
const mockWebViewInjectJavaScript = jest.fn();

jest.mock('react-native', () => {
  const ReactLib = require('react');
  const mockComponent = (name: string) =>
    ReactLib.forwardRef((props: any, ref: any) =>
      ReactLib.createElement(name, { ...props, ref }, props.children),
    );

  class MockAnimatedValue {
    _value: number;
    constructor(initialValue: number) {
      this._value = initialValue;
    }
    setValue(nextValue: number) {
      this._value = nextValue;
    }
    stopAnimation(cb?: (value: number) => void) {
      cb?.(this._value);
    }
    interpolate() {
      return 1;
    }
  }

  return {
    Platform: { OS: 'ios', Version: 34 },
    PermissionsAndroid: {
      check: jest.fn(async () => false),
      request: jest.fn(async () => 'granted'),
      RESULTS: { GRANTED: 'granted', DENIED: 'denied' },
    },
    StyleSheet: {
      create: (styles: any) => styles,
      hairlineWidth: 1,
      absoluteFillObject: {},
    },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    Animated: {
      Value: MockAnimatedValue,
      View: mockComponent('Animated.View'),
      timing: (val: any, config: any) => ({
        start: (cb?: (result: { finished: boolean }) => void) => {
          if (val && typeof val.setValue === 'function' && typeof config?.toValue === 'number') {
            val.setValue(config.toValue);
          }
          cb?.({ finished: true });
        },
      }),
      spring: (val: any, config: any) => ({
        start: (cb?: (result: { finished: boolean }) => void) => {
          if (val && typeof val.setValue === 'function' && typeof config?.toValue === 'number') {
            val.setValue(config.toValue);
          }
          cb?.({ finished: true });
        },
      }),
    },
    PanResponder: {
      create: (handlers: any) => ({ panHandlers: handlers }),
    },
    View: mockComponent('View'),
    ScrollView: mockComponent('ScrollView'),
    Text: mockComponent('Text'),
    TextInput: mockComponent('TextInput'),
    TouchableOpacity: mockComponent('TouchableOpacity'),
    Pressable: mockComponent('Pressable'),
    ActivityIndicator: mockComponent('ActivityIndicator'),
    AppState: {
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    Keyboard: {
      addListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    BackHandler: {
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const ReactLib = require('react');
  return {
    SafeAreaProvider: ({ children }: any) =>
      ReactLib.createElement('SafeAreaProvider', null, children),
    SafeAreaView: ({ children, ...props }: any) =>
      ReactLib.createElement('SafeAreaView', props, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('expo-linking', () => ({
  getInitialURL: jest.fn(async () => null),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  openURL: jest.fn(async () => true),
}));

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStoreData.set(key, value);
  }),
  getItemAsync: jest.fn(async (key: string) => {
    return mockSecureStoreData.get(key) ?? null;
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStoreData.delete(key);
  }),
}));

jest.mock('@preeternal/react-native-cookie-manager', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (url: string) => mockCookieStore.get(url) ?? {}),
    set: jest.fn(async (url: string, cookie: any) => {
      const existing = mockCookieStore.get(url) ?? {};
      existing[cookie.name] = cookie;
      mockCookieStore.set(url, existing);
      return true;
    }),
    clearAll: jest.fn(async () => {
      mockCookieStore.clear();
      return true;
    }),
    flush: jest.fn(async () => undefined),
  },
}));

jest.mock('react-native-webview', () => {
  const ReactLib = require('react');
  const WebView = ReactLib.forwardRef((props: any, ref: any) => {
    ReactLib.useImperativeHandle(ref, () => ({
      reload: jest.fn(),
      goBack: jest.fn(),
      clearCache: jest.fn(),
      injectJavaScript: mockWebViewInjectJavaScript,
      stopLoading: jest.fn(),
    }));
    return ReactLib.createElement('WebView', props);
  });
  return { WebView };
});

import { LeftNavigationDrawer } from '../src/components/LeftNavigationDrawer';
import { RemoteWebView } from '../src/components/RemoteWebView';
import {
  INBOX_BRIDGE_SCRIPT,
  buildInboxRefreshScript,
} from '../src/services/inboxBridge';
import {
  backupCookiesFromWebView,
  resumeSessionPersistence,
} from '../src/services/sessionVault';
import { InboxSnapshot } from '../src/types/inbox';
import {
  buildInboxSnapshot,
  buildUsageSnapshot,
  formatResetCountdown,
  parseInboxBridgeMessage,
} from '../src/utils/inboxParser';

function extractTextTree(root: ReactTestRenderer['root']): string[] {
  return root
    .findAllByType('Text' as any)
    .map((node) => {
      const children = node.props.children;
      if (Array.isArray(children)) {
        return children.filter((c) => typeof c === 'string' || typeof c === 'number').join('');
      }
      return typeof children === 'string' || typeof children === 'number'
        ? String(children)
        : '';
    })
    .filter(Boolean);
}

describe('Usage Stats Parser & Workstation Bridge', () => {
  it('parses grouped quota pools, tier, credits, per-model quotas, and proto3 omitted 0% vs 100% fractions', () => {
    const nowMs = Date.parse('2026-11-05T18:00:00Z');
    const reset5hIso = '2026-11-05T22:15:00Z'; // 4h 15m
    const resetWeeklyIso = '2026-11-10T06:00:00Z'; // 4d 12h

    const usage = buildUsageSnapshot(
      {
        instanceUuid: 'box-pro',
        instanceName: 'Mac Studio',
        fetchedAtMs: nowMs,
        quotaSummary: {
          groups: [
            {
              groupName: 'Gemini Models',
              buckets: [
                {
                  window: 'WINDOW_5_HOURS',
                  remainingFraction: 0.72,
                  resetTime: reset5hIso,
                },
                {
                  window: 'WINDOW_WEEKLY',
                  // Omitted remainingFraction AND omitted resetTime -> untouched (100%)
                },
              ],
            },
            {
              groupName: 'Claude and GPT models',
              buckets: [
                {
                  window: '5h',
                  // Proto3 omitted 0.0 remainingFraction WITH active resetTime -> exhausted (0%)
                  resetTime: reset5hIso,
                },
                {
                  window: '7d',
                  remainingFraction: 0.41,
                  resetTime: resetWeeklyIso,
                },
              ],
            },
          ],
        },
        userStatus: {
          userStatus: {
            email: 'dev@example.com',
            paidTier: { name: 'Google AI Ultra' },
            planStatus: {
              availablePromptCredits: 1500,
              planInfo: { monthlyPromptCredits: 5000 },
            },
            availableCredits: [
              {
                creditType: 'GOOGLE_ONE_AI',
                creditAmount: '25000',
                minimumCreditAmountForUsage: '5',
              },
            ],
            cascadeModelConfigData: {
              defaultOverrideModelConfig: {
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M18' },
              },
              clientModelConfigs: [
                {
                  label: 'Gemini 2.5 Pro',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M18' },
                  isRecommended: true,
                  supportsImages: true,
                  quotaInfo: {
                    remainingFraction: 0.72,
                    resetTime: reset5hIso,
                  },
                },
                {
                  label: 'Claude Opus 4.6 (Thinking)',
                  modelOrAlias: { model: 'MODEL_CLAUDE_4_6_OPUS' },
                  quotaInfo: {
                    // Proto3 omitted 0.0 fraction when exhausted
                    resetTime: reset5hIso,
                  },
                },
              ],
            },
          },
        },
      },
      nowMs,
    );

    expect(usage).not.toBeNull();
    expect(usage!.sourceInstanceName).toBe('Mac Studio');
    expect(usage!.planName).toBe('Google AI Ultra');
    expect(usage!.accountEmail).toBe('dev@example.com');
    expect(usage!.lowestRemainingFraction).toBe(0);

    expect(usage!.credits).toEqual([
      {
        id: 'ai-credits',
        label: 'AI Credits',
        available: 25000,
        minimumForUsage: 5,
      },
      {
        id: 'prompt-credits',
        label: 'Prompt Credits',
        available: 1500,
        limit: 5000,
      },
    ]);

    expect(usage!.groups).toHaveLength(2);
    expect(usage!.groups[0].label).toBe('Gemini Models');
    expect(usage!.groups[0].buckets[0]).toMatchObject({
      label: '5-hour window',
      remainingFraction: 0.72,
      remainingPercent: 72,
      isExhausted: false,
    });
    expect(usage!.groups[0].buckets[1]).toMatchObject({
      label: 'Weekly limit',
      remainingFraction: 1,
      remainingPercent: 100,
      isExhausted: false,
    });

    expect(usage!.groups[1].label).toBe('Claude and GPT models');
    expect(usage!.groups[1].buckets[0]).toMatchObject({
      label: '5-hour window',
      remainingFraction: 0,
      remainingPercent: 0,
      isExhausted: true,
    });

    // Preserves Antigravity's model selector order so rows stay in stable positions
    expect(usage!.models.map((m) => m.label)).toEqual([
      'Gemini 2.5 Pro',
      'Claude Opus 4.6 (Thinking)',
    ]);
    expect(usage!.models[0].isDefault).toBe(true);
    expect(usage!.models[0].isRecommended).toBe(true);
    expect(usage!.models[0].remainingPercent).toBe(72);
    expect(usage!.models[1].isExhausted).toBe(true);
    expect(usage!.models[1].remainingPercent).toBe(0);

    expect(formatResetCountdown(Date.parse(reset5hIso), nowMs)).toBe(
      'Resets in 4h 15m',
    );
    expect(formatResetCountdown(Date.parse(resetWeeklyIso), nowMs)).toBe(
      'Resets in 4d 12h',
    );
    expect(formatResetCountdown(nowMs + 30_000, nowMs)).toBe('Resets in <1m');
    expect(formatResetCountdown(nowMs - 5_000, nowMs)).toBe('Resetting soon');
    expect(formatResetCountdown(0, nowMs)).toBe('');
  });

  it('falls back to GetCommandModelConfigs when GetUserStatus omits model configs and wires into buildInboxSnapshot', () => {
    const rawMsg = parseInboxBridgeMessage(
      JSON.stringify({
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_365_000_000,
        activeUrl: 'https://antigravity.google.com/r/box-1',
        instances: [
          {
            uuid: 'box-1',
            name: 'Dev Workstation',
            status: 1,
            trajectories: {},
          },
        ],
        usage: {
          instanceUuid: 'box-1',
          instanceName: 'Dev Workstation',
          userStatus: {
            userStatus: {
              currentTier: { name: 'Free Tier' },
            },
          },
          commandModelConfigs: {
            clientModelConfigs: [
              {
                label: 'Gemini 2.5 Flash',
                quotaInfo: {
                  remainingFraction: 0.9,
                  resetTime: '2026-11-05T20:00:00Z',
                },
              },
            ],
          },
        },
      }),
    );

    expect(rawMsg).not.toBeNull();
    expect(rawMsg!.type).toBe('AGY_INBOX_SNAPSHOT');
    if (rawMsg!.type !== 'AGY_INBOX_SNAPSHOT') return;

    const snapshot = buildInboxSnapshot(rawMsg!, {});
    expect(snapshot.usage).not.toBeNull();
    expect(snapshot.usage!.planName).toBe('Free Tier');
    expect(snapshot.usage!.models).toHaveLength(1);
    expect(snapshot.usage!.models[0].label).toBe('Gemini 2.5 Flash');
    expect(snapshot.usage!.models[0].remainingPercent).toBe(90);
  });

  it('queries RetrieveUserQuotaSummary + GetUserStatus + GetCommandModelConfigs fallback in INBOX_BRIDGE_SCRIPT and honors force refresh', async () => {
    const postedToNative: any[] = [];
    const rpcCalls: string[] = [];
    let remainingFractionFromServer = 0.65;

    class MockListInstancesRequest {}
    class MockProxyCommandRequest {
      uuid = '';
      rpcPath = '';
      payload: Uint8Array<ArrayBufferLike> = new Uint8Array();
      setTargetInstanceUuid(u: string) {
        this.uuid = u;
      }
      setRpcPath(p: string) {
        this.rpcPath = p;
      }
      setPayload(bytes: Uint8Array) {
        this.payload = bytes;
      }
      putHeaders() {}
    }

    class MockApiServicePromiseClient {
      listInstances() {
        return Promise.resolve({
          getInstancesList: () => [
            {
              getUuid: () => 'box-usage',
              getStatus: () => 1,
              getMetadata: () => ({
                getName: () => 'Usage Host',
                getVersion: () => '2.1.0',
              }),
              getStatusLastUpdatedAt: () => ({ getSeconds: () => 1762365000 }),
            },
          ],
        });
      }
      proxyCommand(req: MockProxyCommandRequest) {
        rpcCalls.push(req.rpcPath);
        let body: Record<string, unknown> = {};
        if (req.rpcPath.endsWith('/GetAllCascadeTrajectories')) {
          body = { trajectorySummaries: {} };
        } else if (req.rpcPath.endsWith('/RetrieveUserQuotaSummary')) {
          body = {
            groups: [
              {
                groupName: 'Gemini Models',
                buckets: [
                  {
                    window: '5h',
                    remainingFraction: remainingFractionFromServer,
                    resetTime: '2026-11-05T23:00:00Z',
                  },
                ],
              },
            ],
          };
        } else if (req.rpcPath.endsWith('/GetUserStatus')) {
          // Omit clientModelConfigs so GetCommandModelConfigs fallback is exercised
          body = {
            userStatus: {
              paidTier: { name: 'Google AI Pro' },
            },
          };
        } else if (req.rpcPath.endsWith('/GetCommandModelConfigs')) {
          body = {
            clientModelConfigs: [
              {
                label: 'Gemini 2.5 Pro',
                quotaInfo: {
                  remainingFraction: remainingFractionFromServer,
                  resetTime: '2026-11-05T23:00:00Z',
                },
              },
            ],
          };
        }
        const encoded = new TextEncoder().encode(JSON.stringify(body));
        return Promise.resolve({ getPayload_asU8: () => encoded });
      }
    }

    const sandboxWindow: any = {
      location: {
        hostname: 'antigravity.google.com',
        origin: 'https://antigravity.google.com',
        pathname: '/r/box-usage',
        search: '',
        href: 'https://antigravity.google.com/r/box-usage',
      },
      history: { state: null, replaceState: () => undefined },
      navigator: { onLine: true },
      document: {
        cookie: 'SAPISID=test',
        visibilityState: 'visible',
        querySelectorAll: () => [],
      },
      default_GoogleAntigravity: {
        K: {
          devtools_jetski_boq_api_proto: {
            ApiServicePromiseClient: MockApiServicePromiseClient,
            ListInstancesRequest: MockListInstancesRequest,
            ProxyCommandRequest: MockProxyCommandRequest,
          },
        },
        pj: {
          auth_firstparty: {
            getAuthHeaderValueForFirstParty: () => 'SAPISIDHASH 1_a',
          },
        },
      },
      ReactNativeWebView: {
        postMessage: (raw: string) => {
          postedToNative.push(JSON.parse(raw));
        },
      },
      addEventListener: () => undefined,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      setInterval: () => 2,
      clearInterval: () => undefined,
    };
    sandboxWindow.window = sandboxWindow;

    const context = vm.createContext(sandboxWindow);
    vm.runInContext(INBOX_BRIDGE_SCRIPT, context);

    await sandboxWindow.__agyInboxBridge.refresh(false);

    expect(rpcCalls).toEqual(
      expect.arrayContaining([
        '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories',
        '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
        '/exa.language_server_pb.LanguageServerService/GetUserStatus',
        '/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs',
      ]),
    );
    expect(postedToNative[0].usage.instanceName).toBe('Usage Host');

    // Background unforced poll reuses cached usage within TTL
    rpcCalls.length = 0;
    remainingFractionFromServer = 0.25;
    await sandboxWindow.__agyInboxBridge.refresh(false);
    expect(
      rpcCalls.some((p) => p.endsWith('/RetrieveUserQuotaSummary')),
    ).toBe(false);
    expect(
      postedToNative[1].usage.quotaSummary.groups[0].buckets[0]
        .remainingFraction,
    ).toBe(0.65);

    // Explicit UI refresh (`buildInboxRefreshScript(true)`) bypasses cache immediately
    rpcCalls.length = 0;
    vm.runInContext(buildInboxRefreshScript(true), context);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      rpcCalls.some((p) => p.endsWith('/RetrieveUserQuotaSummary')),
    ).toBe(true);
    expect(
      postedToNative[2].usage.quotaSummary.groups[0].buckets[0]
        .remainingFraction,
    ).toBe(0.25);
  });

  it('never blocks trajectory snapshots when usage RPCs stall, and polls trajectories (without usage RPCs) while hidden only when Keep-Alive is desired', async () => {
    const rpcCalls: string[] = [];
    const postedToNative: any[] = [];
    const budgetTimers: Array<() => void> = [];
    let pollCallback: (() => void) | null = null;
    let resolveSlowQuota!: (val: any) => void;

    class MockListInstancesRequest {}
    class MockProxyCommandRequest {
      uuid = '';
      rpcPath = '';
      setTargetInstanceUuid(u: string) {
        this.uuid = u;
      }
      setRpcPath(p: string) {
        this.rpcPath = p;
      }
      setPayload() {}
      putHeaders() {}
    }

    class SlowUsageApiClient {
      listInstances() {
        return Promise.resolve({
          getInstancesList: () => [
            {
              getUuid: () => 'box-slow',
              getStatus: () => 1,
              getMetadata: () => ({
                getName: () => 'Slow Usage Host',
                getVersion: () => '2.1.0',
              }),
              getStatusLastUpdatedAt: () => ({ getSeconds: () => 1762365000 }),
            },
          ],
        });
      }
      proxyCommand(req: MockProxyCommandRequest) {
        rpcCalls.push(req.rpcPath);
        if (req.rpcPath.endsWith('/GetAllCascadeTrajectories')) {
          const encoded = new TextEncoder().encode(
            JSON.stringify({
              trajectorySummaries: {
                'cascade-urgent': {
                  summary: 'Waiting on approval',
                  status: 'CASCADE_RUN_STATUS_WAITING_FOR_USER',
                },
              },
            }),
          );
          return Promise.resolve({ getPayload_asU8: () => encoded });
        }
        return new Promise((resolve) => {
          if (req.rpcPath.endsWith('/RetrieveUserQuotaSummary')) {
            resolveSlowQuota = resolve;
          } else {
            const encoded = new TextEncoder().encode(
              JSON.stringify({
                userStatus: {
                  paidTier: { name: 'Google AI Pro' },
                  cascadeModelConfigData: {
                    clientModelConfigs: [{ label: 'Gemini 2.5 Pro' }],
                  },
                },
              }),
            );
            resolve({ getPayload_asU8: () => encoded });
          }
        });
      }
    }

    const sandboxWindow: any = {
      __agyKeepAliveLockDesired: false,
      location: {
        hostname: 'antigravity.google.com',
        origin: 'https://antigravity.google.com',
        pathname: '/r/box-slow',
        search: '',
        href: 'https://antigravity.google.com/r/box-slow',
      },
      history: { state: null, replaceState: () => undefined },
      navigator: { onLine: true },
      document: {
        cookie: 'SAPISID=test',
        visibilityState: 'visible',
        querySelectorAll: () => [],
      },
      default_GoogleAntigravity: {
        K: {
          devtools_jetski_boq_api_proto: {
            ApiServicePromiseClient: SlowUsageApiClient,
            ListInstancesRequest: MockListInstancesRequest,
            ProxyCommandRequest: MockProxyCommandRequest,
          },
        },
        pj: {
          auth_firstparty: {
            getAuthHeaderValueForFirstParty: () => 'SAPISIDHASH 1_a',
          },
        },
      },
      ReactNativeWebView: {
        postMessage: (raw: string) => {
          postedToNative.push(JSON.parse(raw));
        },
      },
      addEventListener: () => undefined,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      setTimeout: (fn: () => void, ms?: number) => {
        if (ms === 1200) {
          budgetTimers.push(fn);
        }
        return budgetTimers.length;
      },
      clearTimeout: () => undefined,
      setInterval: (fn: () => void) => {
        pollCallback = fn;
        return 99;
      },
      clearInterval: () => undefined,
    };
    sandboxWindow.window = sandboxWindow;

    const context = vm.createContext(sandboxWindow);
    vm.runInContext(INBOX_BRIDGE_SCRIPT, context);

    const refreshPromise = sandboxWindow.__agyInboxBridge.refresh(false);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Usage RPC is still stalled, so inline budget timer fires and delivers trajectories immediately
    expect(budgetTimers.length).toBe(1);
    budgetTimers[0]();
    await refreshPromise;

    expect(postedToNative).toHaveLength(1);
    expect(
      postedToNative[0].instances[0].trajectories['cascade-urgent'].summary,
    ).toBe('Waiting on approval');
    expect(postedToNative[0].usage).toBeNull();

    // When the slow quota RPC eventually resolves, a follow-up snapshot updates usage
    const quotaBytes = new TextEncoder().encode(
      JSON.stringify({
        groups: [
          {
            groupName: 'Gemini Models',
            buckets: [{ window: '5h', remainingFraction: 0.5 }],
          },
        ],
      }),
    );
    resolveSlowQuota({ getPayload_asU8: () => quotaBytes });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(postedToNative).toHaveLength(2);
    expect(postedToNative[1].usage.instanceName).toBe('Slow Usage Host');

    // Background polling: when hidden WITHOUT Keep-Alive, poll interval is a no-op
    rpcCalls.length = 0;
    sandboxWindow.document.visibilityState = 'hidden';
    sandboxWindow.__agyKeepAliveLockDesired = false;
    expect(pollCallback).not.toBeNull();
    pollCallback!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(rpcCalls).toHaveLength(0);

    // When hidden WITH Keep-Alive (`__agyKeepAliveLockDesired = true`), trajectories poll while usage RPCs are skipped
    sandboxWindow.__agyKeepAliveLockDesired = true;
    pollCallback!();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(rpcCalls).toEqual([
      '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories',
    ]);
  });
});

describe('LeftNavigationDrawer Usage Tab & RemoteWebView E2E', () => {
  beforeEach(() => {
    resumeSessionPersistence();
    mockSecureStoreData.clear();
    mockCookieStore.clear();
    mockWebViewInjectJavaScript.mockClear();
  });

  it('renders Inbox | Usage | Settings tabs, low-quota indicator dot, progress bars, activity metrics, and budget-paused thread jump', async () => {
    const onRefreshInbox = jest.fn();
    const onSelectThread = jest.fn();
    const pausedThread = {
      id: 'box-1:cascade-budget',
      cascadeId: 'cascade-budget',
      trajectoryId: 'traj-budget',
      title: 'Overnight refactor',
      workspaceName: 'core-service',
      instanceUuid: 'box-1',
      instanceName: 'Studio Box',
      source: 'remote-control' as const,
      targetUrl: 'https://antigravity.google.com/r/box-1?p=c%2Fcascade-budget',
      childPath: 'c/cascade-budget',
      attentionKind: 'error' as const,
      needsAttention: true,
      attentionReason: 'Paused (token/step budget reached)',
      stepCount: 142,
      waitingStepCount: 0,
      lastModifiedAtMs: Date.now() - 30_000,
      lastUserViewAtMs: 0,
      isActiveThread: false,
      isPinned: false,
      hasRunningSubagents: false,
    };

    const snapshot: InboxSnapshot = {
      instances: [
        { uuid: 'box-1', name: 'Studio Box', status: 'connected' },
      ],
      threads: [pausedThread],
      fetchedAtMs: Date.now() - 10_000,
      activeInstanceUuid: 'box-1',
      activeCascadeId: null,
      usage: {
        sourceInstanceUuid: 'box-1',
        sourceInstanceName: 'Studio Box',
        fetchedAtMs: Date.now() - 5_000,
        planName: 'Google AI Pro',
        accountEmail: 'alex@example.com',
        credits: [
          { id: 'google_one_ai', label: 'AI Credits', available: 12450 },
        ],
        groups: [
          {
            id: 'gemini',
            label: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-5h',
                label: '5-hour window',
                remainingFraction: 0.14,
                remainingPercent: 14,
                resetTimeMs: Date.now() + 2 * 3_600_000 + 20 * 60_000,
                isExhausted: false,
              },
            ],
          },
        ],
        models: [
          {
            id: 'gemini-pro',
            label: 'Gemini 2.5 Pro',
            remainingFraction: 0.14,
            remainingPercent: 14,
            resetTimeMs: Date.now() + 2 * 3_600_000 + 20 * 60_000,
            isExhausted: false,
            isRecommended: true,
            isDefault: true,
            supportsImages: true,
          },
        ],
        lowestRemainingFraction: 0.14,
        error: null,
      },
      error: null,
    };

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <LeftNavigationDrawer
          visible={true}
          stage="authenticated"
          snapshot={snapshot}
          isRefreshing={false}
          attentionCount={1}
          urgentAttentionCount={0}
          runningCount={0}
          onOpen={jest.fn()}
          onClose={jest.fn()}
          onRefreshInbox={onRefreshInbox}
          onSelectThread={onSelectThread}
          onMarkThreadRead={jest.fn()}
          onMarkAllRead={jest.fn()}
          onNavigateToUrl={jest.fn()}
          onReloadSession={jest.fn()}
          onSignOut={jest.fn()}
        />,
      );
    });

    const modeButtons = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Drawer mode '),
    );
    expect(modeButtons.map((b) => b.props.accessibilityLabel)).toEqual([
      'Drawer mode Inbox',
      'Drawer mode Usage',
      'Drawer mode Settings',
    ]);

    // Low quota (14% <= 20%) displays an amber warning dot inside the Usage tab button
    const usageTabBtn = modeButtons[1];
    const usageDot = usageTabBtn.findAllByType('View' as any)[0];
    expect(usageDot).toBeDefined();
    expect(JSON.stringify(usageDot.props.style)).toContain('#F59E0B');

    // Switch to Usage tab
    await act(async () => {
      usageTabBtn.props.onPress();
    });
    expect(onRefreshInbox).toHaveBeenCalledTimes(1);

    const texts = extractTextTree(tree.root);
    expect(texts).toContain('Google AI Pro');
    expect(texts).toContain('alex@example.com');
    expect(texts).toContain('AI Credits');
    expect(texts).toContain('12,450');
    expect(texts).toContain('QUOTA POOLS');
    expect(texts).toContain('Gemini Models');
    expect(texts).toContain('5-hour window');
    expect(texts).toContain('14% left');
    expect(texts).toContain('MODEL QUOTAS');
    expect(texts).toContain('Gemini 2.5 Pro');
    expect(texts).toContain('DEFAULT');
    expect(texts).toContain('WORKSTATION ACTIVITY');
    expect(texts).toContain('142');

    // Tap the budget-paused thread alert to jump straight to that thread
    const budgetAlertBtn = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        n.props.accessibilityLabel === 'Open budget-paused thread',
    )[0];
    expect(budgetAlertBtn).toBeDefined();
    await act(async () => {
      budgetAlertBtn.props.onPress();
    });
    expect(onSelectThread).toHaveBeenCalledWith(pausedThread);

    await act(async () => tree.unmount());
  });

  it('handles Usage empty states cleanly and purges live usage telemetry on Sign Out in RemoteWebView', async () => {
    mockCookieStore.set('https://antigravity.google.com', {
      SID: {
        name: 'SID',
        value: 'sid-usage-e2e',
        domain: '.google.com',
        path: '/',
        secure: true,
      },
    });
    await backupCookiesFromWebView();

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RemoteWebView
          incomingDeepLinkUrl={null}
          isInitialUrlResolved={true}
          onDeepLinkConsumed={jest.fn()}
        />,
      );
    });

    const webView = tree.root.findByType('WebView' as any);
    await act(async () => {
      webView.props.onNavigationStateChange({
        url: 'https://antigravity.google.com/r/workstation-z',
        loading: false,
        canGoBack: false,
      });
    });

    // Open drawer and switch to Usage before any workstation reports -> empty state shortcut works
    const openHandle = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        n.props.accessibilityLabel === 'Open Antigravity drawer',
    )[0];
    await act(async () => {
      openHandle.props.onPress();
    });

    const usageTab = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        n.props.accessibilityLabel === 'Drawer mode Usage',
    )[0];
    await act(async () => {
      usageTab.props.onPress();
    });

    // While initial refresh is in flight before first snapshot arrives, shows syncing indicator
    expect(extractTextTree(tree.root)).toContain('Loading usage stats…');

    // First snapshot arrives with 0 connected workstations -> shows empty state + link shortcut
    await act(async () => {
      webView.props.onMessage({
        nativeEvent: {
          url: 'https://antigravity.google.com/r/workstation-z',
          data: JSON.stringify({
            type: 'AGY_INBOX_SNAPSHOT',
            fetchedAtMs: Date.now(),
            activeUrl: 'https://antigravity.google.com/r/workstation-z',
            instances: [],
            usage: null,
          }),
        },
      });
    });

    expect(extractTextTree(tree.root)).toContain('No connected workstations');
    const openLinkShortcut = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        n.props.accessibilityLabel === 'Open machine link from Usage',
    )[0];
    await act(async () => {
      openLinkShortcut.props.onPress();
    });
    // Jumps to Settings with Machine link input already expanded
    expect(
      tree.root.findAll(
        (n) =>
          n.type === ('TextInput' as any) &&
          n.props.accessibilityLabel === 'Machine link or ID',
      ),
    ).toHaveLength(1);

    // Switch back to Usage and stream a live AGY_INBOX_SNAPSHOT with usage data
    await act(async () => {
      usageTab.props.onPress();
      webView.props.onMessage({
        nativeEvent: {
          url: 'https://antigravity.google.com/r/workstation-z',
          data: JSON.stringify({
            type: 'AGY_INBOX_SNAPSHOT',
            fetchedAtMs: Date.now(),
            activeUrl: 'https://antigravity.google.com/r/workstation-z',
            instances: [
              { uuid: 'workstation-z', name: 'Linux Z', status: 1 },
            ],
            usage: {
              instanceUuid: 'workstation-z',
              instanceName: 'Linux Z',
              userStatus: {
                userStatus: {
                  paidTier: { name: 'Google AI Ultra' },
                  cascadeModelConfigData: {
                    clientModelConfigs: [
                      {
                        label: 'Claude Sonnet 4.6',
                        quotaInfo: {
                          remainingFraction: 0.85,
                          resetTime: new Date(
                            Date.now() + 3_600_000,
                          ).toISOString(),
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        },
      });
    });

    const liveTexts = extractTextTree(tree.root);
    expect(liveTexts).toContain('Google AI Ultra');
    expect(liveTexts).toContain('Claude Sonnet 4.6');
    expect(liveTexts).toContain('85%');

    // Refresh Usage Stats button triggers forced bridge refresh
    mockWebViewInjectJavaScript.mockClear();
    const refreshUsageBtn = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        n.props.accessibilityLabel === 'Refresh Usage Stats',
    )[0];
    await act(async () => {
      refreshUsageBtn.props.onPress();
    });
    expect(
      mockWebViewInjectJavaScript.mock.calls.some(
        ([script]) =>
          typeof script === 'string' && script.includes('.refresh(true)'),
      ),
    ).toBe(true);

    // Sign Out wipes usage stats from memory immediately
    const settingsTab = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        n.props.accessibilityLabel === 'Drawer mode Settings',
    )[0];
    await act(async () => {
      settingsTab.props.onPress();
    });

    const signOutBtn = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        n
          .findAllByType('Text' as any)
          .some((t) => t.props.children === 'Sign Out of Google Account'),
    )[0];
    await act(async () => {
      signOutBtn.props.onPress();
    });

    const confirmSignOutBtn = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        n
          .findAllByType('Text' as any)
          .some((t) => t.props.children === 'Confirm Sign Out'),
    )[0];
    await act(async () => {
      await confirmSignOutBtn.props.onPress();
    });

    const postSignOutTexts = extractTextTree(tree.root);
    expect(postSignOutTexts).not.toContain('Google AI Ultra');
    expect(postSignOutTexts).not.toContain('Claude Sonnet 4.6');

    await act(async () => tree.unmount());
  });
});
