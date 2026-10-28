/**
 * 同源 Service Worker 脚本（浏览器通知与推送的“常驻半边”）。
 *
 * 为什么需要它：页面里直接 `new Notification()` 弹出的通知
 * 1) 页面被系统挂起/收起后常被浏览器降级（Windows 上常直接不弹）；
 * 2) 点击后没有用户手势，`window.focus()` 多半被浏览器忽略。
 * 持久通知（`registration.showNotification`）只有 Service Worker 能发，
 * 点击事件也带着用户手势落在 worker 里，`client.focus()` 能真正把窗口带到前台。
 *
 * 这个 worker 做四件事：
 * - `notificationclick`：把点击广播给同源页面（BroadcastChannel + clients.postMessage
 *   双通道），由页面决定聚焦哪个窗口、切换到哪个会话；
 * - `push`：接 Web Push（VAPID + aes128gcm），弹一条和页面内通知同形的通知；
 * - `pushsubscriptionchange`：订阅失效时通知页面重新订阅；
 * - `fetch`：导航请求走「网络优先 + 缓存兜底」，断网时至少能打开应用外壳。
 *
 * 它不存储、不主动联网：除缓存应用外壳外只做转发。
 *
 * 本文件被宿主以文本形式下发到 /webhook-notify/sw.js（见 lib/index.js），
 * 也作为 ES 模块被测试直接加载；两处用的是同一份字符串，不会漂移。
 */

/** 客户端与 worker 之间的消息通道名。 */
export const BRIDGE_CHANNEL = 'dsh-webhook-notify:bridge';

/** 通知统一带上的 tag 前缀，便于按 tag 关闭已处理的通知。 */
export const NOTIFICATION_TAG_PREFIX = 'dsh-webhook-notify-';

/** 离线兜底用的缓存名。 */
export const OFFLINE_CACHE = 'dsh-webhook-notify-shell-v1';

/**
 * 生成完整的 worker 脚本文本。
 *
 * 必须自包含：Service Worker 注册不能跨源、也不能 import 插件的 ESM 模块，
 * 所以处理器整体内联在这里。末尾的 sourceURL 只为 DevTools 里好认。
 *
 * @param {object} [options]
 * @param {boolean} [options.offline] 是否缓存应用外壳（导航请求网络优先、
 *   断网时回退到缓存）。默认开启。
 * @returns {string} worker 脚本文本。
 */
export function buildServiceWorkerSource(options = {}) {
  const offline = options.offline !== false;
  return `// dsh-webhook-notify — Service Worker half (notification click relay + Web Push).
// Served at /webhook-notify/sw.js; see lib/sw.js for the module twin.
(function (g) {
  if (!g || typeof g.registration !== "object" || g.registration === null ||
      typeof g.addEventListener !== "function" || typeof g.document !== "undefined") return;

  var BRIDGE_CHANNEL = ${JSON.stringify(BRIDGE_CHANNEL)};
  var NOTIFICATION_TAG_PREFIX = ${JSON.stringify(NOTIFICATION_TAG_PREFIX)};
  var OFFLINE_CACHE = ${JSON.stringify(OFFLINE_CACHE)};
  var OFFLINE = ${offline ? 'true' : 'false'};

  function relay(message) {
    try {
      if (typeof g.BroadcastChannel === "function") {
        var channel = new g.BroadcastChannel(BRIDGE_CHANNEL);
        channel.postMessage(message);
        try { channel.close(); } catch (e) {}
      }
    } catch (e) {}
    try {
      if (g.clients && typeof g.clients.matchAll === "function") {
        g.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
          for (var i = 0; i < list.length; i++) {
            try { list[i].postMessage(message); } catch (e) {}
          }
        }, function () {});
      }
    } catch (e) {}
  }

  // One click does two jobs: tell the page which notification was clicked (the
  // page switches to that conversation), and bring exactly one window forward.
  // The window choice lives here because only notificationclick carries the
  // user activation — a page-side window.focus() without one is routinely
  // dropped. With several DSH tabs open only the picked client gets
  // navigate:true; the rest stay put instead of fighting over focus.
  //
  // Delivery is deliberately single-path. Broadcasting the same click over both
  // client.postMessage and BroadcastChannel made one click navigate twice (and
  // the BroadcastChannel copy, which carries no navigate flag, overrode the
  // targeted navigate:false). So: postMessage to live clients; BroadcastChannel
  // only when no client can be reached.
  function deliverClick(base) {
    var wantsFocus = base.autoFocus !== false;
    var send = function (list) {
      var clients = Array.isArray(list) ? list : [];
      var best = null;
      for (var i = 0; i < clients.length; i++) {
        if (clients[i] && typeof clients[i].postMessage === "function" && clients[i].visibilityState === "visible") { best = clients[i]; break; }
      }
      if (!best) {
        for (var j = 0; j < clients.length; j++) {
          if (clients[j] && typeof clients[j].postMessage === "function") { best = clients[j]; break; }
        }
      }
      if (!best) return false;
      for (var k = 0; k < clients.length; k++) {
        if (!clients[k] || typeof clients[k].postMessage !== "function") continue;
        try {
          clients[k].postMessage({
            source: base.source,
            type: base.type,
            sessionId: base.sessionId,
            kind: base.kind,
            navigate: wantsFocus && clients[k] === best,
            autoFocus: wantsFocus
          });
        } catch (e) {}
      }
      if (wantsFocus && typeof best.focus === "function") {
        try {
          var pending = best.focus();
          if (pending && typeof pending.then === "function") pending.then(null, function () {});
        } catch (e) {}
      }
      return true;
    };
    try {
      if (g.clients && typeof g.clients.matchAll === "function") {
        var pending = g.clients.matchAll({ type: "window", includeUncontrolled: true });
        if (pending && typeof pending.then === "function") {
          return pending.then(function (list) {
            if (!send(list)) relay(base);
          }, function () {
            if (!send([])) relay(base);
          });
        }
      }
    } catch (e) {}
    if (!send([])) relay(base);
    return Promise.resolve();
  }

  g.addEventListener("notificationclick", function (event) {
    try {
      var notification = event.notification;
      var data = (notification && notification.data) || {};
      var base = {
        source: "dsh-webhook-notify",
        type: "notificationclick",
        sessionId: data.sessionId === undefined ? null : data.sessionId,
        kind: data.kind === undefined ? null : data.kind,
        // 页面在 showNotification 时按用户偏好写入；缺省视为要聚焦。
        autoFocus: data.autoFocus === false ? false : true
      };
      try { if (notification && typeof notification.close === "function") notification.close(); } catch (e) {}
      var run = function () { return deliverClick(base); };
      if (typeof event.waitUntil === "function") event.waitUntil(Promise.resolve().then(run));
      else run();
    } catch (e) {}
  });

  // ── Web Push ──────────────────────────────────────────────────
  // 宿主用 VAPID + aes128gcm 把载荷 POST 到推送服务，服务再投到这里。
  // 载荷格式与页面内通知一致，所以点击行为完全复用上面的通道。
  g.addEventListener("push", function (event) {
    var payload = {};
    try {
      if (event && event.data) {
        var text = event.data.text();
        try { payload = JSON.parse(text); } catch (e) { payload = { title: text, body: "" }; }
      }
    } catch (e) {}
    if (!payload || typeof payload !== "object") payload = {};
    var options = {
      body: typeof payload.body === "string" ? payload.body : "",
      tag: typeof payload.tag === "string" && payload.tag ? payload.tag : NOTIFICATION_TAG_PREFIX + "push",
      renotify: true,
      silent: payload.silent === true,
      data: {
        source: "dsh-webhook-notify",
        sessionId: payload.sessionId === undefined ? null : payload.sessionId,
        kind: payload.kind === undefined ? null : payload.kind
      }
    };
    if (typeof payload.icon === "string" && payload.icon) options.icon = payload.icon;
    var title = typeof payload.title === "string" && payload.title ? payload.title : "DSH";
    var show = function () {
      try { return g.registration.showNotification(title, options); } catch (e) { return Promise.resolve(); }
    };
    if (event && typeof event.waitUntil === "function") event.waitUntil(Promise.resolve().then(show));
    else show();
  });

  // 订阅过期/轮换：告诉页面重新订阅（页面拿到新的订阅后回报给宿主）。
  g.addEventListener("pushsubscriptionchange", function (event) {
    var message = { source: "dsh-webhook-notify", type: "pushsubscriptionchange" };
    var run = function () { relay(message); };
    if (event && typeof event.waitUntil === "function") event.waitUntil(Promise.resolve().then(run));
    else run();
  });

  // 页面可以问 worker「在吗」；也用来把 VAPID 公钥交给 worker 备用。
  g.addEventListener("message", function (event) {
    var data = event && event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "ping") {
      try {
        if (event.ports && event.ports[0] && typeof event.ports[0].postMessage === "function") {
          event.ports[0].postMessage({ source: "dsh-webhook-notify", type: "pong" });
        }
      } catch (e) {}
      return;
    }
    if (data.type === "pushsubscriptionchange") relay({ source: "dsh-webhook-notify", type: "pushsubscriptionchange" });
  });

  // ── 导航请求：网络优先，断网时回退到缓存的应用外壳 ─────────────
  // 只拦同源的导航请求；其它请求（脚本、接口、WS）一律不碰。
  if (OFFLINE) {
    g.addEventListener("fetch", function (event) {
      try {
        var request = event.request;
        if (!request || request.method !== "GET") return;
        if (request.mode !== "navigate") return;
        if (!g.location || request.url.indexOf(g.location.origin) !== 0) return;
        if (typeof event.respondWith !== "function") return;
        var url;
        try { url = new URL(request.url); } catch (e) { return; }
        // 只缓存应用外壳本身（根路径、无查询串）。带查询/片段/子路径的导航
        // 可能是别人的深链或带一次性参数，缓存下来会在断网时把旧内容当成
        // 那个地址的页面返回。
        var cacheable = url.pathname === "/" && url.search === "" && url.hash === "";
        event.respondWith(
          fetch(request).then(function (response) {
            if (cacheable && response && response.ok) {
              try {
                var copy = response.clone();
                // cache.put 必须挂进 respondWith 的生命周期：否则 worker 可能在
                // 写盘前被终止，缓存时有时无。
                var write = g.caches.open(OFFLINE_CACHE).then(function (cache) {
                  return cache.put(request, copy);
                }).catch(function () {});
                return Promise.all([write]).then(function () { return response; });
              } catch (e) {}
            }
            return response;
          }).catch(function () {
            return g.caches.match(cacheable ? "/" : request).then(function (cached) {
              if (cached) return cached;
              return g.caches.match("/").then(function (root) {
                if (root) return root;
                return new Response("<!doctype html><meta charset=\\"utf-8\\"><title>DSH 离线</title><p>DSH 当前离线，且没有缓存的页面。", {
                  status: 200,
                  headers: { "content-type": "text/html; charset=utf-8" }
                });
              });
            }).catch(function () {
              return new Response("offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
            });
          })
        );
      } catch (e) {}
    });
  }

  // Take over an older worker right away; saves one reload after an update.
  g.addEventListener("install", function (event) {
    try {
      if (typeof g.skipWaiting === "function") {
        if (typeof event.waitUntil === "function") event.waitUntil(g.skipWaiting());
        else g.skipWaiting();
      }
    } catch (e) {}
  });
  g.addEventListener("activate", function (event) {
    var claim = function () {
      try {
        if (g.clients && typeof g.clients.claim === "function") return g.clients.claim();
      } catch (e) {}
      return Promise.resolve();
    };
    // 顺手清掉旧版本的缓存。
    var cleanup = function () {
      try {
        if (g.caches && typeof g.caches.keys === "function") {
          return g.caches.keys().then(function (keys) {
            for (var i = 0; i < keys.length; i++) {
              if (keys[i] !== OFFLINE_CACHE && keys[i].indexOf("dsh-webhook-notify-shell") === 0) {
                try { g.caches.delete(keys[i]); } catch (e) {}
              }
            }
          }).catch(function () {});
        }
      } catch (e) {}
      return Promise.resolve();
    };
    var run = function () { return Promise.all([claim(), cleanup()]); };
    if (typeof event.waitUntil === "function") event.waitUntil(run());
    else run();
  });
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : null);
//# sourceURL=dsh-webhook-notify/sw.js
`;
}

/** 默认的 worker 脚本（开启离线外壳缓存）。 */
export const SERVICE_WORKER_SOURCE = buildServiceWorkerSource({ offline: true });

/**
 * 是否处在 Service Worker 全局：有 registration 与 addEventListener、
 * 且没有 document（普通页面与测试环境都不会命中）。
 *
 * @param g 待判定的全局对象。
 * @returns 是否为 Service Worker 作用域。
 */
export function isServiceWorkerScope(g) {
  return Boolean(
    g
      && typeof g.registration === 'object'
      && g.registration !== null
      && typeof g.addEventListener === 'function'
      && typeof g.document === 'undefined',
  );
}
