/**
 * 浏览器通知半边的测试：Service Worker 脚本 + 通知管理器。
 *
 * 只测纯逻辑（createNotifier 用注入的假 Notification / SW / BroadcastChannel），
 * 不碰真实浏览器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRIDGE_CHANNEL, SERVICE_WORKER_SOURCE, isServiceWorkerScope } from '../lib/sw.js';
import { createNotifier } from '../lib/browser-notify.js';

test('Service Worker 脚本自包含且处理 notificationclick', () => {
  assert.match(SERVICE_WORKER_SOURCE, /notificationclick/);
  assert.match(SERVICE_WORKER_SOURCE, /BroadcastChannel/);
  assert.match(SERVICE_WORKER_SOURCE, /clients\.matchAll/);
  // 通道名与模块导出一致，两端不会漂移。
  assert.ok(SERVICE_WORKER_SOURCE.includes(BRIDGE_CHANNEL));
  // 必须能被当作独立脚本解析。
  assert.doesNotThrow(() => new Function(SERVICE_WORKER_SOURCE));
});

test('isServiceWorkerScope 只在 worker 全局命中', () => {
  assert.equal(isServiceWorkerScope({ registration: {}, addEventListener() {} }), true);
  assert.equal(isServiceWorkerScope({ registration: {}, addEventListener() {}, document: {} }), false);
  assert.equal(isServiceWorkerScope({}), false);
  assert.equal(isServiceWorkerScope(null), false);
});

function fakeNotification(opts) {
  return class FakeNotification {
    static permission = opts.permission;
    static requestPermissionCalls = 0;
    static requestPermission() {
      FakeNotification.requestPermissionCalls += 1;
      return Promise.resolve('granted');
    }
    constructor(title, options) {
      this.title = title;
      this.options = options;
      FakeNotification.instances.push(this);
    }
    close() {
      this.closed = true;
    }
  };
}

test('无 Service Worker 时退回页面通知，点击回调触发 onNavigate', async () => {
  const Fake = fakeNotification({ permission: 'granted' });
  Fake.instances = [];
  let navigated = null;
  const notifier = createNotifier({
    notify: Fake,
    serviceWorker: undefined,
    BroadcastChannel: undefined,
    onNavigate: (info) => {
      navigated = info;
    },
  });
  const shown = await notifier.show({
    kind: 'attention',
    key: 'k1',
    title: 'DSH · 需要你操作',
    body: '工具 bash 请求批准',
    sessionId: 'sess-1',
    onClick: (info) => {
      navigated = info;
    },
  });
  assert.equal(shown, 'page');
  assert.equal(Fake.instances.length, 1);
  assert.equal(Fake.instances[0].title, 'DSH · 需要你操作');
  assert.equal(Fake.instances[0].options.tag, 'dsh-webhook-notify-k1');
  // 模拟点击
  Fake.instances[0].onclick();
  assert.ok(navigated, '点击后应触发 onNavigate');
  assert.equal(navigated.sessionId, 'sess-1');
  assert.equal(navigated.navigate, true);
  assert.equal(Fake.instances[0].closed, true);
  notifier.dispose();
});

test('权限未授予时不弹通知', async () => {
  const Fake = fakeNotification({ permission: 'denied' });
  Fake.instances = [];
  const notifier = createNotifier({ notify: Fake, serviceWorker: undefined, BroadcastChannel: undefined });
  const shown = await notifier.show({ kind: 'done', title: 'x', body: 'y' });
  assert.equal(shown, 'skipped');
  assert.equal(Fake.instances.length, 0);
  notifier.dispose();
});

test('有 Service Worker 注册时用持久通知', async () => {
  const Fake = fakeNotification({ permission: 'granted' });
  Fake.instances = [];
  const shownCalls = [];
  const fakeReg = {
    active: {},
    showNotification(title, options) {
      shownCalls.push({ title, options });
      return Promise.resolve();
    },
  };
  const fakeSW = {
    register() {
      return Promise.resolve(fakeReg);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const notifier = createNotifier({ notify: Fake, serviceWorker: fakeSW, BroadcastChannel: undefined });
  notifier.ensureBridge('/webhook-notify/sw.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const shown = await notifier.show({ kind: 'attention', key: 'k2', title: 'T', body: 'B', sessionId: 's' });
  assert.equal(shown, 'sw');
  assert.equal(shownCalls.length, 1);
  assert.equal(shownCalls[0].options.data.sessionId, 's');
  // worker 通道不受权限约束但这里权限已授予；页面构造器不应被调用。
  assert.equal(Fake.instances.length, 0);
  notifier.dispose();
});

test('持久通知把 autoFocus 偏好带进 data，供 worker 点击时遵守', async () => {
  const Fake = fakeNotification({ permission: 'granted' });
  Fake.instances = [];
  const shownCalls = [];
  const fakeReg = {
    active: {},
    showNotification(title, options) {
      shownCalls.push({ title, options });
      return Promise.resolve();
    },
  };
  const fakeSW = { register: () => Promise.resolve(fakeReg), addEventListener() {}, removeEventListener() {} };
  const notifier = createNotifier({ notify: Fake, serviceWorker: fakeSW, BroadcastChannel: undefined });
  notifier.ensureBridge('/webhook-notify/sw.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await notifier.show({ kind: 'done', key: 'k4', title: 'T', body: 'B', sessionId: 's4', autoFocus: false });
  assert.equal(shownCalls.length, 1);
  assert.equal(shownCalls[0].options.data.autoFocus, false, 'worker 必须拿到 autoFocus=false');
  assert.equal(shownCalls[0].options.data.sessionId, 's4');
  // 缺省视为聚焦，避免旧调用点行为回退。
  await notifier.show({ kind: 'done', key: 'k5', title: 'T', body: 'B' });
  assert.equal(shownCalls[1].options.data.autoFocus, true);
  notifier.dispose();
});

test('worker 点击消息把 autoFocus 透传给 onNavigate', () => {
  const Fake = fakeNotification({ permission: 'granted' });
  Fake.instances = [];
  const navigations = [];
  let capturedChannel = null;
  class FakeChannel {
    constructor() {
      capturedChannel = this;
      this.listeners = [];
    }
    addEventListener(type, listener) {
      if (type === 'message') this.listeners.push(listener);
    }
    close() {}
  }
  const notifier = createNotifier({
    notify: Fake,
    serviceWorker: undefined,
    BroadcastChannel: FakeChannel,
    onNavigate: (info) => navigations.push(info),
  });
  notifier.ensureBridge('/webhook-notify/sw.js');
  capturedChannel.listeners[0]({
    data: { source: 'dsh-webhook-notify', type: 'notificationclick', sessionId: 's5', navigate: false, autoFocus: false },
  });
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].sessionId, 's5');
  assert.equal(navigations[0].navigate, false);
  assert.equal(navigations[0].autoFocus, false);
  notifier.dispose();
});

test('showNotification 拒绝时降级页面通知，不产生未处理拒绝', async () => {
  const Fake = fakeNotification({ permission: 'granted' });
  Fake.instances = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const fakeReg = {
    active: {},
    showNotification() {
      return Promise.reject(new Error('worker gone'));
    },
  };
  const fakeSW = {
    register: () => Promise.resolve(fakeReg),
    addEventListener() {},
    removeEventListener() {},
  };
  const notifier = createNotifier({ notify: Fake, serviceWorker: fakeSW, BroadcastChannel: undefined });
  notifier.ensureBridge('/webhook-notify/sw.js');
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shown = await notifier.show({ kind: 'done', key: 'k3', title: 'T', body: 'B' });
    assert.equal(shown, 'page', 'SW 失败应降级到页面通知');
    assert.equal(Fake.instances.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, [], '不应产生 unhandledRejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    notifier.dispose();
  }
});

test('BroadcastChannel 点击消息只触发一次导航，且保留 navigate:false', () => {
  const Fake = fakeNotification({ permission: 'granted' });
  Fake.instances = [];
  const navigations = [];
  let capturedChannel = null;
  class FakeChannel {
    constructor(name) {
      this.name = name;
      this.listeners = [];
      capturedChannel = this;
    }
    addEventListener(type, listener) {
      if (type === 'message') this.listeners.push(listener);
    }
    postMessage() {}
    close() {}
  }
  const notifier = createNotifier({
    notify: Fake,
    serviceWorker: undefined,
    BroadcastChannel: FakeChannel,
    onNavigate: (info) => navigations.push(info),
  });
  notifier.ensureBridge('/webhook-notify/sw.js');
  assert.ok(capturedChannel, '应建立 BroadcastChannel');
  assert.equal(capturedChannel.name, BRIDGE_CHANNEL);
  const message = {
    data: {
      source: 'dsh-webhook-notify',
      type: 'notificationclick',
      sessionId: 'sess-9',
      kind: 'attention',
      navigate: false,
    },
  };
  // 只挂了一种监听：派发一次就只会进一次回调。
  for (const listener of capturedChannel.listeners) listener(message);
  assert.equal(navigations.length, 1, '同一条消息不应触发两次导航');
  assert.equal(navigations[0].sessionId, 'sess-9');
  assert.equal(navigations[0].navigate, false, 'navigate:false 必须保留');
  notifier.dispose();
});

test('dispose 摘掉监听并关闭页面通知，之后不再回调', async () => {
  const Fake = fakeNotification({ permission: 'granted' });
  Fake.instances = [];
  const navigations = [];
  let capturedChannel = null;
  class FakeChannel {
    constructor() {
      this.listeners = [];
      this.closed = false;
      capturedChannel = this;
    }
    addEventListener(type, listener) {
      if (type === 'message') this.listeners.push(listener);
    }
    postMessage() {}
    close() {
      this.closed = true;
    }
  }
  const notifier = createNotifier({
    notify: Fake,
    serviceWorker: undefined,
    BroadcastChannel: FakeChannel,
    onNavigate: (info) => navigations.push(info),
  });
  notifier.ensureBridge('/webhook-notify/sw.js');
  await notifier.show({ kind: 'notice', key: 'k4', title: 'T', body: 'B' });
  assert.equal(Fake.instances.length, 1);
  const instance = Fake.instances[0];
  notifier.dispose();
  assert.equal(capturedChannel.closed, true, 'BroadcastChannel 应被关闭');
  assert.equal(instance.closed, true, '页面通知应被关闭');
  // 已 dispose 的实例不再处理消息，也不再弹新通知。
  for (const listener of capturedChannel.listeners) {
    listener({ data: { source: 'dsh-webhook-notify', type: 'notificationclick', sessionId: 'x' } });
  }
  assert.equal(navigations.length, 0);
  assert.equal(await notifier.show({ kind: 'notice', title: 'T', body: 'B' }), 'skipped');
  // 幂等。
  assert.doesNotThrow(() => notifier.dispose());
});

test('requestPermission 返回结果，失败后仍可重试', async () => {
  let attempts = 0;
  class Flaky {
    static permission = 'default';
    static requestPermission() {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('dismissed'));
      Flaky.permission = 'granted';
      return Promise.resolve('granted');
    }
  }
  const notifier = createNotifier({ notify: Flaky, serviceWorker: undefined, BroadcastChannel: undefined });
  assert.equal(await notifier.requestPermission(), 'default', '被拒后应返回当前权限');
  assert.equal(await notifier.requestPermission(), 'granted', '失败不应把权限请求永久锁死');
  assert.equal(attempts, 2);
  notifier.dispose();
});
