/**
 * Trusted-Types-safe WebView bridge injected into `https://antigravity.google.com`.
 *
 * Security & CSP invariants:
 * - Executes strictly when `window.location.hostname === 'antigravity.google.com'`.
 * - Never touches `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
 *   `<script>` injection, `eval`, or `new Function` (satisfies `require-trusted-types-for 'script'`).
 * - Reuses the host page's first-party / enterprise gRPC-Web `ApiServicePromiseClient`
 *   to query `ListInstances` and `ProxyCommand` (`GetAllCascadeTrajectories` &
 *   `UpdateConversationAnnotations`) across all connected workstations.
 * - Never transmits data outside the local `window.ReactNativeWebView.postMessage` channel.
 */
export const INBOX_BRIDGE_SCRIPT = `
(function() {
  try {
    if (!window.location || window.location.hostname !== 'antigravity.google.com') {
      return true;
    }
    if (window.__agyInboxBridge) {
      window.__agyInboxBridge.installHooks();
      window.__agyInboxBridge.scheduleRefresh(150);
      return true;
    }

    var GET_TRAJECTORIES_PATH = '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories';
    var UPDATE_ANNOTATIONS_PATH = '/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations';
    var POLL_INTERVAL_MS = 20000;
    var INSTANCE_RPC_TIMEOUT_MS = 8000;
    var SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/;

    var capturedApiClient = null;
    var capturedMetadata = null;
    var standaloneApiClient = null;
    var cachedProtoNs = null;
    var cachedAuthFirstParty = null;
    var cachedApiKey = null;
    var lastTrajectoryCache = Object.create(null);
    var cloudTrajectoriesCache = null;
    var activeIframeCascadeId = null;
    var activeIframeLocationHref = null;
    var hasIframeRouteOverride = false;
    var pendingFastNav = null;
    var FAST_NAV_CONFIRM_MS = 380;
    var refreshTimer = null;
    var inFlightRefresh = null;

    function setIframeCascadeOverride(cascadeId) {
      activeIframeCascadeId = cascadeId || null;
      activeIframeLocationHref = (window.location && window.location.href) || '';
      hasIframeRouteOverride = true;
    }

    function postToNative(payload) {
      try {
        if (
          window.ReactNativeWebView &&
          typeof window.ReactNativeWebView.postMessage === 'function'
        ) {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      } catch (_) {}
    }

    function getAccountSessionIndex() {
      try {
        var match = /^\\/u\\/(\\d+)(?:\\/|$)/.exec(window.location.pathname || '');
        return match ? match[1] : '0';
      } catch (_) {
        return '0';
      }
    }

    function parseRouteFromLocation() {
      var currentHref = (window.location && window.location.href) || '';
      if (hasIframeRouteOverride && currentHref !== activeIframeLocationHref) {
        activeIframeCascadeId = null;
        activeIframeLocationHref = null;
        hasIframeRouteOverride = false;
      }
      var pathname = (window.location && window.location.pathname) || '';
      var stripped = pathname.replace(/^\\/u\\/\\d+(?=\\/|$)/, '');
      var instanceMatch = /^\\/r\\/([^/?#]+)/.exec(stripped);
      if (instanceMatch) {
        var uuid = decodeURIComponent(instanceMatch[1]);
        var search = (window.location && window.location.search) || '';
        var pVal = '';
        try {
          pVal = new URLSearchParams(search).get('p') || '';
        } catch (_) {}
        var cleanChild = pVal.replace(/^\\/+/, '');
        var cMatch = /^c\\/([a-zA-Z0-9._-]+)(?:[/?#]|$)/.exec(cleanChild);
        return {
          instanceUuid: SAFE_ID_RE.test(uuid) ? uuid : null,
          cascadeId: hasIframeRouteOverride
            ? activeIframeCascadeId
            : (cMatch && cMatch[1]) || null
        };
      }
      var cloudMatch = /^\\/remote\\/c\\/([a-zA-Z0-9._-]+)(?:[/?#]|$)/.exec(stripped);
      if (cloudMatch) {
        return {
          instanceUuid: '__cloud__',
          cascadeId: cloudMatch[1]
        };
      }
      return { instanceUuid: null, cascadeId: null };
    }

    function discoverHostNamespaces() {
      if (cachedProtoNs && cachedProtoNs.ApiServicePromiseClient) {
        return cachedProtoNs;
      }
      if (
        window.devtools_jetski_boq_api_proto &&
        window.devtools_jetski_boq_api_proto.ApiServicePromiseClient
      ) {
        cachedProtoNs = window.devtools_jetski_boq_api_proto;
        return cachedProtoNs;
      }
      var ag = window.default_GoogleAntigravity;
      if (!ag || typeof ag !== 'object') {
        return null;
      }
      if (
        ag.K &&
        ag.K.devtools_jetski_boq_api_proto &&
        ag.K.devtools_jetski_boq_api_proto.ApiServicePromiseClient
      ) {
        cachedProtoNs = ag.K.devtools_jetski_boq_api_proto;
      }
      if (ag.pj && ag.pj.auth_firstparty) {
        cachedAuthFirstParty = ag.pj.auth_firstparty;
      }
      if (ag.nj && ag.nj.ConfigService && ag.nj.ConfigService.API_KEY) {
        cachedApiKey = ag.nj.ConfigService.API_KEY;
      }

      var keys = [];
      try {
        keys = Object.keys(ag);
      } catch (_) {}
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var entry = null;
        try {
          entry = ag[key];
        } catch (_) {
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;

        if (
          !cachedProtoNs &&
          entry.devtools_jetski_boq_api_proto &&
          entry.devtools_jetski_boq_api_proto.ApiServicePromiseClient
        ) {
          cachedProtoNs = entry.devtools_jetski_boq_api_proto;
        }
        if (!cachedAuthFirstParty && entry.auth_firstparty) {
          cachedAuthFirstParty = entry.auth_firstparty;
        }
        if (
          !cachedApiKey &&
          entry.ConfigService &&
          typeof entry.ConfigService.API_KEY === 'string'
        ) {
          cachedApiKey = entry.ConfigService.API_KEY;
        }
        if (
          entry.GrpcClientService &&
          entry.GrpcClientService.prototype &&
          typeof entry.GrpcClientService.prototype.getClient === 'function' &&
          !entry.GrpcClientService.prototype.getClient.__agyWrapped
        ) {
          var origGetClient = entry.GrpcClientService.prototype.getClient;
          var wrappedGetClient = function() {
            var c = origGetClient.apply(this, arguments);
            if (c) capturedApiClient = c;
            return c;
          };
          wrappedGetClient.__agyWrapped = true;
          entry.GrpcClientService.prototype.getClient = wrappedGetClient;
        }
        if (
          entry.google &&
          entry.google.gca &&
          entry.google.gca.aicode &&
          entry.google.gca.aicode.v1alpha &&
          entry.google.gca.aicode.v1alpha.JetskiRemoteAgentProxyServiceImmutablePromiseClient
        ) {
          hookRemoteAgentClient(
            entry.google.gca.aicode.v1alpha.JetskiRemoteAgentProxyServiceImmutablePromiseClient
          );
        }
      }
      return cachedProtoNs;
    }

    function hookRemoteAgentClient(ClientCtor) {
      if (!ClientCtor || !ClientCtor.prototype || ClientCtor.prototype.__agyHooked) {
        return;
      }
      ClientCtor.prototype.__agyHooked = true;
      var origList = ClientCtor.prototype.listConversations;
      if (typeof origList === 'function') {
        ClientCtor.prototype.listConversations = function() {
          var p = origList.apply(this, arguments);
          if (p && typeof p.then === 'function') {
            p.then(function(res) {
              try {
                if (res && typeof res.getConversationsList === 'function') {
                  var list = res.getConversationsList() || [];
                  var mapped = Object.create(null);
                  for (var i = 0; i < list.length; i++) {
                    var conv = list[i];
                    var tid =
                      (typeof conv.getTrajectoryId === 'function' && conv.getTrajectoryId()) ||
                      (typeof conv.getId === 'function' && conv.getId()) ||
                      '';
                    if (!tid || !SAFE_ID_RE.test(tid)) continue;
                    var title =
                      (typeof conv.getTitle === 'function' && conv.getTitle()) ||
                      (typeof conv.getSummary === 'function' && conv.getSummary()) ||
                      '';
                    mapped[tid] = {
                      trajectoryId: tid,
                      summary: title
                    };
                  }
                  cloudTrajectoriesCache = mapped;
                  scheduleRefresh(200);
                }
              } catch (_) {}
            }).catch(function() {});
          }
          return p;
        };
      }
    }

    function installHooks() {
      var proto = discoverHostNamespaces();
      if (!proto || !proto.ApiServicePromiseClient) {
        return false;
      }
      var Ctor = proto.ApiServicePromiseClient;
      if (Ctor.prototype && !Ctor.prototype.__agyHooked) {
        Ctor.prototype.__agyHooked = true;
        var methodNames = [
          'listInstances',
          'proxyCommand',
          'streamProxyCommand',
          'recordClientEvent',
          'recordTrajectoryAnalytics',
          'registerWebPush',
          'notifyUser',
          'updateInstance',
          'deleteInstance'
        ];
        for (var i = 0; i < methodNames.length; i++) {
          (function(methodName) {
            var orig = Ctor.prototype[methodName];
            if (typeof orig !== 'function') return;
            Ctor.prototype[methodName] = function() {
              if (this) {
                capturedApiClient = this;
              }
              var callMeta = arguments.length > 1 ? arguments[1] : null;
              if (callMeta && typeof callMeta === 'object') {
                try {
                  var copy = Object.create(null);
                  var mKeys = Object.keys(callMeta);
                  for (var k = 0; k < mKeys.length; k++) {
                    var mk = mKeys[k];
                    if (typeof callMeta[mk] === 'string') {
                      copy[mk] = callMeta[mk];
                    }
                  }
                  capturedMetadata = copy;
                } catch (_) {}
              }
              return orig.apply(this, arguments);
            };
          })(methodNames[i]);
        }
      }
      return true;
    }

    function readCookieValue(name) {
      var raw = (document && document.cookie) || '';
      if (!raw) return '';
      var parts = raw.split(';');
      var prefix = name + '=';
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim();
        if (part.indexOf(prefix) === 0) {
          return part.substring(prefix.length);
        }
      }
      return '';
    }

    function sha1Hex(input) {
      if (
        !window.crypto ||
        !window.crypto.subtle ||
        typeof window.crypto.subtle.digest !== 'function' ||
        typeof TextEncoder !== 'function'
      ) {
        return Promise.resolve('');
      }
      var bytes = new TextEncoder().encode(input);
      return window.crypto.subtle.digest('SHA-1', bytes).then(function(buf) {
        var arr = new Uint8Array(buf);
        var hex = '';
        for (var i = 0; i < arr.length; i++) {
          var h = arr[i].toString(16);
          hex += h.length === 1 ? '0' + h : h;
        }
        return hex;
      }).catch(function() {
        return '';
      });
    }

    function buildStandaloneAuthHeader() {
      try {
        if (
          cachedAuthFirstParty &&
          typeof cachedAuthFirstParty.getAuthHeaderValueForFirstParty === 'function'
        ) {
          var builtIn = cachedAuthFirstParty.getAuthHeaderValueForFirstParty([]);
          if (builtIn) {
            return Promise.resolve(builtIn);
          }
        }
      } catch (_) {}

      var origin = window.location.origin;
      var nowSec = Math.floor(Date.now() / 1000);
      var schemes = [
        { cookie: 'SAPISID', scheme: 'SAPISIDHASH' },
        { cookie: '__Secure-1PAPISID', scheme: 'SAPISID1PHASH' },
        { cookie: '__Secure-3PAPISID', scheme: 'SAPISID3PHASH' }
      ];
      var tasks = [];
      for (var i = 0; i < schemes.length; i++) {
        (function(item) {
          var val = readCookieValue(item.cookie);
          if (!val) return;
          tasks.push(
            sha1Hex(nowSec + ' ' + val + ' ' + origin).then(function(hash) {
              return hash ? item.scheme + ' ' + nowSec + '_' + hash : '';
            })
          );
        })(schemes[i]);
      }
      if (tasks.length === 0) {
        return Promise.resolve('');
      }
      return Promise.all(tasks).then(function(tokens) {
        return tokens.filter(Boolean).join(' ');
      });
    }

    function getClientWithMetadata() {
      var proto = discoverHostNamespaces();
      if (!proto || !proto.ApiServicePromiseClient) {
        return Promise.resolve(null);
      }
      installHooks();

      if (capturedApiClient) {
        var meta = Object.create(null);
        if (capturedMetadata) {
          var capKeys = Object.keys(capturedMetadata);
          for (var c = 0; c < capKeys.length; c++) {
            meta[capKeys[c]] = capturedMetadata[capKeys[c]];
          }
        }
        return Promise.resolve({
          proto: proto,
          client: capturedApiClient,
          metadata: meta
        });
      }

      if (!standaloneApiClient) {
        standaloneApiClient = new proto.ApiServicePromiseClient(
          window.location.origin,
          null,
          {
            format: 'binary',
            withCredentials: true,
            credentials: 'include'
          }
        );
      }

      return buildStandaloneAuthHeader().then(function(authHeader) {
        var meta = Object.create(null);
        if (capturedMetadata) {
          var cmKeys = Object.keys(capturedMetadata);
          for (var m = 0; m < cmKeys.length; m++) {
            meta[cmKeys[m]] = capturedMetadata[cmKeys[m]];
          }
        }
        meta['X-Origin'] = window.location.origin;
        meta['X-Referer'] = window.location.origin;
        meta['X-Goog-Encode-Response-If-Executable'] = 'base64';
        if (cachedApiKey) {
          meta['X-Goog-Api-Key'] = cachedApiKey;
        }
        meta['X-Goog-AuthUser'] = getAccountSessionIndex();
        if (authHeader) {
          meta['Authorization'] = authHeader;
        }
        return {
          proto: proto,
          client: standaloneApiClient,
          metadata: meta
        };
      });
    }

    function withTimeout(promise, timeoutMs, label) {
      return new Promise(function(resolve, reject) {
        var settled = false;
        var timer = setTimeout(function() {
          if (!settled) {
            settled = true;
            reject(new Error(label || 'RPC timeout'));
          }
        }, timeoutMs);
        promise.then(
          function(value) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(value);
            }
          },
          function(err) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err);
            }
          }
        );
      });
    }

    function decodeResponseBytes(responseObj) {
      if (!responseObj) return '';
      if (typeof responseObj.getPayload_asU8 === 'function') {
        var bytes = responseObj.getPayload_asU8();
        if (bytes && bytes.length > 0 && typeof TextDecoder === 'function') {
          return new TextDecoder('utf-8').decode(bytes);
        }
      }
      if (typeof responseObj.getPayload_asB64 === 'function') {
        var b64 = responseObj.getPayload_asB64();
        if (b64 && typeof atob === 'function') {
          var bin = atob(b64);
          var out = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) {
            out[i] = bin.charCodeAt(i);
          }
          if (typeof TextDecoder === 'function') {
            return new TextDecoder('utf-8').decode(out);
          }
        }
      }
      if (typeof responseObj.getPayload === 'function') {
        var raw = responseObj.getPayload();
        if (typeof raw === 'string' && raw) {
          try {
            var decodedBin = atob(raw);
            var u8 = new Uint8Array(decodedBin.length);
            for (var j = 0; j < decodedBin.length; j++) {
              u8[j] = decodedBin.charCodeAt(j);
            }
            return new TextDecoder('utf-8').decode(u8);
          } catch (_) {
            return raw;
          }
        }
      }
      return '';
    }

    function callProxyJson(ctx, targetUuid, rpcPath, jsonBody) {
      var req = new ctx.proto.ProxyCommandRequest();
      req.setTargetInstanceUuid(targetUuid);
      req.setRpcPath(rpcPath);
      if (typeof TextEncoder === 'function') {
        req.setPayload(new TextEncoder().encode(jsonBody));
      }
      if (typeof req.putHeaders === 'function') {
        req.putHeaders('content-type', 'application/json');
        req.putHeaders('connect-protocol-version', '1');
      } else if (typeof req.getHeadersMap === 'function') {
        var map = req.getHeadersMap();
        if (map && typeof map.set === 'function') {
          map.set('content-type', 'application/json');
          map.set('connect-protocol-version', '1');
        }
      }
      return withTimeout(
        ctx.client.proxyCommand(req, ctx.metadata),
        INSTANCE_RPC_TIMEOUT_MS,
        'ProxyCommand timeout'
      ).then(function(res) {
        var text = decodeResponseBytes(res);
        if (!text) return Object.create(null);
        return JSON.parse(text);
      });
    }

    function refresh() {
      if (inFlightRefresh) {
        return inFlightRefresh;
      }
      inFlightRefresh = getClientWithMetadata()
        .then(function(ctx) {
          if (!ctx) {
            return null;
          }
          var listReq = new ctx.proto.ListInstancesRequest();
          return withTimeout(
            ctx.client.listInstances(listReq, ctx.metadata),
            INSTANCE_RPC_TIMEOUT_MS,
            'ListInstances timeout'
          ).then(function(listRes) {
            var rawList =
              listRes && typeof listRes.getInstancesList === 'function'
                ? listRes.getInstancesList() || []
                : [];
            var route = parseRouteFromLocation();
            var instanceJobs = [];

            for (var i = 0; i < rawList.length; i++) {
              (function(inst) {
                var uuid =
                  typeof inst.getUuid === 'function' ? inst.getUuid() : '';
                if (!uuid || !SAFE_ID_RE.test(uuid)) return;
                var status =
                  typeof inst.getStatus === 'function' ? inst.getStatus() : 0;
                var meta =
                  typeof inst.getMetadata === 'function'
                    ? inst.getMetadata()
                    : null;
                var name =
                  meta && typeof meta.getName === 'function'
                    ? meta.getName()
                    : '';
                var version =
                  meta && typeof meta.getVersion === 'function'
                    ? meta.getVersion()
                    : '';
                var updatedWrapper =
                  typeof inst.getStatusLastUpdatedAt === 'function'
                    ? inst.getStatusLastUpdatedAt()
                    : null;
                var updatedSec =
                  updatedWrapper && typeof updatedWrapper.getSeconds === 'function'
                    ? Number(updatedWrapper.getSeconds())
                    : 0;
                var updatedAtMs =
                  updatedSec > 0 ? Math.floor(updatedSec * 1000) : undefined;

                var shouldQuery =
                  status === 1 ||
                  (route.instanceUuid === uuid && status !== 2);

                if (!shouldQuery) {
                  delete lastTrajectoryCache[uuid];
                  instanceJobs.push(
                    Promise.resolve({
                      uuid: uuid,
                      name: name || uuid,
                      status: status,
                      version: version || undefined,
                      updatedAtMs: updatedAtMs,
                      trajectories: null
                    })
                  );
                  return;
                }

                instanceJobs.push(
                  callProxyJson(ctx, uuid, GET_TRAJECTORIES_PATH, '{}')
                    .then(function(parsed) {
                      var summaries =
                        (parsed &&
                          (parsed.trajectorySummaries ||
                            parsed.trajectory_summaries)) ||
                        parsed ||
                        Object.create(null);
                      lastTrajectoryCache[uuid] = summaries;
                      return {
                        uuid: uuid,
                        name: name || uuid,
                        status: status,
                        version: version || undefined,
                        updatedAtMs: updatedAtMs,
                        trajectories: summaries
                      };
                    })
                    .catch(function(err) {
                      return {
                        uuid: uuid,
                        name: name || uuid,
                        status: status,
                        version: version || undefined,
                        updatedAtMs: updatedAtMs,
                        trajectories: lastTrajectoryCache[uuid] || null,
                        error: err && err.message ? String(err.message) : 'Unreachable'
                      };
                    })
                );
              })(rawList[i]);
            }

            return Promise.all(instanceJobs).then(function(instancesPayload) {
              var latestRoute = parseRouteFromLocation();
              postToNative({
                type: 'AGY_INBOX_SNAPSHOT',
                fetchedAtMs: Date.now(),
                activeUrl: window.location.href,
                activeInstanceUuid: latestRoute.instanceUuid,
                activeCascadeId: latestRoute.cascadeId,
                instances: instancesPayload,
                cloudTrajectories: cloudTrajectoriesCache,
                error: null
              });
            });
          });
        })
        .catch(function(err) {
          var latestRoute = parseRouteFromLocation();
          postToNative({
            type: 'AGY_INBOX_SNAPSHOT',
            fetchedAtMs: Date.now(),
            activeUrl: window.location.href,
            activeInstanceUuid: latestRoute.instanceUuid,
            activeCascadeId: latestRoute.cascadeId,
            instances: [],
            cloudTrajectories: cloudTrajectoriesCache,
            error: err && err.message ? String(err.message) : 'Unable to query Antigravity instances'
          });
        })
        .then(function() {
          inFlightRefresh = null;
        });

      return inFlightRefresh;
    }

    function scheduleRefresh(delayMs) {
      var wait = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 250;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(function() {
        refreshTimer = null;
        refresh();
      }, wait);
    }

    function markThreadRead(instanceUuid, cascadeId, readAtIso) {
      if (!instanceUuid || !cascadeId || instanceUuid === '__cloud__') {
        return Promise.resolve(false);
      }
      return getClientWithMetadata()
        .then(function(ctx) {
          if (!ctx) return false;
          var body = JSON.stringify({
            cascadeIds: [cascadeId],
            annotations: {
              markedAsUnread: false,
              lastUserViewTime: readAtIso || new Date().toISOString()
            },
            mergeAnnotations: true
          });
          return callProxyJson(ctx, instanceUuid, UPDATE_ANNOTATIONS_PATH, body).then(
            function() {
              scheduleRefresh(400);
              return true;
            }
          );
        })
        .catch(function() {
          return false;
        });
    }

    function findHubIframe() {
      var frames = document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        var src = frames[i].getAttribute('src') || frames[i].src || '';
        if (src.indexOf('https://antigravity.static.usercontent.goog/web/') === 0) {
          return frames[i];
        }
      }
      return null;
    }

    function parseJspbPayload(raw) {
      if (Array.isArray(raw)) {
        return raw;
      }
      if (typeof raw === 'string' && raw.charAt(0) === '[') {
        try {
          var parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : null;
        } catch (_) {
          return null;
        }
      }
      return null;
    }

    function clearPendingFastNav() {
      if (pendingFastNav && pendingFastNav.timer) {
        clearTimeout(pendingFastNav.timer);
      }
      pendingFastNav = null;
    }

    function syncHostLocationUrl(targetUrl) {
      if (
        typeof targetUrl !== 'string' ||
        !targetUrl ||
        !window.history ||
        typeof window.history.replaceState !== 'function'
      ) {
        return;
      }
      try {
        var parsedTarget = new URL(targetUrl);
        if (parsedTarget.origin === window.location.origin) {
          window.history.replaceState(
            window.history.state,
            '',
            parsedTarget.pathname + parsedTarget.search + parsedTarget.hash
          );
        }
      } catch (_) {}
    }

    function completePendingFastNavIfMatched(confirmedCascadeId) {
      if (!pendingFastNav || !confirmedCascadeId) {
        return false;
      }
      if (confirmedCascadeId !== pendingFastNav.expectedCascadeId) {
        return false;
      }
      var completed = pendingFastNav;
      clearPendingFastNav();
      syncHostLocationUrl(completed.targetUrl);
      setIframeCascadeOverride(confirmedCascadeId);
      postToNative({
        type: 'AGY_INBOX_FAST_NAV_RESULT',
        requestId: completed.requestId,
        handled: true,
        targetUrl: completed.targetUrl
      });
      postToNative({
        type: 'AGY_INBOX_ACTIVE_ROUTE',
        activeUrl: window.location.href,
        activeInstanceUuid: completed.instanceUuid,
        activeCascadeId: confirmedCascadeId
      });
      return true;
    }

    function fastNavigate(requestId, instanceUuid, childPath, targetUrl) {
      var route = parseRouteFromLocation();
      var frame = findHubIframe();
      var cleanPath = '/' + String(childPath || '').replace(/^\\/+/, '');
      var cMatch = /^\\/c\\/([a-zA-Z0-9._-]+)/.exec(cleanPath);
      var expectedCascadeId = cMatch && cMatch[1] ? cMatch[1] : null;

      if (
        !instanceUuid ||
        instanceUuid === '__cloud__' ||
        !expectedCascadeId ||
        route.instanceUuid !== instanceUuid ||
        !frame ||
        !frame.contentWindow ||
        !frame.src
      ) {
        postToNative({
          type: 'AGY_INBOX_FAST_NAV_RESULT',
          requestId: requestId,
          handled: false,
          targetUrl: targetUrl
        });
        return false;
      }

      try {
        clearPendingFastNav();
        var frameOrigin = new URL(frame.src).origin;
        var timer = setTimeout(function() {
          if (!pendingFastNav || pendingFastNav.requestId !== requestId) {
            return;
          }
          pendingFastNav = null;
          postToNative({
            type: 'AGY_INBOX_FAST_NAV_RESULT',
            requestId: requestId,
            handled: false,
            targetUrl: targetUrl
          });
        }, FAST_NAV_CONFIRM_MS);

        pendingFastNav = {
          requestId: requestId,
          instanceUuid: instanceUuid,
          expectedCascadeId: expectedCascadeId,
          targetUrl: targetUrl,
          timer: timer
        };

        // Antigravity's Closure/Jetbox IframeMessage (wZ.prototype.serialize /
        // Zub) encodes jspbPayload as a JSON string, NOT a raw JS array:
        // - Field 2 (index 1) = URL_NAVIGATE: [null, ["/c/<cascadeId>"]]
        // - Field 3 (index 2) = URL_QUERY:    [null, null, []] (replies with
        //   field 4 URL_RESPONSE even if the iframe was already on cleanPath).
        frame.contentWindow.postMessage(
          { jspbPayload: JSON.stringify([null, [cleanPath]]) },
          frameOrigin
        );
        frame.contentWindow.postMessage(
          { jspbPayload: JSON.stringify([null, null, []]) },
          frameOrigin
        );
        return true;
      } catch (_) {
        clearPendingFastNav();
        postToNative({
          type: 'AGY_INBOX_FAST_NAV_RESULT',
          requestId: requestId,
          handled: false,
          targetUrl: targetUrl
        });
        return false;
      }
    }

    function extractCascadeIdFromIframePath(rawPath, frameSrc) {
      if (typeof rawPath !== 'string' || !rawPath) return null;
      var normalized = rawPath.indexOf('/') === 0 ? rawPath : '/' + rawPath;
      if (frameSrc) {
        try {
          var basePath = new URL(frameSrc).pathname.replace(/\\/+$/, '');
          if (basePath && normalized.indexOf(basePath) === 0) {
            normalized = normalized.substring(basePath.length) || '/';
          }
        } catch (_) {}
      }
      var match = /(?:^|\\/)c\\/([a-zA-Z0-9._-]+)(?:[/?#]|$)/.exec(normalized);
      return match ? match[1] : null;
    }

    window.addEventListener('message', function(event) {
      try {
        if (!event || event.origin !== 'https://antigravity.static.usercontent.goog') {
          return;
        }
        var data = event.data;
        if (!data || typeof data !== 'object') return;
        var frame = findHubIframe();
        var frameSrc = frame ? frame.src : '';

        if (data.type === 'URL_CHANGED' && typeof data.path === 'string') {
          var changedCascadeId = extractCascadeIdFromIframePath(data.path, frameSrc);
          if (completePendingFastNavIfMatched(changedCascadeId)) {
            return;
          }
          setIframeCascadeOverride(changedCascadeId);
          var routeNow = parseRouteFromLocation();
          postToNative({
            type: 'AGY_INBOX_ACTIVE_ROUTE',
            activeUrl: window.location.href,
            activeInstanceUuid: routeNow.instanceUuid,
            activeCascadeId: activeIframeCascadeId
          });
          return;
        }

        var jspb = parseJspbPayload(data.jspbPayload);
        if (!jspb) return;

        // Field 1 (index 0): URL_CHANGE, or Field 4 (index 3): URL_RESPONSE
        var reportedPath =
          Array.isArray(jspb[0]) && typeof jspb[0][0] === 'string'
            ? jspb[0][0]
            : Array.isArray(jspb[3]) && typeof jspb[3][0] === 'string'
              ? jspb[3][0]
              : null;
        if (reportedPath !== null) {
          var extractedCascadeId = extractCascadeIdFromIframePath(reportedPath, frameSrc);
          if (completePendingFastNavIfMatched(extractedCascadeId)) {
            return;
          }
          if (Array.isArray(jspb[0])) {
            setIframeCascadeOverride(extractedCascadeId);
            var currentRoute = parseRouteFromLocation();
            postToNative({
              type: 'AGY_INBOX_ACTIVE_ROUTE',
              activeUrl: window.location.href,
              activeInstanceUuid: currentRoute.instanceUuid,
              activeCascadeId: activeIframeCascadeId
            });
          }
        }

        // Field 5 (index 4): NOTIFICATION_REQUEST (D9 wraps C9 at index 0)
        if (Array.isArray(jspb[4])) {
          var notif = Array.isArray(jspb[4][0]) ? jspb[4][0] : jspb[4];
          postToNative({
            type: 'AGY_INBOX_REALTIME_HINT',
            reason: 'notification',
            cascadeId: typeof notif[5] === 'string' ? notif[5] : null,
            title: typeof notif[1] === 'string' ? notif[1] : null,
            body: typeof notif[2] === 'string' ? notif[2] : null
          });
          scheduleRefresh(300);
        }

        // Field 18 (index 17): FAVICON_BADGE_CHANGE
        if (Array.isArray(jspb[17])) {
          postToNative({
            type: 'AGY_INBOX_REALTIME_HINT',
            reason: 'badge'
          });
          scheduleRefresh(350);
        }
      } catch (_) {}
    });

    function emitActiveRouteFromLocation() {
      var route = parseRouteFromLocation();
      postToNative({
        type: 'AGY_INBOX_ACTIVE_ROUTE',
        activeUrl: window.location.href,
        activeInstanceUuid: route.instanceUuid,
        activeCascadeId: route.cascadeId
      });
    }

    window.addEventListener('popstate', emitActiveRouteFromLocation);

    try {
      if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('currententrychange', emitActiveRouteFromLocation);
      }
    } catch (_) {}

    window.addEventListener('focus', function() {
      scheduleRefresh(250);
    });

    window.addEventListener('online', function() {
      scheduleRefresh(350);
    });

    var pollId = setInterval(function() {
      if (document.visibilityState === 'hidden') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      refresh();
    }, POLL_INTERVAL_MS);

    var bootstrapDelays = [0, 350, 1100, 2600, 5200];
    for (var b = 0; b < bootstrapDelays.length; b++) {
      (function(delay) {
        setTimeout(function() {
          if (installHooks() && delay <= 1100) {
            scheduleRefresh(150);
          }
        }, delay);
      })(bootstrapDelays[b]);
    }

    window.__agyInboxBridge = {
      installHooks: installHooks,
      refresh: refresh,
      scheduleRefresh: scheduleRefresh,
      markThreadRead: markThreadRead,
      fastNavigate: fastNavigate,
      stop: function() {
        clearPendingFastNav();
        if (refreshTimer) clearTimeout(refreshTimer);
        if (pollId) clearInterval(pollId);
      }
    };
  } catch (_) {}
  return true;
})();
`;

export function buildInboxRefreshScript(): string {
  return `
(function() {
  try {
    if (window.__agyInboxBridge && typeof window.__agyInboxBridge.refresh === 'function') {
      window.__agyInboxBridge.refresh();
    }
  } catch (_) {}
  return true;
})();
`;
}

export function buildFastThreadSwitchScript(params: {
  requestId: string;
  instanceUuid: string;
  childPath: string;
  targetUrl: string;
}): string {
  const serialized = JSON.stringify({
    requestId: params.requestId,
    instanceUuid: params.instanceUuid,
    childPath: params.childPath,
    targetUrl: params.targetUrl,
  });

  return `
(function() {
  var args = ${serialized};
  try {
    if (window.__agyInboxBridge && typeof window.__agyInboxBridge.fastNavigate === 'function') {
      window.__agyInboxBridge.fastNavigate(
        args.requestId,
        args.instanceUuid,
        args.childPath,
        args.targetUrl
      );
      return true;
    }
  } catch (_) {}
  try {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'AGY_INBOX_FAST_NAV_RESULT',
        requestId: args.requestId,
        handled: false,
        targetUrl: args.targetUrl
      }));
    }
  } catch (_) {}
  return true;
})();
`;
}

export function buildMarkThreadReadScript(params: {
  instanceUuid: string;
  cascadeId: string;
  readAtIso: string;
}): string {
  const serialized = JSON.stringify({
    instanceUuid: params.instanceUuid,
    cascadeId: params.cascadeId,
    readAtIso: params.readAtIso,
  });

  return `
(function() {
  var args = ${serialized};
  try {
    if (window.__agyInboxBridge && typeof window.__agyInboxBridge.markThreadRead === 'function') {
      window.__agyInboxBridge.markThreadRead(
        args.instanceUuid,
        args.cascadeId,
        args.readAtIso
      );
    }
  } catch (_) {}
  return true;
})();
`;
}
