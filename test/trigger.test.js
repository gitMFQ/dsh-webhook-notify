/**
 * 触发链路测试：用假 ctx 驱动 session/event，验证事件真的会变成推送。
 *
 * 这里起一个本地 HTTP 服务器当端点，因此测的是完整路径：
 * 事件 → notify() → buildRequest() → fetch → 端点收到什么。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { apply } from '../lib/index.js';

let server;
let port;
/** 端点收到的请求。 */
let received = [];

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** 造一个够用的假 ctx：只需 on / effect / inject / logger / get。 */
function fakeCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect(fn) {
      return fn();
    },
    inject() {},
    get() {
      return undefined;
    },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  };
}

function endpointFor(path, extra = {}) {
  return {
    id: 'e1',
    name: 'test',
    enabled: true,
    url: `http://127.0.0.1:${port}${path}`,
    method: 'POST',
    headers: {},
    bodyMode: 'json',
    body: '',
    retries: 0,
    timeoutMs: 5000,
    kinds: [],
    ...extra,
  };
}

/** 等条件成立，最多 timeout 毫秒。 */
async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test('turn/end completed 触发 done 推送，正文带助手最后一条文本', async () => {
  received = [];
  const ctx = fakeCtx();
  apply(ctx, { endpoints: [endpointFor('/done', { body: '{"content":"{{content}}","session":"{{session}}"}' })] });
  const emit = ctx.handlers.get('session/event');
  assert.ok(emit, 'session/event 未注册');

  const session = { header: { id: 'sess-1' } };
  emit(session, { type: 'session/title', data: { title: '我的会话' } });
  emit(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '这是最终回答' }] } },
  });
  emit(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });

  assert.ok(await waitFor(() => received.length === 1), '没有收到推送');
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.event, undefined);
  assert.match(payload.content, /这是最终回答/);
  assert.equal(received[0].method, 'POST');
  assert.equal(payload.session, '我的会话');
});

test('session/title 事件累积会话标题（SessionHeader 无 title 时也能带上）', async () => {
  received = [];
  const ctx = fakeCtx();
  apply(ctx, { endpoints: [endpointFor('/title', { body: '{"session":"{{session}}"}' })] });
  const emit = ctx.handlers.get('session/event');

  const session = { header: { id: 'sess-title' } };
  emit(session, { type: 'session/title', data: { title: '来自事件的标题' } });
  emit(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });

  assert.ok(await waitFor(() => received.length === 1), '没有收到推送');
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.session, '来自事件的标题');
});

test('done 正文最多 21000 字符，超长回复截断且带省略号', async () => {
  received = [];
  const ctx = fakeCtx();
  apply(ctx, { endpoints: [endpointFor('/long')] });
  const emit = ctx.handlers.get('session/event');
  const session = { header: { id: 'sess-long' } };
  const long = '答'.repeat(30000);

  emit(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: long }] } },
  });
  emit(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });

  assert.ok(await waitFor(() => received.length === 1), '没有收到推送');
  const payload = JSON.parse(received[0].body);
  assert.ok(payload.content.length <= 21000, `正文超出上限：${payload.content.length}`);
  assert.ok(payload.content.includes('答答'), '正文内容丢失');
  assert.ok(payload.content.endsWith('…'), '截断后应以省略号结尾');
  assert.ok(payload.body.length <= 21000, `body 超出上限：${payload.body.length}`);
});

test('approval/asked 触发 attention 推送', async () => {
  received = [];
  const ctx = fakeCtx();
  apply(ctx, { endpoints: [endpointFor('/attention')] });
  const emit = ctx.handlers.get('session/event');

  emit(
    { header: { id: 'sess-2', title: '会话二' } },
    { type: 'approval/asked', data: { toolName: 'bash', reason: '需要执行 rm' } },
  );

  assert.ok(await waitFor(() => received.length === 1));
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.event, 'attention');
  assert.match(payload.content, /需要执行 rm/);
});

test('turn/end error 触发 error 推送且带错误信息', async () => {
  received = [];
  const ctx = fakeCtx();
  apply(ctx, { endpoints: [endpointFor('/error')] });
  const emit = ctx.handlers.get('session/event');

  emit(
    { header: { id: 'sess-3', title: '会话三' } },
    { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '太频繁' } } } },
  );

  assert.ok(await waitFor(() => received.length === 1));
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.event, 'error');
  assert.match(payload.content, /RATE_LIMIT/);
  assert.match(payload.content, /太频繁/);
});

test('关闭对应开关后不推送', async () => {
  received = [];
  const ctx = fakeCtx();
  apply(ctx, { endpoints: [endpointFor('/off')], notifyDone: false });
  const emit = ctx.handlers.get('session/event');

  emit({ header: { id: 'sess-4' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(received.length, 0);
});

test('端点 kinds 过滤：只订阅 error 时 done 不发送', async () => {
  received = [];
  const ctx = fakeCtx();
  apply(ctx, { endpoints: [endpointFor('/filtered', { kinds: ['error'] })] });
  const emit = ctx.handlers.get('session/event');

  emit({ header: { id: 'sess-5' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(received.length, 0);

  emit(
    { header: { id: 'sess-6' } },
    { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'X', message: 'y' } } } },
  );
  assert.ok(await waitFor(() => received.length === 1));
});

test('自定义头原样送达（Authorization 等）', async () => {
  received = [];
  const ctx = fakeCtx();
  apply(ctx, {
    endpoints: [
      endpointFor('/headers', {
        headers: 'Authorization: Bearer secret-token\nX-Custom: hello-world',
        body: '{"content":"{{content}}"}',
      }),
    ],
  });
  const emit = ctx.handlers.get('session/event');

  emit({ header: { id: 'sess-7' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });

  assert.ok(await waitFor(() => received.length === 1));
  assert.equal(received[0].headers.authorization, 'Bearer secret-token');
  assert.equal(received[0].headers['x-custom'], 'hello-world');
  assert.ok(JSON.parse(received[0].body).content, '自定义模板未生效');
});

test('请求头含中文时给出可读报错而不是静默失败', async () => {
  received = [];
  const ctx = fakeCtx();
  const api = apply(ctx, {
    endpoints: [endpointFor('/cn-header', { headers: 'X-Custom: 自定义' })],
  });
  const results = await api.notify(
    { kind: 'notice', title: 'T', body: 'B', sessionId: 'sess-cn' },
    { force: true },
  );
  assert.equal(received.length, 0, '不该真的发出请求');
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /非 ASCII/);
});

test('minIntervalMs 节流同一会话的连续推送', async () => {
  received = [];
  const ctx = fakeCtx();
  apply(ctx, { endpoints: [endpointFor('/throttle')], minIntervalMs: 5000 });
  const emit = ctx.handlers.get('session/event');
  const session = { header: { id: 'sess-8' } };

  emit(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.ok(await waitFor(() => received.length === 1));
  emit(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(received.length, 1, '节流未生效');
});

test('端点不可达时不让事件处理抛错', async () => {
  const ctx = fakeCtx();
  apply(ctx, {
    endpoints: [{ ...endpointFor('/x'), url: 'http://127.0.0.1:1/nope', timeoutMs: 1000 }],
  });
  const emit = ctx.handlers.get('session/event');
  assert.doesNotThrow(() => {
    emit({ header: { id: 'sess-9' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  });
});
