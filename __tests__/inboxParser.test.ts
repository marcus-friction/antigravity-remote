import vm from 'node:vm';
import {
  INBOX_BRIDGE_SCRIPT,
  buildFastThreadSwitchScript,
  buildMarkThreadReadScript,
} from '../src/services/inboxBridge';
import {
  applyLocalStateToSnapshot,
  buildInboxSnapshot,
  describeWaitingSteps,
  extractActiveRouteFromUrl,
  extractWorkspaceName,
  formatRelativeTime,
  parseInboxBridgeMessage,
  parseProtoTimestampMs,
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
  });
});
