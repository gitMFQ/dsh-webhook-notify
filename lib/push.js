/**
 * Web Push —— 宿主侧的 VAPID 签名与 aes128gcm 载荷加密。
 *
 * 为什么自己实现：npm 上的 `web-push` 依赖 `http_ece` / `hkdf`，而插件要装进
 * 用户 profile，不能假设那些依赖存在。Node 自带的 `crypto` 已经够用：
 * P-256 的 ECDH / ECDSA、HMAC-SHA256、AES-128-GCM 全都有。
 *
 * 规范依据：
 * - RFC 8291（VAPID）：`Authorization: vapid t=<jwt>, k=<公钥>`，JWT 用 ES256。
 * - draft-ietf-webpush-encryption：载荷用 `aes128gcm` 内容编码（RFC 8188）。
 * - RFC 8188：PRK/CEK/NONCE 派生与记录结构。
 *
 * 派生链（与 http_ece 参考实现逐字节一致）：
 *   1. ecdh_secret = ECDH(as_private, ua_public)
 *   2. PRK1   = HKDF-Extract(auth_secret, ecdh_secret)
 *   3. IKM    = HKDF-Expand(PRK1, "WebPush: info\0" || ua_public || as_public, 32)
 *   4. PRK    = HKDF-Extract(salt, IKM)
 *   5. CEK    = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
 *   6. NONCE  = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)
 *   7. 记录   = 明文 || 0x02（末记录分隔符），AES-128-GCM 加密后拼 16 字节 tag
 *   8. 头     = salt(16) || rs(4, BE) || idlen(1) || as_public
 */
import crypto from 'node:crypto';

/** 载荷加密用的曲线（P-256 / prime256v1）。 */
const CURVE = 'prime256v1';

/** 内容编码：aes128gcm（RFC 8188）。 */
export const CONTENT_ENCODING = 'aes128gcm';

/** 记录大小（RFC 8188 的 rs）。推送载荷很小，一条记录足够。 */
const RECORD_SIZE = 4096;

/** base64url（无填充）。 */
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** HMAC-SHA-256。 */
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * HKDF-Extract（RFC 5869）。
 *
 * @param {Buffer} salt HKDF 盐。
 * @param {Buffer} ikm 输入密钥材料。
 * @returns {Buffer} 伪随机密钥。
 */
export function hkdfExtract(salt, ikm) {
  return hmac(salt, ikm);
}

/**
 * HKDF-Expand（RFC 5869）。
 *
 * @param {Buffer} prk 伪随机密钥。
 * @param {Buffer} info 上下文串。
 * @param {number} length 输出字节数。
 * @returns {Buffer} 派生的密钥材料。
 */
export function hkdfExpand(prk, info, length) {
  const blocks = [];
  let previous = Buffer.alloc(0);
  let counter = 1;
  let produced = 0;
  while (produced < length) {
    previous = hmac(prk, Buffer.concat([previous, info, Buffer.from([counter])]));
    blocks.push(previous);
    produced += previous.length;
    counter += 1;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/**
 * 生成一对 VAPID 密钥。
 *
 * @returns {{publicKey: string, privateKey: string}} 公钥为未压缩点的 base64url
 *   （浏览器 `PushManager.subscribe({applicationServerKey})` 直接可用），
 *   私钥为 PKCS#8 DER 的 base64url。
 */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: CURVE });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return { publicKey: raw.toString('base64url'), privateKey: der.toString('base64url') };
}

/**
 * 从 base64url 的 PKCS#8 DER 还原私钥。
 *
 * @param {string} privateKeyB64 base64url 私钥。
 * @returns {crypto.KeyObject} 私钥对象。
 */
export function importPrivateKey(privateKeyB64) {
  const der = Buffer.from(String(privateKeyB64 ?? ''), 'base64url');
  if (der.length === 0) throw new Error('VAPID 私钥为空');
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * 签发 VAPID JWT（RFC 8291）。
 *
 * @param {object} options
 * @param {crypto.KeyObject} options.privateKey VAPID 私钥。
 * @param {string} options.publicKey base64url 未压缩公钥（放进 `k=`）。
 * @param {string} options.subject 联系地址，必须是 `mailto:` 或 `https:`。
 * @param {string} options.audience 推送端点的 origin。
 * @param {number} [options.ttl] 推送服务端的缓存秒数。
 * @param {number} [options.now] 当前时间（毫秒），测试可注入。
 * @returns {{authorization: string, ttl: number, jwt: string}} 请求头与 JWT。
 */
export function buildVapidAuth(options = {}) {
  const {
    privateKey,
    publicKey,
    subject = 'mailto:dsh-webhook-notify@localhost',
    audience,
    ttl = 86400,
    now = Date.now(),
  } = options;
  if (!audience) throw new Error('VAPID audience 缺失');
  if (!/^(mailto:|https:)/i.test(subject)) throw new Error('VAPID subject 必须是 mailto: 或 https: 地址');

  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(now / 1000) + 12 * 3600,
      sub: subject,
    }),
  );
  const signingInput = `${header}.${payload}`;
  // dsaEncoding: 'ieee-p1363' → r||s 的 64 字节原始签名，正是 JWS ES256 要的格式。
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  const jwt = `${signingInput}.${b64url(signature)}`;
  return { authorization: `vapid t=${jwt}, k=${publicKey}`, ttl, jwt };
}

/**
 * 计算 Web Push 的输入密钥材料（IKM）。
 *
 * 拆出来是为了让测试能单独验证这一步的字节序。
 *
 * @param {object} options
 * @param {Buffer} options.ecdhSecret ECDH 共享密钥。
 * @param {Buffer} options.uaPublic 用户代理公钥（65 字节未压缩）。
 * @param {Buffer} options.asPublic 应用服务端临时公钥（65 字节未压缩）。
 * @param {Buffer} options.authSecret 订阅里的 auth 密钥（16 字节）。
 * @returns {Buffer} 32 字节 IKM。
 */
export function deriveInputKeyingMaterial(options = {}) {
  const { ecdhSecret, uaPublic, asPublic, authSecret } = options;
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic]);
  const prk = hkdfExtract(authSecret, ecdhSecret);
  return hkdfExpand(prk, info, 32);
}

/**
 * 按 RFC 8188 派生内容加密密钥与 nonce。
 *
 * @param {Buffer} salt 16 字节随机盐。
 * @param {Buffer} ikm 输入密钥材料。
 * @returns {{cek: Buffer, nonce: Buffer}} 16 字节 CEK 与 12 字节 nonce。
 */
export function deriveContentKeyAndNonce(salt, ikm) {
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12);
  return { cek, nonce };
}

/**
 * 用 aes128gcm 加密一条载荷记录（RFC 8188）。
 *
 * @param {Buffer} plaintext 明文。
 * @param {Buffer} cek 内容加密密钥。
 * @param {Buffer} nonce 12 字节 nonce。
 * @param {boolean} [last] 是否为末条记录（分隔符写 0x02）。
 * @returns {Buffer} 密文 + 16 字节 tag。
 */
export function encryptRecord(plaintext, cek, nonce, last = true) {
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const padding = Buffer.from([last ? 0x02 : 0x01]);
  const body = Buffer.concat([plaintext, padding]);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

/**
 * 加密一条 Web Push 载荷。
 *
 * @param {object} subscription 订阅信息：{endpoint, keys:{p256dh, auth}}。
 * @param {string|Buffer} payload 待加密的正文（通常是 JSON 字符串）。
 * @param {object} [options]
 * @param {Buffer} [options.salt] 16 字节盐（测试可注入固定值）。
 * @returns {{body: Buffer, salt: Buffer, asPublic: Buffer}} 请求体与中间量。
 */
export function encryptPayload(subscription, payload, options = {}) {
  const keys = subscription?.keys ?? {};
  const uaPublic = Buffer.from(String(keys.p256dh ?? ''), 'base64url');
  const authSecret = Buffer.from(String(keys.auth ?? ''), 'base64url');
  if (uaPublic.length !== 65) throw new Error('订阅的 p256dh 必须是 65 字节未压缩公钥');
  if (authSecret.length < 16) throw new Error('订阅的 auth 密钥至少 16 字节');

  const ecdh = crypto.createECDH(CURVE);
  const asPublic = ecdh.generateKeys();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const ikm = deriveInputKeyingMaterial({ ecdhSecret, uaPublic, asPublic, authSecret });
  const salt = options.salt ?? crypto.randomBytes(16);
  const { cek, nonce } = deriveContentKeyAndNonce(salt, ikm);

  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const record = encryptRecord(plaintext, cek, nonce, true);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
  return { body: Buffer.concat([header, record]), salt, asPublic };
}

/**
 * 推送端点是否可接受。
 *
 * 推送服务都是 https；但本机自建的推送中继（relay）常在回环地址上跑 http，
 * 这类端点也放行——明文只留在本机，不出网。
 *
 * @param {string} endpoint 端点地址。
 * @returns {boolean} 是否可接受。
 */
export function isAllowedPushEndpoint(endpoint) {
  const url = String(endpoint ?? '').trim();
  if (/^https:\/\//i.test(url)) return true;
  if (!/^http:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * 往一个订阅端点发一条推送。
 *
 * @param {object} subscription 订阅信息。
 * @param {object} payload 通知载荷（会被 JSON 化）。
 * @param {object} options
 * @param {string} options.privateKey VAPID 私钥（base64url PKCS#8）。
 * @param {string} options.publicKey VAPID 公钥（base64url）。
 * @param {string} options.subject VAPID 联系地址。
 * @param {number} [options.timeoutMs] 超时。
 * @returns {Promise<{ok: boolean, status?: number, error?: string, ms: number}>}
 */
/**
 * 出站代理（可选）。
 *
 * 推送服务（FCM / WNS / Mozilla）都在公网。宿主机只能经代理出网时，直连
 * 只会得到 `fetch failed` —— 一个什么都没说的错误。这里给 `fetch` 挂上
 * undici 的 `ProxyAgent`；`undici` 拿不到或代理地址无效时退回直连，
 * 让行为保持和以前一样（宁可直连失败，也不要因为代理配置问题把推送卡死）。
 *
 * 代理按 URL 缓存：每次推送都新建 Agent 会漏连接、漏 socket。
 */
const proxyRoutes = new Map();

/**
 * 取（并缓存）某个代理地址对应的 fetch 与 dispatcher。
 *
 * @param {string} proxyUrl 代理地址，例如 `http://127.0.0.1:7890`。
 * @returns {Promise<{fetch: Function, dispatcher: any}|null>} 不可用时为 null。
 */
export async function resolveProxy(proxyUrl) {
  const key = typeof proxyUrl === 'string' ? proxyUrl.trim() : '';
  if (key === '') return null;
  if (proxyRoutes.has(key)) return proxyRoutes.get(key);
  const pending = (async () => {
    try {
      const undici = await import('undici');
      if (typeof undici.ProxyAgent !== 'function' || typeof undici.fetch !== 'function') return null;
      return { fetch: undici.fetch, dispatcher: new undici.ProxyAgent(key) };
    } catch {
      return null;
    }
  })();
  proxyRoutes.set(key, pending);
  return pending;
}

/** 清掉代理缓存（配置改了之后用）。 */
export function resetProxyCache() {
  proxyRoutes.clear();
}

export async function sendPush(subscription, payload, options = {}) {
  const started = Date.now();
  const endpoint = String(subscription?.endpoint ?? '');
  if (!isAllowedPushEndpoint(endpoint)) {
    return { ok: false, error: `推送端点无效：${endpoint || '(空)'}`, ms: Date.now() - started };
  }
  let body;
  let auth;
  try {
    body = encryptPayload(subscription, JSON.stringify(payload));
    const audience = new URL(endpoint).origin;
    auth = buildVapidAuth({
      privateKey: importPrivateKey(options.privateKey),
      publicKey: options.publicKey,
      subject: options.subject,
      audience,
      ttl: options.ttl ?? 86400,
    });
  } catch (error) {
    return { ok: false, error: `构造推送失败：${error?.message ?? error}`, ms: Date.now() - started };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  const route = options.proxy ? await resolveProxy(options.proxy) : null;
  const request = route?.fetch ?? fetch;
  try {
    const response = await request(endpoint, {
      method: 'POST',
      headers: {
        Authorization: auth.authorization,
        TTL: String(auth.ttl),
        Urgency: 'normal',
        'Content-Encoding': CONTENT_ENCODING,
        'Content-Type': 'application/octet-stream',
      },
      body: body.body,
      signal: controller.signal,
      ...(route ? { dispatcher: route.dispatcher } : {}),
    });
    const text = await response.text().catch(() => '');
    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      ...(response.ok ? {} : { error: `HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}` }),
    };
  } catch (error) {
    let message = error?.message ?? String(error);
    // `fetch failed` 本身没有任何信息量：把真正的底层原因（DNS / 连接被拒 /
    // TLS）带出来，同时提示「要不要配代理」。
    const cause = error?.cause;
    const detail = cause?.message ?? cause?.code ?? '';
    if (detail) message = `${message}（${detail}）`;
    if (/fetch failed/i.test(message) && !options.proxy) {
      message += '：宿主直连推送服务不通？如果本机只能经代理出网，请在「Web Push → 推送代理」里填上代理地址';
    }
    return {
      ok: false,
      error: message,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
