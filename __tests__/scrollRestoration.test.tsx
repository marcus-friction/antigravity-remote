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
  getItemAsync: jest.fn(async (key: string) => {
    if (key === 'agy_last_active_url_v1') {
      return 'https://antigravity.google.com/r/machine-1';
    }
    if (key === 'agy_intro_tour_seen_v1') {
      return 'true';
    }
    return null;
  }),
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

    // Cold-booted authenticated onto Project Overview `/r/machine-1` (no thread):
    // our native Inbox drawer opens automatically because Antigravity's sidebar is hidden.
    // First hardware Back closes the drawer (`true`); second press on overview returns `false`.
    let backClosedDrawer = false;
    await act(async () => {
      for (const listener of mockBackPressListeners) {
        backClosedDrawer = listener() || backClosedDrawer;
      }
    });
    expect(backClosedDrawer).toBe(true);

    let backHandledOnOverview = false;
    await act(async () => {
      for (const listener of mockBackPressListeners) {
        backHandledOnOverview = listener() || backHandledOnOverview;
      }
    });
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

    // Pressing Back from a thread automatically opens our native Inbox drawer
    // (because Antigravity's native sidebar is hidden). Verify Drawer Inbox ScrollView
    // preserves scroll position across Inbox <-> Settings mode switches:
    expect(
      tree.root.findAll(
        (n) =>
          n.type === ('TouchableOpacity' as any) &&
          n.props.accessibilityLabel === 'Drawer mode Settings',
      ),
    ).toHaveLength(1);

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

    // When list content shrinks below the saved scroll offset, `onContentSizeChange` clamps to `contentHeight - viewportHeight`
    mockScrollTo.mockClear();
    await act(async () => {
      inboxScrollView().props.onLayout({
        nativeEvent: { layout: { height: 500 } },
      });
      settingsModeBtn.props.onPress();
    });
    await act(async () => {
      inboxModeBtn.props.onPress();
    });
    mockScrollTo.mockClear();
    await act(async () => {
      inboxScrollView().props.onContentSizeChange(320, 620);
    });
    expect(mockScrollTo).toHaveBeenCalledWith({ y: 120, animated: false });

    // Entering a thread and exiting via in-iframe Back (`activeCascadeId: null` while `activeUrl` still has `?p=`)
    // automatically opens our native Inbox drawer for the empty screen AND clears `canReturnToOverviewRef`:
    // first hardware Back closes the drawer without firing a redundant Overview return, and second press returns `false`.
    mockWebViewInjectJavaScript.mockClear();
    await act(async () => {
      tree.root
        .findAll(
          (n) =>
            n.type === ('TouchableOpacity' as any) &&
            n.props.accessibilityLabel === 'Close Antigravity drawer',
        )[0]
        .props.onPress();
      webView.props.onMessage({
        nativeEvent: {
          url: 'https://antigravity.google.com/r/machine-1',
          data: JSON.stringify({
            type: 'AGY_INBOX_ACTIVE_ROUTE',
            activeUrl: 'https://antigravity.google.com/r/machine-1?p=c%2Fthread-99',
            activeInstanceUuid: 'machine-1',
            activeCascadeId: 'thread-99',
          }),
        },
      });
      webView.props.onMessage({
        nativeEvent: {
          url: 'https://antigravity.google.com/r/machine-1',
          data: JSON.stringify({
            type: 'AGY_INBOX_ACTIVE_ROUTE',
            activeUrl: 'https://antigravity.google.com/r/machine-1?p=c%2Fthread-99',
            activeInstanceUuid: 'machine-1',
            activeCascadeId: null,
          }),
        },
      });
    });

    mockWebViewInjectJavaScript.mockClear();
    let firstBackClosesAutoOpenedDrawer = false;
    await act(async () => {
      for (const listener of mockBackPressListeners) {
        firstBackClosesAutoOpenedDrawer =
          listener() || firstBackClosesAutoOpenedDrawer;
      }
    });
    expect(firstBackClosesAutoOpenedDrawer).toBe(true);
    expect(mockWebViewInjectJavaScript).not.toHaveBeenCalled();

    let backHandledAfterIframeReturn = false;
    await act(async () => {
      for (const listener of mockBackPressListeners) {
        backHandledAfterIframeReturn =
          listener() || backHandledAfterIframeReturn;
      }
    });
    expect(backHandledAfterIframeReturn).toBe(false);

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

  it('injects Antigravity sidebar-hiding CSS and intercepts mobile back-to-home clicks to open our native Inbox drawer', () => {
    const appendedStyles: Array<{ id: string; textContent: string }> = [];
    const parentPosts: Array<{ msg: any; targetOrigin: string }> = [];
    const docClickListeners: Array<(evt: any) => void> = [];
    const styleProps: Record<string, Record<string, string>> = {
      sidebarNav: {},
      sidebarWrapper: {},
      resizer: {},
    };

    const resizer = {
      getAttribute: (k: string) => (k === 'role' ? 'separator' : null),
      className: 'cursor-col-resize',
      style: {
        setProperty: (k: string, v: string) => {
          styleProps.resizer[k] = v;
        },
      },
    };
    const sidebarWrapper = {
      parentElement: null as any,
      nextElementSibling: resizer,
      querySelector: () => null,
      style: {
        setProperty: (k: string, v: string) => {
          styleProps.sidebarWrapper[k] = v;
        },
      },
    };
    const sidebarNav = {
      parentElement: sidebarWrapper,
      style: {
        setProperty: (k: string, v: string) => {
          styleProps.sidebarNav[k] = v;
        },
      },
    };

    const docEl = {
      appendChild: (node: any) => appendedStyles.push(node),
    };
    const windowObj: any = {
      location: {
        protocol: 'https:',
        hostname: 'antigravity.static.usercontent.goog',
        pathname: '/web/2.33.0/',
        search: '?iframe=true',
        href: 'https://antigravity.static.usercontent.goog/web/2.33.0/?iframe=true',
      },
      history: {
        pushState: () => {},
        replaceState: () => {},
      },
      parent: {
        postMessage: (msg: any, targetOrigin: string) => {
          parentPosts.push({ msg, targetOrigin });
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      sessionStorage: {
        getItem: () => null,
        setItem: () => {},
      },
    };
    const documentObj: any = {
      head: docEl,
      documentElement: docEl,
      body: { parentElement: docEl },
      getElementById: (id: string) =>
        appendedStyles.find((s) => s.id === id) ?? null,
      createElement: () => ({ id: '', textContent: '' }),
      querySelectorAll: (sel: string) =>
        sel === '[role="navigation"][aria-label="Sidebar"]' ? [sidebarNav] : [],
      addEventListener: (type: string, fn: (evt: any) => void) => {
        if (type === 'click') {
          docClickListeners.push(fn);
        }
      },
      removeEventListener: () => {},
    };

    const sandbox = vm.createContext({
      window: windowObj,
      document: documentObj,
      URL,
      URLSearchParams,
      setTimeout: () => 1,
      clearTimeout: () => {},
    });
    vm.runInContext(PROJECT_OVERVIEW_SCROLL_SCRIPT, sandbox);

    // 1. Style tag injected hiding Antigravity sidebars without breaking settings dialogs
    expect(appendedStyles).toHaveLength(1);
    expect(appendedStyles[0].id).toBe('__agy_remote_hide_antigravity_sidebar');
    expect(appendedStyles[0].textContent).toContain(
      '[role="navigation"][aria-label="Sidebar"]',
    );
    expect(appendedStyles[0].textContent).toContain(
      '[data-testid="sidebar-popover-backdrop"]',
    );
    expect(appendedStyles[0].textContent).toContain(
      '--sidebar-width: 0px !important;',
    );
    expect(appendedStyles[0].textContent).toContain(
      '[data-sidebar-scroll-container="true"]',
    );
    expect(appendedStyles[0].textContent).toContain(
      ':not([data-testid="settings-sidebar"] *)',
    );
    expect(styleProps.sidebarNav.display).toBe('none');
    expect(styleProps.sidebarWrapper.display).toBe('none');
    expect(styleProps.resizer.display).toBe('none');

    // 2. Clicking Antigravity's mobile back-to-home button intercepts click and opens our Inbox drawer
    let prevented = false;
    let stopped = false;
    for (const listener of docClickListeners) {
      listener({
        target: {
          closest: (sel: string) =>
            sel.includes('mobile-back-to-home') ? { tagName: 'BUTTON' } : null,
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
        stopImmediatePropagation: () => {},
      });
    }
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(parentPosts).toContainEqual({
      msg: { type: 'AGY_REMOTE_OPEN_DRAWER', mode: 'inbox' },
      targetOrigin: 'https://antigravity.google.com',
    });
  });

  it('renders the active project name in the mobile thread header without reparenting React nodes, handles async mounts & route transitions, and opens Projects on tap', () => {
    type MockNode = {
      tagName: string;
      nodeType: number;
      attributes: Record<string, string>;
      children: MockNode[];
      parentElement: MockNode | null;
      textContent: string;
      setAttribute: (k: string, v: string) => void;
      getAttribute: (k: string) => string | null;
      removeAttribute: (k: string) => void;
      appendChild: (child: MockNode) => MockNode;
      removeChild: (child: MockNode) => MockNode;
      querySelector: (sel: string) => MockNode | null;
      querySelectorAll: (sel: string) => MockNode[];
      closest: (sel: string) => MockNode | null;
    };

    const matchesSimpleSelector = (node: MockNode, sel: string): boolean => {
      const parts = sel.split(',').map((s) => s.trim());
      return parts.some((part) => {
        const attrEq = /^\[([^=\]]+)="([^"]*)"\]$/.exec(part);
        if (attrEq) {
          return node.attributes[attrEq[1]] === attrEq[2];
        }
        const attrPresence = /^\[([^=\]]+)\]$/.exec(part);
        if (attrPresence) {
          return Object.prototype.hasOwnProperty.call(
            node.attributes,
            attrPresence[1],
          );
        }
        const tagAttrEq = /^([a-z]+)\[([^=\]]+)="([^"]*)"\]$/i.exec(part);
        if (tagAttrEq) {
          return (
            node.tagName.toLowerCase() === tagAttrEq[1].toLowerCase() &&
            node.attributes[tagAttrEq[2]] === tagAttrEq[3]
          );
        }
        return false;
      });
    };

    const createNode = (
      tagName: string,
      attrs: Record<string, string> = {},
      text = '',
    ): MockNode => {
      const node: MockNode = {
        tagName: tagName.toUpperCase(),
        nodeType: 1,
        attributes: { ...attrs },
        children: [],
        parentElement: null,
        textContent: text,
        setAttribute(k, v) {
          this.attributes[k] = String(v);
        },
        getAttribute(k) {
          return Object.prototype.hasOwnProperty.call(this.attributes, k)
            ? this.attributes[k]
            : null;
        },
        removeAttribute(k) {
          delete this.attributes[k];
        },
        appendChild(child) {
          if (child.parentElement && child.parentElement !== this) {
            child.parentElement.removeChild(child);
          }
          if (!this.children.includes(child)) {
            this.children.push(child);
          }
          child.parentElement = this;
          return child;
        },
        removeChild(child) {
          const idx = this.children.indexOf(child);
          if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parentElement = null;
          }
          return child;
        },
        querySelector(sel) {
          return this.querySelectorAll(sel)[0] ?? null;
        },
        querySelectorAll(sel) {
          const out: MockNode[] = [];
          const walk = (cur: MockNode) => {
            for (const c of cur.children) {
              if (matchesSimpleSelector(c, sel)) {
                out.push(c);
              }
              walk(c);
            }
          };
          walk(this);
          return out;
        },
        closest(sel) {
          let cur: MockNode | null = this;
          while (cur) {
            if (matchesSimpleSelector(cur, sel)) return cur;
            cur = cur.parentElement;
          }
          return null;
        },
      };
      return node;
    };

    const docEl = createNode('html');
    const head = createNode('head');
    const body = createNode('body');
    docEl.appendChild(head);
    docEl.appendChild(body);

    const parentPosts: Array<{ msg: any; targetOrigin: string }> = [];
    const windowMessageListeners: Array<(evt: any) => void> = [];
    const docClickListeners: Array<(evt: any) => void> = [];
    const mutationCallbacks: Array<() => void> = [];
    let activeMutationObservers = 0;
    const pendingTimers: Array<() => void> = [];

    class MockMutationObserver {
      private cb: () => void;
      private active = false;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        if (!this.active) {
          this.active = true;
          activeMutationObservers++;
          mutationCallbacks.push(this.cb);
        }
      }
      disconnect() {
        if (this.active) {
          this.active = false;
          activeMutationObservers--;
        }
      }
    }

    const parentWindow = {
      postMessage: (msg: any, targetOrigin: string) => {
        parentPosts.push({ msg, targetOrigin });
      },
    };

    const windowObj: any = {
      location: {
        protocol: 'https:',
        hostname: 'antigravity.static.usercontent.goog',
        pathname: '/web/2.33.0/c/thread-1',
        search: '?iframe=true',
        href: 'https://antigravity.static.usercontent.goog/web/2.33.0/c/thread-1?iframe=true',
      },
      history: {
        pushState: (_s: any, _t: string, url: string) => {
          const parsed = new URL(url, 'https://antigravity.static.usercontent.goog');
          windowObj.location.pathname = parsed.pathname;
          windowObj.location.search = parsed.search;
          windowObj.location.href = parsed.href;
        },
        replaceState: () => {},
      },
      parent: parentWindow,
      MutationObserver: MockMutationObserver,
      addEventListener: (type: string, fn: (evt: any) => void) => {
        if (type === 'message') {
          windowMessageListeners.push(fn);
        }
      },
      removeEventListener: () => {},
      sessionStorage: {
        getItem: () => null,
        setItem: () => {},
      },
    };

    const documentObj: any = {
      head,
      documentElement: docEl,
      body,
      getElementById: (id: string) =>
        head.children.find((n) => n.attributes.id === id) ?? null,
      createElement: (tag: string) => createNode(tag),
      createElementNS: (_ns: string, tag: string) => createNode(tag),
      querySelector: (sel: string) => docEl.querySelector(sel),
      querySelectorAll: (sel: string) => docEl.querySelectorAll(sel),
      addEventListener: (type: string, fn: (evt: any) => void) => {
        if (type === 'click') {
          docClickListeners.push(fn);
        }
      },
      removeEventListener: () => {},
    };

    const flushTimers = () => {
      const queue = pendingTimers.splice(0, pendingTimers.length);
      for (const fn of queue) fn();
    };

    const sandbox = vm.createContext({
      window: windowObj,
      document: documentObj,
      URL,
      URLSearchParams,
      setTimeout: (fn: () => void) => {
        pendingTimers.push(fn);
        return pendingTimers.length;
      },
      clearTimeout: () => {},
    });

    vm.runInContext(PROJECT_OVERVIEW_SCROLL_SCRIPT, sandbox);

    // 1. Cold boot on thread route immediately requests thread context from host
    expect(parentPosts).toContainEqual({
      msg: { type: 'AGY_REMOTE_REQUEST_THREAD_CONTEXT', cascadeId: 'thread-1' },
      targetOrigin: 'https://antigravity.google.com',
    });
    expect(activeMutationObservers).toBe(1);

    // 2. Untrusted message origin or wrong source is ignored
    for (const fn of windowMessageListeners) {
      fn({
        origin: 'https://evil.example',
        source: parentWindow,
        data: {
          type: 'AGY_REMOTE_THREAD_CONTEXT',
          context: { cascadeId: 'thread-1', projectName: 'Spoofed' },
        },
      });
      fn({
        origin: 'https://antigravity.google.com',
        source: {},
        data: {
          type: 'AGY_REMOTE_THREAD_CONTEXT',
          context: { cascadeId: 'thread-1', projectName: 'Spoofed Source' },
        },
      });
    }

    // 3. Trusted context arrives BEFORE React mounts the header (verifies no lockup)
    for (const fn of windowMessageListeners) {
      fn({
        origin: 'https://antigravity.google.com',
        source: parentWindow,
        data: {
          type: 'AGY_REMOTE_THREAD_CONTEXT',
          context: {
            cascadeId: 'thread-1',
            projectId: 'proj-alpha',
            projectName: 'antigravity-remote',
            instanceName: 'Dev Box',
          },
        },
      });
    }

    // 4. React mounts p9c with ONLY mobile-back-to-home first (no title yet -> solo layout)
    const headerBar = createNode('div', { 'data-main-content-header': 'true' });
    const headerLeft = createNode('div');
    const backBtn = createNode('button', {
      'data-testid': 'mobile-back-to-home',
      'aria-label': 'Back to home',
    });
    headerLeft.appendChild(backBtn);
    headerBar.appendChild(headerLeft);
    body.appendChild(headerBar);

    for (const cb of mutationCallbacks) cb();
    flushTimers();

    expect(headerLeft.getAttribute('data-agy-project-header-layout')).toBe('solo');
    const injectedBtn = headerLeft.querySelector(
      '[data-agy-remote-project-header="true"]',
    );
    expect(injectedBtn).not.toBeNull();
    expect(injectedBtn!.getAttribute('aria-label')).toBe(
      'Project: antigravity-remote on Dev Box',
    );
    expect(
      injectedBtn!.querySelector('[data-agy-remote-project-name="true"]')
        ?.textContent,
    ).toBe('antigravity-remote');
    expect(
      injectedBtn!.querySelector('[data-agy-remote-project-icon="true"]'),
    ).not.toBeNull();

    // 5. React later mounts I6c thread title sibling -> upgrades cleanly to stacked layout without reparenting
    const titleWrap = createNode('div');
    const titleSeg = createNode(
      'span',
      { 'data-testid': 'breadcrumb-segment' },
      'Fix header layout',
    );
    titleWrap.appendChild(titleSeg);
    headerLeft.appendChild(titleWrap);

    for (const cb of mutationCallbacks) cb();
    flushTimers();

    expect(headerLeft.getAttribute('data-agy-project-header-layout')).toBe(
      'stacked',
    );
    expect(backBtn.parentElement).toBe(headerLeft);
    expect(titleWrap.parentElement).toBe(headerLeft);

    // 6. Tapping the project label opens our native Projects drawer
    parentPosts.length = 0;
    let prevented = false;
    let stopped = false;
    for (const listener of docClickListeners) {
      listener({
        target: injectedBtn!.querySelector(
          '[data-agy-remote-project-name="true"]',
        ),
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
        stopImmediatePropagation: () => {},
      });
    }
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(parentPosts).toContainEqual({
      msg: { type: 'AGY_REMOTE_OPEN_DRAWER', mode: 'projects' },
      targetOrigin: 'https://antigravity.google.com',
    });

    // 7. Switching to another thread clears stale project immediately and requests new context
    parentPosts.length = 0;
    windowObj.history.pushState(null, '', '/web/2.33.0/c/thread-2?iframe=true');
    expect(
      headerLeft.querySelector('[data-agy-remote-project-header="true"]'),
    ).toBeNull();
    expect(headerLeft.getAttribute('data-agy-project-header-layout')).toBeNull();
    expect(parentPosts).toContainEqual({
      msg: { type: 'AGY_REMOTE_REQUEST_THREAD_CONTEXT', cascadeId: 'thread-2' },
      targetOrigin: 'https://antigravity.google.com',
    });

    // 8. Returning to overview disconnects MutationObserver cleanly
    windowObj.history.pushState(null, '', '/web/2.33.0/?iframe=true');
    expect(activeMutationObservers).toBe(0);

    // 9. Desktop/tablet header skips duplicate when 2+ breadcrumbs exist, injects inline when only 1 exists
    body.removeChild(headerBar);
    const desktopHeader = createNode('div', {
      'data-main-content-header': 'true',
    });
    const i6c = createNode('div');
    const tvc = createNode('div');
    const seg1Wrap = createNode('div');
    const seg1 = createNode(
      'span',
      { 'data-testid': 'breadcrumb-segment' },
      'Backend API',
    );
    const seg2Wrap = createNode('div');
    const seg2 = createNode(
      'span',
      { 'data-testid': 'breadcrumb-segment' },
      'Refactor router',
    );
    seg1Wrap.appendChild(seg1);
    seg2Wrap.appendChild(seg2);
    tvc.appendChild(seg1Wrap);
    tvc.appendChild(seg2Wrap);
    i6c.appendChild(tvc);
    desktopHeader.appendChild(i6c);
    body.appendChild(desktopHeader);

    windowObj.history.pushState(null, '', '/web/2.33.0/c/thread-3?iframe=true');
    for (const fn of windowMessageListeners) {
      fn({
        origin: 'https://antigravity.google.com',
        source: parentWindow,
        data: {
          type: 'AGY_REMOTE_THREAD_CONTEXT',
          context: {
            cascadeId: 'thread-3',
            projectName: 'Backend API',
          },
        },
      });
    }
    // Already has 2 breadcrumb segments -> no duplicate injected
    expect(
      desktopHeader.querySelector('[data-agy-remote-project-header="true"]'),
    ).toBeNull();

    // Remove the workspace breadcrumb so only thread title remains -> inline fallback injects
    tvc.removeChild(seg1Wrap);
    windowObj.__agyOverviewScrollBridge.syncThreadProjectHeader();
    const inlineBtn = desktopHeader.querySelector(
      '[data-agy-remote-project-header="true"]',
    );
    expect(inlineBtn).not.toBeNull();
    expect(inlineBtn!.getAttribute('data-agy-project-header-mode')).toBe(
      'inline',
    );
    expect(
      inlineBtn!.querySelector('[data-agy-remote-project-name="true"]')
        ?.textContent,
    ).toBe('Backend API');
  });

  it('notifies host/native when archiving leaves an empty route or unmounts the conversation view without false-firing on thread load, switch, dialogs, or special sub-routes', () => {
    type SimpleNode = {
      tagName: string;
      nodeType: number;
      attributes: Record<string, string>;
      children: SimpleNode[];
      parentElement: SimpleNode | null;
      isConnected: boolean;
      style: Record<string, string>;
      setAttribute: (k: string, v: string) => void;
      getAttribute: (k: string) => string | null;
      removeAttribute: (k: string) => void;
      appendChild: (c: SimpleNode) => SimpleNode;
      removeChild: (c: SimpleNode) => SimpleNode;
      querySelector: (sel: string) => SimpleNode | null;
      querySelectorAll: (sel: string) => SimpleNode[];
    };

    const matchesPart = (node: SimpleNode, rawPart: string): boolean => {
      const part = rawPart.trim();
      if (!part) return false;
      let rest = part;
      const tagMatch = /^([a-z]+)/i.exec(rest);
      if (tagMatch) {
        if (node.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) {
          return false;
        }
        rest = rest.slice(tagMatch[0].length);
      }
      const attrRegex = /\[([^=\]]+)(?:="([^"]*)")?\]/g;
      let matchedAnyAttr = false;
      let consumedLength = 0;
      let m: RegExpExecArray | null;
      while ((m = attrRegex.exec(rest)) !== null) {
        if (m.index !== consumedLength) return false;
        matchedAnyAttr = true;
        consumedLength += m[0].length;
        const ok =
          m[2] !== undefined
            ? node.attributes[m[1]] === m[2]
            : Object.prototype.hasOwnProperty.call(node.attributes, m[1]);
        if (!ok) return false;
      }
      if (consumedLength !== rest.length) return false;
      return Boolean(tagMatch || matchedAnyAttr);
    };

    const makeNode = (
      tag: string,
      attrs: Record<string, string> = {},
    ): SimpleNode => {
      const node: SimpleNode = {
        tagName: tag.toUpperCase(),
        nodeType: 1,
        attributes: { ...attrs },
        children: [],
        parentElement: null,
        isConnected: true,
        style: {},
        setAttribute(k, v) {
          this.attributes[k] = String(v);
        },
        getAttribute(k) {
          return Object.prototype.hasOwnProperty.call(this.attributes, k)
            ? this.attributes[k]
            : null;
        },
        removeAttribute(k) {
          delete this.attributes[k];
        },
        appendChild(c) {
          this.children.push(c);
          c.parentElement = this;
          c.isConnected = true;
          return c;
        },
        removeChild(c) {
          const idx = this.children.indexOf(c);
          if (idx >= 0) {
            this.children.splice(idx, 1);
            c.parentElement = null;
            c.isConnected = false;
          }
          return c;
        },
        querySelector(sel) {
          return this.querySelectorAll(sel)[0] ?? null;
        },
        querySelectorAll(sel) {
          const parts = sel.split(',');
          const out: SimpleNode[] = [];
          const walk = (cur: SimpleNode) => {
            for (const c of cur.children) {
              if (parts.some((p) => matchesPart(c, p))) out.push(c);
              walk(c);
            }
          };
          walk(this);
          return out;
        },
      };
      return node;
    };

    const docEl = makeNode('html');
    const head = makeNode('head');
    const body = makeNode('body');
    docEl.appendChild(head);
    docEl.appendChild(body);

    const parentPosts: Array<{ msg: any; targetOrigin: string }> = [];
    const mutationCallbacks: Array<() => void> = [];
    const timers = new Map<number, () => void>();
    let nextTimerId = 1;

    class MockMO {
      private cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        mutationCallbacks.push(this.cb);
      }
      disconnect() {
        const idx = mutationCallbacks.indexOf(this.cb);
        if (idx >= 0) mutationCallbacks.splice(idx, 1);
      }
    }

    const flushTimers = () => {
      const batch = Array.from(timers.entries());
      timers.clear();
      for (const [, fn] of batch) fn();
    };

    const windowObj: any = {
      location: {
        protocol: 'https:',
        hostname: 'antigravity.static.usercontent.goog',
        pathname: '/web/2.33.0/c/thread-1',
        search: '?iframe=true',
        href: 'https://antigravity.static.usercontent.goog/web/2.33.0/c/thread-1?iframe=true',
      },
      history: {
        pushState: (_s: any, _t: string, url: string) => {
          const parsed = new URL(url, 'https://antigravity.static.usercontent.goog');
          windowObj.location.pathname = parsed.pathname;
          windowObj.location.search = parsed.search;
          windowObj.location.href = parsed.href;
        },
        replaceState: (_s: any, _t: string, url: string) => {
          const parsed = new URL(url, 'https://antigravity.static.usercontent.goog');
          windowObj.location.pathname = parsed.pathname;
          windowObj.location.search = parsed.search;
          windowObj.location.href = parsed.href;
        },
      },
      parent: {
        postMessage: (msg: any, targetOrigin: string) => {
          parentPosts.push({ msg, targetOrigin });
        },
      },
      MutationObserver: MockMO,
      addEventListener: () => {},
      removeEventListener: () => {},
      sessionStorage: { getItem: () => null, setItem: () => {} },
    };

    const documentObj: any = {
      head,
      documentElement: docEl,
      body,
      getElementById: (id: string) =>
        head.children.find((n) => n.attributes.id === id) ?? null,
      createElement: (tag: string) => makeNode(tag),
      querySelector: (sel: string) => docEl.querySelector(sel),
      querySelectorAll: (sel: string) => docEl.querySelectorAll(sel),
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    vm.runInContext(
      PROJECT_OVERVIEW_SCROLL_SCRIPT,
      vm.createContext({
        window: windowObj,
        document: documentObj,
        URL,
        URLSearchParams,
        setTimeout: (fn: () => void) => {
          const id = nextTimerId++;
          timers.set(id, fn);
          return id;
        },
        clearTimeout: (id: number) => {
          timers.delete(id);
        },
      }),
    );

    // 1. Initial load on `/c/thread-1` before conversation mounts must NOT false-fire empty screen
    flushTimers();
    expect(
      parentPosts.filter((p) => p.msg.type === 'AGY_REMOTE_EMPTY_SCREEN'),
    ).toHaveLength(0);

    // 2. Mount live conversation view, then unmount it in place (e.g. archived without URL change)
    const convView = makeNode('div', { 'data-testid': 'conversation-view' });
    body.appendChild(convView);
    for (const cb of [...mutationCallbacks]) cb();
    flushTimers();
    expect(
      parentPosts.filter((p) => p.msg.type === 'AGY_REMOTE_EMPTY_SCREEN'),
    ).toHaveLength(0);

    // If a modal dialog opens when conversation unmounts, screen is NOT empty
    body.removeChild(convView);
    const modal = makeNode('div', { role: 'dialog' });
    body.appendChild(modal);
    for (const cb of [...mutationCallbacks]) cb();
    flushTimers();
    expect(
      parentPosts.filter((p) => p.msg.type === 'AGY_REMOTE_EMPTY_SCREEN'),
    ).toHaveLength(0);

    // Once modal closes and nothing remains visible -> emits `dom_empty`
    body.removeChild(modal);
    for (const cb of [...mutationCallbacks]) cb();
    flushTimers();
    expect(parentPosts).toContainEqual({
      msg: {
        type: 'AGY_REMOTE_EMPTY_SCREEN',
        reason: 'dom_empty',
        subPath: '/c/thread-1',
        cascadeId: 'thread-1',
      },
      targetOrigin: 'https://antigravity.google.com',
    });

    // 3. Switching to `/c/thread-2` does NOT false-fire while thread-2 is still mounting
    parentPosts.length = 0;
    windowObj.history.pushState(null, '', '/web/2.33.0/c/thread-2?iframe=true');
    flushTimers();
    expect(
      parentPosts.filter((p) => p.msg.type === 'AGY_REMOTE_EMPTY_SCREEN'),
    ).toHaveLength(0);

    // 4. Navigating from `/c/thread-2` to `/battle/battle-1` or `/history` does NOT fire empty screen
    windowObj.history.pushState(null, '', '/web/2.33.0/battle/battle-1');
    flushTimers();
    windowObj.history.pushState(null, '', '/web/2.33.0/history');
    flushTimers();
    expect(
      parentPosts.filter((p) => p.msg.type === 'AGY_REMOTE_EMPTY_SCREEN'),
    ).toHaveLength(0);

    // 5. Archiving `/c/thread-2` and navigating back to `/` immediately emits `route_overview`
    windowObj.history.pushState(null, '', '/web/2.33.0/c/thread-2?iframe=true');
    parentPosts.length = 0;
    windowObj.history.pushState(null, '', '/web/2.33.0/?iframe=true');
    expect(parentPosts).toContainEqual({
      msg: {
        type: 'AGY_REMOTE_EMPTY_SCREEN',
        reason: 'route_overview',
        subPath: '/',
        cascadeId: null,
      },
      targetOrigin: 'https://antigravity.google.com',
    });

    // 6. Standalone `/remote/c/cloud-1` -> `/remote` posts `AGY_INBOX_EMPTY_SCREEN` directly to native
    const nativePosts: any[] = [];
    const remoteWin: any = {
      location: {
        protocol: 'https:',
        hostname: 'antigravity.google.com',
        pathname: '/remote/c/cloud-1',
        search: '',
        href: 'https://antigravity.google.com/remote/c/cloud-1',
      },
      history: {
        pushState: (_s: any, _t: string, url: string) => {
          const parsed = new URL(url, 'https://antigravity.google.com');
          remoteWin.location.pathname = parsed.pathname;
          remoteWin.location.search = parsed.search;
          remoteWin.location.href = parsed.href;
        },
        replaceState: () => {},
      },
      ReactNativeWebView: {
        postMessage: (raw: string) => nativePosts.push(JSON.parse(raw)),
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      sessionStorage: { getItem: () => null, setItem: () => {} },
    };
    const remoteRoot = makeNode('html');
    const remoteHead = makeNode('head');
    const remoteBody = makeNode('body');
    remoteRoot.appendChild(remoteHead);
    remoteRoot.appendChild(remoteBody);
    vm.runInContext(
      PROJECT_OVERVIEW_SCROLL_SCRIPT,
      vm.createContext({
        window: remoteWin,
        document: {
          head: remoteHead,
          documentElement: remoteRoot,
          body: remoteBody,
          getElementById: () => null,
          createElement: (tag: string) => makeNode(tag),
          querySelector: () => null,
          querySelectorAll: () => [],
          addEventListener: () => {},
          removeEventListener: () => {},
        },
        URL,
        URLSearchParams,
        setTimeout: () => 1,
        clearTimeout: () => {},
      }),
    );
    remoteWin.history.pushState(null, '', '/remote');
    expect(nativePosts).toContainEqual({
      type: 'AGY_INBOX_EMPTY_SCREEN',
      reason: 'route_overview',
      activeUrl: 'https://antigravity.google.com/remote',
      activeInstanceUuid: null,
      activeCascadeId: null,
    });

    // 7. Regression coverage: Case 1 root overview shell detection, ?project= & composer & progressbar
    //    guards, sidebar-dialog ignore, 0x0 hidden iframe bail-out, stale sessionStorage guard,
    //    and non-starving dom_empty timer under continuous mutations.
    parentPosts.length = 0;
    const regDocEl = makeNode('html');
    const regHead = makeNode('head');
    const regBody = makeNode('body');
    regDocEl.appendChild(regHead);
    regDocEl.appendChild(regBody);
    const regTimers: Array<{ id: number; fn: () => void }> = [];
    let regNextId = 1;
    const regMOs: Array<() => void> = [];
    class RegMO {
      private cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        regMOs.push(this.cb);
      }
      disconnect() {
        const idx = regMOs.indexOf(this.cb);
        if (idx >= 0) regMOs.splice(idx, 1);
      }
      takeRecords() {
        return [];
      }
    }
    const regWin: any = {
      innerWidth: 390,
      innerHeight: 844,
      location: {
        protocol: 'https:',
        hostname: 'antigravity.static.usercontent.goog',
        pathname: '/web/2.35.0/',
        search: '?iframe=true',
        href: 'https://antigravity.static.usercontent.goog/web/2.35.0/?iframe=true',
      },
      history: {
        pushState: (_s: any, _t: string, url: string) => {
          const parsed = new URL(url, 'https://antigravity.static.usercontent.goog');
          regWin.location.pathname = parsed.pathname;
          regWin.location.search = parsed.search;
          regWin.location.href = parsed.href;
        },
        replaceState: () => {},
      },
      parent: {
        postMessage: (msg: any, targetOrigin: string) => {
          parentPosts.push({ msg, targetOrigin });
        },
      },
      MutationObserver: RegMO,
      addEventListener: () => {},
      removeEventListener: () => {},
      // Stale sessionStorage from a prior session must NOT fire route_overview on initial load
      sessionStorage: {
        getItem: (k: string) =>
          k === '__agy_overview_last_route_v1'
            ? JSON.stringify({ kind: 'detail', scope: 'frame:/web/2.35.0', key: null })
            : null,
        setItem: () => {},
      },
    };
    const regDoc: any = {
      visibilityState: 'visible',
      head: regHead,
      documentElement: regDocEl,
      body: regBody,
      getElementById: (id: string) =>
        regHead.children.find((n) => n.attributes.id === id) ?? null,
      createElement: (tag: string) => makeNode(tag),
      querySelector: (sel: string) => regDocEl.querySelector(sel),
      querySelectorAll: (sel: string) => regDocEl.querySelectorAll(sel),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    vm.runInContext(
      PROJECT_OVERVIEW_SCROLL_SCRIPT,
      vm.createContext({
        window: regWin,
        document: regDoc,
        URL,
        URLSearchParams,
        setTimeout: (fn: () => void) => {
          const id = regNextId++;
          regTimers.push({ id, fn });
          return id;
        },
        clearTimeout: (id: number) => {
          const idx = regTimers.findIndex((t) => t.id === id);
          if (idx >= 0) regTimers.splice(idx, 1);
        },
      }),
    );
    // Stale sessionStorage did NOT false-fire on initial mount
    expect(parentPosts).toHaveLength(0);

    // Mount hidden desktop sidebar shell + progressbar -> still loading, must NOT emit yet
    const sidebarNav = makeNode('div', { role: 'navigation', 'aria-label': 'Sidebar' });
    const spinner = makeNode('div', { role: 'progressbar' });
    regBody.appendChild(sidebarNav);
    regBody.appendChild(spinner);
    expect(regWin.__agyOverviewScrollBridge.evaluateEmptyScreenDom()).toBe(false);
    regBody.removeChild(spinner);

    // With visible composer textarea on `/` -> NOT empty
    const composer = makeNode('textarea');
    regBody.appendChild(composer);
    expect(regWin.__agyOverviewScrollBridge.evaluateEmptyScreenDom()).toBe(false);
    regBody.removeChild(composer);

    // On 0x0 hidden iframe -> bails out cleanly
    regWin.innerWidth = 0;
    regWin.innerHeight = 0;
    expect(regWin.__agyOverviewScrollBridge.evaluateEmptyScreenDom()).toBe(false);
    regWin.innerWidth = 390;
    regWin.innerHeight = 844;

    // On `/?project=proj-1` -> excluded (composer route)
    regWin.location.search = '?project=proj-1';
    expect(regWin.__agyOverviewScrollBridge.evaluateEmptyScreenDom()).toBe(false);
    regWin.location.search = '?iframe=true';

    // With only hidden sidebar nav shell + sidebar-only dialog -> Case 1 fires `route_overview`!
    const sidebarDialog = makeNode('div', { role: 'dialog' });
    sidebarDialog.appendChild(makeNode('div', { role: 'navigation', 'aria-label': 'Sidebar' }));
    regBody.appendChild(sidebarDialog);
    expect(regWin.__agyOverviewScrollBridge.evaluateEmptyScreenDom()).toBe(true);
    expect(parentPosts).toContainEqual({
      msg: {
        type: 'AGY_REMOTE_EMPTY_SCREEN',
        reason: 'route_overview',
        subPath: '/',
        cascadeId: null,
      },
      targetOrigin: 'https://antigravity.google.com',
    });

    // Non-starving debounce: once conversation unmounts, subsequent mutations do NOT cancel & reset timer
    regBody.removeChild(sidebarDialog);
    regBody.removeChild(sidebarNav);
    regWin.history.pushState(null, '', '/web/2.35.0/c/t-starve?iframe=true');
    const liveConv = makeNode('div', { 'data-testid': 'conversation-view' });
    regBody.appendChild(liveConv);
    regWin.__agyOverviewScrollBridge.syncThreadProjectHeader();
    regBody.removeChild(liveConv);
    regTimers.length = 0;
    regWin.__agyOverviewScrollBridge.syncThreadProjectHeader();
    const firstTimerId = regTimers[0]?.id;
    expect(firstTimerId).toBeDefined();
    // Another mutation occurs while timer is pending -> original timer stays armed (not replaced!)
    regWin.__agyOverviewScrollBridge.syncThreadProjectHeader();
    expect(regTimers[0]?.id).toBe(firstTimerId);
  });
});
