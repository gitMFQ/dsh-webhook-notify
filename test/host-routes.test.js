/**
 * 宿主新增路由的测试：Web Push 的密钥/订阅/测试推送。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../lib/index.js';
import { ROUTES } from '../lib/index.js';

function fakeRes() {
  return {
    headers: null,
    body: null,
    status: null,
    location: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      if (headers?.location) this.location = headers.location;
    },
    end(body) {
      this.body = body;
    },
  };
}

/** 挂一个假的宿主环境，返回路由表与配置写入记录。 */
function mount(config = {}) {
  const routes = new Map();
  const edits = [];
  // 有状态的假编辑器：edit 的入参是「当前已保存的配置」，和真实
  // configEditor 一样。用固定 {} 做基准会让并发覆盖测不出来。
  const stored = { endpoints: [], ...config };
  const fakeWebCtx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
      getOrigin() {
        return 'http://127.0.0.1:3080';
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
    fiber: { entry: { id: 'webhook-notify' } },
    inject(name, fn) {
      const wanted = Array.isArray(name) ? name : [name];
      if (wanted.includes('webServer')) fn(fakeWebCtx);
    },
    get(name) {
      if (name === 'webServer') return fakeWebCtx.webServer;
      if (name === 'configEditor') {
        return {
          async edit(entry, updater) {
            // 让出事件循环：两个并发的读改写会真的交错。
            await new Promise((resolve) => setTimeout(resolve, 5));
            const next = updater(structuredClone(stored));
            for (const key of Object.keys(stored)) delete stored[key];
            Object.assign(stored, next);
            edits.push(next);
            return true;
          },
        };
      }
      return undefined;
    },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  };
  apply(ctx, stored);
  return { routes, edits, stored };
}

/** 构造一个请求。 */
function req(method, url, headers = {}) {
  return { method, url, headers: { host: '127.0.0.1:3080', ...headers } };
}

/** 读 JSON 响应体。 */
function json(res) {
  return JSON.parse(res.body);
}

test('设置页保存：无法覆盖 VAPID 私钥与推送订阅', async () => {
  const { routes, edits } = mount({
    pushVapidPublicKey: 'pub',
    pushVapidPrivateKey: 'priv-secret',
    pushSubscriptions: [
      { id: 's1', endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } },
    ],
  });
  const body = JSON.stringify({
    notifyDone: false,
    pushVapidPrivateKey: 'attacker',
    pushSubscriptions: [],
  });
  const res = fakeRes();
  await routes.get(ROUTES.save)(
    {
      ...req('POST', '/webhook-notify/save'),
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
    },
    res,
  );
  const saved = json(res);
  assert.equal(saved.ok, true);
  assert.equal(saved.config.pushVapidPrivateKey, undefined);
  const written = edits.at(-1);
  // 私钥保持不变（不是被清空，更不是被请求体里的值覆盖）。
  assert.equal(written.pushVapidPrivateKey, 'priv-secret');
  assert.equal(written.notifyDone, false);
  // 订阅不在白名单里，保存不会动它。
  assert.deepEqual(written.pushSubscriptions, [
    { id: 's1', endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' }, ua: '', createdAt: written.pushSubscriptions[0].createdAt },
  ]);
  const listRes = fakeRes();
  await routes.get(ROUTES.pushList)(req('GET', '/webhook-notify/push/list'), listRes);
  assert.equal(json(listRes).subscriptions.length, 1, '订阅不应被设置页保存清空');
});

test('设置页保存：并发写回不会互相覆盖（订阅与设置各自生效）', async () => {
  const { routes } = mount();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'A'.repeat(86), auth: 'B'.repeat(22) },
    };
    const saveBody = JSON.stringify({ notifyError: false });
    await Promise.all([
      routes.get(ROUTES.pushSubscribe)(
        {
          ...req('POST', '/webhook-notify/push/subscribe'),
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify({ subscription }));
          },
        },
        fakeRes(),
      ),
      routes.get(ROUTES.save)(
        {
          ...req('POST', '/webhook-notify/save'),
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(saveBody);
          },
        },
        fakeRes(),
      ),
    ]);
    const stateRes = fakeRes();
    await routes.get(ROUTES.state)(req('GET', '/webhook-notify/state'), stateRes);
    assert.equal(json(stateRes).config.notifyError, false, '设置页的改动应保留');
    const listRes = fakeRes();
    await routes.get(ROUTES.pushList)(req('GET', '/webhook-notify/push/list'), listRes);
    assert.equal(json(listRes).subscriptions.length, 1, '订阅不应被设置页保存冲掉');
  } finally {
    globalThis.fetch = original;
  }
});

test('测试通知：没有可用端点时给出明确错误而不是空成功', async () => {
  const { routes } = mount();
  const res = fakeRes();
  await routes.get(ROUTES.test)(
    {
      ...req('POST', '/webhook-notify/test'),
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{}');
      },
    },
    res,
  );
  const payload = json(res);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /端点/);
});

/** 造一个带 JSON 请求体的 POST 请求。 */
function postReq(url, payload, headers = {}) {
  return {
    ...req('POST', url, headers),
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload));
    },
  };
}

test('测试通知：停用的端点也能测通（不再被 enabled 过滤成空结果）', async () => {
  // 回归：notify() 放行被停用的端点，deliverAll() 又按 enabled 过滤一次，
  // 于是「发送测试消息」报「找不到该端点」——用户拿不到任何真实反馈。
  const { routes } = mount({
    endpoints: [{
      id: 'ep-off',
      name: '停用的端点',
      enabled: false,
      url: 'https://example.com/hook',
      method: 'POST',
      headers: {},
      bodyMode: 'json',
      body: '',
      retries: 0,
      timeoutMs: 0,
      kinds: [],
    }],
  });
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('ok', { status: 200 });
  };
  try {
    const res = fakeRes();
    await routes.get(ROUTES.test)(postReq(ROUTES.test, { endpointId: 'ep-off' }), res);
    const payload = json(res);
    assert.equal(payload.ok, true, `停用端点应能测通：${JSON.stringify(payload)}`);
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].id, 'ep-off');
    assert.equal(payload.results[0].ok, true);
    assert.deepEqual(calls, ['https://example.com/hook'], '应真的向该端点发出一次请求');
  } finally {
    globalThis.fetch = original;
  }
});

test('测试通知：地址为空的端点给出「地址无效」的真实投递结果', async () => {
  const { routes } = mount({
    endpoints: [{
      id: 'ep-empty',
      name: '还没填地址',
      enabled: false,
      url: '',
      method: 'POST',
      headers: {},
      bodyMode: 'json',
      body: '',
      retries: 0,
      timeoutMs: 0,
      kinds: [],
    }],
  });
  const res = fakeRes();
  await routes.get(ROUTES.test)(postReq(ROUTES.test, { endpointId: 'ep-empty' }), res);
  const payload = json(res);
  assert.equal(payload.ok, false);
  // 端点确实存在：要有真实的投递结果，而不是「找不到该端点」。
  assert.equal(payload.results.length, 1, '端点存在时应给出真实投递结果');
  assert.match(payload.results[0].error, /地址无效/);
  assert.equal(payload.results[0].id, 'ep-empty');
  assert.ok(
    payload.error === undefined || !/找不到该端点/.test(String(payload.error)),
    `不该误报找不到端点：${payload.error}`,
  );
});

test('测试通知（广播路径）：启用但没填地址的端点被静默跳过，不写进最近投递', async () => {
  // 广播路径的语义是「静默跳过」：设置页里刚加、还没填地址的草稿行不该让
  // 每条事件都在「最近投递」里压一条红条。
  const { routes } = mount({
    endpoints: [{
      id: 'ep-draft',
      name: '草稿行',
      enabled: true,
      url: '',
      method: 'POST',
      headers: {},
      bodyMode: 'json',
      body: '',
      retries: 0,
      timeoutMs: 0,
      kinds: [],
    }],
  });
  const res = fakeRes();
  await routes.get(ROUTES.test)(postReq(ROUTES.test, {}), res);
  const payload = json(res);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /还没有启用的端点/);
  assert.deepEqual(payload.results, [], '广播路径不该为空地址产生结果');

  const stateRes = fakeRes();
  await routes.get(ROUTES.state)(req('GET', ROUTES.state), stateRes);
  assert.deepEqual(json(stateRes).recent, [], '最近投递里不该出现失败记录');
});

test('测试通知：真正不存在的端点 id 仍然报「找不到该端点」', async () => {
  const { routes } = mount({
    endpoints: [{
      id: 'ep-one',
      name: '正常端点',
      enabled: true,
      url: 'https://example.com/hook',
      method: 'POST',
      headers: {},
      bodyMode: 'json',
      body: '',
      retries: 0,
      timeoutMs: 0,
      kinds: [],
    }],
  });
  const res = fakeRes();
  await routes.get(ROUTES.test)(postReq(ROUTES.test, { endpointId: 'ep-missing' }), res);
  const payload = json(res);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /找不到该端点/);
  assert.deepEqual(payload.results, []);
});

test('反向代理：X-Forwarded-Host 与浏览器 Origin 一致时写接口不再 403', async () => {
  // 代理把 Host 改写成后端地址，浏览器发的 Origin 仍是公开域名。只比
  // req.headers.host 时保存 / 自测会全部 403。
  const { routes, edits } = mount();
  const proxyHeaders = {
    host: '127.0.0.1:3080',
    'x-forwarded-host': 'dsh.osai.eu.org',
    'x-forwarded-proto': 'https',
    origin: 'https://dsh.osai.eu.org',
  };

  const saveRes = fakeRes();
  await routes.get(ROUTES.save)(postReq(ROUTES.save, { notifyDone: false }, proxyHeaders), saveRes);
  assert.equal(saveRes.status, 200, '反代后保存不该 403');
  assert.equal(json(saveRes).ok, true);
  assert.equal(edits.at(-1).notifyDone, false, '保存应真的写回');

  const testRes = fakeRes();
  await routes.get(ROUTES.test)(postReq(ROUTES.test, {}, proxyHeaders), testRes);
  assert.equal(testRes.status, 200, '反代后自测不该 403');

  // 代理链是逗号分隔的一串时，取客户端侧那个。
  const chainRes = fakeRes();
  await routes.get(ROUTES.save)(
    postReq(ROUTES.save, { notifyDone: true }, {
      ...proxyHeaders,
      'x-forwarded-host': 'dsh.osai.eu.org, upstream.internal',
    }),
    chainRes,
  );
  assert.equal(chainRes.status, 200, '多级代理链也应放行');

  // 真的来自别的站点的 Origin 仍然拒绝。
  const foreign = fakeRes();
  await routes.get(ROUTES.save)(
    postReq(ROUTES.save, {}, { host: '127.0.0.1:3080', origin: 'https://evil.example' }),
    foreign,
  );
  assert.equal(foreign.status, 403, '跨站 Origin 必须继续拒绝');
});

test('push 路由：公钥可用且订阅可增删', async () => {
  const { routes, edits } = mount();

  const keyRes = fakeRes();
  await routes.get(ROUTES.pushKey)(req('GET', '/webhook-notify/push/key'), keyRes);
  assert.equal(keyRes.status, 200);
  const key = json(keyRes);
  assert.ok(key.publicKey, '应返回 VAPID 公钥');
  assert.equal(Buffer.from(key.publicKey, 'base64url').length, 65);

  // 订阅
  const subRes = fakeRes();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: 'A'.repeat(86), auth: 'B'.repeat(22) },
  };
  const body = JSON.stringify({ subscription });
  const subReq = {
    ...req('POST', '/webhook-notify/push/subscribe'),
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  };
  await routes.get(ROUTES.pushSubscribe)(subReq, subRes);
  assert.equal(subRes.status, 200);
  assert.equal(json(subRes).count, 1);

  // 列表
  const listRes = fakeRes();
  await routes.get(ROUTES.pushList)(req('GET', '/webhook-notify/push/list'), listRes);
  const list = json(listRes);
  assert.equal(list.subscriptions.length, 1);
  assert.equal(list.subscriptions[0].host, 'fcm.googleapis.com');
  // 列表不泄露密钥。
  assert.equal(list.subscriptions[0].keys, undefined);

  // 退订
  const unRes = fakeRes();
  const unBody = JSON.stringify({ endpoint: subscription.endpoint });
  const unReq = {
    ...req('POST', '/webhook-notify/push/unsubscribe'),
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(unBody);
    },
  };
  await routes.get(ROUTES.pushUnsubscribe)(unReq, unRes);
  assert.equal(json(unRes).count, 0);

  // 订阅与退订都写回了 profile 配置。
  assert.ok(edits.length >= 2, '订阅变化应写回配置');
});

test('push 路由：状态接口不泄露 VAPID 私钥', async () => {
  const { routes } = mount();
  const res = fakeRes();
  await routes.get(ROUTES.state)(req('GET', '/webhook-notify/state'), res);
  const state = json(res);
  assert.equal(state.config.pushVapidPrivateKey, undefined);
  assert.equal(state.config.pushSubscriptions, undefined);
  // 但开关与联系地址要能读到。
  assert.equal(typeof state.config.pushEnabled, 'boolean');
  assert.match(state.config.pushSubject, /^mailto:/);
});

test('端到端：宿主把推送发到本地推送服务并能解密', async () => {
  // 真实的 HTTP 往返：宿主 → 本地「推送服务」→ 用浏览器侧私钥解密。
  // 这样即使外网 FCM 不可达，也能验证 VAPID 头、aes128gcm 加密与载荷内容。
  const crypto = await import('node:crypto');
  const http = await import('node:http');
  const { deriveContentKeyAndNonce, deriveInputKeyingMaterial } = await import('../lib/push.js');

  // 模拟浏览器的用户代理密钥对。
  const ua = crypto.createECDH('prime256v1');
  const uaPublic = ua.generateKeys();
  const authSecret = crypto.randomBytes(16);

  let received = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(201).end('');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/push/send/abc`;

  try {
    const { routes } = mount();

    // 1) 订阅（浏览器把订阅信息报给宿主）。
    const subRes = fakeRes();
    const subBody = JSON.stringify({
      subscription: {
        endpoint,
        keys: { p256dh: uaPublic.toString('base64url'), auth: authSecret.toString('base64url') },
      },
    });
    await routes.get(ROUTES.pushSubscribe)(
      {
        ...req('POST', '/webhook-notify/push/subscribe'),
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(subBody);
        },
      },
      subRes,
    );
    assert.equal(json(subRes).count, 1);

    // 2) 测试推送。
    const testRes = fakeRes();
    await routes.get(ROUTES.pushTest)(
      {
        ...req('POST', '/webhook-notify/push/test'),
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{}');
        },
      },
      testRes,
    );
    const test = json(testRes);
    assert.equal(test.ok, true, `推送应成功：${JSON.stringify(test)}`);

    // 3) 推送服务收到了什么。
    assert.ok(received, '推送服务应收到请求');
    assert.equal(received.method, 'POST');
    assert.equal(received.headers['content-encoding'], 'aes128gcm');
    assert.match(received.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(received.headers.ttl, '86400');

    // 4) VAPID JWT 的签名能被宿主自己的公钥验证。
    const keyRes = fakeRes();
    await routes.get(ROUTES.pushKey)(req('GET', '/webhook-notify/push/key'), keyRes);
    const { publicKey } = json(keyRes);
    const raw = Buffer.from(publicKey, 'base64url');
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33, 65).toString('base64url'),
    };
    const token = received.headers.authorization.match(/t=([^,]+)/)[1];
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    assert.equal(claims.aud, `http://127.0.0.1:${port}`);
    assert.ok(crypto.verify(
      'sha256',
      Buffer.from(`${header}.${payload}`, 'ascii'),
      { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ), 'VAPID 签名应能被公钥验证');

    // 5) 载荷能被订阅端解密。
    const body = received.body;
    const salt = body.subarray(0, 16);
    const idlen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idlen);
    const record = body.subarray(21 + idlen);
    const ecdhSecret = ua.computeSecret(asPublic);
    const ikm = deriveInputKeyingMaterial({ ecdhSecret, uaPublic, asPublic, authSecret });
    const { cek, nonce } = deriveContentKeyAndNonce(salt, ikm);
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([
      decipher.update(record.subarray(0, record.length - 16)),
      decipher.final(),
    ]);
    // 末字节是 RFC 8188 的记录分隔符。
    assert.equal(plain[plain.length - 1], 0x02);
    const pushPayload = JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
    assert.equal(pushPayload.title, 'DSH · 测试推送');
    assert.equal(pushPayload.kind, 'notice');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
