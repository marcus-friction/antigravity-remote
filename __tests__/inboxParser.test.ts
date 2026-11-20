import vm from 'node:vm';
import {
  INBOX_BRIDGE_SCRIPT,
  buildFastThreadSwitchScript,
  buildMarkThreadReadScript,
  buildOpenHostSettingsScript,
  buildStartProjectChatScript,
  buildSyncThreadContextScript,
} from '../src/services/inboxBridge';
import { InboxBridgeMessage } from '../src/types/inbox';
import {
  buildActionNotificationSyncState,
  buildThreadNotificationDeepLink,
} from '../src/utils/actionNotification';
import {
  applyLocalStateToSnapshot,
  buildInboxSnapshot,
  buildProjectGroups,
  describeWaitingSteps,
  extractActiveRouteFromUrl,
  extractProjectIdFromUrl,
  extractWorkspaceName,
  extractWorkspaceUri,
  formatRelativeTime,
  parseInboxBridgeMessage,
  parseProtoTimestampMs,
  reconcileRunningThreadTransitions,
  resolveActiveThreadProject,
} from '../src/utils/inboxParser';

describe('inboxParser', () => {
  it('normalizes RFC 3339, numeric, and { seconds, nanos } timestamps', () => {
    expect(parseProtoTimestampMs('2026-11-04T14:00:00.000Z')).toBe(
      Date.parse('2026-11-04T14:00:00.000Z'),
    );
    expect(parseProtoTimestampMs({ seconds: '1762264800', nanos: 250_000_000 })).toBe(
      1762264800 * 1000 + 250,
    );
    expect(parseProtoTimestampMs(1762264800)).toBe(1762264800 * 1000);
    expect(parseProtoTimestampMs(1762264800123)).toBe(1762264800123);
    expect(parseProtoTimestampMs(null)).toBe(0);
    expect(parseProtoTimestampMs('invalid-date')).toBe(0);
  });

  it('extracts active workstation and conversation routes including multi-account paths', () => {
    expect(
      extractActiveRouteFromUrl(
        'https://antigravity.google.com/r/devbox-1?p=c%2Fthread-abc',
      ),
    ).toEqual({
      instanceUuid: 'devbox-1',
      cascadeId: 'thread-abc',
    });

    expect(
      extractActiveRouteFromUrl(
        'https://antigravity.google.com/u/2/r/devbox-2?p=%2Fc%2Fthread-xyz',
      ),
    ).toEqual({
      instanceUuid: 'devbox-2',
      cascadeId: 'thread-xyz',
    });

    expect(
      extractActiveRouteFromUrl(
        'https://antigravity.google.com/u/1/remote/c/cloud-thread-9',
      ),
    ).toEqual({
      instanceUuid: '__cloud__',
      cascadeId: 'cloud-thread-9',
    });

    expect(extractActiveRouteFromUrl('https://evil.example/r/devbox-1')).toEqual({
      instanceUuid: null,
      cascadeId: null,
    });
  });

  it('extracts workspace names and describes waiting prompts clearly', () => {
    expect(
      extractWorkspaceName({
        workspaces: [
          {
            workspaceFolderAbsoluteUri:
              'file:///home/marcus/projects/antigravity-remote/',
          },
        ],
      }),
    ).toBe('antigravity-remote');

    expect(
      describeWaitingSteps([
        {
          step: {
            runCommand: {
              commandLine: 'npm run deploy:production --dry-run',
            },
          },
        },
      ]),
    ).toBe('Approve command: npm run deploy:production --dry-run');

    expect(
      describeWaitingSteps(
        [
          {
            step: {
              ask_question: {
                questions: [{ question: 'Which target region should we use?' }],
              },
            },
          },
        ],
        'Database Debugger',
      ),
    ).toBe('Database Debugger: Question: Which target region should we use?');
  });

  it('classifies approval, bubbled subagent prompts, errors, unread, running, and idle threads across workstations', () => {
    const snapshot = buildInboxSnapshot(
      {
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_265_000_000,
        activeUrl:
          'https://antigravity.google.com/u/1/r/workstation-a?p=c%2Fcurrently-open-unread',
        instances: [
          {
            uuid: 'workstation-a',
            name: 'MacBook Pro',
            status: 1,
            trajectories: {
              trajectorySummaries: {
                'parent-with-subagent-prompt': {
                  summary: 'Refactor payment service',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: true,
                  hasActiveChildren: true,
                  lastModifiedTime: '2026-11-04T14:10:00Z',
                  lastUserInputTime: '2026-11-04T14:05:00Z',
                  workspaces: [
                    {
                      workspaceFolderAbsoluteUri:
                        'file:///Users/dev/billing-api',
                    },
                  ],
                },
                'child-subagent-1': {
                  summary: 'Subagent task',
                  lastModifiedTime: '2026-11-04T14:12:00Z',
                  trajectoryMetadata: {
                    parentConversationId: 'parent-with-subagent-prompt',
                    subagentSpec: {
                      role: 'Migration Runner',
                    },
                  },
                  waitingSteps: [
                    {
                      step: {
                        runCommand: {
                          commandLine: 'psql -f migrate.sql',
                        },
                      },
                    },
                  ],
                },
                'currently-open-unread': {
                  summary: 'Currently open thread',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  lastModifiedTime: '2026-11-04T14:11:00Z',
                  lastUserInputTime: '2026-11-04T14:00:00Z',
                  annotations: {
                    markedAsUnread: true,
                  },
                },
                'archived-thread': {
                  summary: 'Old archived thread',
                  annotations: { archived: true },
                  waitingSteps: [{ step: {} }],
                },
                'side-question-helper': {
                  summary: 'Side question',
                  trajectoryType: 'TRAJECTORY_TYPE_SIDE_QUESTION',
                  waitingSteps: [{ step: {} }],
                },
              },
            },
          },
          {
            uuid: 'workstation-b',
            name: 'Linux Devbox',
            status: 'INSTANCE_STATUS_CONNECTED',
            trajectories: {
              'unread-completed': {
                summary: 'Investigate flaky CI suite',
                status: 1,
                last_modified_time: '2026-11-04T14:09:00Z',
                last_user_input_time: '2026-11-04T14:02:00Z',
                annotations: {
                  last_user_view_time: '2026-11-04T14:02:00Z',
                },
              },
              'errored-thread': {
                summary: 'Nightly benchmark run',
                status: 1,
                latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_ERROR',
                lastModifiedTime: '2026-11-04T14:08:00Z',
                lastUserInputTime: '2026-11-04T14:01:00Z',
              },
              'running-thread': {
                summary: 'Compile Android release',
                status: 'CASCADE_RUN_STATUS_RUNNING',
                notFullyIdle: true,
                lastModifiedTime: '2026-11-04T14:15:00Z',
              },
            },
          },
        ],
      },
      {},
    );

    expect(snapshot.instances).toHaveLength(2);
    // Archived, subagent child, and side-question trajectories are filtered out;
    // subagent waiting prompt bubbles onto `parent-with-subagent-prompt`.
    expect(snapshot.threads.map((t) => t.cascadeId)).toEqual([
      'parent-with-subagent-prompt',
      'errored-thread',
      'unread-completed',
      'running-thread',
      'currently-open-unread',
    ]);

    const approvalThread = snapshot.threads[0];
    expect(approvalThread.attentionKind).toBe('approval');
    expect(approvalThread.needsAttention).toBe(true);
    expect(approvalThread.attentionReason).toBe(
      'Migration Runner: Approve command: psql -f migrate.sql',
    );
    expect(approvalThread.workspaceName).toBe('billing-api');
    expect(approvalThread.targetUrl).toBe(
      'https://antigravity.google.com/u/1/r/workstation-a?p=c%2Fparent-with-subagent-prompt',
    );

    const enterpriseSnapshot = buildInboxSnapshot(
      {
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_265_000_000,
        activeUrl:
          'https://antigravity.google.com/r/workstation-a?enableBusinessSignIn=true&authuser=2',
        instances: [
          {
            uuid: 'workstation-a',
            name: 'Enterprise Box',
            status: 1,
            trajectories: {
              'ent-thread': {
                summary: 'Enterprise session',
                lastModifiedTime: '2026-11-04T14:20:00Z',
              },
            },
          },
        ],
      },
      {},
    );
    expect(enterpriseSnapshot.threads[0].targetUrl).toBe(
      'https://antigravity.google.com/r/workstation-a?authuser=2&enableBusinessSignIn=true&p=c%2Fent-thread',
    );

    const errorThread = snapshot.threads[1];
    expect(errorThread.attentionKind).toBe('error');
    expect(errorThread.needsAttention).toBe(true);

    const unreadThread = snapshot.threads[2];
    expect(unreadThread.attentionKind).toBe('unread');
    expect(unreadThread.needsAttention).toBe(true);

    const openThread = snapshot.threads[4];
    expect(openThread.isActiveThread).toBe(true);
    expect(openThread.attentionKind).toBe('idle');
    expect(openThread.needsAttention).toBe(false);

    // Marking unread & error threads as read clears their attention flags immediately.
    const updated = applyLocalStateToSnapshot(snapshot, {
      activeInstanceUuid: snapshot.activeInstanceUuid,
      activeCascadeId: snapshot.activeCascadeId,
      locallyReadAtByThreadId: {
        [unreadThread.id]: Date.parse('2026-11-04T14:20:00Z'),
        [errorThread.id]: Date.parse('2026-11-04T14:20:00Z'),
      },
    });
    expect(updated.threads.filter((t) => t.needsAttention).map((t) => t.cascadeId)).toEqual([
      'parent-with-subagent-prompt',
    ]);
  });

  it('validates bridge messages and formats relative times cleanly', () => {
    expect(parseInboxBridgeMessage('')).toBeNull();
    expect(parseInboxBridgeMessage('{not-json')).toBeNull();
    expect(
      parseInboxBridgeMessage(JSON.stringify({ type: 'UNKNOWN_EVENT' })),
    ).toBeNull();
    expect(parseInboxBridgeMessage('x'.repeat(2 * 1024 * 1024 + 10))).toBeNull();

    const parsedNav = parseInboxBridgeMessage(
      JSON.stringify({
        type: 'AGY_INBOX_FAST_NAV_RESULT',
        requestId: 'req-1',
        handled: true,
        targetUrl: 'https://antigravity.google.com/r/box?p=c%2F1',
      }),
    );
    expect(parsedNav).toEqual({
      type: 'AGY_INBOX_FAST_NAV_RESULT',
      requestId: 'req-1',
      handled: true,
      targetUrl: 'https://antigravity.google.com/r/box?p=c%2F1',
    });

    const baseNow = 1_700_000_000_000;
    expect(formatRelativeTime(baseNow - 10_000, baseNow)).toBe('Just now');
    expect(formatRelativeTime(baseNow - 5 * 60_000, baseNow)).toBe('5m ago');
    expect(formatRelativeTime(baseNow - 3 * 3_600_000, baseNow)).toBe('3h ago');
    expect(formatRelativeTime(baseNow - 4 * 86_400_000, baseNow)).toBe('4d ago');
  });

  it('keeps INBOX_BRIDGE_SCRIPT Trusted-Types-safe and executes RPCs + iframe fast-switch accurately', async () => {
    // Must parse cleanly and never touch Trusted-Types-restricted sinks.
    expect(() => new vm.Script(INBOX_BRIDGE_SCRIPT)).not.toThrow();
    for (const forbiddenSink of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
    ]) {
      expect(INBOX_BRIDGE_SCRIPT).not.toContain(forbiddenSink);
    }
    expect(INBOX_BRIDGE_SCRIPT).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);

    const postedToNative: any[] = [];
    const postedToIframe: Array<{ msg: any; decodedJspb: any; origin: string }> =
      [];
    const scheduledTimers = new Map<number, () => void>();
    let nextTimerId = 10;
    const proxyRequests: Array<{
      uuid: string;
      rpcPath: string;
      payloadText: string;
    }> = [];
    const windowListeners = new Map<string, Array<(e: any) => void>>();

    class MockListInstancesRequest {}
    class MockProxyCommandRequest {
      uuid = '';
      rpcPath = '';
      payload: Uint8Array<ArrayBufferLike> = new Uint8Array();
      headers: Record<string, string> = {};
      setTargetInstanceUuid(u: string) {
        this.uuid = u;
      }
      setRpcPath(p: string) {
        this.rpcPath = p;
      }
      setPayload(bytes: Uint8Array) {
        this.payload = bytes;
      }
      putHeaders(k: string, v: string) {
        this.headers[k] = v;
      }
    }
    class MockApiServicePromiseClient {
      listInstances() {
        return Promise.resolve({
          getInstancesList: () => [
            {
              getUuid: () => 'box-alpha',
              getStatus: () => 1,
              getMetadata: () => ({
                getName: () => 'Alpha Workstation',
                getVersion: () => '2.0.1',
              }),
              getStatusLastUpdatedAt: () => ({ getSeconds: () => 1762265000 }),
            },
          ],
        });
      }
      proxyCommand(req: MockProxyCommandRequest) {
        const text = new TextDecoder().decode(req.payload);
        proxyRequests.push({
          uuid: req.uuid,
          rpcPath: req.rpcPath,
          payloadText: text,
        });
        const responseJson = JSON.stringify({
          trajectorySummaries: {
            'cascade-42': {
              summary: 'Fix auth redirect',
              waitingSteps: [{ step: { runCommand: { commandLine: 'npm test' } } }],
              lastModifiedTime: '2026-11-04T14:20:00Z',
            },
          },
        });
        const encoded = new TextEncoder().encode(responseJson);
        return Promise.resolve({
          getPayload_asU8: () => encoded,
        });
      }
    }

    const mockIframe = {
      src: 'https://antigravity.static.usercontent.goog/web/1.0.20260910010023/?iframe=true',
      getAttribute: (attr: string) =>
        attr === 'src'
          ? 'https://antigravity.static.usercontent.goog/web/1.0.20260910010023/?iframe=true'
          : null,
      contentWindow: {
        postMessage: (msg: any, origin: string) => {
          // Match real Jetbox `Zub`: `jspbPayload` MUST be a JSON string, never a raw Array.
          expect(typeof msg?.jspbPayload).toBe('string');
          const decodedJspb = JSON.parse(msg.jspbPayload);
          expect(Array.isArray(decodedJspb)).toBe(true);
          postedToIframe.push({ msg, decodedJspb, origin });
        },
      },
    };

    const sandboxWindow: any = {
      location: {
        hostname: 'antigravity.google.com',
        origin: 'https://antigravity.google.com',
        pathname: '/r/box-alpha',
        search: '?p=c%2Fcascade-1',
        href: 'https://antigravity.google.com/r/box-alpha?p=c%2Fcascade-1',
      },
      history: {
        state: null,
        replaceState: (_state: unknown, _title: string, url: string) => {
          const updated = new URL(url, 'https://antigravity.google.com');
          sandboxWindow.location.pathname = updated.pathname;
          sandboxWindow.location.search = updated.search;
          sandboxWindow.location.href = updated.href;
        },
      },
      navigator: { onLine: true },
      document: {
        cookie: 'SAPISID=test-sapisid',
        visibilityState: 'visible',
        querySelectorAll: (sel: string) =>
          sel === 'iframe' ? [mockIframe] : [],
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
            getAuthHeaderValueForFirstParty: () => 'SAPISIDHASH 123_abc',
          },
        },
      },
      ReactNativeWebView: {
        postMessage: (raw: string) => {
          postedToNative.push(JSON.parse(raw));
        },
      },
      addEventListener: (event: string, fn: (e: any) => void) => {
        const list = windowListeners.get(event) ?? [];
        list.push(fn);
        windowListeners.set(event, list);
      },
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      setTimeout: (fn: () => void, ms?: number) => {
        const id = nextTimerId++;
        if (ms === 380) {
          scheduledTimers.set(id, fn);
        }
        return id;
      },
      clearTimeout: (id: number) => {
        scheduledTimers.delete(id);
      },
      setInterval: () => 2,
      clearInterval: () => undefined,
    };
    sandboxWindow.window = sandboxWindow;

    const context = vm.createContext(sandboxWindow);
    vm.runInContext(INBOX_BRIDGE_SCRIPT, context);
    expect(sandboxWindow.__agyInboxBridge).toBeDefined();

    await sandboxWindow.__agyInboxBridge.refresh();

    expect(postedToNative).toHaveLength(1);
    expect(postedToNative[0].type).toBe('AGY_INBOX_SNAPSHOT');
    expect(postedToNative[0].instances[0].uuid).toBe('box-alpha');
    expect(
      postedToNative[0].instances[0].trajectories['cascade-42'].summary,
    ).toBe('Fix auth redirect');

    // Test marking a thread as read via UpdateConversationAnnotations
    await vm.runInContext(
      buildMarkThreadReadScript({
        instanceUuid: 'box-alpha',
        cascadeId: 'cascade-42',
        readAtIso: '2026-11-04T14:25:00.000Z',
      }),
      context,
    );
    await Promise.resolve();
    expect(
      proxyRequests.some(
        (r) =>
          r.uuid === 'box-alpha' &&
          r.rpcPath.endsWith('/UpdateConversationAnnotations') &&
          r.payloadText.includes('"cascade-42"'),
      ),
    ).toBe(true);

    // Test fast same-workstation iframe navigation (JSON-serialized JSPB + confirmation)
    vm.runInContext(
      buildFastThreadSwitchScript({
        requestId: 'fast-1',
        instanceUuid: 'box-alpha',
        childPath: 'c/cascade-42',
        targetUrl: 'https://antigravity.google.com/r/box-alpha?p=c%2Fcascade-42',
      }),
      context,
    );
    expect(postedToIframe).toEqual([
      {
        msg: { jspbPayload: JSON.stringify([null, ['/c/cascade-42']]) },
        decodedJspb: [null, ['/c/cascade-42']],
        origin: 'https://antigravity.static.usercontent.goog',
      },
      {
        msg: { jspbPayload: JSON.stringify([null, null, []]) },
        decodedJspb: [null, null, []],
        origin: 'https://antigravity.static.usercontent.goog',
      },
    ]);
    // Must NOT prematurely claim `handled: true` before the iframe confirms the route change
    expect(
      postedToNative.some(
        (m) => m.type === 'AGY_INBOX_FAST_NAV_RESULT' && m.requestId === 'fast-1',
      ),
    ).toBe(false);

    // Simulate the iframe echoing `URL_RESPONSE` (field 4 / index 3) as a JSON string
    for (const listener of windowListeners.get('message') ?? []) {
      listener({
        origin: 'https://antigravity.static.usercontent.goog',
        data: {
          jspbPayload: JSON.stringify([
            null,
            null,
            null,
            ['/web/1.0.20260910010023/c/cascade-42'],
          ]),
        },
      });
    }
    expect(
      postedToNative.some(
        (m) =>
          m.type === 'AGY_INBOX_FAST_NAV_RESULT' &&
          m.requestId === 'fast-1' &&
          m.handled === true,
      ),
    ).toBe(true);
    expect(sandboxWindow.location.href).toBe(
      'https://antigravity.google.com/r/box-alpha?p=c%2Fcascade-42',
    );

    // Simulate `URL_CHANGE` (field 1 / index 0) confirming `fastNavigate`:
    // completes `pendingFastNav` and reports updated `activeUrl` to native WITHOUT
    // clobbering `history.replaceState` before Angular's `RemoteControlComponent` syncs router state.
    postedToIframe.length = 0;
    vm.runInContext(
      buildFastThreadSwitchScript({
        requestId: 'fast-url-change',
        instanceUuid: 'box-alpha',
        childPath: 'c/cascade-55',
        targetUrl: 'https://antigravity.google.com/r/box-alpha?p=c%2Fcascade-55',
      }),
      context,
    );
    for (const listener of windowListeners.get('message') ?? []) {
      listener({
        origin: 'https://antigravity.static.usercontent.goog',
        data: {
          jspbPayload: JSON.stringify([
            ['/web/1.0.20260910010023/c/cascade-55'],
          ]),
        },
      });
    }
    expect(
      postedToNative.some(
        (m) =>
          m.type === 'AGY_INBOX_FAST_NAV_RESULT' &&
          m.requestId === 'fast-url-change' &&
          m.handled === true,
      ),
    ).toBe(true);
    expect(
      postedToNative.some(
        (m) =>
          m.type === 'AGY_INBOX_ACTIVE_ROUTE' &&
          m.activeInstanceUuid === 'box-alpha' &&
          m.activeCascadeId === 'cascade-55' &&
          m.activeUrl ===
            'https://antigravity.google.com/r/box-alpha?p=c%2Fcascade-55',
      ),
    ).toBe(true);
    expect(sandboxWindow.location.href).toBe(
      'https://antigravity.google.com/r/box-alpha?p=c%2Fcascade-42',
    );

    // Exiting the thread back to Project Overview inside the iframe strips stale `?p=` from `window.location`
    // and emits `AGY_INBOX_ACTIVE_ROUTE` with `activeCascadeId: null`
    for (const listener of windowListeners.get('message') ?? []) {
      listener({
        origin: 'https://antigravity.static.usercontent.goog',
        data: {
          type: 'URL_CHANGED',
          path: '/web/1.0.20260910010023/',
        },
      });
    }
    expect(sandboxWindow.location.href).toBe(
      'https://antigravity.google.com/r/box-alpha',
    );
    expect(postedToNative[postedToNative.length - 1]).toEqual({
      type: 'AGY_INBOX_ACTIVE_ROUTE',
      activeUrl: 'https://antigravity.google.com/r/box-alpha',
      activeInstanceUuid: 'box-alpha',
      activeCascadeId: null,
    });

    // Test unready/stalled iframe fallback: if the iframe does not confirm within 380ms,
    // `fastNavigate` reports `handled: false` so native falls back to full URL navigation.
    postedToIframe.length = 0;
    vm.runInContext(
      buildFastThreadSwitchScript({
        requestId: 'fast-timeout',
        instanceUuid: 'box-alpha',
        childPath: 'c/cascade-77',
        targetUrl: 'https://antigravity.google.com/r/box-alpha?p=c%2Fcascade-77',
      }),
      context,
    );
    expect(scheduledTimers.size).toBe(1);
    for (const timerFn of Array.from(scheduledTimers.values())) {
      timerFn();
    }
    expect(
      postedToNative.some(
        (m) =>
          m.type === 'AGY_INBOX_FAST_NAV_RESULT' &&
          m.requestId === 'fast-timeout' &&
          m.handled === false,
      ),
    ).toBe(true);

    // Test iframe URL_CHANGE (JSON string `jspbPayload`) stripping `/web/<version>` base path
    // AND overriding stale `?p=` query parameter on subsequent snapshot polls
    for (const listener of windowListeners.get('message') ?? []) {
      listener({
        origin: 'https://antigravity.static.usercontent.goog',
        data: {
          jspbPayload: JSON.stringify([
            ['/web/1.0.20260910010023/c/cascade-99'],
          ]),
        },
      });
    }
    expect(
      postedToNative.some(
        (m) =>
          m.type === 'AGY_INBOX_ACTIVE_ROUTE' &&
          m.activeInstanceUuid === 'box-alpha' &&
          m.activeCascadeId === 'cascade-99',
      ),
    ).toBe(true);

    // Test NOTIFICATION_REQUEST nested C9 payload (`jspb[4][0]`) serialized as JSON string
    for (const listener of windowListeners.get('message') ?? []) {
      listener({
        origin: 'https://antigravity.static.usercontent.goog',
        data: {
          jspbPayload: JSON.stringify([
            null,
            null,
            null,
            null,
            [
              [
                'notif-1',
                'Command approval',
                './gradlew bundleRelease',
                false,
                '/c/cascade-99',
                'cascade-99',
              ],
            ],
          ]),
        },
      });
    }
    expect(
      postedToNative.some(
        (m) =>
          m.type === 'AGY_INBOX_REALTIME_HINT' &&
          m.reason === 'notification' &&
          m.cascadeId === 'cascade-99' &&
          m.title === 'Command approval' &&
          m.body === './gradlew bundleRelease',
      ),
    ).toBe(true);

    postedToNative.length = 0;
    await sandboxWindow.__agyInboxBridge.refresh();
    expect(postedToNative[0].type).toBe('AGY_INBOX_SNAPSHOT');
    expect(postedToNative[0].activeCascadeId).toBe('cascade-99');

    // Simulate Angular Router asynchronously syncing `?p=` on the same `/r/box-alpha` workstation,
    // followed by Closure JSPB empty-path `URL_CHANGE` (`jspbPayload: "[[]"`) when returning to Project Overview
    sandboxWindow.history.replaceState(
      null,
      '',
      '/r/box-alpha?p=c%2Fcascade-99',
    );
    for (const listener of windowListeners.get('message') ?? []) {
      listener({
        origin: 'https://antigravity.static.usercontent.goog',
        data: {
          jspbPayload: JSON.stringify([[]]),
        },
      });
    }
    expect(sandboxWindow.location.href).toBe(
      'https://antigravity.google.com/r/box-alpha',
    );
    expect(postedToNative[postedToNative.length - 1]).toEqual({
      type: 'AGY_INBOX_ACTIVE_ROUTE',
      activeUrl: 'https://antigravity.google.com/r/box-alpha',
      activeInstanceUuid: 'box-alpha',
      activeCascadeId: null,
    });

    // Verify `refresh()` queues a follow-up poll if called again while an earlier refresh is still in flight
    let resolveFirstList!: (value: any) => void;
    let listCallCount = 0;
    const origListInstances =
      MockApiServicePromiseClient.prototype.listInstances;
    MockApiServicePromiseClient.prototype.listInstances = function () {
      listCallCount += 1;
      if (listCallCount === 1) {
        return new Promise((resolve) => {
          resolveFirstList = resolve;
        });
      }
      return origListInstances.call(this);
    };
    try {
      postedToNative.length = 0;
      const firstRefresh = sandboxWindow.__agyInboxBridge.refresh();
      // Trigger a second refresh (e.g. real-time completion event) before the first resolves
      const secondRefresh = sandboxWindow.__agyInboxBridge.refresh();
      await Promise.resolve();
      resolveFirstList({
        getInstancesList: () => [],
      });
      await firstRefresh;
      await secondRefresh;
      await new Promise((resolve) => setImmediate(resolve));
      expect(listCallCount).toBe(2);
      expect(
        postedToNative.filter((m) => m.type === 'AGY_INBOX_SNAPSHOT'),
      ).toHaveLength(2);
    } finally {
      MockApiServicePromiseClient.prototype.listInstances = origListInstances;
    }
  });

  it('builds single-thread vs multi-action Inbox notification payloads, updates silently on decrements, and catches unread replies while backgrounded', () => {
    expect(
      buildThreadNotificationDeepLink(
        'https://antigravity.google.com/r/workstation-1?p=c%2Fthread-7',
      ),
    ).toBe('antigravity-remote://r/workstation-1?p=c%2Fthread-7');
    expect(
      buildThreadNotificationDeepLink('https://evil.example.com/r/box'),
    ).toBeNull();

    const snapshotMsg = {
      type: 'AGY_INBOX_SNAPSHOT' as const,
      fetchedAtMs: 1_762_265_000_000,
      activeUrl: 'https://antigravity.google.com/r/box-1?p=c%2Factive-thread',
      activeInstanceUuid: 'box-1',
      activeCascadeId: 'active-thread',
      instances: [
        {
          uuid: 'box-1',
          name: 'Workstation One',
          status: 1,
          trajectories: {
            trajectorySummaries: {
              'active-thread': {
                summary: 'Open foreground task',
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: '2026-11-04T15:00:00Z',
                lastUserInputTime: '2026-11-04T14:00:00Z',
              },
              'approval-thread': {
                summary: 'Run migration',
                status: 'CASCADE_RUN_STATUS_RUNNING',
                waitingSteps: [
                  { step: { runCommand: { commandLine: 'npm run migrate' } } },
                ],
                lastModifiedTime: '2026-11-04T15:05:00Z',
              },
            },
          },
        },
        {
          uuid: 'box-2',
          name: 'Workstation Two',
          status: 1,
          trajectories: {
            trajectorySummaries: {
              'unread-thread': {
                summary: 'Draft release notes',
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: '2026-11-04T15:02:00Z',
                lastUserInputTime: '2026-11-04T14:00:00Z',
              },
            },
          },
        },
      ],
    };

    // 1. In foreground (`isAppForeground = true`), `active-thread` is suppressed as unread,
    // leaving 2 open background actions (`approval-thread` + `unread-thread`).
    const fgSnap = buildInboxSnapshot(
      snapshotMsg,
      {},
      snapshotMsg.activeUrl,
      true,
    );
    expect(
      fgSnap.threads.find((t) => t.cascadeId === 'active-thread')?.attentionKind,
    ).toBe('idle');

    // Mode = 'approvals': only `approval-thread` counts -> count === 1 -> direct thread deep link!
    const approvalsOnly = buildActionNotificationSyncState({
      stage: 'authenticated',
      mode: 'approvals',
      threads: fgSnap.threads,
      isAppForeground: true,
      isDrawerOpen: false,
      previousOpenThreadIds: new Set(),
    });
    expect(approvalsOnly.notification).toMatchObject({
      count: 1,
      title: '1 action open • Workstation One',
      deepLinkUrl: 'antigravity-remote://r/box-1?p=c%2Fapproval-thread',
      shouldAlert: true,
    });

    // Mode = 'all_attention': 2 open actions -> count === 2 -> Inbox deep link!
    const twoOpen = buildActionNotificationSyncState({
      stage: 'authenticated',
      mode: 'all_attention',
      threads: fgSnap.threads,
      isAppForeground: true,
      isDrawerOpen: false,
      previousOpenThreadIds: approvalsOnly.openThreadIds,
    });
    expect(twoOpen.notification).toMatchObject({
      count: 2,
      title: '2 actions open',
      deepLinkUrl: 'antigravity-remote://inbox',
      shouldAlert: true,
    });

    // Resolving 1 of the 2 actions (`2 -> 1`) updates silently (`shouldAlert: false`) and switches deep link back to the single remaining thread!
    const remainingOne = fgSnap.threads.filter(
      (t) => t.cascadeId !== 'unread-thread',
    );
    const decremented = buildActionNotificationSyncState({
      stage: 'authenticated',
      mode: 'all_attention',
      threads: remainingOne,
      isAppForeground: true,
      isDrawerOpen: false,
      previousOpenThreadIds: twoOpen.openThreadIds,
    });
    expect(decremented.notification).toMatchObject({
      count: 1,
      deepLinkUrl: 'antigravity-remote://r/box-1?p=c%2Fapproval-thread',
      shouldAlert: false,
    });

    // 2. While backgrounded (`isAppForeground = false`), a finished reply on `active-thread` DOES count as unread (`count === 3`)!
    const bgSnap = buildInboxSnapshot(
      snapshotMsg,
      {},
      snapshotMsg.activeUrl,
      false,
    );
    expect(
      bgSnap.threads.find((t) => t.cascadeId === 'active-thread')?.attentionKind,
    ).toBe('unread');
    const bgSync = buildActionNotificationSyncState({
      stage: 'authenticated',
      mode: 'all_attention',
      threads: bgSnap.threads,
      isAppForeground: false,
      isDrawerOpen: false,
      previousOpenThreadIds: twoOpen.openThreadIds,
    });
    expect(bgSync.notification).toMatchObject({
      count: 3,
      title: '3 actions open',
      deepLinkUrl: 'antigravity-remote://inbox',
      shouldAlert: true,
    });

    // Mode = 'off' clears notification (`null`)
    expect(
      buildActionNotificationSyncState({
        stage: 'authenticated',
        mode: 'off',
        threads: bgSnap.threads,
        isAppForeground: false,
        isDrawerOpen: false,
        previousOpenThreadIds: bgSync.openThreadIds,
      }).notification,
    ).toBeNull();
  });

  it('preserves explicit null activeCascadeId when exiting to Project Overview and suppresses false-positive alert chimes on app switch', () => {
    // 1. Exiting a thread inside the iframe posts `activeCascadeId: null` even if `activeUrl` still had `?p=c%2Factive-thread`
    const parsedExitRoute = parseInboxBridgeMessage(
      JSON.stringify({
        type: 'AGY_INBOX_ACTIVE_ROUTE',
        activeUrl: 'https://antigravity.google.com/r/box-1?p=c%2Factive-thread',
        activeInstanceUuid: 'box-1',
        activeCascadeId: null,
      }),
    );
    expect(parsedExitRoute).toEqual({
      type: 'AGY_INBOX_ACTIVE_ROUTE',
      activeUrl: 'https://antigravity.google.com/r/box-1?p=c%2Factive-thread',
      activeInstanceUuid: 'box-1',
      activeCascadeId: null,
    });

    const overviewSnapMsg = parseInboxBridgeMessage(
      JSON.stringify({
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: Date.now(),
        activeUrl: 'https://antigravity.google.com/r/box-1?p=c%2Factive-thread',
        activeInstanceUuid: 'box-1',
        activeCascadeId: null,
        instances: [
          {
            uuid: 'box-1',
            name: 'Workstation One',
            status: 1,
            trajectories: {
              trajectorySummaries: {
                'active-thread': {
                  summary: 'Prompt on active thread',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  waitingSteps: [
                    { step: { runCommand: { commandLine: 'npm test' } } },
                  ],
                  lastModifiedTime: '2026-11-05T18:00:00Z',
                },
              },
            },
          },
        ],
      }),
    );
    expect(overviewSnapMsg?.type).toBe('AGY_INBOX_SNAPSHOT');
    const overviewSnap = buildInboxSnapshot(
      overviewSnapMsg as Extract<
        ReturnType<typeof parseInboxBridgeMessage>,
        { type: 'AGY_INBOX_SNAPSHOT' }
      >,
      {},
      'https://antigravity.google.com/r/box-1?p=c%2Factive-thread',
      true,
    );
    expect(overviewSnap.activeInstanceUuid).toBe('box-1');
    expect(overviewSnap.activeCascadeId).toBeNull();
    expect(overviewSnap.threads[0].isActiveThread).toBe(false);

    // 2. While viewing `active-thread` in the foreground with an open approval, no notification is shown,
    // AND switching apps (`isAppForeground: true -> false`) posts the tray count silently (`shouldAlert: false`)
    // instead of chiming as a newly arrived prompt.
    const inThreadSnap = buildInboxSnapshot(
      {
        ...(overviewSnapMsg as any),
        activeCascadeId: 'active-thread',
      },
      {},
      'https://antigravity.google.com/r/box-1?p=c%2Factive-thread',
      true,
    );
    const whileViewing = buildActionNotificationSyncState({
      stage: 'authenticated',
      mode: 'approvals',
      threads: inThreadSnap.threads,
      isAppForeground: true,
      isDrawerOpen: false,
      previousOpenThreadIds: new Set(),
    });
    expect(whileViewing.notification).toBeNull();
    expect(whileViewing.openThreadIds.has('box-1:active-thread')).toBe(true);

    const afterAppSwitch = buildActionNotificationSyncState({
      stage: 'authenticated',
      mode: 'approvals',
      threads: inThreadSnap.threads,
      isAppForeground: false,
      isDrawerOpen: false,
      previousOpenThreadIds: whileViewing.openThreadIds,
    });
    expect(afterAppSwitch.notification).toMatchObject({
      count: 1,
      deepLinkUrl: 'antigravity-remote://r/box-1?p=c%2Factive-thread',
      shouldAlert: false,
    });
  });

  it('marks finished runs as unread (blue state + notification) across sub-second completions, CLI runs, and open drawer while skipping interrupted runs', () => {
    // 1. Sub-second (+350ms) and same-second (`stepCount > lastUserInputStepIndex + 1`) completions register as unread
    const fastSnap = buildInboxSnapshot(
      {
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_270_000_000,
        activeUrl: 'https://antigravity.google.com/r/box-1',
        activeInstanceUuid: 'box-1',
        activeCascadeId: null,
        instances: [
          {
            uuid: 'box-1',
            name: 'Devbox',
            status: 1,
            trajectories: {
              trajectorySummaries: {
                'subsecond-reply': {
                  summary: 'Quick status check',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  lastUserInputTime: '2026-11-05T19:00:00.100Z',
                  lastModifiedTime: '2026-11-05T19:00:00.450Z',
                },
                'samesecond-steps': {
                  summary: 'Instant one-shot fix',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  stepCount: 5,
                  lastUserInputStepIndex: 2,
                  lastUserInputTime: '2026-11-05T19:00:00Z',
                  lastModifiedTime: '2026-11-05T19:00:00Z',
                  annotations: {
                    lastUserViewTime: '2026-11-05T19:00:00Z',
                  },
                },
              },
            },
          },
        ],
      },
      {},
    );
    expect(fastSnap.threads).toHaveLength(2);
    for (const thread of fastSnap.threads) {
      expect(thread.attentionKind).toBe('unread');
      expect(thread.needsAttention).toBe(true);
      expect(thread.attentionReason).toBe('Agent finished — unread updates');
    }

    // 2. Live `running -> idle` transition catches CLI-started / desktop-viewed completions when not actively viewed on screen,
    // while skipping user-interrupted runs and suppressing threads watched live in the foreground with drawer closed.
    const knownRunning = new Set<string>();
    const completedUnread: Record<string, number> = {};
    const locallyRead: Record<string, number> = {};

    reconcileRunningThreadTransitions({
      message: {
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_270_010_000,
        activeUrl: 'https://antigravity.google.com/r/box-1?p=c%2Fwatched-live',
        activeInstanceUuid: 'box-1',
        activeCascadeId: 'watched-live',
        instances: [
          {
            uuid: 'box-1',
            name: 'Devbox',
            status: 1,
            trajectories: {
              trajectorySummaries: {
                'cli-run': {
                  summary: 'CLI build pipeline',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  lastModifiedTime: '2026-11-05T19:05:00Z',
                },
                'interrupted-run': {
                  summary: 'Cancelled experiment',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  lastModifiedTime: '2026-11-05T19:05:00Z',
                },
                'watched-live': {
                  summary: 'Watched live in foreground',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  lastUserInputTime: '2026-11-05T19:04:00Z',
                  lastModifiedTime: '2026-11-05T19:05:00Z',
                },
              },
            },
          },
        ],
      },
      knownRunningThreadIds: knownRunning,
      completedUnreadAtByThreadId: completedUnread,
      locallyReadAtByThreadId: locallyRead,
      isAppForeground: true,
      isDrawerOpen: false,
    });
    expect(knownRunning.size).toBe(3);

    const finishedSnap = reconcileRunningThreadTransitions({
      message: {
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_270_020_000,
        activeUrl: 'https://antigravity.google.com/r/box-1?p=c%2Fwatched-live',
        activeInstanceUuid: 'box-1',
        activeCascadeId: 'watched-live',
        instances: [
          {
            uuid: 'box-1',
            name: 'Devbox',
            status: 1,
            trajectories: {
              trajectorySummaries: {
                'cli-run': {
                  summary: 'CLI build pipeline',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  lastModifiedTime: '2026-11-05T19:06:00Z',
                },
                'interrupted-run': {
                  summary: 'Cancelled experiment',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  interrupted: true,
                  lastModifiedTime: '2026-11-05T19:06:00Z',
                },
                'watched-live': {
                  summary: 'Watched live in foreground',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  lastUserInputTime: '2026-11-05T19:04:00Z',
                  lastModifiedTime: '2026-11-05T19:06:00Z',
                },
              },
            },
          },
        ],
      },
      knownRunningThreadIds: knownRunning,
      completedUnreadAtByThreadId: completedUnread,
      locallyReadAtByThreadId: locallyRead,
      isAppForeground: true,
      isDrawerOpen: false,
    });

    const cliThread = finishedSnap.threads.find((t) => t.cascadeId === 'cli-run')!;
    const interruptedThread = finishedSnap.threads.find(
      (t) => t.cascadeId === 'interrupted-run',
    )!;
    const watchedThread = finishedSnap.threads.find(
      (t) => t.cascadeId === 'watched-live',
    )!;

    expect(cliThread.attentionKind).toBe('unread');
    expect(cliThread.needsAttention).toBe(true);
    expect(cliThread.attentionReason).toBe('Agent finished — unread updates');

    expect(interruptedThread.attentionKind).toBe('idle');
    expect(interruptedThread.needsAttention).toBe(false);
    expect(interruptedThread.attentionReason).toBe('Interrupted');

    expect(watchedThread.attentionKind).toBe('idle');
    expect(watchedThread.needsAttention).toBe(false);

    // Opening the drawer afterwards must NOT retroactively flag `watched-live` as unread
    const afterDrawerOpen = applyLocalStateToSnapshot(finishedSnap, {
      activeInstanceUuid: 'box-1',
      activeCascadeId: 'watched-live',
      locallyReadAtByThreadId: locallyRead,
      isAppForeground: true,
      isDrawerOpen: true,
    });
    expect(
      afterDrawerOpen.threads.find((t) => t.cascadeId === 'watched-live')
        ?.attentionKind,
    ).toBe('idle');

    // Notification sync under default `all_attention` alerts for `cli-run` with direct deep link
    const notifSync = buildActionNotificationSyncState({
      stage: 'authenticated',
      mode: 'all_attention',
      threads: finishedSnap.threads,
      isAppForeground: true,
      isDrawerOpen: false,
      previousOpenThreadIds: new Set(),
    });
    expect(notifSync.notification).toMatchObject({
      count: 1,
      title: '1 action open • Devbox',
      body: 'CLI build pipeline — Agent finished — unread updates',
      deepLinkUrl: 'antigravity-remote://r/box-1?p=c%2Fcli-run',
      shouldAlert: true,
    });
  });

  it('promotes the workstation iframe to full-bleed on /r/<uuid>, hides outer host header & Google OneBar while preserving overlays, restores on /, and triggers host settings safely', () => {
    expect(
      parseInboxBridgeMessage(
        JSON.stringify({
          type: 'AGY_INBOX_HOST_SETTINGS_RESULT',
          handled: true,
        }),
      ),
    ).toEqual({
      type: 'AGY_INBOX_HOST_SETTINGS_RESULT',
      handled: true,
    });
    expect(
      parseInboxBridgeMessage(
        JSON.stringify({
          type: 'AGY_INBOX_HOST_SETTINGS_RESULT',
          handled: 'invalid',
        }),
      ),
    ).toBeNull();

    // Enforce Trusted-Types CSP compliance on bridge scripts
    for (const script of [
      INBOX_BRIDGE_SCRIPT,
      buildOpenHostSettingsScript(),
    ]) {
      expect(script).not.toMatch(
        /\b(innerHTML|outerHTML|insertAdjacentHTML|eval)\b|document\.write|new\s+Function/,
      );
    }

    interface MockStyle {
      setProperty: (prop: string, val: string, pri?: string) => void;
      removeProperty: (prop: string) => void;
      getPropertyValue: (prop: string) => string;
      getPropertyPriority: (prop: string) => string;
    }

    const createStyle = (
      initial: Record<string, { val: string; pri: string }> = {},
    ): MockStyle => {
      const store = new Map<string, { val: string; pri: string }>(
        Object.entries(initial),
      );
      return {
        setProperty(prop: string, val: string, pri: string = '') {
          store.set(prop, { val, pri });
        },
        removeProperty(prop: string) {
          store.delete(prop);
        },
        getPropertyValue(prop: string) {
          return store.get(prop)?.val ?? '';
        },
        getPropertyPriority(prop: string) {
          return store.get(prop)?.pri ?? '';
        },
      };
    };

    interface MockElement {
      tagName: string;
      className: string;
      textContent: string;
      src?: string;
      parentElement: MockElement | null;
      children: MockElement[];
      style: MockStyle;
      clickCount: number;
      attrs: Record<string, string>;
      getAttribute: (name: string) => string | null;
      querySelector: (selector: string) => MockElement | null;
      click: () => void;
    }

    const makeEl = (
      tagName: string,
      opts: {
        className?: string;
        textContent?: string;
        src?: string;
        attrs?: Record<string, string>;
        initialStyle?: Record<string, { val: string; pri: string }>;
      } = {},
    ): MockElement => {
      const attrs = { ...(opts.attrs ?? {}) };
      if (opts.src) {
        attrs.src = opts.src;
      }
      const el: MockElement = {
        tagName: tagName.toUpperCase(),
        className: opts.className ?? '',
        textContent: opts.textContent ?? '',
        src: opts.src,
        parentElement: null,
        children: [],
        style: createStyle(opts.initialStyle),
        clickCount: 0,
        attrs,
        getAttribute: (name: string) =>
          Object.prototype.hasOwnProperty.call(attrs, name)
            ? attrs[name]
            : null,
        querySelector: (selector: string) => {
          if (
            selector.includes('[role="dialog"]') &&
            el.children.some((c) => c.getAttribute('role') === 'dialog')
          ) {
            return el.children.find((c) => c.getAttribute('role') === 'dialog')!;
          }
          return null;
        },
        click: () => {
          el.clickCount += 1;
        },
      };
      return el;
    };

    const append = (parent: MockElement, ...kids: MockElement[]) => {
      for (const kid of kids) {
        kid.parentElement = parent;
        parent.children.push(kid);
      }
    };

    // Build realistic Antigravity host DOM on `/r/dev-server`:
    // body
    //  ├── appRoot (margin-top: 4px)
    //  │    ├── hostTopHeader ([A] logo, [dev-server ▾], [⚙️ Settings], [↻ Reload])
    //  │    └── workspaceMain (padding-top: 56px)
    //  │         └── hubIframe (src="https://antigravity.static.usercontent.goog/web/...")
    //  ├── googleOneBar (floating [💬! Feedback] + [Google Account Avatar], display: flex)
    //  ├── cdkOverlayContainer (.cdk-overlay-container)
    //  └── appStyle (<style>)
    const docEl = makeEl('HTML');
    const body = makeEl('BODY');
    append(docEl, body);

    const appRoot = makeEl('APP-ROOT', {
      initialStyle: { 'margin-top': { val: '4px', pri: '' } },
    });
    const hostTopHeader = makeEl('HEADER', {
      initialStyle: { display: { val: 'flex', pri: '' } },
    });
    const reloadBtn = makeEl('BUTTON', {
      attrs: { 'aria-label': 'Reload workstation' },
      textContent: 'refresh',
    });
    const hostGearBtn = makeEl('BUTTON', {
      attrs: { 'aria-label': 'Workstation settings' },
      textContent: 'settings',
    });
    append(hostTopHeader, hostGearBtn, reloadBtn);

    const workspaceMain = makeEl('MAIN', {
      initialStyle: { 'padding-top': { val: '56px', pri: '' } },
    });
    const hubIframe = makeEl('IFRAME', {
      src: 'https://antigravity.static.usercontent.goog/web/v1/?iframe=true',
    });
    append(workspaceMain, hubIframe);
    append(appRoot, hostTopHeader, workspaceMain);

    const googleOneBar = makeEl('DIV', {
      className: 'gb_onebar',
      initialStyle: { display: { val: 'flex', pri: '' } },
    });
    const feedbackBtn = makeEl('BUTTON', {
      attrs: { 'aria-label': 'Send feedback' },
    });
    const avatarBtn = makeEl('BUTTON', {
      attrs: { 'aria-label': 'Google Account: user@example.com' },
    });
    append(googleOneBar, feedbackBtn, avatarBtn);

    const cdkOverlayContainer = makeEl('DIV', {
      className: 'cdk-overlay-container',
    });
    const dialogInsideOverlay = makeEl('DIV', {
      attrs: { role: 'dialog' },
    });
    const dialogCloseBtn = makeEl('BUTTON', {
      attrs: { 'aria-label': 'Close settings' },
    });
    append(dialogInsideOverlay, dialogCloseBtn);
    append(cdkOverlayContainer, dialogInsideOverlay);

    const appStyle = makeEl('STYLE');
    append(body, appRoot, googleOneBar, cdkOverlayContainer, appStyle);

    const allButtons = [
      hostGearBtn,
      reloadBtn,
      feedbackBtn,
      avatarBtn,
      dialogCloseBtn,
    ];
    let currentLocation = {
      hostname: 'antigravity.google.com',
      origin: 'https://antigravity.google.com',
      pathname: '/r/dev-server',
      search: '',
      hash: '',
      href: 'https://antigravity.google.com/r/dev-server',
    };
    const postedMessages: any[] = [];
    const popstateHandlers: Array<() => void> = [];

    const windowObj: any = {
      location: currentLocation,
      navigator: { onLine: true },
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'popstate') {
          popstateHandlers.push(cb);
        }
      },
      ReactNativeWebView: {
        postMessage: (raw: string) => {
          postedMessages.push(JSON.parse(raw));
        },
      },
      innerWidth: 390,
      innerHeight: 760,
      visualViewport: {
        width: 390,
        height: 760,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    };
    const documentObj: any = {
      cookie: '',
      visibilityState: 'visible',
      documentElement: docEl,
      body,
      querySelectorAll: (selector: string) => {
        if (selector === 'iframe') {
          return [hubIframe];
        }
        if (selector === 'button, [role="button"]') {
          return allButtons;
        }
        return [];
      },
    };
    const sandbox = vm.createContext({
      window: windowObj,
      document: documentObj,
      navigator: windowObj.navigator,
      URL,
      URLSearchParams,
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    });

    vm.runInContext(INBOX_BRIDGE_SCRIPT, sandbox);

    // 1. On `/r/dev-server`, workstation iframe is promoted to full-bleed fixed viewport
    expect(hubIframe.style.getPropertyValue('position')).toBe('fixed');
    expect(hubIframe.style.getPropertyPriority('position')).toBe('important');
    expect(hubIframe.style.getPropertyValue('top')).toBe('0px');
    expect(hubIframe.style.getPropertyValue('width')).toBe('100%');
    expect(hubIframe.style.getPropertyValue('height')).toBe('100%');
    expect(hubIframe.style.getPropertyValue('z-index')).toBe('990');

    // Outer host header AND floating Google feedback/avatar bar are hidden
    expect(hostTopHeader.style.getPropertyValue('display')).toBe('none');
    expect(hostTopHeader.style.getPropertyPriority('display')).toBe('important');
    expect(googleOneBar.style.getPropertyValue('display')).toBe('none');
    expect(workspaceMain.style.getPropertyValue('padding-top')).toBe('0px');
    expect(appRoot.style.getPropertyValue('margin-top')).toBe('0px');

    // CDK overlay container and <style> tag are NOT hidden; overlay is elevated above iframe with non-static position
    expect(cdkOverlayContainer.style.getPropertyValue('display')).toBe('');
    expect(cdkOverlayContainer.style.getPropertyValue('position')).toBe('relative');
    expect(cdkOverlayContainer.style.getPropertyValue('z-index')).toBe('2000');
    expect(appStyle.style.getPropertyValue('display')).toBe('');

    // 2. `buildOpenHostSettingsScript()` clicks the outer host gear button (ignoring feedback, avatar, reload, and dialog buttons)
    postedMessages.length = 0;
    vm.runInContext(buildOpenHostSettingsScript(), sandbox);
    expect(hostGearBtn.clickCount).toBe(1);
    expect(feedbackBtn.clickCount).toBe(0);
    expect(avatarBtn.clickCount).toBe(0);
    expect(reloadBtn.clickCount).toBe(0);
    expect(dialogCloseBtn.clickCount).toBe(0);
    expect(postedMessages).toContainEqual({
      type: 'AGY_INBOX_HOST_SETTINGS_RESULT',
      handled: true,
    });

    // Fallback attribute matching clicks an unlabeled SVG gear button with data-testid="host-settings-btn"
    const svgGearBtn = makeEl('BUTTON', {
      attrs: { 'data-testid': 'host-settings-btn' },
    });
    allButtons.length = 0;
    allButtons.push(feedbackBtn, avatarBtn, reloadBtn, svgGearBtn);
    postedMessages.length = 0;
    vm.runInContext(buildOpenHostSettingsScript(), sandbox);
    expect(svgGearBtn.clickCount).toBe(1);
    expect(postedMessages).toContainEqual({
      type: 'AGY_INBOX_HOST_SETTINGS_RESULT',
      handled: true,
    });

    // When no host gear button exists, reports `handled: false`
    allButtons.length = 0;
    allButtons.push(feedbackBtn, avatarBtn, reloadBtn);
    postedMessages.length = 0;
    vm.runInContext(buildOpenHostSettingsScript(), sandbox);
    expect(postedMessages).toContainEqual({
      type: 'AGY_INBOX_HOST_SETTINGS_RESULT',
      handled: false,
    });

    // 2b. If the host hides the workstation iframe (e.g. workstation offline / reconnect screen),
    // `syncFullBleedWorkspace()` restores host chrome instead of blanking out the page
    (hubIframe as any).hidden = true;
    expect(windowObj.__agyInboxBridge.syncFullBleedWorkspace()).toBe(false);
    expect(hubIframe.style.getPropertyValue('position')).toBe('');
    expect(hostTopHeader.style.getPropertyValue('display')).toBe('flex');
    (hubIframe as any).hidden = false;
    expect(windowObj.__agyInboxBridge.syncFullBleedWorkspace()).toBe(true);
    expect(hubIframe.style.getPropertyValue('position')).toBe('fixed');
    expect(hostTopHeader.style.getPropertyValue('display')).toBe('none');

    // Menu/popover siblings (`[role="menu"]` / `[popover]`) are also preserved above the full-bleed iframe
    const menuPopover = makeEl('DIV', {
      attrs: { role: 'menu', popover: 'auto' },
    });
    append(body, menuPopover);
    windowObj.__agyInboxBridge.syncFullBleedWorkspace();
    expect(menuPopover.style.getPropertyValue('display')).toBe('');
    expect(menuPopover.style.getPropertyValue('position')).toBe('relative');
    expect(menuPopover.style.getPropertyValue('z-index')).toBe('2000');

    // 2c. When software keyboard shrinks/scrolls `visualViewport` (e.g. iOS WKWebView),
    // `syncFullBleedWorkspace()` pins the promoted iframe to the unobscured visualViewport
    // and restores `100%` once the keyboard closes
    windowObj.visualViewport.height = 458;
    windowObj.visualViewport.offsetTop = 24;
    windowObj.__agyInboxBridge.syncFullBleedWorkspace();
    expect(hubIframe.style.getPropertyValue('top')).toBe('24px');
    expect(hubIframe.style.getPropertyValue('height')).toBe('458px');
    expect(hubIframe.style.getPropertyValue('max-height')).toBe('458px');
    expect(hubIframe.style.getPropertyValue('bottom')).toBe('auto');

    windowObj.visualViewport.height = 760;
    windowObj.visualViewport.offsetTop = 0;
    windowObj.__agyInboxBridge.syncFullBleedWorkspace();
    expect(hubIframe.style.getPropertyValue('top')).toBe('0px');
    expect(hubIframe.style.getPropertyValue('height')).toBe('100%');
    expect(hubIframe.style.getPropertyValue('bottom')).toBe('0px');

    // 3. Navigating back to `/` (All Machines overview) restores all original inline styles
    currentLocation.pathname = '/';
    currentLocation.href = 'https://antigravity.google.com/';
    for (const fn of popstateHandlers) {
      fn();
    }
    expect(hubIframe.style.getPropertyValue('position')).toBe('');
    expect(hostTopHeader.style.getPropertyValue('display')).toBe('flex');
    expect(googleOneBar.style.getPropertyValue('display')).toBe('flex');
    expect(workspaceMain.style.getPropertyValue('padding-top')).toBe('56px');
    expect(appRoot.style.getPropertyValue('margin-top')).toBe('4px');
    expect(cdkOverlayContainer.style.getPropertyValue('position')).toBe('');
    expect(cdkOverlayContainer.style.getPropertyValue('z-index')).toBe('');

    windowObj.__agyInboxBridge.stop();
  });

  it('extracts workspace URIs, groups threads into sorted project groups, and parses AGY_INBOX_START_CHAT_RESULT', () => {
    expect(
      extractWorkspaceUri({
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///home/user/repo-a/' }],
      }),
    ).toBe('file:///home/user/repo-a');
    expect(
      extractWorkspaceUri({
        workspaceFolderAbsoluteUri: '/Users/dev/project-b',
      }),
    ).toBe('/Users/dev/project-b');
    expect(extractWorkspaceUri({})).toBeNull();

    const snapshot = buildInboxSnapshot(
      {
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_265_000_000,
        activeUrl: 'https://antigravity.google.com/u/1/r/box-1?p=c%2Ft-active',
        activeInstanceUuid: 'box-1',
        activeCascadeId: 't-active',
        instances: [
          {
            uuid: 'box-1',
            name: 'Primary Laptop',
            status: 1,
            trajectories: {
              't-active': {
                summary: 'Active feature work',
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: '2026-11-04T14:10:00Z',
                lastUserViewTime: '2026-11-04T14:11:00Z',
                workspaces: [
                  {
                    workspaceFolderAbsoluteUri:
                      'file:///home/dev/antigravity-remote',
                  },
                ],
              },
              't-approval': {
                summary: 'Approve deployment',
                waitingSteps: [
                  { step: { runCommand: { commandLine: 'npm publish' } } },
                ],
                lastModifiedTime: '2026-11-04T14:25:00Z',
                workspaces: [
                  {
                    workspaceFolderAbsoluteUri:
                      'file:///home/dev/backend-service',
                  },
                ],
              },
              't-older-same-project': {
                summary: 'Initial setup',
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: '2026-11-04T13:00:00Z',
                lastUserViewTime: '2026-11-04T13:05:00Z',
                workspaces: [
                  {
                    workspaceFolderAbsoluteUri:
                      'file:///home/dev/antigravity-remote',
                  },
                ],
              },
            },
          },
          {
            uuid: 'box-empty',
            name: 'Idle Workstation',
            status: 1,
            trajectories: {},
          },
        ],
      },
      {},
      'https://antigravity.google.com/u/1/r/box-1?p=c%2Ft-active',
      true,
    );

    const groups = buildProjectGroups(
      snapshot,
      'https://antigravity.google.com/u/1/r/box-1?p=c%2Ft-active',
    );
    expect(groups).toHaveLength(3);

    // Group with active thread comes first (`hasActiveThread === true`), followed by urgent approval group, then empty connected machine
    expect(groups[0]).toMatchObject({
      name: 'antigravity-remote',
      workspaceName: 'antigravity-remote',
      workspaceUri: 'file:///home/dev/antigravity-remote',
      instanceUuid: 'box-1',
      instanceName: 'Primary Laptop',
      hasActiveThread: true,
      newChatUrl: 'https://antigravity.google.com/u/1/r/box-1',
    });
    expect(groups[0].threads.map((t) => t.cascadeId)).toEqual([
      't-active',
      't-older-same-project',
    ]);

    expect(groups[1]).toMatchObject({
      name: 'backend-service',
      workspaceUri: 'file:///home/dev/backend-service',
      instanceUuid: 'box-1',
      attentionCount: 1,
      urgentCount: 1,
    });

    expect(groups[2]).toMatchObject({
      name: 'Idle Workstation',
      workspaceName: null,
      workspaceUri: null,
      instanceUuid: 'box-empty',
      threads: [],
      newChatUrl: 'https://antigravity.google.com/u/1/r/box-empty',
    });

    const parsedStartResult = parseInboxBridgeMessage(
      JSON.stringify({
        type: 'AGY_INBOX_START_CHAT_RESULT',
        requestId: 'req-42',
        handled: true,
        cascadeId: 'new-cascade-99',
        targetUrl:
          'https://antigravity.google.com/u/1/r/box-1?p=c%2Fnew-cascade-99',
      }),
    );
    expect(parsedStartResult).toEqual({
      type: 'AGY_INBOX_START_CHAT_RESULT',
      requestId: 'req-42',
      handled: true,
      cascadeId: 'new-cascade-99',
      targetUrl:
        'https://antigravity.google.com/u/1/r/box-1?p=c%2Fnew-cascade-99',
    });

    const startScript = buildStartProjectChatScript({
      requestId: 'req-42',
      instanceUuid: 'box-1',
      workspaceUri: 'file:///home/dev/antigravity-remote',
      targetUrl: 'https://antigravity.google.com/u/1/r/box-1',
    });
    expect(startScript).toContain('startProjectChat');
    expect(startScript).toContain('file:///home/dev/antigravity-remote');
  });

  test('executes startProjectChat inside VM sandbox and handles StartCascade RPC and fallback', async () => {
    const iframeMessages: Array<{ payload: any; origin: string }> = [];
    const postedNativeMessages: any[] = [];
    const proxyCommandCalls: Array<{
      targetUuid: string;
      rpcPath: string;
      jsonBody: string;
    }> = [];
    let nextStartCascadeResponse: Record<string, unknown> | null = {
      cascadeId: 'new-cascade-77',
    };

    const windowMessageListeners: Array<(evt: any) => void> = [];
    const hubIframe = {
      tagName: 'IFRAME',
      src: 'https://antigravity.static.usercontent.goog/web/v1/?iframe=true',
      contentWindow: {
        postMessage: (msg: any, origin: string) => {
          iframeMessages.push({ payload: msg, origin });
          if (msg && typeof msg.jspbPayload === 'string') {
            try {
              const arr = JSON.parse(msg.jspbPayload);
              if (
                Array.isArray(arr) &&
                Array.isArray(arr[1]) &&
                typeof arr[1][0] === 'string'
              ) {
                const respEvt = {
                  origin: 'https://antigravity.static.usercontent.goog',
                  source: hubIframe.contentWindow,
                  data: {
                    jspbPayload: JSON.stringify([null, null, null, [arr[1][0]]]),
                  },
                };
                for (const fn of windowMessageListeners) {
                  fn(respEvt);
                }
              }
            } catch {}
          }
        },
      },
      style: {
        setProperty: () => {},
        removeProperty: () => {},
        getPropertyValue: () => '',
        getPropertyPriority: () => '',
      },
      getAttribute: (name: string) =>
        name === 'src'
          ? 'https://antigravity.static.usercontent.goog/web/v1/?iframe=true'
          : null,
      getBoundingClientRect: () => ({ width: 390, height: 800 }),
    };

    const locationObj = {
      hostname: 'antigravity.google.com',
      origin: 'https://antigravity.google.com',
      pathname: '/r/box-1',
      search: '?p=c%2Fold-cascade',
      hash: '',
      href: 'https://antigravity.google.com/r/box-1?p=c%2Fold-cascade',
    };

    function MockProxyCommandRequest(this: any) {
      this.targetUuid = '';
      this.rpcPath = '';
      this.payloadBytes = null;
    }
    MockProxyCommandRequest.prototype.setTargetInstanceUuid = function (
      u: string,
    ) {
      this.targetUuid = u;
    };
    MockProxyCommandRequest.prototype.setRpcPath = function (p: string) {
      this.rpcPath = p;
    };
    MockProxyCommandRequest.prototype.setPayload = function (b: Uint8Array) {
      this.payloadBytes = b;
    };
    MockProxyCommandRequest.prototype.putHeaders = function () {};

    function MockListInstancesRequest() {}

    function MockApiServicePromiseClient() {}
    MockApiServicePromiseClient.prototype.listInstances = function () {
      return Promise.resolve({ getInstancesList: () => [] });
    };
    MockApiServicePromiseClient.prototype.proxyCommand = function (req: any) {
      const jsonBody = req.payloadBytes
        ? new TextDecoder('utf-8').decode(req.payloadBytes)
        : '';
      proxyCommandCalls.push({
        targetUuid: req.targetUuid,
        rpcPath: req.rpcPath,
        jsonBody,
      });
      if (req.rpcPath.includes('/StartCascade')) {
        if (!nextStartCascadeResponse) {
          return Promise.reject(new Error('StartCascade RPC failed'));
        }
        const encoded = new TextEncoder().encode(
          JSON.stringify(nextStartCascadeResponse),
        );
        return Promise.resolve({
          getPayload_asU8: () => encoded,
        });
      }
      return Promise.resolve({
        getPayload_asU8: () => new TextEncoder().encode('{}'),
      });
    };

    const windowObj: any = {
      location: locationObj,
      navigator: { onLine: true },
      default_GoogleAntigravity: {
        K: {
          devtools_jetski_boq_api_proto: {
            ApiServicePromiseClient: MockApiServicePromiseClient,
            ProxyCommandRequest: MockProxyCommandRequest,
            ListInstancesRequest: MockListInstancesRequest,
          },
        },
      },
      history: {
        replaceState: (_state: any, _title: string, nextUrl: string) => {
          const parsed = new URL(nextUrl, locationObj.origin);
          locationObj.pathname = parsed.pathname;
          locationObj.search = parsed.search;
          locationObj.href = parsed.toString();
        },
      },
      addEventListener: (name: string, fn: (evt: any) => void) => {
        if (name === 'message') {
          windowMessageListeners.push(fn);
        }
      },
      ReactNativeWebView: {
        postMessage: (raw: string) => {
          postedNativeMessages.push(JSON.parse(raw));
        },
      },
    };

    const documentObj: any = {
      cookie: 'SID=12345',
      visibilityState: 'visible',
      documentElement: null,
      body: null,
      querySelectorAll: (selector: string) =>
        selector === 'iframe' ? [hubIframe] : [],
    };

    const sandbox = vm.createContext({
      window: windowObj,
      document: documentObj,
      navigator: windowObj.navigator,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      URL,
      URLSearchParams,
      Promise,
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    });

    vm.runInContext(INBOX_BRIDGE_SCRIPT, sandbox);
    postedNativeMessages.length = 0;
    proxyCommandCalls.length = 0;

    // 1. Successful StartCascade with workspaceUri + projectId sends UUID cascadeId, source, projectEnvConfig & navigates iframe
    await windowObj.__agyInboxBridge.startProjectChat(
      'req-success',
      'box-1',
      'file:///home/dev/antigravity-remote',
      'https://antigravity.google.com/r/box-1',
      'proj-remote-1',
    );

    const startCall = proxyCommandCalls.find((r) =>
      r.rpcPath.includes('/StartCascade'),
    );
    expect(startCall).toBeDefined();
    expect(startCall!.targetUuid).toBe('box-1');
    const parsedStartBody = JSON.parse(startCall!.jsonBody);
    expect(parsedStartBody.cascadeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(parsedStartBody.source).toBe(
      'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
    );
    // StartCascadeRequest carries projectId exclusively inside projectEnvConfig
    // (never as an unknown top-level field).
    expect(parsedStartBody).not.toHaveProperty('projectId');
    expect(parsedStartBody.projectEnvConfig).toEqual({
      projectId: 'proj-remote-1',
      defaultProjectEnvironment: {},
    });
    expect(iframeMessages).toEqual([
      {
        payload: {
          jspbPayload: JSON.stringify([
            null,
            ['/c/new-cascade-77?project=proj-remote-1'],
          ]),
        },
        origin: 'https://antigravity.static.usercontent.goog',
      },
      {
        payload: { jspbPayload: JSON.stringify([null, null, []]) },
        origin: 'https://antigravity.static.usercontent.goog',
      },
    ]);
    expect(postedNativeMessages).toContainEqual({
      type: 'AGY_INBOX_START_CHAT_RESULT',
      requestId: 'req-success',
      handled: true,
      cascadeId: 'new-cascade-77',
      targetUrl:
        'https://antigravity.google.com/r/box-1?p=c%2Fnew-cascade-77',
    });

    // 2. Fallback to project-scoped overview (`/?project=<id>`) when StartCascade fails
    iframeMessages.length = 0;
    postedNativeMessages.length = 0;
    nextStartCascadeResponse = null;

    await windowObj.__agyInboxBridge.startProjectChat(
      'req-fallback',
      'box-1',
      null,
      'https://antigravity.google.com/r/box-1',
      'proj-remote-1',
    );

    expect(iframeMessages).toEqual([
      {
        payload: {
          jspbPayload: JSON.stringify([null, ['/?project=proj-remote-1']]),
        },
        origin: 'https://antigravity.static.usercontent.goog',
      },
      {
        payload: { jspbPayload: JSON.stringify([null, null, []]) },
        origin: 'https://antigravity.static.usercontent.goog',
      },
    ]);
    expect(postedNativeMessages).toContainEqual({
      type: 'AGY_INBOX_START_CHAT_RESULT',
      requestId: 'req-fallback',
      handled: true,
      cascadeId: null,
      targetUrl: 'https://antigravity.google.com/r/box-1',
    });
  });

  it('lists ALL non-archived server projects from ListProjects/ReadProjects even with zero recent activity', () => {
    const rawMessage = parseInboxBridgeMessage(
      JSON.stringify({
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_300_000_000,
        activeUrl: 'https://antigravity.google.com/r/box-1',
        activeInstanceUuid: 'box-1',
        activeCascadeId: null,
        instances: [
          {
            uuid: 'box-1',
            name: 'Dev Workstation',
            status: 1,
            homeDirUri: 'file:///home/marcus',
            trajectories: {
              'thread-1': {
                summary: 'Fix auth redirect',
                status: 1,
                lastModifiedTime: '2026-11-05T10:00:00Z',
                lastUserViewTime: '2026-11-05T10:01:00Z',
                trajectoryMetadata: { projectId: 'proj-alpha' },
              },
            },
            projects: [
              {
                id: 'proj-alpha',
                name: 'Alpha App',
                archived: false,
                updatedAt: '2026-11-05T10:00:00Z',
                projectResources: {
                  resources: [
                    { gitFolder: { folderUri: 'file:///home/marcus/alpha' } },
                  ],
                },
                projectConversations: {
                  conversations: [{ conversationId: 'thread-1' }],
                },
              },
              {
                id: 'proj-quiet',
                name: 'Quiet Repo',
                archived: false,
                updatedAt: '2026-10-01T08:00:00Z',
                projectResources: {
                  resources: [{ folderUri: 'file:///home/marcus/quiet-repo' }],
                },
                projectConversations: { conversations: [] },
              },
              {
                id: 'proj-archived',
                name: 'Archived Old Repo',
                archived: true,
                projectResources: {
                  resources: [{ folderUri: 'file:///home/marcus/archived' }],
                },
              },
            ],
            workspaceInfos: [
              { workspaceUri: 'file:///home/marcus/tracked-only' },
            ],
          },
        ],
      }),
    );

    expect(rawMessage?.type).toBe('AGY_INBOX_SNAPSHOT');
    const snapshot = buildInboxSnapshot(
      rawMessage as Extract<InboxBridgeMessage, { type: 'AGY_INBOX_SNAPSHOT' }>,
    );
    const groups = buildProjectGroups(snapshot);

    expect(groups.map((g) => g.name)).toEqual([
      'Alpha App',
      'Quiet Repo',
      'tracked-only',
    ]);
    expect(groups[0]).toMatchObject({
      projectId: 'proj-alpha',
      workspaceUri: 'file:///home/marcus/alpha',
    });
    expect(groups[0].threads.map((t) => t.cascadeId)).toEqual(['thread-1']);
    expect(groups[1]).toMatchObject({
      projectId: 'proj-quiet',
      workspaceUri: 'file:///home/marcus/quiet-repo',
      threads: [],
    });
    expect(groups.find((g) => g.name === 'Archived Old Repo')).toBeUndefined();
  });

  it('executes listDirectory and createProject (existing + scratch) inside VM sandbox', async () => {
    const postedNativeMessages: any[] = [];
    const rpcCalls: Array<{ rpcPath: string; body: any }> = [];

    class MockProxyCommandRequest {
      rpcPath = '';
      payload: Uint8Array = new Uint8Array();
      setTargetInstanceUuid() {}
      setRpcPath(path: string) {
        this.rpcPath = path;
      }
      setPayload(bytes: Uint8Array) {
        this.payload = bytes;
      }
      putHeaders() {}
    }
    class MockListInstancesRequest {}
    class MockApiServicePromiseClient {
      listInstances() {
        return Promise.resolve({ getInstancesList: () => [] });
      }
      proxyCommand(req: MockProxyCommandRequest) {
        const body = JSON.parse(new TextDecoder().decode(req.payload));
        rpcCalls.push({ rpcPath: req.rpcPath, body });
        if (req.rpcPath.includes('/GetDefaultProjectDir')) {
          return Promise.resolve({
            getPayload_asU8: () =>
              new TextEncoder().encode(
                JSON.stringify({
                  defaultProjectDirUri: 'file:///home/marcus/projects',
                }),
              ),
          });
        }
        if (req.rpcPath.includes('/ReadDir')) {
          return Promise.resolve({
            getPayload_asU8: () =>
              new TextEncoder().encode(
                JSON.stringify({
                  entries: [
                    {
                      uri: 'file:///home/marcus/projects/zeta',
                      fileType: 'FILE_TYPE_DIRECTORY',
                    },
                    {
                      uri: 'file:///home/marcus/projects/README.md',
                      fileType: 'FILE_TYPE_FILE',
                    },
                    {
                      uri: 'file:///home/marcus/projects/alpha',
                      fileType: 2,
                    },
                  ],
                }),
              ),
          });
        }
        if (req.rpcPath.includes('/ResolveFolder')) {
          return Promise.resolve({
            getPayload_asU8: () =>
              new TextEncoder().encode(
                JSON.stringify({ resourceType: 2 }),
              ),
          });
        }
        if (req.rpcPath.includes('/GetWorkspaceInfos')) {
          return Promise.resolve({
            getPayload_asU8: () =>
              new TextEncoder().encode(
                JSON.stringify({
                  homeDirUri: 'file:///home/marcus',
                  workspaceInfos: [],
                }),
              ),
          });
        }
        if (req.rpcPath.includes('/CreateScratchProjectFolder')) {
          return Promise.resolve({
            getPayload_asU8: () =>
              new TextEncoder().encode(
                JSON.stringify({
                  folderUri: 'file:///home/marcus/projects/brand-new',
                  isGitRepo: false,
                }),
              ),
          });
        }
        if (req.rpcPath.includes('/CreateProject')) {
          return Promise.resolve({
            getPayload_asU8: () =>
              new TextEncoder().encode(
                JSON.stringify({
                  project: {
                    id: body.project?.id || 'created-proj-1',
                    name: body.project?.name || 'Created',
                  },
                }),
              ),
          });
        }
        return Promise.resolve({
          getPayload_asU8: () => new TextEncoder().encode('{}'),
        });
      }
    }

    const windowObj: any = {
      location: {
        origin: 'https://antigravity.google.com',
        hostname: 'antigravity.google.com',
        pathname: '/r/box-1',
        search: '',
        href: 'https://antigravity.google.com/r/box-1',
      },
      navigator: { onLine: true },
      default_GoogleAntigravity: {
        K: {
          devtools_jetski_boq_api_proto: {
            ApiServicePromiseClient: MockApiServicePromiseClient,
            ProxyCommandRequest: MockProxyCommandRequest,
            ListInstancesRequest: MockListInstancesRequest,
          },
        },
      },
      history: { replaceState: () => {} },
      addEventListener: () => {},
      ReactNativeWebView: {
        postMessage: (raw: string) => {
          postedNativeMessages.push(JSON.parse(raw));
        },
      },
    };
    const sandbox = vm.createContext({
      window: windowObj,
      document: {
        cookie: 'SID=12345',
        visibilityState: 'visible',
        documentElement: null,
        body: null,
        querySelectorAll: () => [],
      },
      navigator: windowObj.navigator,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      URL,
      URLSearchParams,
      Promise,
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    });

    vm.runInContext(INBOX_BRIDGE_SCRIPT, sandbox);
    postedNativeMessages.length = 0;

    // 1. listDirectory defaults to GetDefaultProjectDir and filters/sorts directories
    await windowObj.__agyInboxBridge.listDirectory('dir-1', 'box-1', null);
    expect(postedNativeMessages).toContainEqual({
      type: 'AGY_INBOX_LIST_DIR_RESULT',
      requestId: 'dir-1',
      ok: true,
      currentUri: 'file:///home/marcus/projects',
      parentUri: 'file:///home/marcus',
      entries: [
        { name: 'alpha', uri: 'file:///home/marcus/projects/alpha' },
        { name: 'zeta', uri: 'file:///home/marcus/projects/zeta' },
      ],
      error: null,
    });

    // 2. createProject (existing folder with ~/ tilde path) expands homeDirUri, detects git via resourceType === 2
    postedNativeMessages.length = 0;
    rpcCalls.length = 0;
    await windowObj.__agyInboxBridge.createProject(
      'cp-1',
      'box-1',
      'existing',
      'Alpha Project',
      '~/projects/alpha',
    );
    const createExistingCall = rpcCalls.find((c) =>
      c.rpcPath.includes('/CreateProject'),
    );
    expect(createExistingCall).toBeDefined();
    expect(createExistingCall!.body.project).toMatchObject({
      name: 'Alpha Project',
      isWorkspaceOnly: false,
      projectResources: {
        resources: [
          { gitFolder: { folderUri: 'file:///home/marcus/projects/alpha' } },
        ],
      },
    });
    expect(postedNativeMessages).toContainEqual(
      expect.objectContaining({
        type: 'AGY_INBOX_CREATE_PROJECT_RESULT',
        requestId: 'cp-1',
        ok: true,
        projectName: 'Alpha Project',
        workspaceUri: 'file:///home/marcus/projects/alpha',
      }),
    );

    // 3. createProject (scratch folder) calls CreateScratchProjectFolder + CreateProject
    postedNativeMessages.length = 0;
    rpcCalls.length = 0;
    await windowObj.__agyInboxBridge.createProject(
      'cp-2',
      'box-1',
      'scratch',
      'brand-new',
      null,
    );
    expect(
      rpcCalls.some((c) => c.rpcPath.includes('/CreateScratchProjectFolder')),
    ).toBe(true);
    expect(postedNativeMessages).toContainEqual(
      expect.objectContaining({
        type: 'AGY_INBOX_CREATE_PROJECT_RESULT',
        requestId: 'cp-2',
        ok: true,
        projectName: 'brand-new',
        workspaceUri: 'file:///home/marcus/projects/brand-new',
      }),
    );
  });

  it('builds structured color-coded notification card items with per-thread deep links', () => {
    const sync = buildActionNotificationSyncState({
      stage: 'authenticated',
      mode: 'all_attention',
      isAppForeground: false,
      isDrawerOpen: false,
      previousOpenThreadIds: new Set(),
      threads: [
        {
          id: 'box-1:c-1',
          cascadeId: 'c-1',
          trajectoryId: 'c-1',
          instanceUuid: 'box-1',
          instanceName: 'Mac Studio',
          title: 'Deploy database migration',
          attentionKind: 'approval',
          needsAttention: true,
          attentionReason: 'Approve command: prisma migrate deploy',
          stepCount: 8,
          waitingStepCount: 1,
          lastModifiedAtMs: 1_762_300_000_000,
          lastUserViewAtMs: 1_762_299_000_000,
          workspaceName: 'backend-api',
          workspaceUri: 'file:///home/dev/backend-api',
          childPath: '/c/c-1',
          targetUrl: 'https://antigravity.google.com/r/box-1?p=c%2Fc-1',
          isActiveThread: false,
          isPinned: false,
          hasRunningSubagents: false,
          source: 'remote-control',
        },
        {
          id: 'box-1:c-2',
          cascadeId: 'c-2',
          trajectoryId: 'c-2',
          instanceUuid: 'box-1',
          instanceName: 'Mac Studio',
          title: 'Run unit tests',
          attentionKind: 'unread',
          needsAttention: true,
          attentionReason: 'Finished — unread updates',
          stepCount: 4,
          waitingStepCount: 0,
          lastModifiedAtMs: 1_762_299_500_000,
          lastUserViewAtMs: 1_762_298_000_000,
          workspaceName: 'frontend',
          workspaceUri: 'file:///home/dev/frontend',
          childPath: '/c/c-2',
          targetUrl: 'https://antigravity.google.com/r/box-1?p=c%2Fc-2',
          isActiveThread: false,
          isPinned: false,
          hasRunningSubagents: false,
          source: 'remote-control',
        },
      ],
    });

    expect(sync.notification).not.toBeNull();
    expect(sync.notification!.count).toBe(2);
    expect(sync.notification!.deepLinkUrl).toBe('antigravity-remote://inbox');
    expect(sync.notification!.items).toEqual([
      {
        id: 'box-1:c-1',
        title: 'Deploy database migration',
        attentionKind: 'approval',
        statusLabel: 'NEEDS APPROVAL',
        attentionReason: 'Approve command: prisma migrate deploy',
        subtitle: 'Mac Studio • backend-api',
        deepLinkUrl: 'antigravity-remote://r/box-1?p=c%2Fc-1',
      },
      {
        id: 'box-1:c-2',
        title: 'Run unit tests',
        attentionKind: 'unread',
        statusLabel: 'FINISHED',
        attentionReason: 'Finished — unread updates',
        subtitle: 'Mac Studio • frontend',
        deepLinkUrl: 'antigravity-remote://r/box-1?p=c%2Fc-2',
      },
    ]);
    expect(sync.notification!.expandedBody).toContain('🟠 NEEDS APPROVAL');
    expect(sync.notification!.expandedBody).toContain('🔵 FINISHED');
  });

  it('resolves the active thread project across server projects, workspaces, subagents, URL params, and pending new chats', () => {
    const rawMessage = parseInboxBridgeMessage(
      JSON.stringify({
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_300_000_000,
        activeUrl: 'https://antigravity.google.com/r/box-1?p=c%2Fc-proj-id',
        activeInstanceUuid: 'box-1',
        activeCascadeId: 'c-proj-id',
        instances: [
          {
            uuid: 'box-1',
            name: 'Dev Workstation',
            status: 1,
            projects: [
              {
                id: 'proj-alpha',
                name: 'Alpha Platform',
                projectResources: {
                  resources: [
                    { gitFolder: { folderUri: 'file:///home/dev/alpha-repo' } },
                  ],
                },
                projectConversations: {
                  conversations: [{ conversationId: 'c-by-conv' }],
                },
              },
              {
                id: 'proj-archived',
                name: 'Legacy Archive',
                archived: true,
                projectResources: {
                  resources: [{ folderUri: 'file:///home/dev/legacy' }],
                },
              },
            ],
            trajectories: {
              'c-proj-id': {
                summary: 'Thread matched by projectId',
                trajectoryMetadata: { projectId: 'proj-alpha' },
                workspaces: [
                  { workspaceFolderAbsoluteUri: 'file:///home/dev/alpha-repo' },
                ],
              },
              'c-by-conv': {
                summary: 'Thread matched by conversationIds',
              },
              'c-by-uri': {
                summary: 'Thread matched by workspaceUri',
                workspaces: [
                  { workspaceFolderAbsoluteUri: 'file:///home/dev/alpha-repo/' },
                ],
              },
              'c-archived': {
                summary: 'Thread in archived project',
                trajectoryMetadata: { projectId: 'proj-archived' },
              },
              'c-ws-only': {
                summary: 'Thread with workspace folder only',
                workspaces: [
                  { workspaceFolderAbsoluteUri: 'file:///home/dev/standalone-tool' },
                ],
              },
              'c-unscoped': {
                summary: 'Thread outside of project',
                trajectoryMetadata: { projectId: 'outside-of-project' },
              },
              'c-subagent-1': {
                summary: 'Child subagent',
                killed: true,
                trajectoryMetadata: {
                  parentConversationId: 'c-proj-id',
                },
              },
            },
          },
        ],
        cloudTrajectories: {
          'cloud-1': {
            summary: 'Cloud task',
          },
        },
      }),
    );

    expect(rawMessage?.type).toBe('AGY_INBOX_SNAPSHOT');
    const snapshot = buildInboxSnapshot(
      rawMessage as Extract<InboxBridgeMessage, { type: 'AGY_INBOX_SNAPSHOT' }>,
    );

    // 1. Server project by projectId uses server project name (not raw folder name)
    expect(resolveActiveThreadProject(snapshot)).toEqual({
      instanceUuid: 'box-1',
      cascadeId: 'c-proj-id',
      projectId: 'proj-alpha',
      projectName: 'Alpha Platform',
      instanceName: 'Dev Workstation',
    });

    // 2. Server project by conversationIds
    expect(
      resolveActiveThreadProject({
        ...snapshot,
        activeCascadeId: 'c-by-conv',
      }),
    ).toMatchObject({
      projectId: 'proj-alpha',
      projectName: 'Alpha Platform',
    });

    // 3. Server project by normalized workspaceUri
    expect(
      resolveActiveThreadProject({
        ...snapshot,
        activeCascadeId: 'c-by-uri',
      }),
    ).toMatchObject({
      projectId: 'proj-alpha',
      projectName: 'Alpha Platform',
    });

    // 4. Archived project fallback when thread explicitly belongs to it
    expect(
      resolveActiveThreadProject({
        ...snapshot,
        activeCascadeId: 'c-archived',
      }),
    ).toMatchObject({
      projectId: 'proj-archived',
      projectName: 'Legacy Archive',
    });

    // 5. Workspace-only fallback when no server project matches
    expect(
      resolveActiveThreadProject({
        ...snapshot,
        activeCascadeId: 'c-ws-only',
      }),
    ).toMatchObject({
      projectId: null,
      projectName: 'standalone-tool',
    });

    // 6. Unscoped thread falls back to workstation name
    expect(
      resolveActiveThreadProject({
        ...snapshot,
        activeCascadeId: 'c-unscoped',
      }),
    ).toMatchObject({
      projectId: null,
      projectName: 'Dev Workstation',
    });

    // 7. Cloud thread falls back to Cloud Agent
    expect(
      resolveActiveThreadProject({
        ...snapshot,
        activeInstanceUuid: '__cloud__',
        activeCascadeId: 'cloud-1',
      }),
    ).toMatchObject({
      projectId: null,
      projectName: 'Cloud Agent',
      instanceName: 'Cloud Agent',
    });

    // 8. Subagent child thread resolves parent thread's project even after completion/kill
    expect(
      resolveActiveThreadProject({
        ...snapshot,
        activeCascadeId: 'c-subagent-1',
      }),
    ).toEqual({
      instanceUuid: 'box-1',
      cascadeId: 'c-subagent-1',
      projectId: 'proj-alpha',
      projectName: 'Alpha Platform',
      instanceName: 'Dev Workstation',
    });

    // 9. URL ?project=<id> fallback when brand-new thread isn't in snapshot yet
    expect(
      extractProjectIdFromUrl(
        'https://antigravity.google.com/r/box-1?p=c%2Fc-brand-new%3Fproject%3Dproj-alpha',
      ),
    ).toBe('proj-alpha');
    expect(
      resolveActiveThreadProject(
        {
          ...snapshot,
          activeCascadeId: 'c-brand-new',
        },
        {
          activeUrl:
            'https://antigravity.google.com/r/box-1?p=c%2Fc-brand-new%3Fproject%3Dproj-alpha',
        },
      ),
    ).toMatchObject({
      cascadeId: 'c-brand-new',
      projectId: 'proj-alpha',
      projectName: 'Alpha Platform',
    });

    // 10. Pending new-chat fallback before server snapshot includes thread
    expect(
      resolveActiveThreadProject(
        {
          ...snapshot,
          activeCascadeId: 'c-new-pending',
        },
        {
          fallbackProject: {
            instanceUuid: 'box-1',
            cascadeId: 'c-new-pending',
            projectId: 'proj-alpha',
            projectName: 'Alpha Platform',
          },
        },
      ),
    ).toMatchObject({
      cascadeId: 'c-new-pending',
      projectId: 'proj-alpha',
      projectName: 'Alpha Platform',
    });

    // 11. Non-thread overview route returns null
    expect(
      resolveActiveThreadProject({
        ...snapshot,
        activeCascadeId: null,
      }),
    ).toBeNull();
  });

  it('forwards active thread project context from INBOX_BRIDGE_SCRIPT to verified workstation iframe and answers pull requests', () => {
    const iframePosts: Array<{ msg: any; origin: string }> = [];
    const messageListeners: Array<(evt: any) => void> = [];
    const sameOriginScrollContexts: any[] = [];

    const hubFrame = {
      src: 'https://antigravity.static.usercontent.goog/web/2.33.0/?iframe=true',
      getAttribute: (k: string) =>
        k === 'src'
          ? 'https://antigravity.static.usercontent.goog/web/2.33.0/?iframe=true'
          : null,
      contentWindow: {
        postMessage: (msg: any, origin: string) => {
          iframePosts.push({ msg, origin });
        },
      },
      style: {
        setProperty: () => {},
        removeProperty: () => {},
        getPropertyValue: () => '',
        getPropertyPriority: () => '',
      },
      parentElement: null as any,
    };

    const windowObj: any = {
      location: {
        origin: 'https://antigravity.google.com',
        hostname: 'antigravity.google.com',
        pathname: '/r/box-1',
        search: '?p=c%2Fthread-1',
        href: 'https://antigravity.google.com/r/box-1?p=c%2Fthread-1',
      },
      navigator: { onLine: true },
      history: { replaceState: () => {} },
      addEventListener: (type: string, fn: (evt: any) => void) => {
        if (type === 'message') {
          messageListeners.push(fn);
        }
      },
      ReactNativeWebView: { postMessage: () => {} },
      __agyOverviewScrollBridge: {
        setThreadContext: (ctx: any) => {
          sameOriginScrollContexts.push(ctx);
        },
      },
    };

    const sandbox = vm.createContext({
      window: windowObj,
      document: {
        cookie: '',
        visibilityState: 'visible',
        documentElement: null,
        body: null,
        querySelectorAll: (sel: string) => (sel === 'iframe' ? [hubFrame] : []),
      },
      navigator: windowObj.navigator,
      URL,
      URLSearchParams,
      Promise,
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    });

    vm.runInContext(INBOX_BRIDGE_SCRIPT, sandbox);
    iframePosts.length = 0;
    sameOriginScrollContexts.length = 0;

    // Push context via buildSyncThreadContextScript
    const syncScript = buildSyncThreadContextScript({
      instanceUuid: 'box-1',
      cascadeId: 'thread-1',
      projectId: 'proj-alpha',
      projectName: 'Alpha Platform',
      instanceName: 'Dev Workstation',
    });
    vm.runInContext(syncScript, sandbox);

    expect(iframePosts).toHaveLength(1);
    expect(iframePosts[0]).toEqual({
      origin: 'https://antigravity.static.usercontent.goog',
      msg: {
        type: 'AGY_REMOTE_THREAD_CONTEXT',
        context: {
          instanceUuid: 'box-1',
          cascadeId: 'thread-1',
          projectId: 'proj-alpha',
          projectName: 'Alpha Platform',
          instanceName: 'Dev Workstation',
        },
      },
    });
    expect(sameOriginScrollContexts).toHaveLength(1);
    expect(sameOriginScrollContexts[0]).toMatchObject({
      cascadeId: 'thread-1',
      projectName: 'Alpha Platform',
    });

    // Iframe requesting thread context receives cached context; untrusted origin is ignored
    iframePosts.length = 0;
    for (const fn of messageListeners) {
      fn({
        origin: 'https://evil.example',
        data: { type: 'AGY_REMOTE_REQUEST_THREAD_CONTEXT', cascadeId: 'thread-1' },
      });
    }
    expect(iframePosts).toHaveLength(0);

    for (const fn of messageListeners) {
      fn({
        origin: 'https://antigravity.static.usercontent.goog',
        data: { type: 'AGY_REMOTE_REQUEST_THREAD_CONTEXT', cascadeId: 'thread-1' },
      });
    }
    expect(iframePosts).toHaveLength(1);
    expect(iframePosts[0].msg.context.projectName).toBe('Alpha Platform');

    // Clearing context sends null
    iframePosts.length = 0;
    vm.runInContext(buildSyncThreadContextScript(null), sandbox);
    expect(iframePosts).toEqual([
      {
        origin: 'https://antigravity.static.usercontent.goog',
        msg: {
          type: 'AGY_REMOTE_THREAD_CONTEXT',
          context: null,
        },
      },
    ]);
  });

  it('keeps threads working (and suppresses completion notifications) while non-daemon background tasks, subagents, nested grandchildren, tool children, or battle forks are still active', () => {
    const knownRunning = new Set<string>();
    const completedUnread: Record<string, number> = {};
    const locallyRead: Record<string, number> = {};

    // 1. Agent starts working with a non-daemon background task -> tracked as running
    const step1 = reconcileRunningThreadTransitions({
      message: {
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_300_000_000,
        activeUrl: 'https://antigravity.google.com/r/box-1',
        activeInstanceUuid: 'box-1',
        activeCascadeId: null,
        instances: [
          {
            uuid: 'box-1',
            name: 'Dev Workstation',
            status: 1,
            backgroundTasks: [
              {
                conversationId: 'bg-cmd-thread',
                task: {
                  taskId: 'task-1',
                  toolName: 'run_command',
                  toolSummary: 'Gradle release build',
                  isDaemon: false,
                },
              },
              {
                conversationId: 'daemon-only-thread',
                task: {
                  taskId: 'task-daemon',
                  toolName: 'run_command',
                  toolSummary: 'Dev server startup',
                  isDaemon: true,
                },
              },
              {
                conversationId: 'mixed-bg-thread',
                task: {
                  taskId: 'task-mixed-daemon',
                  toolSummary: 'Vite dev server',
                  isDaemon: true,
                },
              },
              {
                conversationId: 'mixed-bg-thread',
                task: {
                  taskId: 'task-mixed-test',
                  toolSummary: 'Integration test suite',
                  isDaemon: false,
                },
              },
              {
                conversationId: 'subagent-with-bg',
                task: {
                  taskId: 'task-child-1',
                  toolSummary: 'Database migration',
                  isDaemon: false,
                },
              },
            ],
            trajectories: {
              trajectorySummaries: {
                'bg-cmd-thread': {
                  summary: 'Ship Android build',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  backgroundTaskCount: 1,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                },
                'summary-count-only-thread': {
                  summary: 'Run overnight benchmark',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  backgroundTaskCount: 2,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                },
                'daemon-only-thread': {
                  summary: 'Start local dev server',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  backgroundTaskCount: 1,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                },
                'mixed-bg-thread': {
                  summary: 'Verify live app with tests',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  backgroundTaskCount: 2,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                },
                'false-subagent-flag-thread': {
                  summary: 'Audit auth module',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                },
                'parent-of-subagent-bg': {
                  summary: 'Run migrations via subagent',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                },
                'subagent-with-bg': {
                  summary: 'Migration helper',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  backgroundTaskCount: 1,
                  trajectoryMetadata: {
                    parentConversationId: 'parent-of-subagent-bg',
                  },
                },
                'nested-parent': {
                  summary: 'Refactor monolith',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                },
                'nested-child': {
                  summary: 'Mid-level worker',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  trajectoryMetadata: {
                    parentConversationId: 'nested-parent',
                  },
                },
                'nested-grandchild': {
                  summary: 'Leaf worker',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  trajectoryMetadata: {
                    parentConversationId: 'nested-child',
                    rootConversationId: 'nested-parent',
                  },
                },
                'tool-child-parent': {
                  summary: 'Inspect staging UI',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                },
                'hidden-tool-child': {
                  summary: 'Browser automation sub-trajectory',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                  trajectoryMetadata: {
                    sourceMetadata: {
                      hideFromConversationList: true,
                      tool: {
                        conversationId: 'tool-child-parent',
                      },
                    },
                  },
                },
                'battle-parent': {
                  summary: 'Compare implementations',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  battleModeInfo: {
                    childrenConversationIds: ['battle-fork-1'],
                    endType: 'BATTLE_END_TYPE_UNSPECIFIED',
                  },
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                },
                'battle-fork-1': {
                  summary: 'Fork A',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  trajectoryMetadata: {
                    isBattleModeFork: true,
                  },
                },
                'canceled-run': {
                  summary: 'Aborted migration',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:01:00Z',
                },
              },
            },
          },
        ],
      },
      knownRunningThreadIds: knownRunning,
      completedUnreadAtByThreadId: completedUnread,
      locallyReadAtByThreadId: locallyRead,
      isAppForeground: false,
      isDrawerOpen: false,
    });
    // Hidden tool-spawned trajectories must never be emitted as top-level Inbox threads
    expect(
      step1.threads.find((t) => t.cascadeId === 'hidden-tool-child'),
    ).toBeUndefined();
    expect(step1.threads.every((t) => t.attentionKind === 'running')).toBe(true);

    // 2. Agent turns finish (`status: IDLE`, `notFullyIdle: false`) while background work continues:
    //    - Only `daemon-only-thread` (only an `isDaemon: true` server) should transition to `unread` (`FINISHED`)
    //    - `canceled-run` (`USER_CANCELED`) should become `idle` ('Interrupted'), NOT `unread`
    //    - Every thread with active non-daemon background work or active children MUST remain `running`
    const step2 = reconcileRunningThreadTransitions({
      message: {
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_300_020_000,
        activeUrl: 'https://antigravity.google.com/r/box-1',
        activeInstanceUuid: 'box-1',
        activeCascadeId: null,
        instances: [
          {
            uuid: 'box-1',
            name: 'Dev Workstation',
            status: 1,
            backgroundTasks: [
              {
                conversationId: 'bg-cmd-thread',
                task: {
                  taskId: 'task-1',
                  toolName: 'run_command',
                  toolSummary: 'Gradle release build',
                  isDaemon: false,
                },
              },
              {
                conversationId: 'daemon-only-thread',
                task: {
                  taskId: 'task-daemon',
                  toolName: 'run_command',
                  toolSummary: 'Dev server startup',
                  isDaemon: true,
                },
              },
              {
                conversationId: 'mixed-bg-thread',
                task: {
                  taskId: 'task-mixed-daemon',
                  toolSummary: 'Vite dev server',
                  isDaemon: true,
                },
              },
              {
                conversationId: 'mixed-bg-thread',
                task: {
                  taskId: 'task-mixed-test',
                  toolSummary: 'Integration test suite',
                  isDaemon: false,
                },
              },
              {
                conversationId: 'subagent-with-bg',
                task: {
                  taskId: 'task-child-1',
                  toolSummary: 'Database migration',
                  isDaemon: false,
                },
              },
            ],
            trajectories: {
              trajectorySummaries: {
                'bg-cmd-thread': {
                  summary: 'Ship Android build',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  backgroundTaskCount: 0, // Even if summary count lags, ListBackgroundTasks catches it
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                },
                'summary-count-only-thread': {
                  summary: 'Run overnight benchmark',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  backgroundTaskCount: 2, // Unaccounted by daemon tasks -> still running
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                },
                'daemon-only-thread': {
                  summary: 'Start local dev server',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  backgroundTaskCount: 1, // Matched by isDaemon: true -> finished!
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                },
                'mixed-bg-thread': {
                  summary: 'Verify live app with tests',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  backgroundTaskCount: 2, // 1 daemon + 1 non-daemon -> still running!
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                },
                'false-subagent-flag-thread': {
                  summary: 'Audit auth module',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  hasRunningSubagents: false, // Must NOT short-circuit `hasActiveChildren: true` via `??`
                  hasActiveChildren: true,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                },
                'parent-of-subagent-bg': {
                  summary: 'Run migrations via subagent',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  hasRunningSubagents: false, // Must NOT short-circuit bubbled running subagent
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                },
                'subagent-with-bg': {
                  summary: 'Migration helper',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  backgroundTaskCount: 1,
                  trajectoryMetadata: {
                    parentConversationId: 'parent-of-subagent-bg',
                  },
                },
                'nested-parent': {
                  summary: 'Refactor monolith',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                },
                'nested-child': {
                  summary: 'Mid-level worker',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  trajectoryMetadata: {
                    parentConversationId: 'nested-parent',
                  },
                },
                'nested-grandchild': {
                  summary: 'Leaf worker',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  trajectoryMetadata: {
                    parentConversationId: 'nested-child',
                    rootConversationId: 'nested-parent',
                  },
                },
                'tool-child-parent': {
                  summary: 'Inspect staging UI',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                },
                'hidden-tool-child': {
                  summary: 'Browser automation sub-trajectory',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                  trajectoryMetadata: {
                    sourceMetadata: {
                      hideFromConversationList: true,
                      tool: {
                        conversationId: 'tool-child-parent',
                      },
                    },
                  },
                },
                'battle-parent': {
                  summary: 'Compare implementations',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  battleModeInfo: {
                    childrenConversationIds: ['battle-fork-1'],
                    endType: 'BATTLE_END_TYPE_UNSPECIFIED',
                  },
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                },
                'battle-fork-1': {
                  summary: 'Fork A',
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  notFullyIdle: true,
                  trajectoryMetadata: {
                    isBattleModeFork: true,
                  },
                },
                'canceled-run': {
                  summary: 'Aborted migration',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  latestExecutorTerminationReason:
                    'EXECUTOR_TERMINATION_REASON_USER_CANCELED',
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:02:00Z',
                },
              },
            },
          },
        ],
      },
      knownRunningThreadIds: knownRunning,
      completedUnreadAtByThreadId: completedUnread,
      locallyReadAtByThreadId: locallyRead,
      isAppForeground: false,
      isDrawerOpen: false,
    });

    const byId = (id: string) =>
      step2.threads.find((t) => t.cascadeId === id)!;

    expect(byId('bg-cmd-thread')).toMatchObject({
      attentionKind: 'running',
      needsAttention: false,
      attentionReason: 'Background task: Gradle release build',
      backgroundTaskCount: 1,
    });
    expect(byId('summary-count-only-thread')).toMatchObject({
      attentionKind: 'running',
      needsAttention: false,
      attentionReason: '2 background tasks running…',
      backgroundTaskCount: 2,
    });
    expect(byId('mixed-bg-thread')).toMatchObject({
      attentionKind: 'running',
      needsAttention: false,
      attentionReason: 'Background task: Integration test suite',
      backgroundTaskCount: 1,
    });
    expect(byId('false-subagent-flag-thread')).toMatchObject({
      attentionKind: 'running',
      needsAttention: false,
      hasRunningSubagents: true,
    });
    expect(byId('parent-of-subagent-bg')).toMatchObject({
      attentionKind: 'running',
      needsAttention: false,
      hasRunningSubagents: true,
      backgroundTaskCount: 1,
    });
    expect(byId('nested-parent')).toMatchObject({
      attentionKind: 'running',
      needsAttention: false,
      hasRunningSubagents: true,
    });
    expect(byId('tool-child-parent')).toMatchObject({
      attentionKind: 'running',
      needsAttention: false,
      hasRunningSubagents: true,
    });
    expect(byId('battle-parent')).toMatchObject({
      attentionKind: 'running',
      needsAttention: false,
      hasRunningSubagents: true,
    });
    expect(byId('daemon-only-thread')).toMatchObject({
      attentionKind: 'unread',
      needsAttention: true,
      attentionReason: 'Agent finished — unread updates',
      backgroundTaskCount: 0,
    });
    expect(byId('canceled-run')).toMatchObject({
      attentionKind: 'idle',
      needsAttention: false,
      attentionReason: 'Interrupted',
    });

    // Only `daemon-only-thread` produces an OS notification; none of the background-working threads alert!
    const notifSync = buildActionNotificationSyncState({
      stage: 'authenticated',
      mode: 'all_attention',
      threads: step2.threads,
      isAppForeground: false,
      isDrawerOpen: false,
      previousOpenThreadIds: new Set(),
    });
    expect(notifSync.notification).toMatchObject({
      count: 1,
      deepLinkUrl: 'antigravity-remote://r/box-1?p=c%2Fdaemon-only-thread',
      shouldAlert: true,
    });

    // 3. Once the non-daemon background task on `bg-cmd-thread` completes and the agent finishes,
    //    `bg-cmd-thread` cleanly transitions to `unread` (`FINISHED`) and fires its notification!
    const step3 = reconcileRunningThreadTransitions({
      message: {
        type: 'AGY_INBOX_SNAPSHOT',
        fetchedAtMs: 1_762_300_040_000,
        activeUrl: 'https://antigravity.google.com/r/box-1',
        activeInstanceUuid: 'box-1',
        activeCascadeId: null,
        instances: [
          {
            uuid: 'box-1',
            name: 'Dev Workstation',
            status: 1,
            backgroundTasks: [],
            trajectories: {
              trajectorySummaries: {
                'bg-cmd-thread': {
                  summary: 'Ship Android build',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  backgroundTaskCount: 0,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:03:00Z',
                },
                'hidden-tool-child': {
                  summary: 'Browser automation sub-trajectory',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  notFullyIdle: false,
                  lastUserInputTime: '2026-11-20T18:00:00Z',
                  lastModifiedTime: '2026-11-20T18:03:00Z',
                  trajectoryMetadata: {
                    sourceMetadata: {
                      hideFromConversationList: true,
                      tool: {
                        conversationId: 'tool-child-parent',
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      knownRunningThreadIds: knownRunning,
      completedUnreadAtByThreadId: completedUnread,
      locallyReadAtByThreadId: locallyRead,
      isAppForeground: false,
      isDrawerOpen: false,
    });
    expect(step3.threads).toHaveLength(1);
    expect(step3.threads[0]).toMatchObject({
      cascadeId: 'bg-cmd-thread',
      attentionKind: 'unread',
      needsAttention: true,
      attentionReason: 'Agent finished — unread updates',
      backgroundTaskCount: 0,
    });
  });

  it('queries ListBackgroundTasks in INBOX_BRIDGE_SCRIPT, compacts tasks, handles empty/unimplemented responses, and validates backgroundTasks in parseInboxBridgeMessage', async () => {
    const postedToNative: any[] = [];
    const bgRpcCalls: string[] = [];
    let bgMode: 'populated' | 'empty' | 'unimplemented' = 'populated';

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
              getUuid: () => 'box-bg',
              getStatus: () => 1,
              getMetadata: () => ({
                getName: () => 'Build Server',
                getVersion: () => '2.33.0',
              }),
              getStatusLastUpdatedAt: () => ({ getSeconds: () => 1762300000 }),
            },
          ],
        });
      }
      proxyCommand(req: MockProxyCommandRequest) {
        let body: Record<string, unknown> = {};
        if (req.rpcPath.endsWith('/GetAllCascadeTrajectories')) {
          body = {
            trajectorySummaries: {
              'thread-build': {
                summary: 'Compile release',
                status: 'CASCADE_RUN_STATUS_IDLE',
                notFullyIdle: false,
                backgroundTaskCount: 1,
                lastUserInputTime: '2026-11-20T18:00:00Z',
                lastModifiedTime: '2026-11-20T18:01:00Z',
              },
            },
          };
        } else if (req.rpcPath.endsWith('/ListBackgroundTasks')) {
          bgRpcCalls.push(req.uuid);
          if (bgMode === 'populated') {
            body = {
              tasks: [
                {
                  conversationId: 'thread-build',
                  task: {
                    taskId: 'task-42',
                    toolName: 'run_command',
                    toolSummary: 'Gradle assembleRelease',
                    isDaemon: false,
                  },
                },
                {
                  conversationId: 'bad id with spaces!',
                  task: { taskId: 'ignored' },
                },
              ],
            };
          } else if (bgMode === 'empty') {
            body = {};
          } else {
            body = {
              code: 'unimplemented',
              message: 'Method ListBackgroundTasks not implemented',
            };
          }
        }
        const encoded = new TextEncoder().encode(JSON.stringify(body));
        return Promise.resolve({ getPayload_asU8: () => encoded });
      }
    }

    const sandboxWindow: any = {
      location: {
        hostname: 'antigravity.google.com',
        origin: 'https://antigravity.google.com',
        pathname: '/r/box-bg',
        search: '',
        href: 'https://antigravity.google.com/r/box-bg',
      },
      history: { state: null, replaceState: () => {} },
      navigator: { onLine: true },
      document: {
        cookie: 'SAPISID=test',
        visibilityState: 'hidden',
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
        postMessage: (raw: string) => postedToNative.push(raw),
      },
      addEventListener: () => {},
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    };
    sandboxWindow.window = sandboxWindow;

    const context = vm.createContext(sandboxWindow);
    vm.runInContext(INBOX_BRIDGE_SCRIPT, context);

    // 1. Populated ListBackgroundTasks response (even while hidden)
    await sandboxWindow.__agyInboxBridge.refresh(false);
    expect(bgRpcCalls).toHaveLength(1);
    const parsed1 = parseInboxBridgeMessage(postedToNative[0]);
    expect(parsed1?.type).toBe('AGY_INBOX_SNAPSHOT');
    if (parsed1?.type !== 'AGY_INBOX_SNAPSHOT') return;
    expect(parsed1.instances[0].backgroundTasks).toEqual([
      {
        conversationId: 'thread-build',
        task: {
          taskId: 'task-42',
          toolName: 'run_command',
          toolSummary: 'Gradle assembleRelease',
          isDaemon: false,
        },
      },
    ]);
    const snap1 = buildInboxSnapshot(parsed1);
    expect(snap1.threads[0]).toMatchObject({
      cascadeId: 'thread-build',
      attentionKind: 'running',
      needsAttention: false,
      attentionReason: 'Background task: Gradle assembleRelease',
      backgroundTaskCount: 1,
    });

    // 2. Empty proto3 `{}` response maps to `[]`
    bgMode = 'empty';
    postedToNative.length = 0;
    await sandboxWindow.__agyInboxBridge.refresh(false);
    const parsed2 = parseInboxBridgeMessage(postedToNative[0]);
    expect(parsed2?.type).toBe('AGY_INBOX_SNAPSHOT');
    if (parsed2?.type !== 'AGY_INBOX_SNAPSHOT') return;
    expect(parsed2.instances[0].backgroundTasks).toEqual([]);

    // 3. Unimplemented response maps to `null` and caches unsupported for that server version
    bgMode = 'unimplemented';
    postedToNative.length = 0;
    await sandboxWindow.__agyInboxBridge.refresh(false);
    expect(bgRpcCalls).toHaveLength(3);
    const parsed3 = parseInboxBridgeMessage(postedToNative[0]);
    expect(parsed3?.type).toBe('AGY_INBOX_SNAPSHOT');
    if (parsed3?.type !== 'AGY_INBOX_SNAPSHOT') return;
    expect(parsed3.instances[0].backgroundTasks).toBeNull();
    // Still falls back safely to `summary.backgroundTaskCount: 1`!
    const snap3 = buildInboxSnapshot(parsed3);
    expect(snap3.threads[0]).toMatchObject({
      cascadeId: 'thread-build',
      attentionKind: 'running',
      needsAttention: false,
      backgroundTaskCount: 1,
    });

    // Subsequent poll on same version skips the unsupported RPC
    postedToNative.length = 0;
    await sandboxWindow.__agyInboxBridge.refresh(false);
    expect(bgRpcCalls).toHaveLength(3);
  });
});
