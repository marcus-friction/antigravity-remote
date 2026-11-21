import { ActiveThreadProjectContext } from '../types/inbox';

/**
 * Trusted-Types-safe WebView bridge injected into `https://antigravity.google.com`.
 *
 * Security & CSP invariants:
 * - Executes strictly when `window.location.hostname === 'antigravity.google.com'`.
 * - Never touches `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
 *   `<script>` injection, `eval`, or `new Function` (satisfies `require-trusted-types-for 'script'`).
 * - Reuses the host page's first-party / enterprise gRPC-Web `ApiServicePromiseClient`
 *   to query `ListInstances`, `ProxyCommand` (`GetAllCascadeTrajectories`,
 *   `ListProjects`, `ReadProjects`, `GetWorkspaceInfos`, `ListBackgroundTasks`,
 *   `UpdateConversationAnnotations`, `RetrieveUserQuotaSummary`, `GetUserStatus`,
 *   and fallback `GetCommandModelConfigs`), and `StreamProxyCommand`
 *   (`JetboxSubscribeToSummaries`) across connected workstations.
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
      if (typeof window.__agyInboxBridge.syncFullBleedWorkspace === 'function') {
        window.__agyInboxBridge.syncFullBleedWorkspace();
      }
      if (typeof window.__agyInboxBridge.syncActiveThreadContext === 'function') {
        window.__agyInboxBridge.syncActiveThreadContext();
      }
      window.__agyInboxBridge.scheduleRefresh(150);
      return true;
    }

    var GET_TRAJECTORIES_PATH = '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories';
    var JETBOX_SUBSCRIBE_SUMMARIES_PATH = '/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries';
    var LIST_BACKGROUND_TASKS_PATH = '/exa.language_server_pb.LanguageServerService/ListBackgroundTasks';
    var LIST_PROJECTS_PATH = '/exa.language_server_pb.LanguageServerService/ListProjects';
    var READ_PROJECTS_PATH = '/exa.language_server_pb.LanguageServerService/ReadProjects';
    var GET_WORKSPACE_INFOS_PATH = '/exa.language_server_pb.LanguageServerService/GetWorkspaceInfos';
    var GET_DEFAULT_PROJECT_DIR_PATH = '/exa.language_server_pb.LanguageServerService/GetDefaultProjectDir';
    var READ_DIR_PATH = '/exa.language_server_pb.LanguageServerService/ReadDir';
    var RESOLVE_FOLDER_PATH = '/exa.language_server_pb.LanguageServerService/ResolveFolder';
    var CREATE_SCRATCH_PROJECT_FOLDER_PATH = '/exa.language_server_pb.LanguageServerService/CreateScratchProjectFolder';
    var CREATE_PROJECT_PATH = '/exa.language_server_pb.LanguageServerService/CreateProject';
    var ADD_TRACKED_WORKSPACE_PATH = '/exa.language_server_pb.LanguageServerService/AddTrackedWorkspace';
    var START_CASCADE_PATH = '/exa.language_server_pb.LanguageServerService/StartCascade';
    var UPDATE_ANNOTATIONS_PATH = '/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations';
    var RETRIEVE_QUOTA_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
    var GET_USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
    var GET_COMMAND_MODEL_CONFIGS_PATH = '/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs';
    var DEFAULT_LS_METADATA_OBJ = {
      ideName: 'antigravity',
      extensionName: 'antigravity',
      locale: 'en'
    };
    var DEFAULT_LS_METADATA_BODY = JSON.stringify({
      metadata: DEFAULT_LS_METADATA_OBJ
    });
    var POLL_INTERVAL_MS = 20000;
    var USAGE_POLL_MIN_INTERVAL_MS = 45000;
    var INSTANCE_RPC_TIMEOUT_MS = 8000;
    var JETBOX_SUMMARIES_TIMEOUT_MS = 5500;
    var JETBOX_SUMMARIES_SETTLE_MS = 220;
    var READ_PROJECTS_BATCH_SIZE = 64;
    var BACKGROUND_TASKS_RPC_TIMEOUT_MS = 3500;
    var PROJECTS_RPC_TIMEOUT_MS = 5000;
    var START_CASCADE_TIMEOUT_MS = 5000;
    var USAGE_RPC_TIMEOUT_MS = 3500;
    var USAGE_INLINE_BUDGET_MS = 1200;
    var SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/;

    var capturedApiClient = null;
    var capturedMetadata = null;
    var standaloneApiClient = null;
    var cachedProtoNs = null;
    var cachedAuthFirstParty = null;
    var cachedApiKey = null;
    var lastTrajectoryCache = Object.create(null);
    var lastJetboxSummariesCache = Object.create(null);
    var unsupportedJetboxSummariesCache = Object.create(null);
    var lastBackgroundTasksCache = Object.create(null);
    var unsupportedBackgroundTasksCache = Object.create(null);
    var lastProjectsCache = Object.create(null);
    var lastWorkspaceInfosCache = Object.create(null);
    var lastHomeDirCache = Object.create(null);
    var lastInstancesPayloadCache = [];
    var lastUsageCache = null;
    var lastUsageFetchedAtMs = 0;
    var inFlightUsagePromise = null;
    var pendingFollowUpRefresh = false;
    var pendingForcedUsageRefresh = false;
    var cloudTrajectoriesCache = null;
    var activeIframeCascadeId = null;
    var activeIframeInstanceUuid = null;
    var hasIframeRouteOverride = false;
    var activeThreadContext = null;
    var pendingFastNav = null;
    var pendingStartNav = null;
    var FAST_NAV_CONFIRM_MS = 380;
    var START_NAV_CONFIRM_MS = 1200;
    var refreshTimer = null;
    var inFlightRefresh = null;
    var isStopped = false;

    function generateUuidV4() {
      try {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
          return window.crypto.randomUUID();
        }
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
          var bytes = new Uint8Array(16);
          window.crypto.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;
          var hex = '';
          for (var i = 0; i < 16; i++) {
            var h = bytes[i].toString(16);
            hex += h.length === 1 ? '0' + h : h;
            if (i === 3 || i === 5 || i === 7 || i === 9) hex += '-';
          }
          return hex;
        }
      } catch (_) {}
      var tpl = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
      var out = '';
      for (var j = 0; j < tpl.length; j++) {
        var ch = tpl.charAt(j);
        if (ch === 'x' || ch === 'y') {
          var r = Math.floor(Math.random() * 16);
          var v = ch === 'x' ? r : (r & 0x3) | 0x8;
          out += v.toString(16);
        } else {
          out += ch;
        }
      }
      return out;
    }

    function hasConnectRpcError(res) {
      return Boolean(
        res &&
          typeof res === 'object' &&
          typeof res.code === 'string' &&
          typeof res.message === 'string' &&
          !res.cascadeId &&
          !res.cascade_id &&
          !res.project &&
          !res.projects &&
          !res.projectIds &&
          !res.project_ids &&
          !res.entries &&
          !res.folderUri &&
          !res.folder_uri &&
          !res.tasks
      );
    }

    function extractInstanceUuidFromHostPath() {
      var pathname = (window.location && window.location.pathname) || '';
      var stripped = pathname.replace(/^\\/u\\/\\d+(?=\\/|$)/, '');
      var instanceMatch = /^\\/r\\/([^/?#]+)/.exec(stripped);
      if (!instanceMatch) {
        return null;
      }
      var uuid = decodeURIComponent(instanceMatch[1]);
      return SAFE_ID_RE.test(uuid) ? uuid : null;
    }

    function setIframeCascadeOverride(cascadeId) {
      activeIframeCascadeId = cascadeId || null;
      activeIframeInstanceUuid = extractInstanceUuidFromHostPath();
      hasIframeRouteOverride = activeIframeInstanceUuid !== null;
    }

    function clearIframeCascadeOverride() {
      activeIframeCascadeId = null;
      activeIframeInstanceUuid = null;
      hasIframeRouteOverride = false;
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
      var currentInstanceUuid = extractInstanceUuidFromHostPath();
      if (
        hasIframeRouteOverride &&
        currentInstanceUuid !== activeIframeInstanceUuid
      ) {
        clearIframeCascadeOverride();
      }
      var pathname = (window.location && window.location.pathname) || '';
      var stripped = pathname.replace(/^\\/u\\/\\d+(?=\\/|$)/, '');
      if (currentInstanceUuid) {
        var search = (window.location && window.location.search) || '';
        var pVal = '';
        try {
          pVal = new URLSearchParams(search).get('p') || '';
        } catch (_) {}
        var cleanChild = pVal.replace(/^\\/+/, '');
        var cMatch = /^c\\/([a-zA-Z0-9._-]+)(?:[/?#]|$)/.exec(cleanChild);
        return {
          instanceUuid: currentInstanceUuid,
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

    function extractRawPayloadBytes(responseObj) {
      if (!responseObj) return new Uint8Array(0);
      if (typeof responseObj.getPayload_asU8 === 'function') {
        var bytes = responseObj.getPayload_asU8();
        if (bytes && bytes.length > 0) {
          return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
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
          return out;
        }
      }
      if (typeof responseObj.getPayload === 'function') {
        var raw = responseObj.getPayload();
        if (raw instanceof Uint8Array) {
          return raw;
        }
        if (raw && typeof raw.asUint8Array === 'function') {
          return raw.asUint8Array();
        }
        if (typeof raw === 'string' && raw) {
          try {
            var decodedBin = atob(raw);
            var u8 = new Uint8Array(decodedBin.length);
            for (var j = 0; j < decodedBin.length; j++) {
              u8[j] = decodedBin.charCodeAt(j);
            }
            return u8;
          } catch (_) {
            if (typeof TextEncoder === 'function') {
              return new TextEncoder().encode(raw);
            }
          }
        }
      }
      return new Uint8Array(0);
    }

    function decodeResponseBytes(responseObj) {
      if (!responseObj) return '';
      var bytes = extractRawPayloadBytes(responseObj);
      if (bytes && bytes.length > 0 && typeof TextDecoder === 'function') {
        return new TextDecoder('utf-8').decode(bytes);
      }
      if (typeof responseObj.getPayload === 'function') {
        var raw = responseObj.getPayload();
        if (typeof raw === 'string' && raw) {
          return raw;
        }
      }
      return '';
    }

    function encodeConnectEnvelope(jsonBody) {
      var payloadBytes =
        typeof TextEncoder === 'function'
          ? new TextEncoder().encode(jsonBody || '{}')
          : new Uint8Array(0);
      var out = new Uint8Array(5 + payloadBytes.length);
      out[0] = 0;
      var len = payloadBytes.length;
      out[1] = (len >>> 24) & 255;
      out[2] = (len >>> 16) & 255;
      out[3] = (len >>> 8) & 255;
      out[4] = len & 255;
      out.set(payloadBytes, 5);
      return out;
    }

    function concatBytes(a, b) {
      if (!a || a.length === 0) return b || new Uint8Array(0);
      if (!b || b.length === 0) return a;
      var merged = new Uint8Array(a.length + b.length);
      merged.set(a, 0);
      merged.set(b, a.length);
      return merged;
    }

    function decodeConnectJsonFrames(buffer) {
      var frames = [];
      var offset = 0;
      var decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
      if (!buffer || buffer.length === 0 || !decoder) {
        return { frames: frames, remaining: buffer || new Uint8Array(0) };
      }
      // Fallback for plain unframed JSON responses (e.g. legacy proxies or test mocks).
      if (buffer[0] === 123) {
        try {
          var directText = decoder.decode(buffer);
          var directObj = JSON.parse(directText);
          if (directObj && typeof directObj === 'object') {
            frames.push({ flags: 0, data: directObj });
            return { frames: frames, remaining: new Uint8Array(0) };
          }
        } catch (_) {
          return { frames: frames, remaining: buffer };
        }
      }
      while (offset + 5 <= buffer.length) {
        var flags = buffer[offset];
        var len =
          ((buffer[offset + 1] << 24) >>> 0) +
          (buffer[offset + 2] << 16) +
          (buffer[offset + 3] << 8) +
          buffer[offset + 4];
        if (len > 32 * 1024 * 1024) {
          // Corrupted/unexpected framing — abort parsing remaining bytes.
          return { frames: frames, remaining: new Uint8Array(0) };
        }
        if (offset + 5 + len > buffer.length) {
          break;
        }
        var slice = buffer.subarray(offset + 5, offset + 5 + len);
        offset += 5 + len;
        // Skip compressed frames (bit 0 set) since we request uncompressed JSON.
        if ((flags & 1) !== 0) {
          continue;
        }
        try {
          var text = slice.length > 0 ? decoder.decode(slice) : '{}';
          var parsed = text ? JSON.parse(text) : Object.create(null);
          frames.push({ flags: flags, data: parsed });
        } catch (_) {}
      }
      return {
        frames: frames,
        remaining: offset < buffer.length ? buffer.subarray(offset) : new Uint8Array(0)
      };
    }

    function getSummaryTimestampScore(raw) {
      if (!raw || typeof raw !== 'object') return 0;
      var ts = raw.lastModifiedTime || raw.last_modified_time || raw.createdTime || raw.created_time;
      if (!ts) return 0;
      if (typeof ts === 'number') return ts > 1e11 ? ts : ts * 1000;
      if (typeof ts === 'string') {
        var parsed = Date.parse(ts);
        return isNaN(parsed) ? 0 : parsed;
      }
      if (typeof ts === 'object') {
        var sec = Number(ts.seconds || ts.secs || 0);
        if (sec > 0) return sec * 1000;
      }
      return 0;
    }

    function isSummaryLiveActive(raw) {
      if (!raw || typeof raw !== 'object' || raw.killed) return false;
      var waiting = raw.waitingSteps || raw.waiting_steps;
      if (Array.isArray(waiting) && waiting.length > 0) return true;
      if (raw.notFullyIdle || raw.not_fully_idle || raw.hasRunningSubagents || raw.has_running_subagents) {
        return true;
      }
      var st = raw.status;
      if (st === 2 || st === 3 || st === 4) return true;
      if (typeof st === 'string') {
        var u = st.toUpperCase();
        if (
          u.indexOf('RUNNING') !== -1 ||
          u.indexOf('BUSY') !== -1 ||
          u.indexOf('CANCELING') !== -1 ||
          u.indexOf('WAITING') !== -1
        ) {
          return true;
        }
      }
      return false;
    }

    function getJetboxBackendKey(backend) {
      return backend ? String(backend) : 'local';
    }

    function parseTimestampForComparison(ts) {
      if (!ts) return 0;
      if (typeof ts === 'number') return ts > 1e11 ? ts : ts * 1000;
      if (typeof ts === 'string') {
        var parsed = Date.parse(ts);
        return isNaN(parsed) ? 0 : parsed;
      }
      if (typeof ts === 'object') {
        var sec = Number(ts.seconds || ts.secs || 0);
        if (sec > 0) return sec * 1000;
      }
      return 0;
    }

    function hasPresentScalar(obj, camelKey, snakeKey) {
      if (!obj || typeof obj !== 'object') return false;
      var cv = obj[camelKey];
      if (cv !== undefined && cv !== null && cv !== '') return true;
      if (snakeKey) {
        var sv = obj[snakeKey];
        if (sv !== undefined && sv !== null && sv !== '') return true;
      }
      return false;
    }

    function backfillScalarField(target, source, camelKey, snakeKey) {
      if (!source || typeof source !== 'object') return;
      if (hasPresentScalar(target, camelKey, snakeKey)) return;
      var val = source[camelKey];
      if (val !== undefined && val !== null && val !== '') {
        target[camelKey] = val;
        return;
      }
      if (snakeKey) {
        var sval = source[snakeKey];
        if (sval !== undefined && sval !== null && sval !== '') {
          target[snakeKey] = sval;
        }
      }
    }

    function mergeStringArraysUnique(primary, secondary) {
      var out = [];
      var seen = Object.create(null);
      var lists = [primary, secondary];
      for (var i = 0; i < lists.length; i++) {
        var arr = lists[i];
        if (!Array.isArray(arr)) continue;
        for (var j = 0; j < arr.length; j++) {
          var val = arr[j];
          if (typeof val === 'string' && val && !seen[val]) {
            seen[val] = true;
            out.push(val);
          }
        }
      }
      return out;
    }

    function mergeWorkspaceLists(primary, secondary) {
      var out = [];
      var seen = Object.create(null);
      var lists = [primary, secondary];
      for (var i = 0; i < lists.length; i++) {
        var arr = lists[i];
        if (!Array.isArray(arr)) continue;
        for (var j = 0; j < arr.length; j++) {
          var ws = arr[j];
          if (!ws || typeof ws !== 'object') continue;
          var key =
            String(ws.workspaceFolderAbsoluteUri || ws.workspace_folder_absolute_uri || '') +
            '|' +
            String(ws.gitRootAbsoluteUri || ws.git_root_absolute_uri || '');
          if (key !== '|' && seen[key]) continue;
          if (key !== '|') seen[key] = true;
          out.push(ws);
        }
      }
      return out;
    }

    function mergeSingleTrajectorySummary(jetboxItem, cascadeItem, jetboxIsFresh) {
      if (!jetboxItem || typeof jetboxItem !== 'object') return cascadeItem;
      if (!cascadeItem || typeof cascadeItem !== 'object') return jetboxItem;

      var isJetboxFresh = jetboxIsFresh !== false;
      var jetboxTs = getSummaryTimestampScore(jetboxItem);
      var cascadeTs = getSummaryTimestampScore(cascadeItem);
      var jetboxSteps = Number(jetboxItem.stepCount || jetboxItem.step_count || 0) || 0;
      var cascadeSteps = Number(cascadeItem.stepCount || cascadeItem.step_count || 0) || 0;
      var jetboxLive = isSummaryLiveActive(jetboxItem);
      var cascadeLive = isSummaryLiveActive(cascadeItem);

      // Cached Jetbox entries must never override fresh live Cascade summaries.
      // Between two live sources, freshness (timestamp -> stepCount) decides first,
      // with liveness used only as a tie-breaker so a stale live snapshot never masks
      // a newer IDLE/finished state.
      var preferCascade;
      if (!isJetboxFresh) {
        preferCascade = true;
      } else if (cascadeTs !== jetboxTs) {
        preferCascade = cascadeTs > jetboxTs;
      } else if (cascadeSteps !== jetboxSteps) {
        preferCascade = cascadeSteps > jetboxSteps;
      } else if (cascadeLive !== jetboxLive) {
        preferCascade = cascadeLive;
      } else {
        preferCascade = true;
      }

      var primary = preferCascade ? cascadeItem : jetboxItem;
      var secondary = preferCascade ? jetboxItem : cascadeItem;

      // Start strictly from primary so proto3-omitted transient runtime fields
      // (waitingSteps, notFullyIdle, hasRunningSubagents, backgroundTaskCount,
      // killed, interrupted, latestExecutorTerminationReason, markedAsUnread)
      // never leak from a stale secondary snapshot.
      var merged = Object.create(null);
      var priKeys = Object.keys(primary);
      for (var p = 0; p < priKeys.length; p++) {
        merged[priKeys[p]] = primary[priKeys[p]];
      }

      // Selectively backfill only structural/identity fields from secondary.
      backfillScalarField(merged, secondary, 'summary', null);
      backfillScalarField(merged, secondary, 'createdTime', 'created_time');
      backfillScalarField(merged, secondary, 'trajectoryId', 'trajectory_id');
      backfillScalarField(merged, secondary, 'source', null);
      backfillScalarField(merged, secondary, 'projectId', 'project_id');
      backfillScalarField(merged, secondary, 'workspaceFolderAbsoluteUri', 'workspace_folder_absolute_uri');
      backfillScalarField(merged, secondary, 'gitRootAbsoluteUri', 'git_root_absolute_uri');
      backfillScalarField(merged, secondary, 'workspaceUri', 'workspace_uri');
      backfillScalarField(merged, secondary, 'trajectoryType', 'trajectory_type');
      backfillScalarField(merged, secondary, 'cloud', null);
      backfillScalarField(merged, secondary, 'lastUserInputTime', 'last_user_input_time');
      if (
        merged.lastUserInputStepIndex === undefined &&
        merged.last_user_input_step_index === undefined
      ) {
        if (secondary.lastUserInputStepIndex !== undefined) {
          merged.lastUserInputStepIndex = secondary.lastUserInputStepIndex;
        } else if (secondary.last_user_input_step_index !== undefined) {
          merged.last_user_input_step_index = secondary.last_user_input_step_index;
        }
      }

      // Preserve projectId, workspaceUris, workspaces, and parent links across BOTH sources.
      var priMeta = primary.trajectoryMetadata || primary.trajectory_metadata || null;
      var secMeta = secondary.trajectoryMetadata || secondary.trajectory_metadata || null;
      if (priMeta || secMeta) {
        var mergedMeta = Object.create(null);
        if (priMeta && typeof priMeta === 'object') {
          var pmKeys = Object.keys(priMeta);
          for (var b = 0; b < pmKeys.length; b++) {
            mergedMeta[pmKeys[b]] = priMeta[pmKeys[b]];
          }
        }
        if (secMeta && typeof secMeta === 'object') {
          backfillScalarField(mergedMeta, secMeta, 'projectId', 'project_id');
          backfillScalarField(mergedMeta, secMeta, 'environmentId', 'environment_id');
          backfillScalarField(mergedMeta, secMeta, 'parentConversationId', 'parent_conversation_id');
          backfillScalarField(mergedMeta, secMeta, 'rootConversationId', 'root_conversation_id');
          backfillScalarField(mergedMeta, secMeta, 'isBattleModeFork', 'is_battle_mode_fork');
          backfillScalarField(mergedMeta, secMeta, 'subagentSpec', 'subagent_spec');
          backfillScalarField(mergedMeta, secMeta, 'sourceMetadata', 'source_metadata');
          backfillScalarField(mergedMeta, secMeta, 'createdAt', 'created_at');
        }
        var mergedMetaUris = mergeStringArraysUnique(
          priMeta && (priMeta.workspaceUris || priMeta.workspace_uris),
          secMeta && (secMeta.workspaceUris || secMeta.workspace_uris)
        );
        if (mergedMetaUris.length > 0) {
          mergedMeta.workspaceUris = mergedMetaUris;
        }
        var mergedMetaWorkspaces = mergeWorkspaceLists(
          priMeta && priMeta.workspaces,
          secMeta && secMeta.workspaces
        );
        if (mergedMetaWorkspaces.length > 0) {
          mergedMeta.workspaces = mergedMetaWorkspaces;
        }
        merged.trajectoryMetadata = mergedMeta;
      }

      var mergedWorkspaces = mergeWorkspaceLists(primary.workspaces, secondary.workspaces);
      if (mergedWorkspaces.length > 0) {
        merged.workspaces = mergedWorkspaces;
      }

      // For annotations, keep primary's transient flags (markedAsUnread, archived, pinned, starred)
      // authoritative; only backfill missing title and strictly newer monotonic lastUserViewTime.
      var priAnn = primary.annotations && typeof primary.annotations === 'object' ? primary.annotations : null;
      var secAnn = secondary.annotations && typeof secondary.annotations === 'object' ? secondary.annotations : null;
      if (priAnn || secAnn) {
        var mergedAnn = Object.create(null);
        if (priAnn) {
          var paKeys = Object.keys(priAnn);
          for (var d = 0; d < paKeys.length; d++) {
            mergedAnn[paKeys[d]] = priAnn[paKeys[d]];
          }
        }
        if (secAnn) {
          backfillScalarField(mergedAnn, secAnn, 'title', null);
          var priViewTs = parseTimestampForComparison(
            mergedAnn.lastUserViewTime || mergedAnn.last_user_view_time
          );
          var secViewRaw = secAnn.lastUserViewTime || secAnn.last_user_view_time;
          var secViewTs = parseTimestampForComparison(secViewRaw);
          if (secViewTs > priViewTs && secViewRaw !== undefined) {
            mergedAnn.lastUserViewTime = secViewRaw;
          }
        }
        if (Object.keys(mergedAnn).length > 0) {
          merged.annotations = mergedAnn;
        }
      }

      return merged;
    }

    function mergeTrajectorySummaryMaps(jetboxMap, cascadeMap, jetboxIsFresh) {
      var out = Object.create(null);
      if (jetboxMap && typeof jetboxMap === 'object') {
        var jKeys = Object.keys(jetboxMap);
        for (var i = 0; i < jKeys.length; i++) {
          var jk = jKeys[i];
          if (SAFE_ID_RE.test(jk) && jetboxMap[jk] && typeof jetboxMap[jk] === 'object') {
            out[jk] = jetboxMap[jk];
          }
        }
      }
      if (cascadeMap && typeof cascadeMap === 'object') {
        var cKeys = Object.keys(cascadeMap);
        for (var j = 0; j < cKeys.length; j++) {
          var ck = cKeys[j];
          if (!SAFE_ID_RE.test(ck) || !cascadeMap[ck] || typeof cascadeMap[ck] !== 'object') {
            continue;
          }
          if (out[ck]) {
            out[ck] = mergeSingleTrajectorySummary(out[ck], cascadeMap[ck], jetboxIsFresh);
          } else {
            out[ck] = cascadeMap[ck];
          }
        }
      }
      return out;
    }

    function getCachedJetboxSummariesForInstance(uuid) {
      var keys = ['local', '2', '3'];
      var combined = null;
      for (var i = 0; i < keys.length; i++) {
        var entry = lastJetboxSummariesCache[uuid + ':' + keys[i]];
        if (entry && typeof entry === 'object') {
          combined = combined
            ? mergeTrajectorySummaryMaps(combined, entry, true)
            : entry;
        }
      }
      return combined;
    }

    function compactWaitingStepEntry(entry) {
      if (!entry || typeof entry !== 'object') return entry;
      var step = entry.step && typeof entry.step === 'object' ? entry.step : entry;
      var compactStep = {};
      var rc = step.runCommand || step.run_command;
      if (rc && typeof rc === 'object') {
        compactStep.runCommand = {
          commandLine: rc.commandLine || rc.command_line || rc.proposedCommandLine || rc.command
        };
      }
      var aq = step.askQuestion || step.ask_question;
      if (aq && typeof aq === 'object') {
        compactStep.askQuestion = {
          question: aq.question,
          questions: Array.isArray(aq.questions) && aq.questions[0]
            ? [{ question: aq.questions[0].question }]
            : undefined
        };
      }
      var obu = step.openBrowserUrl || step.open_browser_url;
      if (obu && typeof obu === 'object') {
        compactStep.openBrowserUrl = { url: obu.url };
      }
      var ebj = step.executeBrowserJavascript || step.execute_browser_javascript;
      if (ebj && typeof ebj === 'object') {
        compactStep.executeBrowserJavascript = {
          javascriptDescription: ebj.javascriptDescription || ebj.javascript_description
        };
      }
      if (step.filePermission || step.file_permission) {
        compactStep.filePermission = {};
      }
      var meta = step.metadata;
      if (meta && typeof meta === 'object') {
        var toolSummary = meta.toolSummary || meta.tool_summary;
        if (typeof toolSummary === 'string' && toolSummary) {
          compactStep.metadata = { toolSummary: toolSummary.slice(0, 140) };
        }
      }
      return entry.step && typeof entry.step === 'object'
        ? { step: compactStep }
        : compactStep;
    }

    function compactTrajectorySummary(raw) {
      if (!raw || typeof raw !== 'object') return raw;
      var out = {};
      var directKeys = [
        'summary',
        'stepCount',
        'step_count',
        'lastModifiedTime',
        'last_modified_time',
        'createdTime',
        'created_time',
        'lastUserInputTime',
        'last_user_input_time',
        'lastUserInputStepIndex',
        'last_user_input_step_index',
        'trajectoryId',
        'trajectory_id',
        'status',
        'source',
        'projectId',
        'project_id',
        'workspaceFolderAbsoluteUri',
        'workspace_folder_absolute_uri',
        'gitRootAbsoluteUri',
        'git_root_absolute_uri',
        'workspaceUri',
        'workspace_uri',
        'hasActiveChildren',
        'has_active_children',
        'notFullyIdle',
        'not_fully_idle',
        'trajectoryType',
        'trajectory_type',
        'killed',
        'interrupted',
        'cloud',
        'latestExecutorTerminationReason',
        'latest_executor_termination_reason',
        'backgroundTaskCount',
        'background_task_count',
        'hasRunningSubagents',
        'has_running_subagents',
        'battleModeInfo',
        'battle_mode_info'
      ];
      for (var i = 0; i < directKeys.length; i++) {
        var k = directKeys[i];
        if (raw[k] !== undefined) {
          out[k] = raw[k];
        }
      }
      var waiting = raw.waitingSteps || raw.waiting_steps;
      if (Array.isArray(waiting) && waiting.length > 0) {
        var compactWaiting = [];
        for (var w = 0; w < waiting.length && w < 8; w++) {
          compactWaiting.push(compactWaitingStepEntry(waiting[w]));
        }
        out.waitingSteps = compactWaiting;
      }
      if (Array.isArray(raw.workspaces) && raw.workspaces.length > 0) {
        out.workspaces = raw.workspaces;
      }
      if (raw.annotations && typeof raw.annotations === 'object') {
        out.annotations = raw.annotations;
      }
      var meta = raw.trajectoryMetadata || raw.trajectory_metadata;
      if (meta && typeof meta === 'object') {
        var compactMeta = {};
        var metaKeys = [
          'projectId',
          'project_id',
          'environmentId',
          'environment_id',
          'workspaces',
          'workspaceUris',
          'workspace_uris',
          'parentConversationId',
          'parent_conversation_id',
          'rootConversationId',
          'root_conversation_id',
          'isBattleModeFork',
          'is_battle_mode_fork',
          'subagentSpec',
          'subagent_spec',
          'sourceMetadata',
          'source_metadata',
          'createdAt',
          'created_at'
        ];
        for (var m = 0; m < metaKeys.length; m++) {
          var mk = metaKeys[m];
          if (meta[mk] !== undefined) {
            compactMeta[mk] = meta[mk];
          }
        }
        out.trajectoryMetadata = compactMeta;
      }
      return out;
    }

    function compactTrajectorySummaries(rawMap) {
      if (!rawMap || typeof rawMap !== 'object') return rawMap;
      var out = Object.create(null);
      var keys = Object.keys(rawMap);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (SAFE_ID_RE.test(key) && rawMap[key] && typeof rawMap[key] === 'object') {
          out[key] = compactTrajectorySummary(rawMap[key]);
        }
      }
      return out;
    }

    function compactProjectsList(projects) {
      if (!Array.isArray(projects)) return projects;
      var out = [];
      for (var i = 0; i < projects.length; i++) {
        var p = projects[i];
        if (!p || typeof p !== 'object') continue;
        var compact = {};
        var pKeys = [
          'id',
          'projectId',
          'project_id',
          'name',
          'title',
          'displayName',
          'display_name',
          'archived',
          'isWorkspaceOnly',
          'is_workspace_only',
          'updatedAt',
          'updated_at',
          'updateTimeMicros',
          'backendType',
          'backend_type',
          'projectResources',
          'project_resources',
          'resources',
          'environments',
          'projectConversations',
          'project_conversations',
          'conversations',
          'workspaceUri',
          'workspace_uri',
          'folderUri',
          'folder_uri',
          'workspaces'
        ];
        for (var k = 0; k < pKeys.length; k++) {
          var pk = pKeys[k];
          if (p[pk] !== undefined) {
            compact[pk] = p[pk];
          }
        }
        out.push(compact);
      }
      return out;
    }

    function fetchJetboxSummariesStream(ctx, uuid, backend, version) {
      if (!ctx || !ctx.client || typeof ctx.client.streamProxyCommand !== 'function') {
        return Promise.resolve({ ok: false, summaries: null });
      }
      var backendKey = backend ? String(backend) : 'local';
      var cacheKey = uuid + ':' + backendKey;
      var versionTag = version || '*';
      if (unsupportedJetboxSummariesCache[cacheKey] === versionTag) {
        return Promise.resolve({ ok: false, summaries: null });
      }
      return new Promise(function(resolve) {
        var settled = false;
        var stream = null;
        var rawBuffer = new Uint8Array(0);
        var collected = Object.create(null);
        var receivedValidFrame = false;
        var settleTimer = null;
        var hardTimer = null;

        function finish(ok) {
          if (settled) return;
          settled = true;
          if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
          }
          if (hardTimer) {
            clearTimeout(hardTimer);
            hardTimer = null;
          }
          if (stream && typeof stream.cancel === 'function') {
            try {
              stream.cancel();
            } catch (_) {}
          }
          resolve({
            ok: ok,
            summaries: ok ? collected : null
          });
        }

        function armSettleTimer() {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(function() {
            settleTimer = null;
            finish(receivedValidFrame);
          }, JETBOX_SUMMARIES_SETTLE_MS);
        }

        hardTimer = setTimeout(function() {
          hardTimer = null;
          finish(receivedValidFrame);
        }, JETBOX_SUMMARIES_TIMEOUT_MS);

        try {
          var req = new ctx.proto.ProxyCommandRequest();
          req.setTargetInstanceUuid(uuid);
          req.setRpcPath(JETBOX_SUBSCRIBE_SUMMARIES_PATH);
          var bodyJson = backend ? JSON.stringify({ backend: backend }) : '{}';
          req.setPayload(encodeConnectEnvelope(bodyJson));
          if (typeof req.putHeaders === 'function') {
            req.putHeaders('content-type', 'application/connect+json');
            req.putHeaders('connect-protocol-version', '1');
            req.putHeaders('x-is-streaming', 'true');
          } else if (typeof req.getHeadersMap === 'function') {
            var map = req.getHeadersMap();
            if (map && typeof map.set === 'function') {
              map.set('content-type', 'application/connect+json');
              map.set('connect-protocol-version', '1');
              map.set('x-is-streaming', 'true');
            }
          }
          stream = ctx.client.streamProxyCommand(req, ctx.metadata);
          if (!stream || typeof stream.on !== 'function') {
            finish(false);
            return;
          }
          stream.on('data', function(res) {
            if (settled) return;
            var chunk = extractRawPayloadBytes(res);
            if (!chunk || chunk.length === 0) return;
            if (receivedValidFrame) {
              armSettleTimer();
            }
            rawBuffer = concatBytes(rawBuffer, chunk);
            var decoded = decodeConnectJsonFrames(rawBuffer);
            rawBuffer = decoded.remaining;
            for (var i = 0; i < decoded.frames.length; i++) {
              var frame = decoded.frames[i];
              var payload = frame.data;
              if (frame.flags === 2) {
                var endErr = payload && payload.error ? payload.error : payload;
                if (
                  endErr &&
                  typeof endErr === 'object' &&
                  typeof endErr.code === 'string' &&
                  endErr.code.toLowerCase() === 'unimplemented'
                ) {
                  unsupportedJetboxSummariesCache[cacheKey] = versionTag;
                }
                finish(receivedValidFrame);
                return;
              }
              if (payload && typeof payload === 'object') {
                if (hasConnectRpcError(payload) && !payload.updates && !payload.deletes) {
                  if (
                    typeof payload.code === 'string' &&
                    payload.code.toLowerCase() === 'unimplemented'
                  ) {
                    unsupportedJetboxSummariesCache[cacheKey] = versionTag;
                  }
                  finish(receivedValidFrame);
                  return;
                }
                receivedValidFrame = true;
                var updates = payload.updates;
                if (updates && typeof updates === 'object' && !Array.isArray(updates)) {
                  var uKeys = Object.keys(updates);
                  for (var u = 0; u < uKeys.length; u++) {
                    var uk = uKeys[u];
                    if (SAFE_ID_RE.test(uk) && updates[uk] && typeof updates[uk] === 'object') {
                      collected[uk] = updates[uk];
                    }
                  }
                }
                if (Array.isArray(payload.deletes)) {
                  for (var d = 0; d < payload.deletes.length; d++) {
                    var delId = payload.deletes[d];
                    if (typeof delId === 'string') {
                      delete collected[delId];
                    }
                  }
                }
                armSettleTimer();
              }
            }
          });
          stream.on('end', function() {
            finish(receivedValidFrame);
          });
          stream.on('error', function(err) {
            if (
              err &&
              (err.code === 12 ||
                (typeof err.message === 'string' &&
                  err.message.toLowerCase().indexOf('unimplemented') !== -1))
            ) {
              unsupportedJetboxSummariesCache[cacheKey] = versionTag;
            }
            finish(receivedValidFrame);
          });
        } catch (_) {
          finish(receivedValidFrame);
        }
      });
    }

    function callProxyJson(ctx, targetUuid, rpcPath, jsonBody, timeoutMs) {
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
      var rpcTimeout =
        typeof timeoutMs === 'number' && timeoutMs > 0
          ? timeoutMs
          : INSTANCE_RPC_TIMEOUT_MS;
      return withTimeout(
        ctx.client.proxyCommand(req, ctx.metadata),
        rpcTimeout,
        'ProxyCommand timeout'
      ).then(function(res) {
        var text = decodeResponseBytes(res);
        if (!text) return Object.create(null);
        return JSON.parse(text);
      });
    }

    function hasQuotaSummaryFields(obj) {
      if (!obj || typeof obj !== 'object') return false;
      return Boolean(
        obj.groups ||
          obj.quotaGroups ||
          obj.quota_groups ||
          obj.buckets ||
          obj.quotaBuckets ||
          obj.quota_buckets ||
          (obj.response && typeof obj.response === 'object') ||
          (obj.quotaSummary && typeof obj.quotaSummary === 'object') ||
          (obj.quota_summary && typeof obj.quota_summary === 'object')
      );
    }

    function hasUserStatusFields(obj) {
      if (!obj || typeof obj !== 'object') return false;
      return Boolean(
        obj.userStatus ||
          obj.user_status ||
          obj.userTier ||
          obj.user_tier ||
          obj.paidTier ||
          obj.paid_tier ||
          obj.currentTier ||
          obj.current_tier ||
          obj.planStatus ||
          obj.plan_status ||
          obj.cascadeModelConfigData ||
          obj.cascade_model_config_data ||
          obj.clientModelConfigs ||
          obj.client_model_configs ||
          obj.availableCredits ||
          obj.available_credits ||
          obj.email
      );
    }

    function hasModelConfigsInStatus(obj) {
      if (!obj || typeof obj !== 'object') return false;
      var root = obj.userStatus || obj.user_status || obj;
      if (!root || typeof root !== 'object') return false;
      var cascadeCfg =
        root.cascadeModelConfigData || root.cascade_model_config_data;
      if (
        cascadeCfg &&
        typeof cascadeCfg === 'object' &&
        (Array.isArray(cascadeCfg.clientModelConfigs) ||
          Array.isArray(cascadeCfg.client_model_configs))
      ) {
        return true;
      }
      return Boolean(
        Array.isArray(root.clientModelConfigs) ||
          Array.isArray(root.client_model_configs) ||
          Array.isArray(obj.modelConfigs) ||
          Array.isArray(obj.model_configs) ||
          (obj.models && typeof obj.models === 'object')
      );
    }

    function queryUsageOnCandidate(ctx, candidate) {
      var lastErr = null;
      var quotaPromise = callProxyJson(
        ctx,
        candidate.uuid,
        RETRIEVE_QUOTA_SUMMARY_PATH,
        '{}',
        USAGE_RPC_TIMEOUT_MS
      )
        .then(function(res) {
          return hasQuotaSummaryFields(res) ? res : null;
        })
        .catch(function(err) {
          if (err && err.message) lastErr = String(err.message);
          return null;
        });

      var statusPromise = callProxyJson(
        ctx,
        candidate.uuid,
        GET_USER_STATUS_PATH,
        DEFAULT_LS_METADATA_BODY,
        USAGE_RPC_TIMEOUT_MS
      )
        .then(function(res) {
          if (hasUserStatusFields(res)) return res;
          return callProxyJson(
            ctx,
            candidate.uuid,
            GET_USER_STATUS_PATH,
            '{}',
            USAGE_RPC_TIMEOUT_MS
          ).then(
            function(fallbackRes) {
              return hasUserStatusFields(fallbackRes) ? fallbackRes : null;
            }
          );
        })
        .catch(function(err) {
          if (err && err.message) lastErr = String(err.message);
          return callProxyJson(
            ctx,
            candidate.uuid,
            GET_USER_STATUS_PATH,
            '{}',
            USAGE_RPC_TIMEOUT_MS
          )
            .then(function(fallbackRes) {
              return hasUserStatusFields(fallbackRes) ? fallbackRes : null;
            })
            .catch(function(err2) {
              if (err2 && err2.message) lastErr = String(err2.message);
              return null;
            });
        });

      return Promise.all([quotaPromise, statusPromise]).then(function(pair) {
        var quotaSummaryRes = pair[0];
        var userStatusRes = pair[1];
        if (hasModelConfigsInStatus(userStatusRes)) {
          return {
            ok: true,
            payload: {
              instanceUuid: candidate.uuid,
              instanceName: candidate.name,
              fetchedAtMs: Date.now(),
              quotaSummary: quotaSummaryRes,
              userStatus: userStatusRes,
              commandModelConfigs: null,
              error: null
            }
          };
        }

        return callProxyJson(
          ctx,
          candidate.uuid,
          GET_COMMAND_MODEL_CONFIGS_PATH,
          DEFAULT_LS_METADATA_BODY,
          USAGE_RPC_TIMEOUT_MS
        )
          .then(function(cmdRes) {
            return hasModelConfigsInStatus(cmdRes) ? cmdRes : null;
          })
          .catch(function(err) {
            if (err && err.message) lastErr = String(err.message);
            return null;
          })
          .then(function(cmdConfigsRes) {
            if (!quotaSummaryRes && !userStatusRes && !cmdConfigsRes) {
              return {
                ok: false,
                error: lastErr
              };
            }
            return {
              ok: true,
              payload: {
                instanceUuid: candidate.uuid,
                instanceName: candidate.name,
                fetchedAtMs: Date.now(),
                quotaSummary: quotaSummaryRes,
                userStatus: userStatusRes,
                commandModelConfigs: cmdConfigsRes,
                error: null
              }
            };
          });
      });
    }

    function fetchUsageFromCandidates(ctx, candidates, forceUsage) {
      if (!candidates || candidates.length === 0) {
        lastUsageCache = null;
        lastUsageFetchedAtMs = 0;
        return Promise.resolve(null);
      }
      if (!forceUsage && document && document.visibilityState === 'hidden') {
        return Promise.resolve(lastUsageCache);
      }
      var now = Date.now();
      if (
        !forceUsage &&
        lastUsageCache &&
        now - lastUsageFetchedAtMs < USAGE_POLL_MIN_INTERVAL_MS
      ) {
        return Promise.resolve(lastUsageCache);
      }
      if (inFlightUsagePromise) {
        return inFlightUsagePromise;
      }

      var idx = 0;
      var firstError = null;
      function next() {
        if (idx >= candidates.length) {
          if (lastUsageCache) {
            return Promise.resolve(lastUsageCache);
          }
          if (firstError) {
            return Promise.resolve({
              instanceUuid: candidates[0].uuid,
              instanceName: candidates[0].name,
              fetchedAtMs: Date.now(),
              quotaSummary: null,
              userStatus: null,
              commandModelConfigs: null,
              error: firstError
            });
          }
          return Promise.resolve(null);
        }
        var current = candidates[idx++];
        return queryUsageOnCandidate(ctx, current).then(function(res) {
          if (res && res.ok && res.payload) {
            lastUsageCache = res.payload;
            lastUsageFetchedAtMs = res.payload.fetchedAtMs;
            return res.payload;
          }
          if (!firstError && res && res.error) {
            firstError = res.error;
          }
          return next();
        });
      }

      var job = next().then(
        function(result) {
          if (inFlightUsagePromise === job) {
            inFlightUsagePromise = null;
          }
          return result;
        },
        function() {
          if (inFlightUsagePromise === job) {
            inFlightUsagePromise = null;
          }
          return lastUsageCache;
        }
      );
      inFlightUsagePromise = job;
      return job;
    }

    function fetchProjectsForInstance(ctx, uuid) {
      return callProxyJson(ctx, uuid, LIST_PROJECTS_PATH, '{}', PROJECTS_RPC_TIMEOUT_MS)
        .then(function(listRes) {
          if (!listRes || typeof listRes !== 'object' || hasConnectRpcError(listRes)) {
            return lastProjectsCache[uuid] || null;
          }
          var inlineProjects = Array.isArray(listRes.projects) ? listRes.projects : null;
          var ids = Array.isArray(listRes.projectIds)
            ? listRes.projectIds
            : Array.isArray(listRes.project_ids)
              ? listRes.project_ids
              : [];
          var cleanIds = [];
          for (var i = 0; i < ids.length; i++) {
            if (
              typeof ids[i] === 'string' &&
              ids[i] !== 'outside-of-project' &&
              SAFE_ID_RE.test(ids[i])
            ) {
              cleanIds.push(ids[i]);
            }
          }
          if (cleanIds.length === 0) {
            var resolvedEmpty = inlineProjects ? compactProjectsList(inlineProjects) : [];
            lastProjectsCache[uuid] = resolvedEmpty;
            return resolvedEmpty;
          }
          if (inlineProjects && inlineProjects.length >= cleanIds.length) {
            var compactedInline = compactProjectsList(inlineProjects);
            lastProjectsCache[uuid] = compactedInline;
            return compactedInline;
          }
          var batchIdLists = [];
          var batchPromises = [];
          for (var offset = 0; offset < cleanIds.length; offset += READ_PROJECTS_BATCH_SIZE) {
            var batchIds = cleanIds.slice(offset, offset + READ_PROJECTS_BATCH_SIZE);
            batchIdLists.push(batchIds);
            batchPromises.push(
              callProxyJson(
                ctx,
                uuid,
                READ_PROJECTS_PATH,
                JSON.stringify({ ids: batchIds }),
                PROJECTS_RPC_TIMEOUT_MS
              )
                .then(function(readRes) {
                  return readRes && Array.isArray(readRes.projects)
                    ? readRes.projects
                    : null;
                })
                .catch(function() {
                  return null;
                })
            );
          }
          return Promise.all(batchPromises).then(function(batches) {
            var cachedById = Object.create(null);
            var prevCached = lastProjectsCache[uuid];
            if (Array.isArray(prevCached)) {
              for (var cIdx = 0; cIdx < prevCached.length; cIdx++) {
                var cp = prevCached[cIdx];
                var cid = cp && (cp.id || cp.projectId || cp.project_id);
                if (typeof cid === 'string' && cid) {
                  cachedById[cid] = cp;
                }
              }
            }
            var combined = [];
            var anyBatchSucceeded = false;
            for (var b = 0; b < batches.length; b++) {
              if (Array.isArray(batches[b])) {
                anyBatchSucceeded = true;
                for (var p = 0; p < batches[b].length; p++) {
                  combined.push(batches[b][p]);
                }
              } else {
                var failedIds = batchIdLists[b] || [];
                for (var f = 0; f < failedIds.length; f++) {
                  if (cachedById[failedIds[f]]) {
                    combined.push(cachedById[failedIds[f]]);
                  }
                }
              }
            }
            if (anyBatchSucceeded) {
              var compactedProjects = compactProjectsList(combined);
              lastProjectsCache[uuid] = compactedProjects;
              return compactedProjects;
            }
            return (
              (inlineProjects ? compactProjectsList(inlineProjects) : null) ||
              lastProjectsCache[uuid] ||
              null
            );
          });
        })
        .catch(function() {
          return lastProjectsCache[uuid] || null;
        });
    }

    function fetchWorkspaceInfosForInstance(ctx, uuid) {
      return callProxyJson(ctx, uuid, GET_WORKSPACE_INFOS_PATH, '{}', PROJECTS_RPC_TIMEOUT_MS)
        .then(function(wsRes) {
          if (!wsRes || typeof wsRes !== 'object' || hasConnectRpcError(wsRes)) {
            return {
              workspaceInfos: lastWorkspaceInfosCache[uuid] || null,
              homeDirUri: lastHomeDirCache[uuid] || null
            };
          }
          var infos = Array.isArray(wsRes.workspaceInfos)
            ? wsRes.workspaceInfos
            : Array.isArray(wsRes.workspace_infos)
              ? wsRes.workspace_infos
              : null;
          var homeUri =
            (typeof wsRes.homeDirUri === 'string' && wsRes.homeDirUri.trim()) ||
            (typeof wsRes.home_dir_uri === 'string' && wsRes.home_dir_uri.trim()) ||
            (typeof wsRes.homeDirPath === 'string' && wsRes.homeDirPath.trim()
              ? 'file://' + wsRes.homeDirPath.trim()
              : null) ||
            (typeof wsRes.home_dir_path === 'string' && wsRes.home_dir_path.trim()
              ? 'file://' + wsRes.home_dir_path.trim()
              : null) ||
            lastHomeDirCache[uuid] ||
            null;
          if (infos) {
            lastWorkspaceInfosCache[uuid] = infos;
          }
          if (homeUri) {
            lastHomeDirCache[uuid] = homeUri;
          }
          return {
            workspaceInfos: infos || lastWorkspaceInfosCache[uuid] || null,
            homeDirUri: homeUri
          };
        })
        .catch(function() {
          return {
            workspaceInfos: lastWorkspaceInfosCache[uuid] || null,
            homeDirUri: lastHomeDirCache[uuid] || null
          };
        });
    }

    function fetchBackgroundTasksForInstance(ctx, uuid, version) {
      var versionTag = version || '*';
      if (unsupportedBackgroundTasksCache[uuid] === versionTag) {
        return Promise.resolve({ ok: false, tasks: null });
      }
      return callProxyJson(
        ctx,
        uuid,
        LIST_BACKGROUND_TASKS_PATH,
        '{}',
        BACKGROUND_TASKS_RPC_TIMEOUT_MS
      )
        .then(function(res) {
          if (!res || typeof res !== 'object' || hasConnectRpcError(res)) {
            if (
              res &&
              typeof res.code === 'string' &&
              res.code.toLowerCase() === 'unimplemented'
            ) {
              unsupportedBackgroundTasksCache[uuid] = versionTag;
            }
            return { ok: false, tasks: null };
          }
          if (!Array.isArray(res.tasks) && Object.keys(res).length > 0) {
            return { ok: false, tasks: null };
          }
          var rawTasks = Array.isArray(res.tasks) ? res.tasks : [];
          var compact = [];
          for (var i = 0; i < rawTasks.length && compact.length < 256; i++) {
            var entry = rawTasks[i];
            if (!entry || typeof entry !== 'object') continue;
            var convId = entry.conversationId || entry.conversation_id || '';
            if (typeof convId !== 'string' || !SAFE_ID_RE.test(convId)) continue;
            var taskObj =
              entry.task && typeof entry.task === 'object' ? entry.task : null;
            var compactedTask = null;
            if (taskObj) {
              var rawTaskId = taskObj.taskId || taskObj.task_id;
              var rawToolName = taskObj.toolName || taskObj.tool_name;
              var rawToolSummary = taskObj.toolSummary || taskObj.tool_summary;
              var rawDescription = taskObj.description;
              compactedTask = {
                taskId:
                  typeof rawTaskId === 'string' && rawTaskId.trim()
                    ? rawTaskId.trim().slice(0, 128)
                    : undefined,
                toolName:
                  typeof rawToolName === 'string' && rawToolName.trim()
                    ? rawToolName.trim().slice(0, 64)
                    : undefined,
                toolSummary:
                  typeof rawToolSummary === 'string' && rawToolSummary.trim()
                    ? rawToolSummary.trim().slice(0, 140)
                    : undefined,
                description:
                  typeof rawDescription === 'string' && rawDescription.trim()
                    ? rawDescription.trim().slice(0, 140)
                    : undefined,
                isDaemon: Boolean(taskObj.isDaemon || taskObj.is_daemon)
              };
            }
            compact.push({
              conversationId: convId,
              task: compactedTask
            });
          }
          lastBackgroundTasksCache[uuid] = compact;
          return { ok: true, tasks: compact };
        })
        .catch(function() {
          return { ok: false, tasks: null };
        });
    }

    function refresh(forceUsage) {
      syncFullBleedWorkspace();
      var wantForcedUsage = Boolean(forceUsage);
      if (inFlightRefresh) {
        pendingFollowUpRefresh = true;
        if (wantForcedUsage) {
          pendingForcedUsageRefresh = true;
        }
        return inFlightRefresh;
      }
      var didForceUsageThisRun = wantForcedUsage || pendingForcedUsageRefresh;
      pendingFollowUpRefresh = false;
      pendingForcedUsageRefresh = false;

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
            var usageCandidates = [];

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
                  delete lastJetboxSummariesCache[uuid + ':local'];
                  delete lastJetboxSummariesCache[uuid + ':2'];
                  delete lastJetboxSummariesCache[uuid + ':3'];
                  delete unsupportedJetboxSummariesCache[uuid + ':local'];
                  delete unsupportedJetboxSummariesCache[uuid + ':2'];
                  delete unsupportedJetboxSummariesCache[uuid + ':3'];
                  delete lastBackgroundTasksCache[uuid];
                  delete unsupportedBackgroundTasksCache[uuid];
                  delete lastProjectsCache[uuid];
                  delete lastWorkspaceInfosCache[uuid];
                  delete lastHomeDirCache[uuid];
                  instanceJobs.push(
                    Promise.resolve({
                      uuid: uuid,
                      name: name || uuid,
                      status: status,
                      version: version || undefined,
                      updatedAtMs: updatedAtMs,
                      homeDirUri: null,
                      trajectories: null,
                      backgroundTasks: null,
                      projects: null,
                      workspaceInfos: null
                    })
                  );
                  return;
                }

                var candidateEntry = {
                  uuid: uuid,
                  name: name || uuid
                };
                if (route.instanceUuid === uuid) {
                  usageCandidates.unshift(candidateEntry);
                } else {
                  usageCandidates.push(candidateEntry);
                }

                var isHiddenBackgroundPoll =
                  typeof document !== 'undefined' &&
                  document.visibilityState === 'hidden';

                var cascadeTrajJob = callProxyJson(ctx, uuid, GET_TRAJECTORIES_PATH, '{}')
                  .then(function(parsed) {
                    var summaries =
                      (parsed &&
                        (parsed.trajectorySummaries ||
                          parsed.trajectory_summaries)) ||
                      parsed ||
                      Object.create(null);
                    return {
                      ok: true,
                      trajectories: summaries,
                      error: undefined
                    };
                  })
                  .catch(function(err) {
                    return {
                      ok: false,
                      trajectories: null,
                      error: err && err.message ? String(err.message) : 'Unreachable'
                    };
                  });

                // Antigravity's native sidebar populates all persisted conversations (and
                // project associations) via JetboxSubscribeToSummaries; GetAllCascadeTrajectories
                // alone can miss historical/disk-stored chats across projects.
                var localJetboxCacheKey = uuid + ':local';
                var jetboxTrajJob = isHiddenBackgroundPoll
                  ? Promise.resolve({
                      ok: false,
                      cachedSummaries: getCachedJetboxSummariesForInstance(uuid),
                      liveSummaries: null
                    })
                  : fetchJetboxSummariesStream(ctx, uuid, 0, version).then(function(res) {
                      if (res && res.ok && res.summaries) {
                        lastJetboxSummariesCache[localJetboxCacheKey] = res.summaries;
                        return {
                          ok: true,
                          liveSummaries: res.summaries,
                          cachedSummaries: null
                        };
                      }
                      return {
                        ok: false,
                        liveSummaries: null,
                        cachedSummaries: lastJetboxSummariesCache[localJetboxCacheKey] || null
                      };
                    });

                // Always fetch live running background tasks (even while backgrounded) so
                // threads waiting on background commands/timers/workflows never notify early.
                var bgTasksJob = fetchBackgroundTasksForInstance(ctx, uuid, version);
                var projectsJob = isHiddenBackgroundPoll
                  ? Promise.resolve(lastProjectsCache[uuid] || null)
                  : fetchProjectsForInstance(ctx, uuid);
                var wsInfoJob = isHiddenBackgroundPoll
                  ? Promise.resolve({
                      workspaceInfos: lastWorkspaceInfosCache[uuid] || null,
                      homeDirUri: lastHomeDirCache[uuid] || null
                    })
                  : fetchWorkspaceInfosForInstance(ctx, uuid);

                instanceJobs.push(
                  Promise.all([
                    cascadeTrajJob,
                    jetboxTrajJob,
                    bgTasksJob,
                    projectsJob,
                    wsInfoJob
                  ]).then(function(results) {
                    var cascadeResult = results[0];
                    var jetboxResult = results[1];
                    var bgTasksResult = results[2];
                    var projectsResult = results[3];
                    var wsResult = results[4] || { workspaceInfos: null, homeDirUri: null };

                    var extraBackends = [];
                    if (!isHiddenBackgroundPoll && Array.isArray(projectsResult)) {
                      var hasCloudProj = false;
                      var hasEntProj = false;
                      for (var pIdx = 0; pIdx < projectsResult.length; pIdx++) {
                        var bt = projectsResult[pIdx] && (projectsResult[pIdx].backendType || projectsResult[pIdx].backend_type);
                        if (bt === 2 || bt === 'BACKEND_TYPE_REMOTE_AICODE') hasCloudProj = true;
                        if (bt === 3 || bt === 'BACKEND_TYPE_REMOTE_ENTERPRISE') hasEntProj = true;
                      }
                      if (hasCloudProj) {
                        extraBackends.push(2);
                      } else {
                        delete lastJetboxSummariesCache[uuid + ':2'];
                      }
                      if (hasEntProj) {
                        extraBackends.push(3);
                      } else {
                        delete lastJetboxSummariesCache[uuid + ':3'];
                      }
                    }

                    var extraJetboxJob =
                      extraBackends.length > 0
                        ? Promise.all(
                            extraBackends.map(function(b) {
                              var bCacheKey = uuid + ':' + getJetboxBackendKey(b);
                              return fetchJetboxSummariesStream(ctx, uuid, b, version).then(function(res) {
                                if (res && res.ok && res.summaries) {
                                  lastJetboxSummariesCache[bCacheKey] = res.summaries;
                                  return {
                                    ok: true,
                                    liveSummaries: res.summaries,
                                    cachedSummaries: null
                                  };
                                }
                                return {
                                  ok: false,
                                  liveSummaries: null,
                                  cachedSummaries: lastJetboxSummariesCache[bCacheKey] || null
                                };
                              });
                            })
                          )
                        : Promise.resolve([]);

                    return extraJetboxJob.then(function(extraResults) {
                      var liveJetboxMap = jetboxResult && jetboxResult.liveSummaries
                        ? jetboxResult.liveSummaries
                        : null;
                      var cachedJetboxMap = jetboxResult && jetboxResult.cachedSummaries
                        ? jetboxResult.cachedSummaries
                        : null;
                      var anyLiveJetboxOk = Boolean(jetboxResult && jetboxResult.ok);

                      for (var eIdx = 0; eIdx < extraResults.length; eIdx++) {
                        var extra = extraResults[eIdx];
                        if (!extra) continue;
                        if (extra.ok && extra.liveSummaries) {
                          anyLiveJetboxOk = true;
                          liveJetboxMap = liveJetboxMap
                            ? mergeTrajectorySummaryMaps(liveJetboxMap, extra.liveSummaries, true)
                            : extra.liveSummaries;
                        } else if (extra.cachedSummaries) {
                          cachedJetboxMap = cachedJetboxMap
                            ? mergeTrajectorySummaryMaps(cachedJetboxMap, extra.cachedSummaries, true)
                            : extra.cachedSummaries;
                        }
                      }

                      var anyTrajOk = Boolean(cascadeResult.ok || anyLiveJetboxOk);
                      var finalTrajectories = null;
                      if (anyTrajOk) {
                        var liveMerged = mergeTrajectorySummaryMaps(
                          liveJetboxMap,
                          cascadeResult.ok ? cascadeResult.trajectories : null,
                          true
                        );
                        var withCachedFallback = cachedJetboxMap
                          ? mergeTrajectorySummaryMaps(cachedJetboxMap, liveMerged, false)
                          : liveMerged;
                        finalTrajectories = compactTrajectorySummaries(withCachedFallback);
                        lastTrajectoryCache[uuid] = finalTrajectories;
                      } else {
                        finalTrajectories = lastTrajectoryCache[uuid] || null;
                      }

                      var resolvedBgTasks =
                        bgTasksResult && bgTasksResult.ok
                          ? bgTasksResult.tasks
                          : !anyTrajOk
                            ? (lastBackgroundTasksCache[uuid] || null)
                            : null;
                      var payload = {
                        uuid: uuid,
                        name: name || uuid,
                        status: status,
                        version: version || undefined,
                        updatedAtMs: updatedAtMs,
                        homeDirUri: wsResult.homeDirUri || null,
                        trajectories: finalTrajectories,
                        backgroundTasks: resolvedBgTasks,
                        projects: projectsResult,
                        workspaceInfos: wsResult.workspaceInfos
                      };
                      if (!anyTrajOk && cascadeResult.error) {
                        payload.error = cascadeResult.error;
                      }
                      return payload;
                    });
                  })
                );
              })(rawList[i]);
            }

            var instancesPromise = Promise.all(instanceJobs);
            var usageJob = fetchUsageFromCandidates(
              ctx,
              usageCandidates,
              didForceUsageThisRun
            );

            return instancesPromise.then(function(instancesPayload) {
              lastInstancesPayloadCache = instancesPayload;

              return new Promise(function(resolveSnapshot) {
                var emittedInitialSnapshot = false;
                var inlineBudgetTimer = setTimeout(function() {
                  if (emittedInitialSnapshot || isStopped) return;
                  emittedInitialSnapshot = true;
                  var fallbackRoute = parseRouteFromLocation();
                  postToNative({
                    type: 'AGY_INBOX_SNAPSHOT',
                    fetchedAtMs: Date.now(),
                    activeUrl: window.location.href,
                    activeInstanceUuid: fallbackRoute.instanceUuid,
                    activeCascadeId: fallbackRoute.cascadeId,
                    instances: instancesPayload,
                    cloudTrajectories: cloudTrajectoriesCache,
                    usage: lastUsageCache,
                    error: null
                  });
                  resolveSnapshot();
                }, USAGE_INLINE_BUDGET_MS);

                usageJob.then(function(usagePayload) {
                  clearTimeout(inlineBudgetTimer);
                  if (isStopped) {
                    if (!emittedInitialSnapshot) {
                      emittedInitialSnapshot = true;
                      resolveSnapshot();
                    }
                    return;
                  }
                  var latestRoute = parseRouteFromLocation();
                  if (!emittedInitialSnapshot) {
                    emittedInitialSnapshot = true;
                    postToNative({
                      type: 'AGY_INBOX_SNAPSHOT',
                      fetchedAtMs: Date.now(),
                      activeUrl: window.location.href,
                      activeInstanceUuid: latestRoute.instanceUuid,
                      activeCascadeId: latestRoute.cascadeId,
                      instances: instancesPayload,
                      cloudTrajectories: cloudTrajectoriesCache,
                      usage: usagePayload,
                      error: null
                    });
                    resolveSnapshot();
                    return;
                  }
                  if (usagePayload) {
                    postToNative({
                      type: 'AGY_INBOX_SNAPSHOT',
                      fetchedAtMs: Date.now(),
                      activeUrl: window.location.href,
                      activeInstanceUuid: latestRoute.instanceUuid,
                      activeCascadeId: latestRoute.cascadeId,
                      instances: lastInstancesPayloadCache,
                      cloudTrajectories: cloudTrajectoriesCache,
                      usage: usagePayload,
                      error: null
                    });
                  }
                });
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
            usage: lastUsageCache,
            error: err && err.message ? String(err.message) : 'Unable to query Antigravity instances'
          });
        })
        .then(function() {
          inFlightRefresh = null;
          if (isStopped) {
            pendingFollowUpRefresh = false;
            pendingForcedUsageRefresh = false;
            return;
          }
          if (
            pendingFollowUpRefresh ||
            (pendingForcedUsageRefresh && !didForceUsageThisRun)
          ) {
            var nextForceUsage =
              pendingForcedUsageRefresh && !didForceUsageThisRun;
            pendingFollowUpRefresh = false;
            pendingForcedUsageRefresh = false;
            return refresh(nextForceUsage);
          }
          pendingForcedUsageRefresh = false;
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

    function isElementHiddenInHost(el) {
      if (!el) return true;
      if (el.hidden === true) return true;
      if (typeof el.getAttribute === 'function') {
        var ariaHidden = el.getAttribute('aria-hidden');
        if (ariaHidden === 'true') return true;
      }
      if (el.style) {
        var inlineDisplay =
          typeof el.style.getPropertyValue === 'function'
            ? el.style.getPropertyValue('display')
            : el.style.display || '';
        var inlineVis =
          typeof el.style.getPropertyValue === 'function'
            ? el.style.getPropertyValue('visibility')
            : el.style.visibility || '';
        if (inlineDisplay === 'none' || inlineVis === 'hidden') {
          return true;
        }
      }
      if (typeof window.getComputedStyle === 'function') {
        try {
          var cs = window.getComputedStyle(el);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) {
            return true;
          }
        } catch (_) {}
      }
      return false;
    }

    function isFrameVisibleInHost(frame) {
      if (!frame) return false;
      var node = frame;
      var guard = 0;
      while (
        node &&
        node !== document.body &&
        node !== document.documentElement &&
        guard < 40
      ) {
        guard++;
        if (isElementHiddenInHost(node)) {
          return false;
        }
        node = node.parentElement;
      }
      return true;
    }

    function findHubIframe(requireVisible) {
      if (!document || typeof document.querySelectorAll !== 'function') {
        return null;
      }
      var frames = document.querySelectorAll('iframe');
      var fallbackMatch = null;
      for (var i = 0; i < frames.length; i++) {
        var candidate = frames[i];
        if (!candidate) continue;
        var getAttr = typeof candidate.getAttribute === 'function'
          ? candidate.getAttribute('src')
          : '';
        var src = getAttr || candidate.src || '';
        if (src.indexOf('https://antigravity.static.usercontent.goog/web/') === 0) {
          if (isFrameVisibleInHost(candidate)) {
            return candidate;
          }
          if (!fallbackMatch) {
            fallbackMatch = candidate;
          }
        }
      }
      return requireVisible ? null : fallbackMatch;
    }

    var NON_VISUAL_HOST_TAGS = {
      SCRIPT: true,
      STYLE: true,
      LINK: true,
      NOSCRIPT: true,
      TEMPLATE: true,
      META: true
    };
    var OVERLAY_CLASS_RE = /\\b(cdk-overlay|mat-mdc-dialog|mdc-dialog|mat-mdc-menu-panel)\\b/i;
    var HOST_SETTINGS_LABEL_RE = /\\b(settings?|preferences?|configure|configuration)\\b/i;
    var HOST_SETTINGS_ATTR_RE = /(?:^|[-_\\s])(settings?|preferences?)(?:$|[-_\\s])/i;
    var HOST_SETTINGS_EXCLUDE_RE = /\\b(feedback|account|profile|avatar|reload|refresh|sign\\s*in|sign\\s*out)\\b/i;
    var fullBleedStyleRecords = [];
    var isFullBleedActive = false;
    var promotedFrame = null;
    var fullBleedTimer = null;
    var domObserver = null;

    function hasStyleApi(el) {
      return Boolean(
        el &&
          el.style &&
          typeof el.style.setProperty === 'function' &&
          typeof el.style.removeProperty === 'function' &&
          typeof el.style.getPropertyValue === 'function'
      );
    }

    function recordAndSetStyle(el, prop, value, priority) {
      if (!hasStyleApi(el)) return;
      var pri = priority || 'important';
      var existing = null;
      for (var i = 0; i < fullBleedStyleRecords.length; i++) {
        if (
          fullBleedStyleRecords[i].el === el &&
          fullBleedStyleRecords[i].prop === prop
        ) {
          existing = fullBleedStyleRecords[i];
          break;
        }
      }
      if (!existing) {
        var prevPri =
          typeof el.style.getPropertyPriority === 'function'
            ? el.style.getPropertyPriority(prop)
            : '';
        fullBleedStyleRecords.push({
          el: el,
          prop: prop,
          val: el.style.getPropertyValue(prop) || '',
          pri: prevPri || ''
        });
      }
      var curVal = el.style.getPropertyValue(prop);
      var curPri =
        typeof el.style.getPropertyPriority === 'function'
          ? el.style.getPropertyPriority(prop)
          : pri;
      if (curVal !== value || curPri !== pri) {
        el.style.setProperty(prop, value, pri);
      }
    }

    function restoreSingleStyleRecord(el, prop) {
      if (!hasStyleApi(el)) return;
      for (var i = fullBleedStyleRecords.length - 1; i >= 0; i--) {
        var rec = fullBleedStyleRecords[i];
        if (rec.el === el && rec.prop === prop) {
          if (rec.val) {
            el.style.setProperty(rec.prop, rec.val, rec.pri || '');
          } else {
            el.style.removeProperty(rec.prop);
          }
          fullBleedStyleRecords.splice(i, 1);
        }
      }
    }

    function restoreHostChrome() {
      for (var i = fullBleedStyleRecords.length - 1; i >= 0; i--) {
        var rec = fullBleedStyleRecords[i];
        try {
          if (hasStyleApi(rec.el)) {
            if (rec.val) {
              rec.el.style.setProperty(rec.prop, rec.val, rec.pri || '');
            } else {
              rec.el.style.removeProperty(rec.prop);
            }
          }
        } catch (_) {}
      }
      fullBleedStyleRecords = [];
      isFullBleedActive = false;
      promotedFrame = null;
    }

    function isOverlayOrDialogElement(el) {
      if (!el) return false;
      var tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
      if (tag === 'DIALOG') return true;
      var hasAttr = typeof el.hasAttribute === 'function';
      var getAttr = typeof el.getAttribute === 'function';
      if (
        (hasAttr && el.hasAttribute('popover')) ||
        (getAttr && el.getAttribute('popover') !== null)
      ) {
        return true;
      }
      var role = getAttr ? el.getAttribute('role') || '' : '';
      if (
        role === 'dialog' ||
        role === 'alertdialog' ||
        role === 'menu' ||
        role === 'listbox'
      ) {
        return true;
      }
      var ariaModal = getAttr ? el.getAttribute('aria-modal') || '' : '';
      if (ariaModal === 'true') return true;
      var cls = typeof el.className === 'string' ? el.className : '';
      if (cls && OVERLAY_CLASS_RE.test(cls)) return true;
      if (typeof el.querySelector === 'function') {
        try {
          if (
            el.querySelector(
              '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"], dialog[open], [popover], .cdk-overlay-pane'
            )
          ) {
            return true;
          }
        } catch (_) {}
      }
      return false;
    }

    function syncFullBleedWorkspace() {
      if (isStopped) return false;
      if (!document || !document.body) {
        return false;
      }
      var instanceUuid = extractInstanceUuidFromHostPath();
      var frame = instanceUuid ? findHubIframe(true) : null;
      if (!instanceUuid || !frame) {
        if (isFullBleedActive) {
          restoreHostChrome();
        }
        return false;
      }

      if (promotedFrame && promotedFrame !== frame) {
        restoreHostChrome();
      }
      var didPromoteNewFrame = promotedFrame !== frame;

      var cur = frame;
      var guard = 0;
      while (
        cur &&
        cur !== document.body &&
        cur !== document.documentElement &&
        guard < 40
      ) {
        guard++;
        var parent = cur.parentElement;
        if (!parent) break;
        if (cur !== frame && hasStyleApi(cur)) {
          recordAndSetStyle(cur, 'margin-top', '0px', 'important');
          recordAndSetStyle(cur, 'padding-top', '0px', 'important');
        }
        var siblings = parent.children || [];
        for (var s = 0; s < siblings.length; s++) {
          var sib = siblings[s];
          if (!sib || sib === cur) continue;
          var sibTag =
            typeof sib.tagName === 'string' ? sib.tagName.toUpperCase() : '';
          if (NON_VISUAL_HOST_TAGS[sibTag]) continue;
          if (isOverlayOrDialogElement(sib)) {
            restoreSingleStyleRecord(sib, 'display');
            var sibPos = '';
            if (typeof window.getComputedStyle === 'function') {
              try {
                var sibCs = window.getComputedStyle(sib);
                sibPos = (sibCs && sibCs.position) || '';
              } catch (_) {}
            }
            if (!sibPos && sib.style) {
              sibPos =
                typeof sib.style.getPropertyValue === 'function'
                  ? sib.style.getPropertyValue('position')
                  : sib.style.position || '';
            }
            if (!sibPos || sibPos === 'static') {
              recordAndSetStyle(sib, 'position', 'relative', 'important');
            }
            recordAndSetStyle(sib, 'z-index', '2000', 'important');
          } else {
            recordAndSetStyle(sib, 'display', 'none', 'important');
          }
        }
        cur = parent;
      }

      if (hasStyleApi(document.body)) {
        recordAndSetStyle(document.body, 'margin', '0px', 'important');
        recordAndSetStyle(document.body, 'padding', '0px', 'important');
        recordAndSetStyle(document.body, 'overflow', 'hidden', 'important');
      }

      if (hasStyleApi(frame)) {
        var vv = window.visualViewport;
        var vvScale =
          vv && typeof vv.scale === 'number' && isFinite(vv.scale) ? vv.scale : 1;
        var vvHeight =
          vv &&
          typeof vv.height === 'number' &&
          isFinite(vv.height) &&
          vv.height > 0
            ? vv.height
            : 0;
        var vvWidth =
          vv &&
          typeof vv.width === 'number' &&
          isFinite(vv.width) &&
          vv.width > 0
            ? vv.width
            : 0;
        var vvTop =
          vv && typeof vv.offsetTop === 'number' && isFinite(vv.offsetTop)
            ? Math.max(0, vv.offsetTop)
            : 0;
        var vvLeft =
          vv && typeof vv.offsetLeft === 'number' && isFinite(vv.offsetLeft)
            ? Math.max(0, vv.offsetLeft)
            : 0;
        var innerH =
          typeof window.innerHeight === 'number' &&
          isFinite(window.innerHeight) &&
          window.innerHeight > 0
            ? window.innerHeight
            : 0;
        var innerW =
          typeof window.innerWidth === 'number' &&
          isFinite(window.innerWidth) &&
          window.innerWidth > 0
            ? window.innerWidth
            : 0;
        var useVisualBounds =
          Math.abs(vvScale - 1) < 0.05 &&
          vvHeight > 0 &&
          innerH > 0 &&
          (innerH - vvHeight > 2 ||
            vvTop > 1 ||
            (vvWidth > 0 && innerW - vvWidth > 2) ||
            vvLeft > 1);

        recordAndSetStyle(frame, 'position', 'fixed', 'important');
        if (useVisualBounds) {
          var heightPx = Math.round(vvHeight) + 'px';
          var widthPx = vvWidth > 0 ? Math.round(vvWidth) + 'px' : '100%';
          recordAndSetStyle(frame, 'top', Math.round(vvTop) + 'px', 'important');
          recordAndSetStyle(
            frame,
            'left',
            Math.round(vvLeft) + 'px',
            'important'
          );
          recordAndSetStyle(frame, 'right', 'auto', 'important');
          recordAndSetStyle(frame, 'bottom', 'auto', 'important');
          recordAndSetStyle(frame, 'width', widthPx, 'important');
          recordAndSetStyle(frame, 'height', heightPx, 'important');
          recordAndSetStyle(frame, 'max-width', widthPx, 'important');
          recordAndSetStyle(frame, 'max-height', heightPx, 'important');
        } else {
          recordAndSetStyle(frame, 'top', '0px', 'important');
          recordAndSetStyle(frame, 'left', '0px', 'important');
          recordAndSetStyle(frame, 'right', '0px', 'important');
          recordAndSetStyle(frame, 'bottom', '0px', 'important');
          recordAndSetStyle(frame, 'width', '100%', 'important');
          recordAndSetStyle(frame, 'height', '100%', 'important');
          recordAndSetStyle(frame, 'max-width', '100%', 'important');
          recordAndSetStyle(frame, 'max-height', '100%', 'important');
        }
        recordAndSetStyle(frame, 'margin', '0px', 'important');
        recordAndSetStyle(frame, 'border', '0px', 'important');
        recordAndSetStyle(frame, 'z-index', '990', 'important');
      }

      isFullBleedActive = true;
      promotedFrame = frame;
      if (didPromoteNewFrame && activeThreadContext) {
        syncActiveThreadContext();
      }
      return true;
    }

    function sanitizeThreadContext(raw) {
      if (!raw || typeof raw !== 'object') return null;
      var cid = typeof raw.cascadeId === 'string' ? raw.cascadeId.trim() : '';
      var projName =
        typeof raw.projectName === 'string' ? raw.projectName.trim() : '';
      if (!cid || !SAFE_ID_RE.test(cid) || !projName) {
        return null;
      }
      var instUuid =
        typeof raw.instanceUuid === 'string' &&
        SAFE_ID_RE.test(raw.instanceUuid.trim())
          ? raw.instanceUuid.trim()
          : null;
      var projId =
        typeof raw.projectId === 'string' && SAFE_ID_RE.test(raw.projectId.trim())
          ? raw.projectId.trim()
          : null;
      var instName =
        typeof raw.instanceName === 'string' && raw.instanceName.trim()
          ? raw.instanceName.trim().slice(0, 72)
          : null;
      return {
        instanceUuid: instUuid,
        cascadeId: cid,
        projectId: projId,
        projectName: projName.slice(0, 72),
        instanceName: instName
      };
    }

    function syncActiveThreadContext() {
      try {
        if (
          window.__agyOverviewScrollBridge &&
          typeof window.__agyOverviewScrollBridge.setThreadContext === 'function'
        ) {
          window.__agyOverviewScrollBridge.setThreadContext(activeThreadContext);
        }
      } catch (_) {}
      try {
        var frame = findHubIframe(false);
        if (frame && frame.contentWindow && frame.src) {
          var frameOrigin = new URL(frame.src).origin;
          if (frameOrigin === 'https://antigravity.static.usercontent.goog') {
            frame.contentWindow.postMessage(
              {
                type: 'AGY_REMOTE_THREAD_CONTEXT',
                context: activeThreadContext
              },
              frameOrigin
            );
          }
        }
      } catch (_) {}
    }

    function setActiveThreadContext(nextContext) {
      activeThreadContext = sanitizeThreadContext(nextContext);
      syncActiveThreadContext();
    }

    function scheduleFullBleedSync(delayMs) {
      var wait = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 35;
      if (fullBleedTimer) {
        clearTimeout(fullBleedTimer);
      }
      fullBleedTimer = setTimeout(function() {
        fullBleedTimer = null;
        syncFullBleedWorkspace();
      }, wait);
    }

    function isInsideOverlayContainer(el) {
      var node = el ? el.parentElement : null;
      var depth = 0;
      while (node && node !== document.body && depth < 30) {
        depth++;
        if (isOverlayOrDialogElement(node)) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    }

    function findHostSettingsButton() {
      if (!document || typeof document.querySelectorAll !== 'function') {
        return null;
      }
      var candidates = document.querySelectorAll('button, [role="button"]');
      var iconFallback = null;
      var attrFallback = null;
      for (var i = 0; i < candidates.length; i++) {
        var btn = candidates[i];
        if (!btn || isInsideOverlayContainer(btn)) continue;
        var getAttr = typeof btn.getAttribute === 'function';
        var labelParts = [
          getAttr ? btn.getAttribute('aria-label') || '' : '',
          getAttr ? btn.getAttribute('title') || '' : '',
          getAttr ? btn.getAttribute('mattooltip') || '' : '',
          getAttr ? btn.getAttribute('data-tooltip') || '' : ''
        ];
        var combinedLabel = labelParts.join(' ').trim();
        if (combinedLabel && HOST_SETTINGS_EXCLUDE_RE.test(combinedLabel)) {
          continue;
        }
        if (combinedLabel && HOST_SETTINGS_LABEL_RE.test(combinedLabel)) {
          return btn;
        }
        if (!iconFallback) {
          var rawText =
            typeof btn.textContent === 'string'
              ? btn.textContent.trim().toLowerCase()
              : '';
          if (rawText === 'settings' || rawText === 'tune') {
            iconFallback = btn;
          }
        }
        if (!attrFallback) {
          var attrParts = [
            getAttr ? btn.getAttribute('data-testid') || '' : '',
            getAttr ? btn.getAttribute('id') || '' : '',
            typeof btn.className === 'string' ? btn.className : ''
          ];
          var combinedAttrs = attrParts.join(' ').trim();
          if (
            combinedAttrs &&
            !HOST_SETTINGS_EXCLUDE_RE.test(combinedAttrs) &&
            HOST_SETTINGS_ATTR_RE.test(combinedAttrs)
          ) {
            attrFallback = btn;
          }
        }
      }
      return iconFallback || attrFallback;
    }

    function openHostSettings() {
      try {
        var btn = findHostSettingsButton();
        if (btn) {
          if (typeof btn.click === 'function') {
            btn.click();
          } else if (
            typeof btn.dispatchEvent === 'function' &&
            typeof Event === 'function'
          ) {
            btn.dispatchEvent(new Event('click', { bubbles: true }));
          }
          syncFullBleedWorkspace();
          setTimeout(syncFullBleedWorkspace, 60);
          setTimeout(syncFullBleedWorkspace, 200);
          postToNative({
            type: 'AGY_INBOX_HOST_SETTINGS_RESULT',
            handled: true
          });
          return true;
        }
      } catch (_) {}
      postToNative({
        type: 'AGY_INBOX_HOST_SETTINGS_RESULT',
        handled: false
      });
      return false;
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

    function clearPendingStartNav() {
      if (pendingStartNav) {
        if (pendingStartNav.timer) {
          clearTimeout(pendingStartNav.timer);
        }
        if (pendingStartNav.probeTimers) {
          for (var i = 0; i < pendingStartNav.probeTimers.length; i++) {
            clearTimeout(pendingStartNav.probeTimers[i]);
          }
        }
      }
      pendingStartNav = null;
    }

    function completePendingStartNavIfMatched(confirmedCascadeId, hostHandlesUrlSync) {
      if (!pendingStartNav || !confirmedCascadeId) {
        return false;
      }
      if (confirmedCascadeId !== pendingStartNav.expectedCascadeId) {
        return false;
      }
      var completed = pendingStartNav;
      clearPendingStartNav();
      if (!hostHandlesUrlSync) {
        syncHostLocationUrl(completed.targetUrl);
      }
      setIframeCascadeOverride(confirmedCascadeId);
      postToNative({
        type: 'AGY_INBOX_START_CHAT_RESULT',
        requestId: completed.requestId,
        handled: true,
        cascadeId: confirmedCascadeId,
        targetUrl: completed.targetUrl
      });
      postToNative({
        type: 'AGY_INBOX_ACTIVE_ROUTE',
        activeUrl: completed.targetUrl || window.location.href,
        activeInstanceUuid: completed.instanceUuid,
        activeCascadeId: confirmedCascadeId
      });
      return true;
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

    function clearHostChildPathParam() {
      if (
        !window.location ||
        !window.history ||
        typeof window.history.replaceState !== 'function'
      ) {
        return;
      }
      try {
        var parsedCurrent = new URL(window.location.href);
        if (!parsedCurrent.searchParams.has('p')) {
          return;
        }
        parsedCurrent.searchParams.delete('p');
        var nextSearch = parsedCurrent.searchParams.toString();
        var nextRelativeUrl =
          parsedCurrent.pathname +
          (nextSearch ? '?' + nextSearch : '') +
          parsedCurrent.hash;
        window.history.replaceState(window.history.state, '', nextRelativeUrl);
        if (typeof window.location.search === 'string') {
          try {
            var updatedHref = parsedCurrent.origin + nextRelativeUrl;
            if (window.location.href !== updatedHref) {
              // Real browsers update window.location synchronously via replaceState.
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    function completePendingFastNavIfMatched(confirmedCascadeId, hostHandlesUrlSync) {
      if (!pendingFastNav || !confirmedCascadeId) {
        return false;
      }
      if (confirmedCascadeId !== pendingFastNav.expectedCascadeId) {
        return false;
      }
      var completed = pendingFastNav;
      clearPendingFastNav();
      if (!hostHandlesUrlSync) {
        syncHostLocationUrl(completed.targetUrl);
      }
      setIframeCascadeOverride(confirmedCascadeId);
      postToNative({
        type: 'AGY_INBOX_FAST_NAV_RESULT',
        requestId: completed.requestId,
        handled: true,
        targetUrl: completed.targetUrl
      });
      postToNative({
        type: 'AGY_INBOX_ACTIVE_ROUTE',
        activeUrl: completed.targetUrl || window.location.href,
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

    function extractCreatedCascadeId(res) {
      if (!res || typeof res !== 'object' || hasConnectRpcError(res)) return null;
      var candidate =
        res.cascadeId ||
        res.cascade_id ||
        res.trajectoryId ||
        res.trajectory_id ||
        (res.response &&
          typeof res.response === 'object' &&
          (res.response.cascadeId || res.response.cascade_id)) ||
        null;
      return typeof candidate === 'string' && SAFE_ID_RE.test(candidate)
        ? candidate
        : null;
    }

    function buildCascadeTargetUrl(baseUrl, cascadeId) {
      try {
        var parsed = new URL(baseUrl);
        parsed.searchParams.set('p', 'c/' + cascadeId);
        return parsed.toString();
      } catch (_) {
        var sep = String(baseUrl || '').indexOf('?') === -1 ? '?p=' : '&p=';
        return String(baseUrl || '') + sep + encodeURIComponent('c/' + cascadeId);
      }
    }

    function navigateIframeToNewChatOverview(requestId, instanceUuid, targetUrl, projectId) {
      var route = parseRouteFromLocation();
      var frame = findHubIframe();
      var cleanProjectId =
        typeof projectId === 'string' && SAFE_ID_RE.test(projectId.trim())
          ? projectId.trim()
          : null;
      var navPath = cleanProjectId
        ? '/?project=' + encodeURIComponent(cleanProjectId)
        : '/';
      if (
        route.instanceUuid === instanceUuid &&
        frame &&
        frame.contentWindow &&
        frame.src
      ) {
        try {
          var frameOrigin = new URL(frame.src).origin;
          frame.contentWindow.postMessage(
            { jspbPayload: JSON.stringify([null, [navPath]]) },
            frameOrigin
          );
          frame.contentWindow.postMessage(
            { jspbPayload: JSON.stringify([null, null, []]) },
            frameOrigin
          );
          clearHostChildPathParam();
          setIframeCascadeOverride(null);
          postToNative({
            type: 'AGY_INBOX_START_CHAT_RESULT',
            requestId: requestId,
            handled: true,
            cascadeId: null,
            targetUrl: targetUrl
          });
          postToNative({
            type: 'AGY_INBOX_ACTIVE_ROUTE',
            activeUrl: window.location.href,
            activeInstanceUuid: instanceUuid,
            activeCascadeId: null
          });
          return true;
        } catch (_) {}
      }
      postToNative({
        type: 'AGY_INBOX_START_CHAT_RESULT',
        requestId: requestId,
        handled: false,
        cascadeId: null,
        targetUrl: targetUrl
      });
      return false;
    }

    function tryStartCascadeRequest(ctx, instanceUuid, bodyObj) {
      var requestedId = bodyObj.cascadeId;
      return callProxyJson(
        ctx,
        instanceUuid,
        START_CASCADE_PATH,
        JSON.stringify(bodyObj),
        START_CASCADE_TIMEOUT_MS
      )
        .then(function(res) {
          if (hasConnectRpcError(res)) {
            return null;
          }
          var returnedId = extractCreatedCascadeId(res);
          if (returnedId) {
            return returnedId;
          }
          // Some Connect responses return an empty JSON object {} when the
          // client-generated cascadeId was accepted without modification.
          if (
            res &&
            typeof res === 'object' &&
            Object.keys(res).length === 0 &&
            typeof requestedId === 'string' &&
            SAFE_ID_RE.test(requestedId)
          ) {
            return requestedId;
          }
          return null;
        })
        .catch(function() {
          return null;
        });
    }

    function startProjectChat(requestId, instanceUuid, workspaceUri, targetUrl, projectId) {
      if (!instanceUuid || instanceUuid === '__cloud__') {
        postToNative({
          type: 'AGY_INBOX_START_CHAT_RESULT',
          requestId: requestId,
          handled: false,
          cascadeId: null,
          targetUrl: targetUrl
        });
        return Promise.resolve(false);
      }

      var cleanProjectId =
        typeof projectId === 'string' && SAFE_ID_RE.test(projectId.trim())
          ? projectId.trim()
          : null;
      var cleanUri =
        typeof workspaceUri === 'string' && workspaceUri.trim()
          ? workspaceUri.trim()
          : null;

      return getClientWithMetadata()
        .then(function(ctx) {
          if (!ctx) {
            return null;
          }
          var attempts = [];
          if (cleanProjectId) {
            // Note: StartCascadeRequest carries projectId exclusively inside
            // projectEnvConfig (never as a top-level field, which strict
            // protojson unmarshalers reject).
            attempts.push({
              cascadeId: generateUuidV4(),
              source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
              projectEnvConfig: {
                projectId: cleanProjectId,
                defaultProjectEnvironment: {}
              },
              workspaceUris: [],
              metadata: DEFAULT_LS_METADATA_OBJ
            });
          }
          if (cleanUri) {
            attempts.push({
              cascadeId: generateUuidV4(),
              source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
              workspaceUris: [cleanUri],
              metadata: DEFAULT_LS_METADATA_OBJ
            });
          }
          attempts.push({
            cascadeId: generateUuidV4(),
            source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
            metadata: DEFAULT_LS_METADATA_OBJ
          });

          var idx = 0;
          function runNextAttempt() {
            if (idx >= attempts.length) {
              return Promise.resolve(null);
            }
            var bodyObj = attempts[idx++];
            return tryStartCascadeRequest(ctx, instanceUuid, bodyObj).then(function(cid) {
              if (cid) return cid;
              return runNextAttempt();
            });
          }
          return runNextAttempt();
        })
        .then(function(cascadeId) {
          if (!cascadeId) {
            return navigateIframeToNewChatOverview(
              requestId,
              instanceUuid,
              targetUrl,
              cleanProjectId
            );
          }

          scheduleRefresh(250);
          var createdUrl = buildCascadeTargetUrl(targetUrl, cascadeId);
          var route = parseRouteFromLocation();
          var frame = findHubIframe();
          if (
            route.instanceUuid === instanceUuid &&
            frame &&
            frame.contentWindow &&
            frame.src
          ) {
            try {
              clearPendingStartNav();
              var frameOrigin = new URL(frame.src).origin;
              var navChildPath =
                '/c/' +
                cascadeId +
                (cleanProjectId ? '?project=' + encodeURIComponent(cleanProjectId) : '');
              var probeTimers = [];
              var scheduleUrlProbe = function(delayMs) {
                var probeTimer = setTimeout(function() {
                  if (!pendingStartNav || pendingStartNav.requestId !== requestId) {
                    return;
                  }
                  try {
                    if (frame && frame.contentWindow) {
                      frame.contentWindow.postMessage(
                        { jspbPayload: JSON.stringify([null, null, []]) },
                        frameOrigin
                      );
                    }
                  } catch (_) {}
                }, delayMs);
                probeTimers.push(probeTimer);
              };
              var timer = setTimeout(function() {
                if (!pendingStartNav || pendingStartNav.requestId !== requestId) {
                  return;
                }
                clearPendingStartNav();
                postToNative({
                  type: 'AGY_INBOX_START_CHAT_RESULT',
                  requestId: requestId,
                  handled: false,
                  cascadeId: cascadeId,
                  targetUrl: createdUrl
                });
              }, START_NAV_CONFIRM_MS);
              pendingStartNav = {
                requestId: requestId,
                instanceUuid: instanceUuid,
                expectedCascadeId: cascadeId,
                targetUrl: createdUrl,
                timer: timer,
                probeTimers: probeTimers
              };
              frame.contentWindow.postMessage(
                { jspbPayload: JSON.stringify([null, [navChildPath]]) },
                frameOrigin
              );
              frame.contentWindow.postMessage(
                { jspbPayload: JSON.stringify([null, null, []]) },
                frameOrigin
              );
              // TanStack Router's navigate() settles asynchronously; follow-up GET_URL
              // probes confirm route activation even if URL_CHANGED is not emitted.
              scheduleUrlProbe(180);
              scheduleUrlProbe(550);
              return true;
            } catch (_) {
              clearPendingStartNav();
            }
          }

          postToNative({
            type: 'AGY_INBOX_START_CHAT_RESULT',
            requestId: requestId,
            handled: false,
            cascadeId: cascadeId,
            targetUrl: createdUrl
          });
          return true;
        })
        .catch(function() {
          return navigateIframeToNewChatOverview(
            requestId,
            instanceUuid,
            targetUrl,
            cleanProjectId
          );
        });
    }

    function normalizeFolderPathToFileUri(rawInput, homeDirUri) {
      if (typeof rawInput !== 'string') return '';
      var trimmed = rawInput.trim();
      if (!trimmed) return '';
      if (
        (trimmed === '~' || trimmed.indexOf('~/') === 0 || trimmed.indexOf('~\\\\') === 0) &&
        typeof homeDirUri === 'string' &&
        homeDirUri.trim()
      ) {
        var cleanHome = homeDirUri.trim().replace(/\\/+$/, '');
        var suffix = trimmed.length > 1 ? trimmed.substring(1).replace(/\\\\/g, '/') : '';
        var cleanSuffix = suffix.length > 1 ? suffix.replace(/\\/+$/, '') : '';
        if (cleanHome.indexOf('file://') === 0) {
          return cleanHome + (cleanSuffix ? encodeURI(cleanSuffix) : '');
        }
        trimmed = cleanHome + cleanSuffix;
      }
      if (trimmed.indexOf('file://') === 0) {
        return trimmed.length > 8 ? trimmed.replace(/\\/+$/, '') : trimmed;
      }
      if (trimmed.charAt(0) === '/') {
        var cleaned = trimmed.length > 1 ? trimmed.replace(/\\/+$/, '') : '/';
        return 'file://' + encodeURI(cleaned);
      }
      if (/^[a-zA-Z]:[\\\\/]/.test(trimmed)) {
        var normWin = trimmed.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return 'file:///' + encodeURI(normWin);
      }
      return '';
    }

    function extractDirDisplayName(uri) {
      if (typeof uri !== 'string' || !uri) return '';
      try {
        var decoded = decodeURIComponent(uri).replace(/\\/+$/, '');
        var stripped = decoded.replace(/^file:\\/\\//i, '');
        var parts = stripped.split('/').filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : stripped || '/';
      } catch (_) {
        var fallback = uri.replace(/\\/+$/, '').split('/').filter(Boolean);
        return fallback.length > 0 ? fallback[fallback.length - 1] : uri;
      }
    }

    function computeParentFileUri(uri) {
      if (typeof uri !== 'string' || !uri) return null;
      try {
        var cleaned = uri.replace(/\\/+$/, '');
        if (!cleaned || cleaned === 'file://' || cleaned === 'file:///') {
          return null;
        }
        var stripped = cleaned.replace(/^file:\\/\\//i, '');
        // Stop at Windows drive root (e.g. file:///C: or file:///c%3A)
        if (/^\\/[a-zA-Z](?::|%3[aA])$/.test(stripped)) {
          return null;
        }
        var lastSlash = stripped.lastIndexOf('/');
        if (lastSlash <= 0) {
          return 'file:///';
        }
        return 'file://' + stripped.substring(0, lastSlash);
      } catch (_) {
        return null;
      }
    }

    function listDirectory(requestId, instanceUuid, rawUri) {
      if (!instanceUuid || instanceUuid === '__cloud__') {
        postToNative({
          type: 'AGY_INBOX_LIST_DIR_RESULT',
          requestId: requestId,
          ok: false,
          currentUri: '',
          parentUri: null,
          entries: [],
          error: 'Select a connected workstation first.'
        });
        return Promise.resolve(false);
      }

      return getClientWithMetadata()
        .then(function(ctx) {
          if (!ctx) {
            throw new Error('Workstation bridge is not ready yet.');
          }
          var initialUri = normalizeFolderPathToFileUri(
            rawUri,
            lastHomeDirCache[instanceUuid]
          );
          var resolveStartUri = initialUri
            ? Promise.resolve(initialUri)
            : callProxyJson(ctx, instanceUuid, GET_DEFAULT_PROJECT_DIR_PATH, '{}', PROJECTS_RPC_TIMEOUT_MS)
                .then(function(defRes) {
                  var defUri =
                    defRes &&
                    !hasConnectRpcError(defRes) &&
                    (defRes.defaultProjectDirUri || defRes.default_project_dir_uri);
                  if (typeof defUri === 'string' && defUri.trim()) {
                    return normalizeFolderPathToFileUri(defUri) || defUri.trim();
                  }
                  return null;
                })
                .catch(function() {
                  return null;
                })
                .then(function(defUri) {
                  if (defUri) return defUri;
                  if (lastHomeDirCache[instanceUuid]) {
                    return lastHomeDirCache[instanceUuid];
                  }
                  return fetchWorkspaceInfosForInstance(ctx, instanceUuid).then(function(ws) {
                    return (ws && ws.homeDirUri) || 'file:///';
                  });
                });

          return resolveStartUri.then(function(targetUri) {
            return callProxyJson(
              ctx,
              instanceUuid,
              READ_DIR_PATH,
              JSON.stringify({ uri: targetUri, userInitiated: true }),
              PROJECTS_RPC_TIMEOUT_MS
            ).then(function(dirRes) {
              if (!dirRes || typeof dirRes !== 'object' || hasConnectRpcError(dirRes)) {
                throw new Error(
                  (dirRes && dirRes.message) || 'Unable to read directory on workstation.'
                );
              }
              var rawEntries = Array.isArray(dirRes.entries) ? dirRes.entries : [];
              var dirs = [];
              for (var i = 0; i < rawEntries.length; i++) {
                var item = rawEntries[i];
                if (!item || typeof item !== 'object') continue;
                var ft = item.fileType !== undefined ? item.fileType : item.file_type;
                var isDir =
                  ft === 2 ||
                  (typeof ft === 'string' && ft.toUpperCase().indexOf('DIR') !== -1);
                if (!isDir) continue;
                var entryUri =
                  typeof item.uri === 'string' && item.uri.trim()
                    ? item.uri.trim().replace(/\\/+$/, '')
                    : '';
                var entryName =
                  (typeof item.name === 'string' && item.name.trim()) ||
                  extractDirDisplayName(entryUri);
                if (!entryUri || !entryName || entryName === '.' || entryName === '..') {
                  continue;
                }
                dirs.push({ name: entryName, uri: entryUri });
              }
              dirs.sort(function(a, b) {
                var aHidden = a.name.charAt(0) === '.';
                var bHidden = b.name.charAt(0) === '.';
                if (aHidden !== bHidden) return aHidden ? 1 : -1;
                return a.name.localeCompare(b.name);
              });
              postToNative({
                type: 'AGY_INBOX_LIST_DIR_RESULT',
                requestId: requestId,
                ok: true,
                currentUri: targetUri,
                parentUri: computeParentFileUri(targetUri),
                entries: dirs.slice(0, 200),
                error: null
              });
              return true;
            });
          });
        })
        .catch(function(err) {
          postToNative({
            type: 'AGY_INBOX_LIST_DIR_RESULT',
            requestId: requestId,
            ok: false,
            currentUri: normalizeFolderPathToFileUri(rawUri) || '',
            parentUri: computeParentFileUri(normalizeFolderPathToFileUri(rawUri)),
            entries: [],
            error: err && err.message ? String(err.message) : 'Failed to list folders.'
          });
          return false;
        });
    }

    function createProject(requestId, instanceUuid, mode, rawName, rawFolderPathOrUri) {
      if (!instanceUuid || instanceUuid === '__cloud__') {
        postToNative({
          type: 'AGY_INBOX_CREATE_PROJECT_RESULT',
          requestId: requestId,
          ok: false,
          error: 'Select a connected workstation first.'
        });
        return Promise.resolve(false);
      }

      var effectiveMode = mode === 'scratch' ? 'scratch' : 'existing';
      var trimmedName = typeof rawName === 'string' ? rawName.trim() : '';

      return getClientWithMetadata()
        .then(function(ctx) {
          if (!ctx) {
            throw new Error('Workstation bridge is not ready yet.');
          }

          var resolveFolderTarget;
          if (effectiveMode === 'scratch') {
            if (!trimmedName) {
              throw new Error('Enter a project name.');
            }
            var folderSlug =
              trimmedName
                .replace(/[^a-zA-Z0-9._-]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'project';
            resolveFolderTarget = callProxyJson(
              ctx,
              instanceUuid,
              CREATE_SCRATCH_PROJECT_FOLDER_PATH,
              JSON.stringify({ name: folderSlug }),
              INSTANCE_RPC_TIMEOUT_MS
            ).then(function(scratchRes) {
              if (!scratchRes || hasConnectRpcError(scratchRes)) {
                throw new Error(
                  (scratchRes && scratchRes.message) ||
                    'Unable to create project folder on server.'
                );
              }
              var folderUri = scratchRes.folderUri || scratchRes.folder_uri || '';
              if (!folderUri) {
                throw new Error(
                  scratchRes.errorMessage ||
                    scratchRes.error_message ||
                    'Server did not return a folder path.'
                );
              }
              return {
                folderUri: String(folderUri).trim().replace(/\\/+$/, ''),
                isGitRepo: Boolean(scratchRes.isGitRepo || scratchRes.is_git_repo),
                projectName: trimmedName
              };
            });
          } else {
            var resolveHomeThenNormalize =
              typeof rawFolderPathOrUri === 'string' &&
              rawFolderPathOrUri.trim().charAt(0) === '~' &&
              !lastHomeDirCache[instanceUuid]
                ? fetchWorkspaceInfosForInstance(ctx, instanceUuid).then(function(ws) {
                    return normalizeFolderPathToFileUri(
                      rawFolderPathOrUri,
                      (ws && ws.homeDirUri) || lastHomeDirCache[instanceUuid]
                    );
                  })
                : Promise.resolve(
                    normalizeFolderPathToFileUri(
                      rawFolderPathOrUri,
                      lastHomeDirCache[instanceUuid]
                    )
                  );

            resolveFolderTarget = resolveHomeThenNormalize.then(function(normalizedUri) {
              if (!normalizedUri) {
                throw new Error(
                  'Select or enter a valid absolute folder path (e.g. /home/user/repo or ~/repo).'
                );
              }
              var finalName =
                trimmedName || extractDirDisplayName(normalizedUri) || 'Project';
              return callProxyJson(
                ctx,
                instanceUuid,
                RESOLVE_FOLDER_PATH,
                JSON.stringify({ folderUri: normalizedUri }),
                PROJECTS_RPC_TIMEOUT_MS
              )
                .then(function(res) {
                  var rType =
                    res && (res.resourceType !== undefined ? res.resourceType : res.resource_type);
                  var vcs = res && (res.vcsType !== undefined ? res.vcsType : res.vcs_type);
                  var isGit =
                    rType === 2 ||
                    (typeof rType === 'string' && rType.toUpperCase().indexOf('GIT') !== -1) ||
                    vcs === 1 ||
                    (typeof vcs === 'string' && vcs.toUpperCase().indexOf('GIT') !== -1);
                  return {
                    folderUri: normalizedUri,
                    isGitRepo: isGit,
                    projectName: finalName
                  };
                })
                .catch(function() {
                  return {
                    folderUri: normalizedUri,
                    isGitRepo: false,
                    projectName: finalName
                  };
                });
            });
          }

          return resolveFolderTarget.then(function(target) {
            var newProjectId = generateUuidV4();
            var resourceEntry = target.isGitRepo
              ? { gitFolder: { folderUri: target.folderUri } }
              : { folderUri: target.folderUri };
            var projectPayload = {
              id: newProjectId,
              name: target.projectName,
              isWorkspaceOnly: false,
              projectResources: {
                resources: [resourceEntry]
              }
            };

            return callProxyJson(
              ctx,
              instanceUuid,
              CREATE_PROJECT_PATH,
              JSON.stringify({ project: projectPayload }),
              INSTANCE_RPC_TIMEOUT_MS
            )
              .then(function(createRes) {
                if (hasConnectRpcError(createRes)) {
                  throw new Error(createRes.message || 'CreateProject failed');
                }
                var createdProj =
                  (createRes && createRes.project && typeof createRes.project === 'object'
                    ? createRes.project
                    : null) || projectPayload;
                var resolvedId =
                  (typeof createdProj.id === 'string' && createdProj.id) || newProjectId;
                scheduleRefresh(150);
                postToNative({
                  type: 'AGY_INBOX_CREATE_PROJECT_RESULT',
                  requestId: requestId,
                  ok: true,
                  projectId: resolvedId,
                  projectName: target.projectName,
                  workspaceUri: target.folderUri,
                  error: null
                });
                return true;
              })
              .catch(function(createErr) {
                // Graceful fallback for older language servers without CreateProject
                return callProxyJson(
                  ctx,
                  instanceUuid,
                  ADD_TRACKED_WORKSPACE_PATH,
                  JSON.stringify({ workspace: target.folderUri }),
                  PROJECTS_RPC_TIMEOUT_MS
                )
                  .then(function(wsRes) {
                    if (hasConnectRpcError(wsRes)) {
                      throw createErr;
                    }
                    scheduleRefresh(150);
                    postToNative({
                      type: 'AGY_INBOX_CREATE_PROJECT_RESULT',
                      requestId: requestId,
                      ok: true,
                      projectId: null,
                      projectName: target.projectName,
                      workspaceUri: target.folderUri,
                      error: null
                    });
                    return true;
                  })
                  .catch(function() {
                    throw createErr;
                  });
              });
          });
        })
        .catch(function(err) {
          postToNative({
            type: 'AGY_INBOX_CREATE_PROJECT_RESULT',
            requestId: requestId,
            ok: false,
            error: err && err.message ? String(err.message) : 'Unable to add project to server.'
          });
          return false;
        });
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

        if (data.type === 'AGY_REMOTE_OPEN_DRAWER') {
          postToNative({
            type: 'AGY_INBOX_OPEN_DRAWER_REQUEST',
            mode: data.mode === 'projects' ? 'projects' : 'inbox'
          });
          return;
        }

        if (data.type === 'AGY_REMOTE_REQUEST_THREAD_CONTEXT') {
          syncActiveThreadContext();
          return;
        }

        if (data.type === 'URL_CHANGED') {
          var rawChangedPath = typeof data.path === 'string' ? data.path : '';
          var changedCascadeId = extractCascadeIdFromIframePath(rawChangedPath, frameSrc);
          if (completePendingFastNavIfMatched(changedCascadeId, true)) {
            return;
          }
          if (completePendingStartNavIfMatched(changedCascadeId, true)) {
            return;
          }
          if (!changedCascadeId) {
            clearHostChildPathParam();
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

        // Field 1 (index 0): URL_CHANGE (empty path "" serializes as [] in Closure JSPB),
        // or Field 4 (index 3): URL_RESPONSE
        var isUrlChangeEvent = Array.isArray(jspb[0]);
        var isUrlResponseEvent = !isUrlChangeEvent && Array.isArray(jspb[3]);
        var reportedPath = isUrlChangeEvent
          ? (typeof jspb[0][0] === 'string' ? jspb[0][0] : '')
          : isUrlResponseEvent
            ? (typeof jspb[3][0] === 'string' ? jspb[3][0] : '')
            : null;
        if (reportedPath !== null) {
          var extractedCascadeId = extractCascadeIdFromIframePath(reportedPath, frameSrc);
          if (completePendingFastNavIfMatched(extractedCascadeId, isUrlChangeEvent)) {
            return;
          }
          if (completePendingStartNavIfMatched(extractedCascadeId, isUrlChangeEvent)) {
            return;
          }
          if (isUrlChangeEvent) {
            if (!extractedCascadeId) {
              clearHostChildPathParam();
            }
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
      syncFullBleedWorkspace();
      var route = parseRouteFromLocation();
      postToNative({
        type: 'AGY_INBOX_ACTIVE_ROUTE',
        activeUrl: window.location.href,
        activeInstanceUuid: route.instanceUuid,
        activeCascadeId: route.cascadeId
      });
    }

    window.addEventListener('popstate', function() {
      clearIframeCascadeOverride();
      emitActiveRouteFromLocation();
    });

    try {
      if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('currententrychange', emitActiveRouteFromLocation);
      }
    } catch (_) {}

    try {
      var observeRoot =
        (document && (document.documentElement || document.body)) || null;
      if (observeRoot && typeof MutationObserver === 'function') {
        domObserver = new MutationObserver(function() {
          scheduleFullBleedSync(35);
        });
        domObserver.observe(observeRoot, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['hidden', 'aria-hidden', 'open', 'role', 'class']
        });
      }
    } catch (_) {}

    function onVisualViewportChange() {
      if (!isStopped) {
        syncFullBleedWorkspace();
      }
    }

    try {
      if (
        window.visualViewport &&
        typeof window.visualViewport.addEventListener === 'function'
      ) {
        window.visualViewport.addEventListener('resize', onVisualViewportChange, {
          passive: true
        });
        window.visualViewport.addEventListener('scroll', onVisualViewportChange, {
          passive: true
        });
      }
    } catch (_) {}

    syncFullBleedWorkspace();

    window.addEventListener('focus', function() {
      syncFullBleedWorkspace();
      scheduleRefresh(250);
    });

    window.addEventListener('online', function() {
      scheduleRefresh(350);
    });

    var pollId = setInterval(function() {
      if (document.visibilityState === 'hidden' && !window.__agyKeepAliveLockDesired) {
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      syncFullBleedWorkspace();
      refresh(false);
    }, POLL_INTERVAL_MS);

    var bootstrapDelays = [0, 350, 1100, 2600, 5200];
    for (var b = 0; b < bootstrapDelays.length; b++) {
      (function(delay) {
        setTimeout(function() {
          syncFullBleedWorkspace();
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
      startProjectChat: startProjectChat,
      listDirectory: listDirectory,
      createProject: createProject,
      syncFullBleedWorkspace: syncFullBleedWorkspace,
      restoreHostChrome: restoreHostChrome,
      openHostSettings: openHostSettings,
      setActiveThreadContext: setActiveThreadContext,
      syncActiveThreadContext: syncActiveThreadContext,
      stop: function() {
        isStopped = true;
        activeThreadContext = null;
        clearPendingFastNav();
        clearPendingStartNav();
        if (refreshTimer) clearTimeout(refreshTimer);
        if (fullBleedTimer) clearTimeout(fullBleedTimer);
        if (pollId) clearInterval(pollId);
        if (domObserver && typeof domObserver.disconnect === 'function') {
          try {
            domObserver.disconnect();
          } catch (_) {}
        }
        try {
          if (
            window.visualViewport &&
            typeof window.visualViewport.removeEventListener === 'function'
          ) {
            window.visualViewport.removeEventListener(
              'resize',
              onVisualViewportChange
            );
            window.visualViewport.removeEventListener(
              'scroll',
              onVisualViewportChange
            );
          }
        } catch (_) {}
        restoreHostChrome();
      }
    };
  } catch (_) {}
  return true;
})();
`;

export function buildInboxRefreshScript(forceUsage: boolean = false): string {
  const serializedForce = forceUsage ? 'true' : 'false';
  return `
(function() {
  try {
    if (window.__agyInboxBridge && typeof window.__agyInboxBridge.refresh === 'function') {
      window.__agyInboxBridge.refresh(${serializedForce});
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

export function buildOpenHostSettingsScript(): string {
  return `
(function() {
  try {
    if (window.__agyInboxBridge && typeof window.__agyInboxBridge.openHostSettings === 'function') {
      window.__agyInboxBridge.openHostSettings();
      return true;
    }
  } catch (_) {}
  try {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'AGY_INBOX_HOST_SETTINGS_RESULT',
        handled: false
      }));
    }
  } catch (_) {}
  return true;
})();
`;
}

export function buildStartProjectChatScript(params: {
  requestId: string;
  instanceUuid: string;
  projectId?: string | null;
  workspaceUri?: string | null;
  targetUrl: string;
}): string {
  const serialized = JSON.stringify({
    requestId: params.requestId,
    instanceUuid: params.instanceUuid,
    projectId: params.projectId ?? null,
    workspaceUri: params.workspaceUri ?? null,
    targetUrl: params.targetUrl,
  });

  return `
(function() {
  var args = ${serialized};
  try {
    if (window.__agyInboxBridge && typeof window.__agyInboxBridge.startProjectChat === 'function') {
      window.__agyInboxBridge.startProjectChat(
        args.requestId,
        args.instanceUuid,
        args.workspaceUri,
        args.targetUrl,
        args.projectId
      );
      return true;
    }
  } catch (_) {}
  try {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'AGY_INBOX_START_CHAT_RESULT',
        requestId: args.requestId,
        handled: false,
        cascadeId: null,
        targetUrl: args.targetUrl
      }));
    }
  } catch (_) {}
  return true;
})();
`;
}

export function buildListDirectoryScript(params: {
  requestId: string;
  instanceUuid: string;
  uri?: string | null;
}): string {
  const serialized = JSON.stringify({
    requestId: params.requestId,
    instanceUuid: params.instanceUuid,
    uri: params.uri ?? null,
  });

  return `
(function() {
  var args = ${serialized};
  try {
    if (window.__agyInboxBridge && typeof window.__agyInboxBridge.listDirectory === 'function') {
      window.__agyInboxBridge.listDirectory(
        args.requestId,
        args.instanceUuid,
        args.uri
      );
      return true;
    }
  } catch (_) {}
  try {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'AGY_INBOX_LIST_DIR_RESULT',
        requestId: args.requestId,
        ok: false,
        currentUri: args.uri || '',
        parentUri: null,
        entries: [],
        error: 'Workstation bridge is unavailable.'
      }));
    }
  } catch (_) {}
  return true;
})();
`;
}

export function buildSyncThreadContextScript(
  context: ActiveThreadProjectContext | null,
): string {
  const serialized = JSON.stringify(context ?? null);

  return `
(function() {
  var ctx = ${serialized};
  try {
    if (window.__agyInboxBridge && typeof window.__agyInboxBridge.setActiveThreadContext === 'function') {
      window.__agyInboxBridge.setActiveThreadContext(ctx);
      return true;
    }
    if (window.__agyOverviewScrollBridge && typeof window.__agyOverviewScrollBridge.setThreadContext === 'function') {
      window.__agyOverviewScrollBridge.setThreadContext(ctx);
      return true;
    }
  } catch (_) {}
  return true;
})();
`;
}

export function buildCreateProjectScript(params: {
  requestId: string;
  instanceUuid: string;
  mode: 'existing' | 'scratch';
  name: string;
  folderPathOrUri?: string | null;
}): string {
  const serialized = JSON.stringify({
    requestId: params.requestId,
    instanceUuid: params.instanceUuid,
    mode: params.mode,
    name: params.name,
    folderPathOrUri: params.folderPathOrUri ?? null,
  });

  return `
(function() {
  var args = ${serialized};
  try {
    if (window.__agyInboxBridge && typeof window.__agyInboxBridge.createProject === 'function') {
      window.__agyInboxBridge.createProject(
        args.requestId,
        args.instanceUuid,
        args.mode,
        args.name,
        args.folderPathOrUri
      );
      return true;
    }
  } catch (_) {}
  try {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'AGY_INBOX_CREATE_PROJECT_RESULT',
        requestId: args.requestId,
        ok: false,
        error: 'Workstation bridge is unavailable.'
      }));
    }
  } catch (_) {}
  return true;
})();
`;
}
