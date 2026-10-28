/** 发送层的边界：重定向、429 重试、响应体上限、URL 校验。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliver, deliverAll } from '../lib/send.js';

const EVENT = { kind: 'done', title: 'T', body: 'B', time: '2026-10-20T00:00:00.000Z', text: 'T\nB' };

function endpoint(extra = {}) {
  // timeoutMs 默认 0 = 不覆盖插件级超时（正常配置里的默认值）。
  return { id: 'e1', name: 'n', enabled: true, url: 'https://example.com/h', method: 'POST', headers: {}, bodyMode: 'json', body: '', retries: 0, timeoutMs: 0, kinds: [], ...extra };
}

test('3xx 不自动跟随，而是当成可读失败上报', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:1/internal' } });
  };
  try {
    const result = await deliver(endpoint(), EVENT);
    assert.equal(result.ok, false);
    assert.equal(result.status, 302);
    assert.match(result.error, /重定向/);
    assert.equal(calls[0].redirect, 'manual', '不能让对端决定请求发到哪');
  } finally {
    globalThis.fetch = original;
  }
});

test('429 会重试，普通 400 不重试', async () => {
  const original = globalThis.fetch;
  try {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return new Response('slow down', { status: 429 });
    };
    const retried = await deliver(endpoint({ retries: 2 }), EVENT);
    assert.equal(attempts, 3, '429 应重试到上限');
    assert.equal(retried.ok, false);

    attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return new Response('bad', { status: 400 });
    };
    await deliver(endpoint({ retries: 2 }), EVENT);
    assert.equal(attempts, 1, '400 是确定性错误，不该重试');
  } finally {
    globalThis.fetch = original;
  }
});

test('超大响应体被截断，不会整个读进内存', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('x'.repeat(200_000), { status: 500 });
  try {
    const result = await deliver(endpoint(), EVENT);
    assert.equal(result.ok, false);
    assert.ok((result.body ?? '').length <= 64 * 1024, `响应体应被截断，实际 ${(result.body ?? '').length}`);
  } finally {
    globalThis.fetch = original;
  }
});

test('非 http(s) 的端点地址直接拒绝，不发起请求', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('', { status: 200 });
  };
  try {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', '']) {
      const result = await deliver(endpoint({ url }), EVENT);
      assert.equal(result.ok, false, `${url} 应被拒绝`);
      assert.match(result.error, /地址无效/);
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

/** 一个只会被 AbortSignal 结束的 fetch：用来观察真正生效的超时值。 */
function hangingFetch() {
  return (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

test('端点没配 timeoutMs（0）时继承插件级超时', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  try {
    const result = await deliver(endpoint({ timeoutMs: 0 }), EVENT, { timeoutMs: 60 });
    assert.equal(result.ok, false);
    // 错误文案里的毫秒数就是真正生效的那个值。
    assert.match(result.error, /超时（60ms）/, `应使用插件级超时，实际：${result.error}`);
  } finally {
    globalThis.fetch = original;
  }
});

test('端点显式配置的 timeoutMs 优先于插件级超时', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  try {
    const result = await deliver(endpoint({ timeoutMs: 40 }), EVENT, { timeoutMs: 5000 });
    assert.match(result.error, /超时（40ms）/, `应使用端点自己的超时，实际：${result.error}`);
  } finally {
    globalThis.fetch = original;
  }
});

test('deliverAll：广播路径静默跳过空地址，自测才让空地址走 deliver', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('', { status: 200 });
  };
  try {
    // 广播：停用与「没填地址的草稿行」都不该产生结果（也就不会刷出红条）。
    const strict = await deliverAll(
      [
        endpoint({ id: 'on', url: 'https://example.com/on' }),
        endpoint({ id: 'draft', url: '   ' }),
        endpoint({ id: 'off', url: 'https://example.com/off', enabled: false }),
      ],
      EVENT,
    );
    assert.deepEqual(strict.map((item) => item.id), ['on'], '只应投递启用且有地址的端点');
    assert.equal(calls.length, 1);

    // 自测：空地址也走一遍，拿到真实的「地址无效」结果，但不是真的发请求。
    calls.length = 0;
    const loose = await deliverAll([endpoint({ id: 'draft', url: '' })], EVENT, { includeEmptyUrl: true });
    assert.equal(loose.length, 1);
    assert.equal(loose[0].id, 'draft');
    assert.equal(loose[0].ok, false);
    assert.match(loose[0].error, /地址无效/);
    assert.equal(calls.length, 0, '空地址不该真的发出请求');
  } finally {
    globalThis.fetch = original;
  }
});
