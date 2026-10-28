/**
 * 宿主端 Service Worker 路由的测试：/webhook-notify/sw.js 必须以
 * text/javascript 下发自包含的 worker 脚本（Service Worker 注册对
 * 同源 + 脚本类型敏感，这也是它不走 /plugins/… 组合脚本通道的原因）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../lib/index.js';
import { SERVICE_WORKER_SOURCE } from '../lib/sw.js';

function fakeRes() {
  return {
    headers: null,
    body: null,
    status: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function mount() {
  const routes = new Map();
  const fakeWebCtx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    effect(fn) {
      return fn();
    },
  };
  const ctx = {
    on() {
      return () => {};
    },
    effect(fn) {
      return fn();
    },
    inject(name, fn) {
      const wanted = Array.isArray(name) ? name : [name];
      if (wanted.includes('webServer')) fn(fakeWebCtx);
    },
    get() {
      return undefined;
    },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  };
  apply(ctx, { endpoints: [] });
  return routes;
}

test('/webhook-notify/sw.js 以 text/javascript 下发 worker 脚本', async () => {
  const routes = mount();
  assert.ok(routes.has('/webhook-notify/sw.js'), 'sw 路由应注册');

  const req = { method: 'GET', url: '/webhook-notify/sw.js', headers: {} };
  const res = fakeRes();
  await routes.get('/webhook-notify/sw.js')(req, res);

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/javascript/);
  assert.equal(res.body, SERVICE_WORKER_SOURCE);
  assert.match(res.body, /notificationclick/);
});

test('HEAD 请求只回头部不回正文', async () => {
  const routes = mount();
  const req = { method: 'HEAD', url: '/webhook-notify/sw.js', headers: {} };
  const res = fakeRes();
  await routes.get('/webhook-notify/sw.js')(req, res);
  assert.equal(res.status, 200);
  assert.equal(res.body, undefined);
});
