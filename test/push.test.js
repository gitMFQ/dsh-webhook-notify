/**
 * Web Push 加密与 VAPID 签名的测试。
 *
 * 两层验证：
 * 1. RFC 8188 §3.1 的官方测试向量 —— 内容编码层逐字节对齐规范；
 * 2. 自实现的解密侧 —— 端到端验证 Web Push 的 KDF 链（IKM → CEK/NONCE），
 *    模拟浏览器用订阅私钥解出明文。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import {
  buildVapidAuth,
  deriveContentKeyAndNonce,
  deriveInputKeyingMaterial,
  encryptPayload,
  encryptRecord,
  generateVapidKeys,
  hkdfExpand,
  hkdfExtract,
  importPrivateKey,
  sendPush,
} from '../lib/push.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** 按 RFC 8188 解一条 aes128gcm 记录（测试用的解密侧）。 */
function decryptRecord(ciphertext, tag, cek, nonce) {
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

test('RFC 8188 §3.1：官方测试向量逐字节一致', () => {
  const ikm = Buffer.from('yqdlZ-tYemfogSmv7Ws5PQ', 'base64url');
  const salt = Buffer.from('I1BsxtFttlv3u_Oo94xnmw', 'base64url');
  const { cek, nonce } = deriveContentKeyAndNonce(salt, ikm);

  // 规范给的中间值：CEK 与 NONCE 的 base64url。
  assert.equal(b64url(cek), '_wniytB-ofscZDh4tbSjHw');
  assert.equal(b64url(nonce), 'Bcs8gkIRKLI8GeI8');

  const record = encryptRecord(Buffer.from('I am the walrus', 'utf8'), cek, nonce, true);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  const body = Buffer.concat([salt, rs, Buffer.from([0]), record]);

  assert.equal(
    b64url(body),
    'I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg',
  );
});

test('HKDF 派生链符合 RFC 5869', () => {
  // RFC 5869 附录 A.1（SHA-256）：
  //   IKM = 0x0b × 22，salt = 0x000102…0c，info = 0xf0f1…f9，L = 42。
  const ikm = Buffer.alloc(22, 0x0b);
  const salt = Buffer.from('000102030405060708090a0b0c', 'hex');
  const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
  const okm = hkdfExpand(hkdfExtract(salt, ikm), info, 42);
  assert.equal(
    okm.toString('hex'),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  );
  // 与 Node 内置实现（RFC 5869）逐字节一致。
  const nodeOkm = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 42));
  assert.deepEqual(okm, nodeOkm);
});

test('Web Push 载荷可被订阅端解密（端到端往返）', () => {
  // 模拟浏览器：生成用户代理密钥对作为订阅。
  const ua = crypto.createECDH('prime256v1');
  const uaPublic = ua.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: b64url(uaPublic), auth: b64url(authSecret) },
  };

  const payload = { title: 'DSH · 回复完成', body: '干完了', kind: 'done', sessionId: 's-1' };
  const { body } = encryptPayload(subscription, JSON.stringify(payload));

  // 头：salt(16) || rs(4) || idlen(1) || as_public
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idlen = body.readUInt8(20);
  assert.equal(idlen, 65);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  assert.equal(record.length, Buffer.byteLength(JSON.stringify(payload), 'utf8') + 1 + 16);

  // 浏览器侧的解密：IKM → CEK/NONCE → AES-GCM。
  const ecdhSecret = ua.computeSecret(asPublic);
  const ikm = deriveInputKeyingMaterial({ ecdhSecret, uaPublic, asPublic, authSecret });
  const { cek, nonce } = deriveContentKeyAndNonce(salt, ikm);
  const plain = decryptRecord(record.subarray(0, record.length - 16), record.subarray(record.length - 16), cek, nonce);

  // 明文末尾是 RFC 8188 的记录分隔符 0x02。
  assert.equal(plain[plain.length - 1], 0x02);
  assert.deepEqual(JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8')), payload);
});

test('VAPID：JWT 结构正确且签名可被公钥验证', () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);

  const auth = buildVapidAuth({
    privateKey: importPrivateKey(keys.privateKey),
    publicKey: keys.publicKey,
    subject: 'mailto:dsh@example.com',
    audience: 'https://fcm.googleapis.com',
    now: 1_700_000_000_000,
  });
  assert.match(auth.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

  const [header, payload, signature] = auth.jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:dsh@example.com');
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600);

  // 用公钥验签：ES256 的签名是 r||s 原始格式。
  const jwk = JSON.parse(
    Buffer.from(keys.publicKey, 'base64url').subarray(1).toString('hex')
      && JSON.stringify({
        kty: 'EC', crv: 'P-256',
        x: Buffer.from(keys.publicKey, 'base64url').subarray(1, 33).toString('base64url'),
        y: Buffer.from(keys.publicKey, 'base64url').subarray(33, 65).toString('base64url'),
      }),
  );
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify(
    'sha256',
    Buffer.from(`${header}.${payload}`, 'ascii'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
  assert.equal(ok, true, 'VAPID 签名应能被自己的公钥验证');
});

test('sendPush：带上 VAPID 头与 aes128gcm 编码', async () => {
  const keys = generateVapidKeys();
  const ua = crypto.createECDH('prime256v1');
  const uaPublic = ua.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/xyz',
    keys: { p256dh: b64url(uaPublic), auth: b64url(crypto.randomBytes(16)) },
  };

  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('', { status: 201 });
  };
  try {
    const result = await sendPush(
      subscription,
      { title: 'hi', body: 'there' },
      { privateKey: keys.privateKey, publicKey: keys.publicKey, subject: 'mailto:a@b.c' },
    );
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, subscription.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.match(init.headers.Authorization, /^vapid t=/);
  assert.equal(init.headers.TTL, '86400');
  assert.ok(Buffer.isBuffer(init.body));
  // 头 21 字节 + as_public + 记录
  assert.ok(init.body.length > 21 + 65);
});

test('sendPush：端点非法时返回可读错误而不抛出', async () => {
  const result = await sendPush(
    { endpoint: 'not-a-url', keys: { p256dh: '', auth: '' } },
    { title: 'x' },
    { privateKey: 'x', publicKey: 'y' },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /推送端点无效/);
});

test('resolveProxy：空地址返回 null，可用地址返回带 dispatcher 的 fetch', async () => {
  const { resolveProxy, resetProxyCache } = await import('../lib/push.js');
  assert.equal(await resolveProxy(''), null);
  assert.equal(await resolveProxy('   '), null);
  // 非法地址不应炸掉推送：退回直连。
  assert.equal(await resolveProxy('not a url'), null);
  const route = await resolveProxy('http://127.0.0.1:7890');
  if (route) {
    assert.equal(typeof route.fetch, 'function');
    assert.ok(route.dispatcher, '应带 ProxyAgent');
  }
  resetProxyCache();
});
