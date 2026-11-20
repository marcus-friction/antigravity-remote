/**
 * Trusted-Types-safe Project Overview scroll-state preservation bridge.
 *
 * Why this exists:
 * - On mobile, Antigravity renders the Project Overview (`MOBILE_HOME_VIEW`) inside a
 *   TanStack Virtual scroll container (`[data-testid="conversation-list-sidebar"]`, or
 *   `[data-testid="conversation-list-history"]` on `/history`) at route `"/"` inside
 *   either `https://antigravity.static.usercontent.goog/web/<version>/?iframe=true`
 *   (remote-control workstation iframe) or `https://antigravity.google.com/remote`.
 * - Diving into a thread navigates the SPA router to `"/c/<cascadeId>"` (or
 *   `"/battle/<battleId>"`), unmounting the overview container. Returning via either
 *   the in-app `"Back to home"` arrow (`pushState` to `"/"`) or system back (`popstate`)
 *   remounts the overview container at `scrollTop = 0`.
 *
 * Security & CSP invariants:
 * - Executes strictly on `https://antigravity.static.usercontent.goog` (under `/web/`)
 *   and `https://antigravity.google.com`. Exits immediately on all other origins
 *   (including `accounts.google.com`).
 * - Never touches `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
 *   `<script>`, `eval`, or `new Function` (satisfies `require-trusted-types-for 'script'`).
 * - Stores only numeric scroll offsets in memory and origin-scoped `sessionStorage`,
 *   which is wiped by `clearWebData()` on Sign Out.
 */
export const PROJECT_OVERVIEW_SCROLL_SCRIPT = `
(function() {
  try {
    if (!window.location || window.location.protocol !== 'https:') {
      return true;
    }
    var hostname = window.location.hostname || '';
    var isWorkstationFrame = hostname === 'antigravity.static.usercontent.goog';
    var isHostFrame = hostname === 'antigravity.google.com';
    if (!isWorkstationFrame && !isHostFrame) {
      return true;
    }
    if (isWorkstationFrame) {
      var initialPath = window.location.pathname || '';
      if (initialPath !== '/web' && initialPath.indexOf('/web/') !== 0) {
        return true;
      }
    }

    if (window.__agyOverviewScrollBridge) {
      window.__agyOverviewScrollBridge.checkRoute();
      return true;
    }

    var STORAGE_PREFIX = '__agy_overview_scroll_v1:';
    var LAST_ROUTE_STORAGE_KEY = '__agy_overview_last_route_v1';
    var PRIMARY_OVERVIEW_SELECTOR =
      '[data-testid="conversation-list-sidebar"], ' +
      '[data-sidebar-scroll-container="true"], ' +
      '[data-testid="conversation-list-history"]';
    var RESTORE_WAIT_FOR_CONTAINER_MS = 4000;
    var RESTORE_ACTIVE_ADJUST_MAX_MS = 1400;
    var RESTORE_SETTLE_AFTER_MATCH_MS = 280;

    var memoryEntries = Object.create(null);
    var memoryLastRoute = null;
    var currentRoute = null;
    var isApplyingProgrammaticScroll = false;
    var activeRestoreCancel = null;

    function readSessionJson(key) {
      try {
        if (!window.sessionStorage) return null;
        var raw = window.sessionStorage.getItem(key);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch (_) {
        return null;
      }
    }

    function writeSessionJson(key, value) {
      try {
        if (!window.sessionStorage) return;
        window.sessionStorage.setItem(key, JSON.stringify(value));
      } catch (_) {}
    }

    function normalizeSubPath(rawSubPath) {
      var trimmed = String(rawSubPath || '').replace(/\\/+$/, '');
      return trimmed || '/';
    }

    function isDetailSubPath(subPath) {
      return (
        subPath.indexOf('/c/') === 0 ||
        subPath === '/c' ||
        subPath.indexOf('/battle/') === 0 ||
        subPath === '/battle' ||
        subPath.indexOf('/forked/') === 0 ||
        subPath.indexOf('/multi') === 0
      );
    }

    function classifyFrameRoute() {
      var pathname = (window.location && window.location.pathname) || '/';
      var search = (window.location && window.location.search) || '';

      if (isWorkstationFrame) {
        var webMatch = /^(\\/web\\/[^/]+)(\\/.*)?$/.exec(pathname);
        if (!webMatch) {
          return { kind: 'other', scope: 'frame', key: null };
        }
        var scope = 'frame:' + webMatch[1];
        var subPath = normalizeSubPath(webMatch[2] || '/');
        if (subPath === '/' || subPath === '/history') {
          return {
            kind: 'overview',
            scope: scope,
            key: scope + ':' + subPath
          };
        }
        if (isDetailSubPath(subPath)) {
          return { kind: 'detail', scope: scope, key: null };
        }
        return { kind: 'detail', scope: scope, key: null };
      }

      var stripped = pathname.replace(/^\\/u\\/\\d+(?=\\/|$)/, '') || '/';

      if (stripped === '/remote' || stripped === '/remote/' || stripped.indexOf('/remote/') === 0) {
        var remoteSub = normalizeSubPath(stripped.slice('/remote'.length) || '/');
        var remoteScope = 'remote';
        if (remoteSub === '/' || remoteSub === '/history') {
          return {
            kind: 'overview',
            scope: remoteScope,
            key: remoteScope + ':' + remoteSub
          };
        }
        return { kind: 'detail', scope: remoteScope, key: null };
      }

      var instanceMatch = /^\\/r\\/([^/?#]+)/.exec(stripped);
      if (instanceMatch) {
        var instanceScope = 'instance:' + instanceMatch[1];
        var pParam = '';
        try {
          pParam = new URLSearchParams(search).get('p') || '';
        } catch (_) {}
        var childSub = normalizeSubPath('/' + pParam.replace(/^\\/+/, ''));
        if (childSub === '/' || childSub === '/history') {
          return {
            kind: 'overview',
            scope: instanceScope,
            key: instanceScope + ':' + childSub
          };
        }
        return { kind: 'detail', scope: instanceScope, key: null };
      }

      var normalizedTop = normalizeSubPath(stripped);
      if (normalizedTop === '/') {
        return {
          kind: 'overview',
          scope: 'dashboard',
          key: 'dashboard:/'
        };
      }

      return { kind: 'detail', scope: 'dashboard', key: null };
    }

    function readSavedOffset(routeKey) {
      if (!routeKey) return null;
      var mem = memoryEntries[routeKey];
      var stored = readSessionJson(STORAGE_PREFIX + routeKey);
      var source = mem || stored;
      if (!source || typeof source !== 'object') return null;
      var primary = typeof source.primary === 'number' && isFinite(source.primary) && source.primary >= 0
        ? source.primary
        : 0;
      var outer = typeof source.outer === 'number' && isFinite(source.outer) && source.outer >= 0
        ? source.outer
        : 0;
      var doc = typeof source.doc === 'number' && isFinite(source.doc) && source.doc >= 0
        ? source.doc
        : 0;
      return { primary: primary, outer: outer, doc: doc };
    }

    function writeSavedOffset(routeKey, next) {
      if (!routeKey || !next) return;
      var clean = {
        primary: Math.max(0, Math.round(next.primary || 0)),
        outer: Math.max(0, Math.round(next.outer || 0)),
        doc: Math.max(0, Math.round(next.doc || 0))
      };
      memoryEntries[routeKey] = clean;
      writeSessionJson(STORAGE_PREFIX + routeKey, clean);
    }

    function readLastRouteRecord() {
      return memoryLastRoute || readSessionJson(LAST_ROUTE_STORAGE_KEY);
    }

    function writeLastRouteRecord(route) {
      if (!route) return;
      var record = {
        kind: route.kind,
        scope: route.scope,
        key: route.key || null
      };
      memoryLastRoute = record;
      writeSessionJson(LAST_ROUTE_STORAGE_KEY, record);
    }

    function findPrimaryOverviewContainer() {
      if (!document || typeof document.querySelector !== 'function') return null;
      return document.querySelector(PRIMARY_OVERVIEW_SELECTOR);
    }

    function isIgnoredAuxiliaryContainer(el) {
      if (!el || typeof el.closest !== 'function') return false;
      return Boolean(
        el.closest(
          '[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], textarea'
        )
      );
    }

    function isElementVerticallyScrollable(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el === document.body || el === document.documentElement) return false;
      if (isIgnoredAuxiliaryContainer(el)) return false;
      var cls = typeof el.className === 'string' ? el.className : '';
      if (cls.indexOf('overflow-y-auto') !== -1 || cls.indexOf('overflow-auto') !== -1) {
        return true;
      }
      if (typeof window.getComputedStyle === 'function') {
        try {
          var oy = window.getComputedStyle(el).overflowY;
          return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
        } catch (_) {}
      }
      return false;
    }

    function findOuterOverviewContainer(primaryEl) {
      if (primaryEl && primaryEl.parentElement) {
        var cursor = primaryEl.parentElement;
        while (cursor && cursor !== document.body && cursor !== document.documentElement) {
          if (isElementVerticallyScrollable(cursor)) {
            return cursor;
          }
          cursor = cursor.parentElement;
        }
      }
      if (!document || typeof document.querySelectorAll !== 'function') return null;
      var candidates = document.querySelectorAll('main, [class*="overflow-y-auto"]');
      for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        if (candidate !== primaryEl && isElementVerticallyScrollable(candidate)) {
          return candidate;
        }
      }
      return null;
    }

    function getDocumentScrollTop() {
      if (typeof window.scrollY === 'number' && window.scrollY > 0) {
        return window.scrollY;
      }
      var se = document && (document.scrollingElement || document.documentElement || document.body);
      return se && typeof se.scrollTop === 'number' ? se.scrollTop : 0;
    }

    function canAcceptZeroReset(el) {
      if (!el || !el.isConnected) return false;
      if (el.clientHeight <= 0) return false;
      return el.scrollHeight > el.clientHeight;
    }

    function snapshotLiveOverviewScroll(routeKey) {
      if (!routeKey || isApplyingProgrammaticScroll || activeRestoreCancel) return;
      var liveRoute = classifyFrameRoute();
      if (liveRoute.kind !== 'overview' || liveRoute.key !== routeKey) return;

      var prev = readSavedOffset(routeKey) || { primary: 0, outer: 0, doc: 0 };
      var nextPrimary = prev.primary;
      var nextOuter = prev.outer;
      var nextDoc = prev.doc;

      var primaryEl = findPrimaryOverviewContainer();
      if (primaryEl && primaryEl.isConnected) {
        var pTop = primaryEl.scrollTop || 0;
        if (pTop > 0 || canAcceptZeroReset(primaryEl)) {
          nextPrimary = pTop;
        }
      }

      var outerEl = findOuterOverviewContainer(primaryEl);
      if (outerEl && outerEl.isConnected) {
        var oTop = outerEl.scrollTop || 0;
        if (oTop > 0 || canAcceptZeroReset(outerEl)) {
          nextOuter = oTop;
        }
      }

      var dTop = getDocumentScrollTop();
      var docEl = document && (document.scrollingElement || document.documentElement);
      if (dTop > 0 || (docEl && docEl.scrollHeight > docEl.clientHeight)) {
        nextDoc = dTop;
      }

      writeSavedOffset(routeKey, {
        primary: nextPrimary,
        outer: nextOuter,
        doc: nextDoc
      });
    }

    function onScrollCapture(event) {
      if (isApplyingProgrammaticScroll || activeRestoreCancel) return;
      var liveRoute = classifyFrameRoute();
      if (liveRoute.kind !== 'overview' || !liveRoute.key) return;

      var target = event ? event.target : null;
      var prev = readSavedOffset(liveRoute.key) || { primary: 0, outer: 0, doc: 0 };
      var primaryEl = findPrimaryOverviewContainer();

      if (
        target === document ||
        target === document.documentElement ||
        target === document.body
      ) {
        var dTop = getDocumentScrollTop();
        var docEl = document.scrollingElement || document.documentElement;
        if (dTop === 0 && prev.doc > 0 && (!docEl || docEl.scrollHeight <= docEl.clientHeight)) {
          return;
        }
        writeSavedOffset(liveRoute.key, {
          primary: prev.primary,
          outer: prev.outer,
          doc: dTop
        });
        return;
      }

      if (!target || target.nodeType !== 1 || !target.isConnected) return;
      if (isIgnoredAuxiliaryContainer(target)) return;

      var top = target.scrollTop || 0;
      if (primaryEl && target === primaryEl) {
        if (top === 0 && prev.primary > 0 && !canAcceptZeroReset(target)) {
          return;
        }
        writeSavedOffset(liveRoute.key, {
          primary: top,
          outer: prev.outer,
          doc: prev.doc
        });
        return;
      }

      if (isElementVerticallyScrollable(target)) {
        if (top === 0 && prev.outer > 0 && !canAcceptZeroReset(target)) {
          return;
        }
        writeSavedOffset(liveRoute.key, {
          primary: prev.primary,
          outer: top,
          doc: prev.doc
        });
      }
    }

    function cancelActiveRestore() {
      if (typeof activeRestoreCancel === 'function') {
        var fn = activeRestoreCancel;
        activeRestoreCancel = null;
        fn();
      }
    }

    function applyOffsetOnce(saved) {
      var primarySatisfied = saved.primary <= 0;
      var outerSatisfied = saved.outer <= 0;
      var docSatisfied = saved.doc <= 0;

      isApplyingProgrammaticScroll = true;
      try {
        if (saved.primary > 0) {
          var primaryEl = findPrimaryOverviewContainer();
          if (primaryEl && primaryEl.isConnected && primaryEl.clientHeight > 0) {
            if (Math.abs(primaryEl.scrollTop - saved.primary) > 1) {
              primaryEl.scrollTop = saved.primary;
              try {
                primaryEl.dispatchEvent(new Event('scroll'));
              } catch (_) {}
            }
            if (Math.abs(primaryEl.scrollTop - saved.primary) <= 2) {
              primarySatisfied = true;
            }
          }
        }

        if (saved.outer > 0) {
          var outerEl = findOuterOverviewContainer(findPrimaryOverviewContainer());
          if (outerEl && outerEl.isConnected && outerEl.clientHeight > 0) {
            if (Math.abs(outerEl.scrollTop - saved.outer) > 1) {
              outerEl.scrollTop = saved.outer;
            }
            if (Math.abs(outerEl.scrollTop - saved.outer) <= 2) {
              outerSatisfied = true;
            }
          }
        }

        if (saved.doc > 0) {
          if (Math.abs(getDocumentScrollTop() - saved.doc) > 1) {
            window.scrollTo(0, saved.doc);
          }
          if (Math.abs(getDocumentScrollTop() - saved.doc) <= 2) {
            docSatisfied = true;
          }
        }
      } finally {
        isApplyingProgrammaticScroll = false;
      }

      return primarySatisfied && outerSatisfied && docSatisfied;
    }

    function scheduleRestoreForOverview(routeKey) {
      cancelActiveRestore();
      var saved = readSavedOffset(routeKey);
      if (!saved || (saved.primary <= 0 && saved.outer <= 0 && saved.doc <= 0)) {
        return;
      }

      var startedAt = Date.now();
      var containerSeenAt = null;
      var matchedAt = null;
      var cancelled = false;
      var rafId = null;
      var timeoutId = null;
      var mutationObserver = null;
      var mutationObservedRoot = null;
      var resizeObserver = null;
      var observedResizeTargets = [];

      function cleanup() {
        if (cancelled) return;
        cancelled = true;
        if (activeRestoreCancel === cleanup) {
          activeRestoreCancel = null;
        }
        if (rafId !== null && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (mutationObserver) {
          mutationObserver.disconnect();
          mutationObserver = null;
          mutationObservedRoot = null;
        }
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        observedResizeTargets = [];
        window.removeEventListener('touchstart', onUserInterrupt, true);
        window.removeEventListener('pointerdown', onUserInterrupt, true);
        window.removeEventListener('wheel', onUserInterrupt, true);
      }

      function onUserInterrupt() {
        cleanup();
        onPreInteractionCapture();
      }

      function ensureMutationObserverAttached() {
        if (
          mutationObservedRoot ||
          typeof window.MutationObserver !== 'function' ||
          !document ||
          !document.documentElement
        ) {
          return;
        }
        try {
          mutationObserver = new window.MutationObserver(function() {
            if (cancelled) return;
            var satisfied = applyOffsetOnce(saved);
            attachResizeTargets();
            if (satisfied && matchedAt === null) {
              matchedAt = Date.now();
            }
          });
          mutationObservedRoot = document.documentElement;
          mutationObserver.observe(mutationObservedRoot, {
            childList: true,
            subtree: true
          });
        } catch (_) {
          mutationObserver = null;
          mutationObservedRoot = null;
        }
      }

      function attachResizeTargets() {
        var primaryEl = findPrimaryOverviewContainer();
        if (primaryEl && containerSeenAt === null) {
          containerSeenAt = Date.now();
        }
        if (!resizeObserver || !primaryEl) return;
        var targets = [primaryEl];
        if (primaryEl.firstElementChild) {
          targets.push(primaryEl.firstElementChild);
        }
        for (var i = 0; i < targets.length; i++) {
          var t = targets[i];
          if (observedResizeTargets.indexOf(t) === -1) {
            observedResizeTargets.push(t);
            try {
              resizeObserver.observe(t);
            } catch (_) {}
          }
        }
      }

      function step() {
        if (cancelled) return;
        var live = classifyFrameRoute();
        if (live.kind !== 'overview' || live.key !== routeKey) {
          cleanup();
          return;
        }

        var now = Date.now();
        ensureMutationObserverAttached();
        var allSatisfied = applyOffsetOnce(saved);
        attachResizeTargets();

        if (allSatisfied) {
          if (containerSeenAt === null) {
            containerSeenAt = now;
          }
          if (matchedAt === null) {
            matchedAt = now;
          } else if (now - matchedAt >= RESTORE_SETTLE_AFTER_MATCH_MS) {
            cleanup();
            return;
          }
        } else {
          matchedAt = null;
        }

        if (
          containerSeenAt !== null &&
          now - containerSeenAt >= RESTORE_ACTIVE_ADJUST_MAX_MS
        ) {
          cleanup();
          return;
        }

        if (now - startedAt >= RESTORE_WAIT_FOR_CONTAINER_MS) {
          cleanup();
          return;
        }

        if (typeof window.requestAnimationFrame === 'function') {
          rafId = window.requestAnimationFrame(step);
        }
      }

      activeRestoreCancel = cleanup;

      window.addEventListener('touchstart', onUserInterrupt, { capture: true, passive: true });
      window.addEventListener('pointerdown', onUserInterrupt, { capture: true, passive: true });
      window.addEventListener('wheel', onUserInterrupt, { capture: true, passive: true });

      if (typeof window.ResizeObserver === 'function') {
        try {
          resizeObserver = new window.ResizeObserver(function() {
            if (!cancelled) {
              applyOffsetOnce(saved);
            }
          });
        } catch (_) {
          resizeObserver = null;
        }
      }

      ensureMutationObserverAttached();
      timeoutId = setTimeout(cleanup, RESTORE_WAIT_FOR_CONTAINER_MS + 50);
      step();
    }

    function checkRoute() {
      var nextRoute = classifyFrameRoute();
      var prevRoute = currentRoute || readLastRouteRecord();

      if (
        currentRoute &&
        currentRoute.kind === 'overview' &&
        currentRoute.key &&
        (nextRoute.kind !== 'overview' || nextRoute.key !== currentRoute.key)
      ) {
        // Leaving overview: do not touch DOM (which may already be tearing down),
        // rely on captured scroll/pointerdown snapshot.
        cancelActiveRestore();
      }

      var enteringOverviewFromOtherRoute =
        nextRoute.kind === 'overview' &&
        Boolean(nextRoute.key) &&
        Boolean(prevRoute) &&
        (prevRoute.kind === 'detail' ||
          (prevRoute.kind === 'overview' && prevRoute.key !== nextRoute.key));

      currentRoute = nextRoute;
      writeLastRouteRecord(nextRoute);

      if (enteringOverviewFromOtherRoute && nextRoute.key) {
        scheduleRestoreForOverview(nextRoute.key);
      }
      if (typeof hideAntigravitySidebarNodes === 'function') {
        hideAntigravitySidebarNodes();
      }
    }

    function onPreInteractionCapture() {
      if (activeRestoreCancel || isApplyingProgrammaticScroll) return;
      var route = classifyFrameRoute();
      if (route.kind === 'overview' && route.key) {
        snapshotLiveOverviewScroll(route.key);
      }
    }

    function wrapHistoryMethod(methodName) {
      if (!window.history || typeof window.history[methodName] !== 'function') return;
      var original = window.history[methodName];
      if (original.__agyScrollWrapped) return;
      var wrapped = function() {
        var routeBefore = classifyFrameRoute();
        if (routeBefore.kind === 'overview' && routeBefore.key && !activeRestoreCancel) {
          snapshotLiveOverviewScroll(routeBefore.key);
        }
        var result = original.apply(this, arguments);
        try {
          checkRoute();
        } catch (_) {}
        return result;
      };
      wrapped.__agyScrollWrapped = true;
      window.history[methodName] = wrapped;
    }

    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');

    document.addEventListener('scroll', onScrollCapture, { capture: true, passive: true });
    document.addEventListener('pointerdown', onPreInteractionCapture, { capture: true, passive: true });
    document.addEventListener('touchstart', onPreInteractionCapture, { capture: true, passive: true });
    document.addEventListener('keydown', onPreInteractionCapture, { capture: true, passive: true });

    window.addEventListener('popstate', function() {
      checkRoute();
    });
    window.addEventListener('pageshow', function() {
      checkRoute();
    });
    try {
      if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('currententrychange', function() {
          checkRoute();
        });
      }
    } catch (_) {}

    var HIDE_SIDEBAR_STYLE_ID = '__agy_remote_hide_antigravity_sidebar';
    var HIDE_SIDEBAR_CSS = [
      '[role="navigation"][aria-label="Sidebar"],',
      '[data-testid="conversation-list-sidebar"],',
      '[data-testid="mobile-home-concierge"],',
      '[data-testid="sidebar-popover-backdrop"],',
      '[data-testid="sidebar-sash"],',
      '[data-testid="sidebar-peek-hot-zone"],',
      '[role="dialog"]:has([role="navigation"][aria-label="Sidebar"]),',
      '[data-sidebar-scroll-container="true"]:not([data-testid="settings-sidebar"] *):not([role="dialog"] *),',
      '[data-testid="sidebar-toggle"]:not([data-testid="aux-pane-split"] *),',
      '[data-testid="sidebar-toggle-button"],',
      '[data-testid="sidebar-search-button"],',
      'button[aria-label="Toggle Sidebar" i]:not([data-testid="aux-pane-split"] *),',
      'button[aria-label="Open Sidebar" i],',
      'button[aria-label="Close Sidebar" i] {',
      '  display: none !important;',
      '  visibility: hidden !important;',
      '  pointer-events: none !important;',
      '}',
      '.agy-layout-vars, .agy-portaled-layout-vars {',
      '  --sidebar-width: 0px !important;',
      '}',
      'div:has(> [role="navigation"][aria-label="Sidebar"]):not(:has([data-testid="conversation-view"], main, textarea, [contenteditable="true"])) {',
      '  display: none !important;',
      '  width: 0 !important;',
      '  min-width: 0 !important;',
      '  max-width: 0 !important;',
      '  flex: 0 0 0 !important;',
      '}',
      'div:has(> [role="navigation"][aria-label="Sidebar"]) + [role="separator"] {',
      '  display: none !important;',
      '}',
      'div[data-media-drop-scope]:has(> [data-sidebar-scroll-container="true"]) {',
      '  justify-content: flex-end !important;',
      '}'
    ].join('\\n');

    function shouldHideAntigravitySidebarInFrame() {
      if (isWorkstationFrame) return true;
      var p = (window.location && window.location.pathname) || '';
      var strippedPath = p.replace(/^\\/u\\/\\d+(?=\\/|$)/, '');
      return strippedPath === '/remote' || strippedPath.indexOf('/remote/') === 0;
    }

    function ensureHideSidebarStyle() {
      if (!shouldHideAntigravitySidebarInFrame()) return;
      if (!document || typeof document.createElement !== 'function') return;
      try {
        var existing =
          typeof document.getElementById === 'function'
            ? document.getElementById(HIDE_SIDEBAR_STYLE_ID)
            : null;
        if (!existing) {
          var styleEl = document.createElement('style');
          styleEl.id = HIDE_SIDEBAR_STYLE_ID;
          styleEl.textContent = HIDE_SIDEBAR_CSS;
          var targetRoot = document.head || document.documentElement;
          if (targetRoot && typeof targetRoot.appendChild === 'function') {
            targetRoot.appendChild(styleEl);
          }
        }
      } catch (_) {}
    }

    function hideAntigravitySidebarNodes() {
      if (!shouldHideAntigravitySidebarInFrame()) return;
      ensureHideSidebarStyle();
      if (!document || typeof document.querySelectorAll !== 'function') return;
      try {
        var navSidebars = document.querySelectorAll('[role="navigation"][aria-label="Sidebar"]');
        for (var i = 0; i < navSidebars.length; i++) {
          var nav = navSidebars[i];
          if (nav && nav.style && typeof nav.style.setProperty === 'function') {
            nav.style.setProperty('display', 'none', 'important');
          }
          // Collapse the outer resizable sidebar column wrapper if it exclusively hosts the sidebar.
          var wrapper = nav ? nav.parentElement : null;
          var depth = 0;
          while (wrapper && wrapper !== document.body && wrapper !== document.documentElement && depth < 3) {
            depth++;
            var hasMainContent =
              typeof wrapper.querySelector === 'function' &&
              Boolean(
                wrapper.querySelector(
                  '[data-testid="conversation-view"], [data-media-drop-scope], main, textarea, [contenteditable="true"]'
                )
              );
            if (hasMainContent) break;
            if (wrapper.style && typeof wrapper.style.setProperty === 'function') {
              wrapper.style.setProperty('display', 'none', 'important');
              wrapper.style.setProperty('width', '0px', 'important');
              wrapper.style.setProperty('min-width', '0px', 'important');
            }
            var nextSib = wrapper.nextElementSibling;
            if (
              nextSib &&
              typeof nextSib.getAttribute === 'function' &&
              (nextSib.getAttribute('role') === 'separator' ||
                (typeof nextSib.className === 'string' && nextSib.className.indexOf('cursor-col-resize') !== -1))
            ) {
              if (nextSib.style && typeof nextSib.style.setProperty === 'function') {
                nextSib.style.setProperty('display', 'none', 'important');
              }
            }
            wrapper = wrapper.parentElement;
          }
        }

        var mobileSidebars = document.querySelectorAll('[data-sidebar-scroll-container="true"]');
        for (var j = 0; j < mobileSidebars.length; j++) {
          var sc = mobileSidebars[j];
          if (!sc) continue;
          if (
            typeof sc.closest === 'function' &&
            sc.closest('[data-testid="settings-sidebar"], [role="dialog"]')
          ) {
            continue;
          }
          var scParent = sc.parentElement;
          if (
            scParent &&
            typeof scParent.hasAttribute === 'function' &&
            scParent.hasAttribute('data-media-drop-scope') &&
            scParent.style &&
            typeof scParent.style.setProperty === 'function'
          ) {
            scParent.style.setProperty('justify-content', 'flex-end', 'important');
          }
        }
      } catch (_) {}
    }

    function requestNativeDrawerFromFrame(mode) {
      try {
        if (isWorkstationFrame && window.parent && window.parent !== window) {
          window.parent.postMessage(
            { type: 'AGY_REMOTE_OPEN_DRAWER', mode: mode || 'inbox' },
            'https://antigravity.google.com'
          );
          return;
        }
        if (
          window.ReactNativeWebView &&
          typeof window.ReactNativeWebView.postMessage === 'function'
        ) {
          window.ReactNativeWebView.postMessage(
            JSON.stringify({
              type: 'AGY_INBOX_OPEN_DRAWER_REQUEST',
              mode: mode || 'inbox'
            })
          );
        }
      } catch (_) {}
    }

    function onInterceptBackToHomeClick(event) {
      if (!shouldHideAntigravitySidebarInFrame()) return;
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') return;
      var backBtn = target.closest('[data-testid="mobile-back-to-home"], button[aria-label="Back to home"]');
      if (!backBtn) {
        var sidebarToggle = target.closest('[data-testid="sidebar-toggle"]');
        if (
          sidebarToggle &&
          !(typeof sidebarToggle.closest === 'function' && sidebarToggle.closest('[data-testid="aux-pane-split"]'))
        ) {
          backBtn = sidebarToggle;
        }
      }
      if (!backBtn) return;
      try {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      } catch (_) {}
      requestNativeDrawerFromFrame('inbox');
    }

    document.addEventListener('click', onInterceptBackToHomeClick, { capture: true });
    hideAntigravitySidebarNodes();
    if (document && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', function() {
        hideAntigravitySidebarNodes();
      });
    }
    window.addEventListener('load', function() {
      hideAntigravitySidebarNodes();
    });

    checkRoute();

    window.__agyOverviewScrollBridge = {
      checkRoute: checkRoute,
      readSavedOffset: readSavedOffset,
      snapshotLiveOverviewScroll: snapshotLiveOverviewScroll,
      cancelActiveRestore: cancelActiveRestore,
      hideAntigravitySidebarNodes: hideAntigravitySidebarNodes
    };
  } catch (_) {}
  return true;
})();
`;

/**
 * Navigates back to the Project Overview inside the active workstation iframe
 * (or standalone `/remote` route) when the user dived into a thread via SPA
 * routing and presses Android hardware Back without a top-frame history entry.
 */
export function buildReturnToOverviewScript(): string {
  return `
(function() {
  try {
    if (!window.location || window.location.hostname !== 'antigravity.google.com') {
      return true;
    }
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      if (
        frame &&
        frame.contentWindow &&
        typeof frame.src === 'string' &&
        frame.src.indexOf('https://antigravity.static.usercontent.goog/web/') === 0
      ) {
        var frameOrigin = new URL(frame.src).origin;
        frame.contentWindow.postMessage(
          { jspbPayload: JSON.stringify([null, ['/']]) },
          frameOrigin
        );
        return true;
      }
    }
    if (window.history && window.history.length > 1) {
      window.history.back();
    }
  } catch (_) {}
  return true;
})();
`;
}
