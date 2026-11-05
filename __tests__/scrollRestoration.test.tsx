const mockInstallDocStartScript = jest.fn(async (_script: string) => undefined);
const mockInstallNativeExpoFn = jest.fn(async (_script: string) => undefined);
const mockWebViewGoBack = jest.fn();
const mockWebViewInjectJavaScript = jest.fn();
const mockScrollTo = jest.fn();
const mockBackPressListeners = new Set<() => boolean>();

jest.mock('expo', () => ({
  requireNativeModule: jest.fn(() => ({
    installDocumentStartScript: (script: string) =>
      mockInstallNativeExpoFn(script),
  })),
}));

jest.mock('../src/services/webData', () => ({
  clearWebData: jest.fn(async () => undefined),
  configureNativeKeepAlive: jest.fn(async () => undefined),
  installNativeDocumentStartScript: (script: string) =>
    mockInstallDocStartScript(script),
  syncNativeActionNotification: jest.fn(async () => undefined),
  clearNativeActionNotification: jest.fn(async () => undefined),
  requestNativeNotificationPermission: jest.fn(async () => false),
}));

jest.mock('react-native', () => {
  const ReactLib = require('react');
  const mockComp = (name: string) =>
    ReactLib.forwardRef((props: any, ref: any) =>
      ReactLib.createElement(name, { ...props, ref }, props.children),
    );
  class MockAnimatedValue {
    _value: number;
    constructor(v: number) {
      this._value = v;
    }
    setValue(v: number) {
      this._value = v;
    }
    stopAnimation(cb?: (v: number) => void) {
      cb?.(this._value);
    }
    interpolate() {
      return 1;
    }
  }
  const ScrollViewMock = ReactLib.forwardRef((props: any, ref: any) => {
    ReactLib.useImperativeHandle(ref, () => ({
      scrollTo: mockScrollTo,
    }));
    return ReactLib.createElement('ScrollView', props, props.children);
  });
  return {
    Platform: { OS: 'android', Version: 35 },
    PermissionsAndroid: {
      check: jest.fn(async () => true),
      request: jest.fn(async () => 'granted'),
    },
    StyleSheet: {
      create: (s: any) => s,
      hairlineWidth: 1,
      absoluteFillObject: {},
    },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    Animated: {
      Value: MockAnimatedValue,
      View: mockComp('Animated.View'),
      timing: (val: any, cfg: any) => ({
        start: (cb?: (r: { finished: boolean }) => void) => {
          val?.setValue?.(cfg?.toValue ?? 0);
          cb?.({ finished: true });
        },
      }),
      spring: (val: any, cfg: any) => ({
        start: (cb?: (r: { finished: boolean }) => void) => {
          val?.setValue?.(cfg?.toValue ?? 0);
          cb?.({ finished: true });
        },
      }),
    },
    PanResponder: { create: (h: any) => ({ panHandlers: h }) },
    View: mockComp('View'),
    ScrollView: ScrollViewMock,
    Text: mockComp('Text'),
    TextInput: mockComp('TextInput'),
    TouchableOpacity: mockComp('TouchableOpacity'),
    Pressable: mockComp('Pressable'),
    ActivityIndicator: mockComp('ActivityIndicator'),
    AppState: {
      addEventListener: jest.fn(() => ({ remove: () => {} })),
    },
    Keyboard: {
      addListener: jest.fn(() => ({ remove: () => {} })),
    },
    BackHandler: {
      addEventListener: jest.fn((_ev: string, handler: () => boolean) => {
        mockBackPressListeners.add(handler);
        return { remove: () => mockBackPressListeners.delete(handler) };
      }),
    },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const ReactLib = require('react');
  return {
    SafeAreaProvider: ({ children }: any) =>
      ReactLib.createElement('SafeAreaProvider', null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('expo-linking', () => ({
  openURL: jest.fn(async () => true),
}));

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  setItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async (key: string) =>
    key === 'agy_last_active_url_v1'
      ? 'https://antigravity.google.com/r/machine-1'
      : null,
  ),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('@preeternal/react-native-cookie-manager', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async () => ({
      SID: { name: 'SID', value: 'sid-1', domain: '.google.com', path: '/' },
    })),
    set: jest.fn(async () => true),
    clearAll: jest.fn(async () => true),
    flush: jest.fn(async () => undefined),
  },
}));

jest.mock('react-native-webview', () => {
  const ReactLib = require('react');
  const WebView = ReactLib.forwardRef((props: any, ref: any) => {
    ReactLib.useImperativeHandle(ref, () => ({
      reload: jest.fn(),
      goBack: mockWebViewGoBack,
      clearCache: jest.fn(),
      injectJavaScript: mockWebViewInjectJavaScript,
      stopLoading: jest.fn(),
    }));
    return ReactLib.createElement('WebView', props);
  });
  return { WebView };
});

import vm from 'node:vm';
import React from 'react';
import renderer, { act, ReactTestRenderer } from 'react-test-renderer';
import { RemoteWebView } from '../src/components/RemoteWebView';
import {
  PROJECT_OVERVIEW_SCROLL_SCRIPT,
  buildReturnToOverviewScript,
} from '../src/services/scrollRestorationBridge';

interface MockElement {
  nodeType: number;
  tagName: string;
  className: string;
  attributes: Record<string, string>;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  isConnected: boolean;
  parentElement: MockElement | null;
  children: MockElement[];
  firstElementChild: MockElement | null;
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => MockElement | null;
  dispatchEvent: (event: { type: string }) => boolean;
  listeners: Record<string, Array<(event: any) => void>>;
  addEventListener: (type: string, cb: (event: any) => void) => void;
}

function createMockElement(opts: {
  tagName?: string;
  className?: string;
  attributes?: Record<string, string>;
  scrollTop?: number;
  clientHeight?: number;
  scrollHeight?: number;
  isConnected?: boolean;
}): MockElement {
  const listeners: Record<string, Array<(event: any) => void>> = {};
  const el: MockElement = {
    nodeType: 1,
    tagName: (opts.tagName ?? 'DIV').toUpperCase(),
    className: opts.className ?? '',
    attributes: { ...(opts.attributes ?? {}) },
    scrollTop: opts.scrollTop ?? 0,
    clientHeight: opts.clientHeight ?? 720,
    scrollHeight: opts.scrollHeight ?? 3600,
    isConnected: opts.isConnected ?? true,
    parentElement: null,
    children: [],
    firstElementChild: null,
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(el.attributes, name)
        ? el.attributes[name]
        : null;
    },
    closest() {
      return null;
    },
    listeners,
    addEventListener(type: string, cb: (event: any) => void) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(cb);
    },
    dispatchEvent(event: { type: string }) {
      for (const cb of listeners[event.type] ?? []) {
        cb({ ...event, target: el });
      }
      return true;
    },
  };
  return el;
}

function createScrollHarness(initialUrl: string, options?: {
  sharedSessionStore?: Map<string, string>;
  deferDocumentElement?: boolean;
}) {
  let currentUrl = new URL(initialUrl);
  const sessionStore = options?.sharedSessionStore ?? new Map<string, string>();
  const winListeners: Record<string, Array<(e?: any) => void>> = {};
  const docListeners: Record<string, Array<(e?: any) => void>> = {};
  const navListeners: Record<string, Array<(e?: any) => void>> = {};
  const rafQueue: Array<() => void> = [];
  const mutationCallbacks: Array<() => void> = [];
  const resizeCallbacks: Array<() => void> = [];
  let nowMs = 1_000;
  let primaryContainer: MockElement | null = null;
  let outerContainer: MockElement | null = null;

  const docRoot = createMockElement({
    tagName: 'HTML',
    clientHeight: 800,
    scrollHeight: 800,
  });
  const docBody = createMockElement({
    tagName: 'BODY',
    clientHeight: 800,
    scrollHeight: 800,
  });

  const locationProxy = {
    get href() {
      return currentUrl.href;
    },
    get protocol() {
      return currentUrl.protocol;
    },
    get hostname() {
      return currentUrl.hostname;
    },
    get pathname() {
      return currentUrl.pathname;
    },
    get search() {
      return currentUrl.search;
    },
  };

  let documentElementReady = !options?.deferDocumentElement;

  const documentMock: any = {
    get documentElement() {
      return documentElementReady ? docRoot : null;
    },
    get body() {
      return documentElementReady ? docBody : null;
    },
    get scrollingElement() {
      return documentElementReady ? docRoot : null;
    },
    addEventListener(type: string, cb: (e?: any) => void) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(cb);
    },
    removeEventListener(type: string, cb: (e?: any) => void) {
      docListeners[type] = (docListeners[type] ?? []).filter((x) => x !== cb);
    },
    querySelector(selector: string) {
      if (!primaryContainer || !primaryContainer.isConnected) return null;
      const testId = primaryContainer.getAttribute('data-testid');
      const isSidebarAttr =
        primaryContainer.getAttribute('data-sidebar-scroll-container') === 'true';
      if (
        (testId === 'conversation-list-sidebar' &&
          selector.includes('conversation-list-sidebar')) ||
        (testId === 'conversation-list-history' &&
          selector.includes('conversation-list-history')) ||
        (isSidebarAttr && selector.includes('data-sidebar-scroll-container'))
      ) {
        return primaryContainer;
      }
      return null;
    },
    querySelectorAll() {
      const currentOuter: MockElement | null = outerContainer;
      return currentOuter && currentOuter.isConnected ? [currentOuter] : [];
    },
  };

  class MockMutationObserver {
    private cb: () => void;
    private active = false;
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe() {
      if (!this.active) {
        this.active = true;
        mutationCallbacks.push(this.cb);
      }
    }
    disconnect() {
      this.active = false;
      const idx = mutationCallbacks.indexOf(this.cb);
      if (idx >= 0) mutationCallbacks.splice(idx, 1);
    }
  }

  class MockResizeObserver {
    private cb: () => void;
    private active = false;
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe() {
      if (!this.active) {
        this.active = true;
        resizeCallbacks.push(this.cb);
      }
    }
    disconnect() {
      this.active = false;
      const idx = resizeCallbacks.indexOf(this.cb);
      if (idx >= 0) resizeCallbacks.splice(idx, 1);
    }
  }

  const historyMock: any = {
    length: 1,
    pushState(_state: any, _title: string, nextUrl: string) {
      currentUrl = new URL(nextUrl, currentUrl.href);
      historyMock.length += 1;
      for (const cb of navListeners.currententrychange ?? []) cb();
    },
    replaceState(_state: any, _title: string, nextUrl: string) {
      currentUrl = new URL(nextUrl, currentUrl.href);
      for (const cb of navListeners.currententrychange ?? []) cb();
    },
  };

  const windowMock: any = {
    location: locationProxy,
    document: documentMock,
    history: historyMock,
    scrollY: 0,
    scrollTo(_x: number, y: number) {
      windowMock.scrollY = y;
      docRoot.scrollTop = y;
    },
    sessionStorage: {
      getItem: (k: string) => sessionStore.get(k) ?? null,
      setItem: (k: string, v: string) => {
        sessionStore.set(k, String(v));
      },
      removeItem: (k: string) => {
        sessionStore.delete(k);
      },
      clear: () => sessionStore.clear(),
    },
    navigation: {
      addEventListener(type: string, cb: (e?: any) => void) {
        if (!navListeners[type]) navListeners[type] = [];
        navListeners[type].push(cb);
      },
    },
    MutationObserver: MockMutationObserver,
    ResizeObserver: MockResizeObserver,
    Event: class MockEvent {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    getComputedStyle(el: MockElement) {
      return {
        overflowY: el.className.includes('overflow-y-auto') ? 'auto' : 'visible',
      };
    },
    addEventListener(type: string, cb: (e?: any) => void) {
      if (!winListeners[type]) winListeners[type] = [];
      winListeners[type].push(cb);
    },
    removeEventListener(type: string, cb: (e?: any) => void) {
      winListeners[type] = (winListeners[type] ?? []).filter((x) => x !== cb);
    },
    requestAnimationFrame(cb: () => void) {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    cancelAnimationFrame() {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  };

  const DateMock: any = {
    now: () => nowMs,
  };

  const sandbox = {
    window: windowMock,
    document: documentMock,
    location: locationProxy,
    history: historyMock,
    Event: windowMock.Event,
    URL,
    URLSearchParams,
    Date: DateMock,
    Math,
    JSON,
    Object,
    String,
    Boolean,
    isFinite,
    setTimeout: windowMock.setTimeout,
    clearTimeout: windowMock.clearTimeout,
  };

  function runScript() {
    vm.runInNewContext(PROJECT_OVERVIEW_SCROLL_SCRIPT, sandbox);
  }

  function mountOverviewList(opts?: {
    testId?: string;
    scrollHeight?: number;
    clientHeight?: number;
  }) {
    documentElementReady = true;
    const innerVirtualizer = createMockElement({
      clientHeight: opts?.scrollHeight ?? 3600,
      scrollHeight: opts?.scrollHeight ?? 3600,
    });
    const list = createMockElement({
      className: 'relative w-full h-full overflow-y-auto overscroll-none px-2',
      attributes: {
        'data-testid': opts?.testId ?? 'conversation-list-sidebar',
      },
      scrollTop: 0,
      clientHeight: opts?.clientHeight ?? 700,
      scrollHeight: opts?.scrollHeight ?? 3600,
      isConnected: true,
    });
    // Clamp scrollTop to maxScroll like real browser layout engines do!
    let internalScrollTop = 0;
    Object.defineProperty(list, 'scrollTop', {
      get() {
        return internalScrollTop;
      },
      set(val: number) {
        const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
        internalScrollTop = Math.max(0, Math.min(val, maxScroll));
      },
    });
    list.firstElementChild = innerVirtualizer;
    list.children = [innerVirtualizer];
    primaryContainer = list;
    for (const cb of [...mutationCallbacks]) cb();
    return list;
  }

  function unmountOverviewListWithTeardownZeroScroll() {
    if (!primaryContainer) return;
    const old = primaryContainer;
    old.scrollHeight = 0;
    old.clientHeight = 0;
    old.scrollTop = 0;
    old.isConnected = false;
    for (const cb of docListeners.scroll ?? []) {
      cb({ type: 'scroll', target: old });
    }
    primaryContainer = null;
  }

  function userScrollOverview(list: MockElement, nextScrollTop: number) {
    for (const cb of winListeners.pointerdown ?? []) cb({ type: 'pointerdown' });
    for (const cb of docListeners.pointerdown ?? []) cb({ type: 'pointerdown' });
    list.scrollTop = nextScrollTop;
    for (const cb of docListeners.scroll ?? []) {
      cb({ type: 'scroll', target: list });
    }
  }

  function tapThreadLink() {
    for (const cb of winListeners.touchstart ?? []) cb({ type: 'touchstart' });
    for (const cb of docListeners.touchstart ?? []) cb({ type: 'touchstart' });
    for (const cb of winListeners.pointerdown ?? []) cb({ type: 'pointerdown' });
    for (const cb of docListeners.pointerdown ?? []) cb({ type: 'pointerdown' });
  }

  function popStateTo(nextUrl: string) {
    currentUrl = new URL(nextUrl, currentUrl.href);
    for (const cb of winListeners.popstate ?? []) cb({ type: 'popstate' });
    for (const cb of navListeners.currententrychange ?? []) cb();
  }

  function flushAnimationFrames(steps = 1, advanceMsPerStep = 16) {
    for (let i = 0; i < steps; i++) {
      nowMs += advanceMsPerStep;
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const fn of batch) fn();
    }
  }

  function notifyVirtualizerResize(list: MockElement, newScrollHeight: number) {
    list.scrollHeight = newScrollHeight;
    for (const cb of [...resizeCallbacks]) cb();
  }

  function mountOuterWrapper(opts?: { scrollHeight?: number; clientHeight?: number }) {
    const wrapper = createMockElement({
      className: 'flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 pt-3',
      scrollTop: 0,
      clientHeight: opts?.clientHeight ?? 760,
      scrollHeight: opts?.scrollHeight ?? 2400,
      isConnected: true,
    });
    outerContainer = wrapper;
    for (const cb of [...mutationCallbacks]) cb();
    return wrapper;
  }

  return {
    windowMock,
    sessionStore,
    runScript,
    mountOverviewList,
    mountOuterWrapper,
    unmountOverviewListWithTeardownZeroScroll,
    userScrollOverview,
    tapThreadLink,
    popStateTo,
    flushAnimationFrames,
    notifyVirtualizerResize,
    getMutationObserverCount: () => mutationCallbacks.length,
    getResizeObserverCount: () => resizeCallbacks.length,
  };
}

describe('Project Overview scroll-state restoration script', () => {
  it('restores exact scrollTop when diving into a thread and tapping "Back to home" (pushState), even as virtualizer rows measure asynchronously', () => {
    const h = createScrollHarness(
      'https://antigravity.static.usercontent.goog/web/prod-123/?iframe=true',
    );
    h.runScript();

    const initialList = h.mountOverviewList({
      clientHeight: 700,
      scrollHeight: 4200,
    });
    h.userScrollOverview(initialList, 845);
    expect(initialList.scrollTop).toBe(845);

    // User taps a thread -> SPA router pushes `/web/prod-123/c/cascade-abc` and unmounts overview
    h.tapThreadLink();
    h.windowMock.history.pushState({}, '', '/web/prod-123/c/cascade-abc');
    h.unmountOverviewListWithTeardownZeroScroll();

    // User taps top-left "Back to home" -> SPA router pushes `/web/prod-123/`
    h.windowMock.history.pushState({}, '', '/web/prod-123/');

    // Fresh virtualized list mounts with initial estimated scrollHeight too short (1100 -> maxScroll 400),
    // then ResizeObserver expands scrollHeight to 4200 as TanStack Virtual measures items.
    const remountedList = h.mountOverviewList({
      clientHeight: 700,
      scrollHeight: 1100,
    });
    let virtualizerNotifiedScroll = false;
    remountedList.addEventListener('scroll', () => {
      virtualizerNotifiedScroll = true;
    });
    expect(remountedList.scrollTop).toBe(400);

    h.notifyVirtualizerResize(remountedList, 4200);
    expect(remountedList.scrollTop).toBe(845);
    expect(virtualizerNotifiedScroll).toBe(true);

    // Settle window completes and disconnects observers cleanly
    h.flushAnimationFrames(25, 20);
    expect(remountedList.scrollTop).toBe(845);
    expect(h.getMutationObserverCount()).toBe(0);
    expect(h.getResizeObserverCount()).toBe(0);
  });

  it('restores exact scrollTop when returning via hardware/gesture Back (popstate)', () => {
    const h = createScrollHarness(
      'https://antigravity.static.usercontent.goog/web/prod-123/?iframe=true',
    );
    h.runScript();

    const list = h.mountOverviewList({ clientHeight: 700, scrollHeight: 5000 });
    h.userScrollOverview(list, 1320);

    h.tapThreadLink();
    h.windowMock.history.pushState({}, '', '/web/prod-123/battle/battle-99');
    h.unmountOverviewListWithTeardownZeroScroll();

    // Browser/WebView Back pops history back to `/web/prod-123/?iframe=true`
    h.popStateTo('/web/prod-123/?iframe=true');
    const restoredList = h.mountOverviewList({
      clientHeight: 700,
      scrollHeight: 5000,
    });
    expect(restoredList.scrollTop).toBe(1320);
  });

  it('yields immediately when the user touches and scrolls after returning, recording the new position for subsequent dives', () => {
    const h = createScrollHarness(
      'https://antigravity.static.usercontent.goog/web/prod-123/?iframe=true',
    );
    h.runScript();

    const list1 = h.mountOverviewList({ clientHeight: 700, scrollHeight: 4000 });
    h.userScrollOverview(list1, 950);

    h.windowMock.history.pushState({}, '', '/web/prod-123/c/thread-1');
    h.unmountOverviewListWithTeardownZeroScroll();

    h.windowMock.history.pushState({}, '', '/web/prod-123/');
    const list2 = h.mountOverviewList({ clientHeight: 700, scrollHeight: 4000 });
    expect(list2.scrollTop).toBe(950);

    // Before settle timer finishes, user immediately touches and scrolls up to 210
    h.userScrollOverview(list2, 210);
    h.flushAnimationFrames(10, 20);
    expect(list2.scrollTop).toBe(210);

    // User dives into a second thread from 210 and comes back -> restores 210, not 950
    h.windowMock.history.pushState({}, '', '/web/prod-123/c/thread-2');
    h.unmountOverviewListWithTeardownZeroScroll();
    h.windowMock.history.pushState({}, '', '/web/prod-123/');
    const list3 = h.mountOverviewList({ clientHeight: 700, scrollHeight: 4000 });
    expect(list3.scrollTop).toBe(210);
  });

  it('supports standalone /u/<n>/remote and keeps /history scroll state isolated from Project Overview', () => {
    const h = createScrollHarness('https://antigravity.google.com/u/1/remote');
    h.runScript();

    const overviewList = h.mountOverviewList({
      testId: 'conversation-list-sidebar',
      clientHeight: 700,
      scrollHeight: 3500,
    });
    h.userScrollOverview(overviewList, 515);

    // Navigate to /u/1/remote/history -> independent scroll state
    h.windowMock.history.pushState({}, '', '/u/1/remote/history');
    h.unmountOverviewListWithTeardownZeroScroll();
    const historyList = h.mountOverviewList({
      testId: 'conversation-list-history',
      clientHeight: 700,
      scrollHeight: 3500,
    });
    expect(historyList.scrollTop).toBe(0);
    h.userScrollOverview(historyList, 910);

    // Dive into cloud thread from history and go back to history -> 910
    h.windowMock.history.pushState({}, '', '/u/1/remote/c/cloud-thread-1');
    h.unmountOverviewListWithTeardownZeroScroll();
    h.popStateTo('/u/1/remote/history');
    const historyRestored = h.mountOverviewList({
      testId: 'conversation-list-history',
      clientHeight: 700,
      scrollHeight: 3500,
    });
    expect(historyRestored.scrollTop).toBe(910);

    // Return to /u/1/remote Project Overview -> still restores 515!
    h.windowMock.history.pushState({}, '', '/u/1/remote');
    h.unmountOverviewListWithTeardownZeroScroll();
    const overviewRestored = h.mountOverviewList({
      testId: 'conversation-list-sidebar',
      clientHeight: 700,
      scrollHeight: 3500,
    });
    expect(overviewRestored.scrollTop).toBe(515);
  });

  it('restores from sessionStorage across full-document back navigation when injected at document-start before <html> exists', () => {
    const sharedSession = new Map<string, string>();
    const firstLoad = createScrollHarness(
      'https://antigravity.static.usercontent.goog/web/prod-123/?iframe=true',
      { sharedSessionStore: sharedSession },
    );
    firstLoad.runScript();
    const list = firstLoad.mountOverviewList({
      clientHeight: 700,
      scrollHeight: 3200,
    });
    firstLoad.userScrollOverview(list, 775);
    firstLoad.windowMock.history.pushState({}, '', '/web/prod-123/c/thread-9');

    // Simulate fresh document load on `/web/prod-123/?iframe=true` sharing tab sessionStorage,
    // running at document-start while `document.documentElement` is initially null.
    const secondLoad = createScrollHarness(
      'https://antigravity.static.usercontent.goog/web/prod-123/?iframe=true',
      { sharedSessionStore: sharedSession, deferDocumentElement: true },
    );
    secondLoad.runScript();
    secondLoad.flushAnimationFrames(2, 16);

    const remounted = secondLoad.mountOverviewList({
      clientHeight: 700,
      scrollHeight: 3200,
    });
    secondLoad.flushAnimationFrames(2, 16);
    expect(remounted.scrollTop).toBe(775);
  });

  it('enforces strict origin allow-listing and Trusted-Types CSP invariants', () => {
    for (const disallowedUrl of [
      'https://accounts.google.com/v3/signin/identifier',
      'https://antigravity.static.usercontent.goog/other/path',
      'http://antigravity.google.com/remote',
      'https://evil.example.com/web/v1/',
    ]) {
      const h = createScrollHarness(disallowedUrl);
      h.runScript();
      expect(h.windowMock.__agyOverviewScrollBridge).toBeUndefined();
    }

    for (const script of [
      PROJECT_OVERVIEW_SCROLL_SCRIPT,
      buildReturnToOverviewScript(),
    ]) {
      expect(script).not.toMatch(
        /\b(innerHTML|outerHTML|insertAdjacentHTML|eval)\b|document\.write|new\s+Function/,
      );
    }
  });
});

describe('Android & iOS WebView scroll-restoration wiring and Inbox drawer scroll state', () => {
  beforeEach(() => {
    mockInstallDocStartScript.mockClear();
    mockInstallNativeExpoFn.mockClear();
    mockWebViewGoBack.mockClear();
    mockWebViewInjectJavaScript.mockClear();
    mockScrollTo.mockClear();
    mockBackPressListeners.clear();
  });

  it('wires cross-frame WKUserScript on iOS, native document-start script on Android, SPA back-to-overview fallback, and Drawer ScrollView restoration', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RemoteWebView
          incomingDeepLinkUrl={null}
          isInitialUrlResolved={true}
          onDeepLinkConsumed={() => {}}
        />,
      );
    });

    const webView = tree.root.findByType('WebView' as any);
    expect(webView.props.injectedJavaScriptBeforeContentLoaded).toBe(
      PROJECT_OVERVIEW_SCROLL_SCRIPT,
    );
    expect(
      webView.props.injectedJavaScriptBeforeContentLoadedForMainFrameOnly,
    ).toBe(false);
    expect(mockInstallDocStartScript).toHaveBeenCalledWith(
      PROJECT_OVERVIEW_SCROLL_SCRIPT,
    );

    // Cold-booted onto Project Overview `/r/machine-1` with canGoBack=false:
    // pressing Back on overview should NOT be intercepted (`false`).
    let backHandledOnOverview = false;
    for (const listener of mockBackPressListeners) {
      backHandledOnOverview = listener() || backHandledOnOverview;
    }
    expect(backHandledOnOverview).toBe(false);

    // User dives into a thread inside the workstation iframe (`AGY_INBOX_ACTIVE_ROUTE`),
    // even before any top-frame history entry sets `canGoBack = true`:
    await act(async () => {
      webView.props.onMessage({
        nativeEvent: {
          url: 'https://antigravity.google.com/r/machine-1',
          data: JSON.stringify({
            type: 'AGY_INBOX_ACTIVE_ROUTE',
            activeUrl: 'https://antigravity.google.com/r/machine-1?p=c%2Fthread-42',
            activeInstanceUuid: 'machine-1',
            activeCascadeId: 'thread-42',
          }),
        },
      });
    });

    mockWebViewInjectJavaScript.mockClear();
    let backHandledInThread = false;
    await act(async () => {
      for (const listener of mockBackPressListeners) {
        backHandledInThread = listener() || backHandledInThread;
      }
    });
    expect(backHandledInThread).toBe(true);
    expect(mockWebViewInjectJavaScript).toHaveBeenCalledTimes(1);
    expect(mockWebViewInjectJavaScript.mock.calls[0][0]).toContain(
      "JSON.stringify([null, ['/']])",
    );

    // Verify Drawer Inbox ScrollView preserves scroll position across Inbox <-> Settings mode switches
    const openDrawerBtn = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Open Antigravity drawer'),
    )[0];
    await act(async () => {
      openDrawerBtn.props.onPress();
    });

    const inboxScrollView = () =>
      tree.root.findAll((n) => n.type === ('ScrollView' as any))[0];
    await act(async () => {
      inboxScrollView().props.onScroll({
        nativeEvent: { contentOffset: { y: 420 } },
      });
    });

    const settingsModeBtn = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        n.props.accessibilityLabel === 'Drawer mode Settings',
    )[0];
    await act(async () => {
      settingsModeBtn.props.onPress();
    });

    mockScrollTo.mockClear();
    const inboxModeBtn = tree.root.findAll(
      (n) =>
        n.type === ('TouchableOpacity' as any) &&
        n.props.accessibilityLabel === 'Drawer mode Inbox',
    )[0];
    await act(async () => {
      inboxModeBtn.props.onPress();
    });

    expect(mockScrollTo).toHaveBeenCalledWith({ y: 420, animated: false });

    await act(async () => {
      tree.unmount();
    });
  });

  it('forwards installNativeDocumentStartScript to the RemoteSession native module and tolerates errors', async () => {
    const actualWebData = jest.requireActual(
      '../src/services/webData',
    ) as typeof import('../src/services/webData');

    await actualWebData.installNativeDocumentStartScript('/* test script */');
    expect(mockInstallNativeExpoFn).toHaveBeenCalledWith('/* test script */');

    mockInstallNativeExpoFn.mockRejectedValueOnce(
      new Error('WebView unavailable'),
    );
    await expect(
      actualWebData.installNativeDocumentStartScript('/* retry */'),
    ).resolves.toBeUndefined();
  });
});
