/**
 * Service Worker 脚本的行为测试。
 *
 * 真的把 worker 源码跑起来（vm 里的假 SW 全局），然后派发 push /
 * pushsubscriptionchange / notificationclick 事件，验证：
 * - 推送载荷能变成一条和页面内通知同形的通知（点击后能回到会话）；
 * - 订阅失效会通知页面重新订阅；
 * - 离线兜底只在开关打开时挂上 fetch 监听。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildServiceWorkerSource, SERVICE_WORKER_SOURCE } from '../lib/sw.js';

/** 起一个假的 Service Worker 全局。 */
function bootWorker(source = SERVICE_WORKER_SOURCE, options = {}) {
  const listeners = new Map();
  const shown = [];
  const posted = [];
  const broadcasts = [];
  const cachePuts = [];
  let pendingPuts = 0;
  const clients = options.clients ?? [
    { postMessage: (message) => posted.push(message), visibilityState: 'visible', focus: () => {} },
  ];
  class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
    }
    postMessage(message) {
      broadcasts.push(message);
    }
    close() {}
  }
  const sw = {
    registration: {
      showNotification: async (title, options) => {
        shown.push({ title, options });
      },
    },
    location: { origin: 'http://127.0.0.1:3080' },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    BroadcastChannel: FakeBroadcastChannel,
    clients: {
      matchAll: async () => clients,
      claim: async () => {},
    },
    caches: {
      open: async () => ({
        put: async () => {
          pendingPuts += 1;
          // 模拟异步落盘：若没被 await，断言时 pendingPuts 仍 > 0。
          await new Promise((resolve) => setTimeout(resolve, 5));
          pendingPuts -= 1;
          cachePuts.push(1);
        },
      }),
      match: async () => null,
      keys: async () => [],
      delete: async () => {},
    },
    skipWaiting: async () => {},
  };
  vm.runInNewContext(source, {
    self: sw,
    Promise,
    Response,
    Request,
    URL,
    console,
    // worker 的 fetch 事件处理会真的发网络请求；这里给一个总是成功的桩，
    // 让缓存分支能跑起来（断言的是缓存行为，不是网络）。
    fetch: async () => new Response('<!doctype html><title>DSH</title>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  });
  return {
    sw,
    listeners,
    shown,
    posted,
    broadcasts,
    cachePuts,
    get pendingPuts() {
      return pendingPuts;
    },
  };
}

/** 造一个 push 事件。 */
function pushEvent(payload) {
  const waits = [];
  return {
    waits,
    data: { text: () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) },
    waitUntil(promise) {
      waits.push(promise);
    },
  };
}

test('push 事件：载荷变成带 sessionId 的通知', async () => {
  const { listeners, shown } = bootWorker();
  const handler = listeners.get('push');
  assert.ok(handler, 'worker 应监听 push');

  const event = pushEvent({
    title: 'DSH · 需要你操作',
    body: '工具 Bash 请求批准',
    kind: 'attention',
    sessionId: 's-42',
  });
  handler(event);
  await Promise.all(event.waits);

  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'DSH · 需要你操作');
  assert.equal(shown[0].options.body, '工具 Bash 请求批准');
  // 点击后要能回到对应会话，data 里必须带 sessionId / kind。
  assert.equal(shown[0].options.data.sessionId, 's-42');
  assert.equal(shown[0].options.data.kind, 'attention');
  assert.equal(shown[0].options.data.source, 'dsh-webhook-notify');
});

test('push 事件：非 JSON 载荷退化成纯文本标题', async () => {
  const { listeners, shown } = bootWorker();
  const event = pushEvent('hello');
  listeners.get('push')(event);
  await Promise.all(event.waits);
  assert.equal(shown[0].title, 'hello');
  assert.equal(shown[0].options.body, '');
});

test('pushsubscriptionchange：通知页面重新订阅', async () => {
  const { listeners, posted } = bootWorker();
  const event = pushEvent({});
  listeners.get('pushsubscriptionchange')(event);
  await Promise.all(event.waits);
  assert.ok(
    posted.some((message) => message.type === 'pushsubscriptionchange'),
    '应把订阅失效的消息转发给页面',
  );
});

test('notificationclick：把点击转发给页面并带上会话', async () => {
  const { listeners, posted } = bootWorker();
  const event = {
    notification: { data: { sessionId: 's-7', kind: 'done' }, close() {} },
    waitUntil(promise) {
      this.promise = promise;
    },
  };
  listeners.get('notificationclick')(event);
  await event.promise;
  const click = posted.find((message) => message.type === 'notificationclick');
  assert.ok(click, '应把点击转发给页面');
  assert.equal(click.sessionId, 's-7');
  assert.equal(click.kind, 'done');
});

test('离线兜底：开关打开才挂 fetch 监听', () => {
  const on = bootWorker(buildServiceWorkerSource({ offline: true }));
  const off = bootWorker(buildServiceWorkerSource({ offline: false }));
  assert.ok(on.listeners.has('fetch'), '开启时应监听 fetch');
  assert.ok(!off.listeners.has('fetch'), '关闭时不应监听 fetch');
  // 两种情况下都保留推送能力。
  assert.ok(on.listeners.has('push'));
  assert.ok(off.listeners.has('push'));
});

test('notificationclick：同一次点击只投递一次（不叠加 BroadcastChannel）', async () => {
  // 回归：曾经既 postMessage 给页面、又 BroadcastChannel 广播同一条消息，
  // 页面侧于是导航两次；而广播那份没有 navigate 字段，还会把「只让一个
  // 窗口导航」的决定覆盖掉。
  const { listeners, posted, broadcasts } = bootWorker();
  const event = {
    notification: { data: { sessionId: 's-1', kind: 'done' }, close() {} },
    waitUntil(promise) {
      this.promise = promise;
    },
  };
  listeners.get('notificationclick')(event);
  await event.promise;
  const clicks = posted.filter((message) => message.type === 'notificationclick');
  assert.equal(clicks.length, 1, '应只投递一条点击消息');
  assert.equal(clicks[0].navigate, true, '被选中的窗口应带 navigate:true');
  assert.equal(broadcasts.length, 0, '有页面可达时不应再广播一遍');
});

test('notificationclick：autoFocus:false 时不抢窗口焦点、不导航', async () => {
  // 回归：开关「点击通知回到对应对话」只作用于页面降级通知；持久通知走
  // worker，worker 必须按通知 data 里的偏好决定是否 focus / 切会话。
  let focused = 0;
  const { listeners, posted } = bootWorker(SERVICE_WORKER_SOURCE, {
    clients: [
      {
        postMessage: (message) => posted.push(message),
        visibilityState: 'visible',
        focus: () => {
          focused += 1;
        },
      },
    ],
  });
  const event = {
    notification: { data: { sessionId: 's-9', kind: 'done', autoFocus: false }, close() {} },
    waitUntil(promise) {
      this.promise = promise;
    },
  };
  listeners.get('notificationclick')(event);
  await event.promise;
  const click = posted.find((message) => message.type === 'notificationclick');
  assert.ok(click, '点击仍要转发给页面');
  assert.equal(click.sessionId, 's-9');
  assert.equal(click.navigate, false, '关掉开关后不应导航到该会话');
  assert.equal(click.autoFocus, false);
  assert.equal(focused, 0, '关掉开关后不应抢窗口焦点');
});

test('notificationclick：缺省 autoFocus 时保持原有聚焦行为', async () => {
  let focused = 0;
  const { listeners, posted } = bootWorker(SERVICE_WORKER_SOURCE, {
    clients: [
      {
        postMessage: (message) => posted.push(message),
        visibilityState: 'visible',
        focus: () => {
          focused += 1;
        },
      },
    ],
  });
  const event = {
    notification: { data: { sessionId: 's-10', kind: 'done' }, close() {} },
    waitUntil(promise) {
      this.promise = promise;
    },
  };
  listeners.get('notificationclick')(event);
  await event.promise;
  const click = posted.find((message) => message.type === 'notificationclick');
  assert.equal(click.navigate, true);
  assert.equal(click.autoFocus, true);
  assert.equal(focused, 1);
});

test('notificationclick：没有可达页面时才退回 BroadcastChannel', async () => {
  const { listeners, broadcasts } = bootWorker(SERVICE_WORKER_SOURCE, { clients: [] });
  const event = {
    notification: { data: { sessionId: 's-2', kind: 'done' }, close() {} },
    waitUntil(promise) {
      this.promise = promise;
    },
  };
  listeners.get('notificationclick')(event);
  await event.promise;
  assert.equal(broadcasts.length, 1, '无页面时应广播一条');
  assert.equal(broadcasts[0].type, 'notificationclick');
});

test('离线兜底：只缓存应用外壳（根路径、无查询串）', async () => {
  const { listeners, cachePuts } = bootWorker(buildServiceWorkerSource({ offline: true }));
  const handler = listeners.get('fetch');

  const run = async (url) => {
    const waits = [];
    handler({
      request: { method: 'GET', mode: 'navigate', url },
      respondWith(promise) {
        waits.push(promise);
      },
    });
    await Promise.all(waits);
  };

  await run('http://127.0.0.1:3080/');
  assert.equal(cachePuts.length, 1, '根路径应写入缓存');
  // 带查询串 / 子路径的导航不写缓存：避免断网时把旧外壳当成别的地址。
  await run('http://127.0.0.1:3080/?session=secret');
  await run('http://127.0.0.1:3080/some/deep/link');
  assert.equal(cachePuts.length, 1, '带查询或子路径的导航不应写缓存');
});

test('离线兜底：cache.put 挂进 respondWith 生命周期', async () => {
  const worker = bootWorker(buildServiceWorkerSource({ offline: true }));
  const waits = [];
  worker.listeners.get('fetch')({
    request: { method: 'GET', mode: 'navigate', url: 'http://127.0.0.1:3080/' },
    respondWith(promise) {
      waits.push(promise);
    },
  });
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  // respondWith 的 Promise 结束时，写入必须已经完成（否则 worker 可能被
  // 提前终止，缓存时有时无）。
  assert.equal(worker.pendingPuts, 0, 'respondWith 完成后不应还有未完成的 cache.put');
  assert.equal(worker.cachePuts.length, 1);
});

test('worker 源码自包含：不引用宿主模块', () => {
  assert.ok(!/\bimport\s|\brequire\(/.test(SERVICE_WORKER_SOURCE), 'worker 脚本不应有 import/require');
  assert.ok(SERVICE_WORKER_SOURCE.includes('showNotification'));
});
