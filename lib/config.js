/**
 * 插件配置 schema 与规范化。
 *
 * 端点用数组存（顺序稳定、设置页可行内编辑），每个端点自描述：
 * 地址、方法、请求头、请求体模板、订阅哪类事件，都能单独设。
 *
 * 规范化函数是所有入口（Loader 配置、设置页保存、订阅接口）的唯一收敛点：
 * 它负责类型清洗、范围夹取与资源上限，避免坏配置一路传到 fetch / 模板渲染。
 */
import Schema from '@deepseek-ai/schemastery';
import { isAllowedPushEndpoint } from './push.js';

/** 订阅的事件类型；`all` 表示全收。 */
export const KINDS = ['attention', 'done', 'error', 'notice'];

/** 资源上限：防止一份坏配置把宿主内存/请求体撑爆。 */
export const LIMITS = Object.freeze({
  endpoints: 50,
  headersBytes: 16 * 1024,
  bodyChars: 64 * 1024,
  nameChars: 200,
  urlChars: 4096,
  templateChars: 4096,
  subscriptions: 20,
});

/** 允许的 HTTP 方法。只放行这几种，避免任意方法名进入 fetch。 */
export const METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'GET', 'HEAD', 'DELETE']);

/** 默认 VAPID 联系地址。 */
export const DEFAULT_PUSH_SUBJECT = 'mailto:dsh-webhook-notify@localhost';

export const EndpointSchema = Schema.object({
  id: Schema.string().default(''),
  name: Schema.string().default('').description('备注名，只用于日志与设置页显示'),
  enabled: Schema.boolean().default(true).description('关闭后不再向此端点投递'),
  url: Schema.string().default('').description('目标地址，可含 {{title}} 等模板变量'),
  method: Schema.string().default('POST').description('HTTP 方法，默认 POST'),
  headers: Schema.any().default({}).description('请求头：对象，或每行一条 Key: Value 的文本'),
  bodyMode: Schema.union(['json', 'text', 'none']).default('json')
    .description('json=插件通用 JSON 载荷；text=只有正文；none=不带请求体'),
  body: Schema.string().default('').description('自定义请求体模板，留空则用 bodyMode 生成的默认载荷'),
  retries: Schema.natural().default(0).description('失败重试次数（4xx 不重试）'),
  timeoutMs: Schema.natural().default(0).description('单次请求超时（毫秒），0=使用插件默认超时'),
  kinds: Schema.array(Schema.string()).default([])
    .description('订阅的事件类型；留空=全部（attention 需要你 / done 回复完成 / error 出错 / notice 其它）'),
});

export const Config = Schema.object({
  endpoints: Schema.array(EndpointSchema).default([]).description('推送端点列表'),
  notifyAttention: Schema.boolean().default(true).description('任务需要你操作时推送'),
  notifyDone: Schema.boolean().default(true).description('回复完成时推送'),
  notifyError: Schema.boolean().default(true).description('本轮出错时推送'),
  minIntervalMs: Schema.natural().default(0).description('同一会话两次推送的最小间隔（毫秒），0=不限制'),
  timeoutMs: Schema.natural().default(10000).description('默认单次请求超时（毫秒）'),
  textTemplate: Schema.string().default('').description('正文模板，留空则用内置排版；可用 {{title}} {{body}} {{session}} {{tool}} {{time}}'),
  logDeliveries: Schema.boolean().default(true).description('把每次投递结果写进日志'),
  debug: Schema.boolean().default(false).description('输出调试日志'),
  // ── 浏览器通知（参考 dsh-notify-me）──
  browserNotify: Schema.boolean().default(true).description('弹浏览器/系统通知'),
  browserAttention: Schema.boolean().default(true).description('「需要你操作」弹浏览器通知'),
  browserDone: Schema.boolean().default(true).description('「回复完成」弹浏览器通知'),
  browserError: Schema.boolean().default(true).description('「本轮出错」弹浏览器通知'),
  browserCurrentQuiet: Schema.boolean().default(true).description('当前对话的等待不弹通知'),
  browserDoneHiddenOnly: Schema.boolean().default(true).description('「回复完成」只在页面隐藏时弹'),
  browserIgnoreSubagent: Schema.boolean().default(true).description('子代理会话不弹浏览器通知'),
  browserAutoFocus: Schema.boolean().default(true).description('点击通知把窗口带到前台并切到对应会话'),
  // ── PWA（可安装）──
  pwaEnabled: Schema.boolean().default(true).description('下发 PWA manifest（可安装为应用）'),
  pwaOffline: Schema.boolean().default(true).description('Service Worker 缓存应用外壳，断网时仍能打开'),
  pwaName: Schema.string().default('').description('覆盖应用名，留空沿用宿主 manifest 的名字'),
  pwaShortName: Schema.string().default('').description('覆盖应用短名'),
  pwaBackgroundColor: Schema.string().default('').description('覆盖启动背景色（留空沿用宿主）'),
  // ── Web Push（页面全关也能收到提醒）──
  pushEnabled: Schema.boolean().default(false).description('宿主向浏览器推送通知（需要页面授权并订阅）'),
  pushSubject: Schema.string().default(DEFAULT_PUSH_SUBJECT)
    .description('VAPID 联系地址，必须是 mailto: 或 https: 开头'),
  pushProxy: Schema.string().default('')
    .description('推送出站代理，例如 http://127.0.0.1:7890；留空=直连（宿主只能经代理出网时必填）'),
  pushVapidPublicKey: Schema.string().default('').description('VAPID 公钥（自动生成，勿手改）'),
  pushVapidPrivateKey: Schema.string().default('').description('VAPID 私钥（自动生成，勿手改）'),
  pushSubscriptions: Schema.any().default([]).description('浏览器推送订阅列表（自动维护，勿手改）'),
});

/** 生成一个端点 id。 */
export function newEndpointId() {
  return `ep${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 把一条端点配置补齐默认值并清洗类型。 */
export function normalizeEndpoint(raw, index = 0) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const url = typeof item.url === 'string' ? item.url.trim().slice(0, LIMITS.urlChars) : '';
  const method = typeof item.method === 'string' ? item.method.trim().toUpperCase() : '';
  return {
    id: typeof item.id === 'string' && item.id !== '' ? item.id.slice(0, 120) : newEndpointId(),
    name: typeof item.name === 'string' ? item.name.slice(0, LIMITS.nameChars) : '',
    enabled: item.enabled !== false,
    url,
    method: METHODS.includes(method) ? method : 'POST',
    headers: sanitizeHeaders(item.headers),
    bodyMode: item.bodyMode === 'text' || item.bodyMode === 'none' ? item.bodyMode : 'json',
    body: typeof item.body === 'string' ? item.body.slice(0, LIMITS.bodyChars) : '',
    retries: clampInt(item.retries, 0, 5, 0),
    // 0（或没填）= 不覆盖插件级 timeoutMs，交给投递层取默认值。
    timeoutMs: clampInt(item.timeoutMs, 0, 120000, 0),
    kinds: normalizeKinds(item.kinds),
  };
}

/** 请求头只接受对象或行文本；超出体积上限的整份丢弃，避免写爆 profile。 */
export function sanitizeHeaders(raw) {
  if (raw === undefined || raw === null) return {};
  let value = raw;
  if (Array.isArray(raw)) value = raw.join('\n');
  if (typeof value !== 'string' && (typeof value !== 'object' || value === null)) return {};
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMITS.headersBytes) return {};
  } catch {
    return {};
  }
  return value;
}

/** 事件订阅只保留已知类型、去重、稳定顺序。 */
export function normalizeKinds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const kind of raw) {
    if (typeof kind !== 'string') continue;
    const normalized = kind.trim().toLowerCase();
    if (!KINDS.includes(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** 规范化整份配置（数组逐项清洗，顺序保留）。 */
export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const endpoints = Array.isArray(config.endpoints)
    ? config.endpoints.slice(0, LIMITS.endpoints).map(normalizeEndpoint)
    : [];
  const subject = typeof config.pushSubject === 'string' ? config.pushSubject.trim() : '';
  return {
    endpoints,
    notifyAttention: config.notifyAttention !== false,
    notifyDone: config.notifyDone !== false,
    notifyError: config.notifyError !== false,
    minIntervalMs: clampInt(config.minIntervalMs, 0, 3_600_000, 0),
    timeoutMs: clampInt(config.timeoutMs, 1000, 120000, 10000),
    textTemplate: typeof config.textTemplate === 'string'
      ? config.textTemplate.slice(0, LIMITS.templateChars)
      : '',
    logDeliveries: config.logDeliveries !== false,
    debug: config.debug === true,
    browserNotify: config.browserNotify !== false,
    browserAttention: config.browserAttention !== false,
    browserDone: config.browserDone !== false,
    browserError: config.browserError !== false,
    browserCurrentQuiet: config.browserCurrentQuiet !== false,
    browserDoneHiddenOnly: config.browserDoneHiddenOnly !== false,
    browserIgnoreSubagent: config.browserIgnoreSubagent !== false,
    browserAutoFocus: config.browserAutoFocus !== false,
    pwaEnabled: config.pwaEnabled !== false,
    pwaOffline: config.pwaOffline !== false,
    pwaName: typeof config.pwaName === 'string' ? config.pwaName.slice(0, 120) : '',
    pwaShortName: typeof config.pwaShortName === 'string' ? config.pwaShortName.slice(0, 60) : '',
    pwaBackgroundColor: normalizeColor(config.pwaBackgroundColor),
    pushEnabled: config.pushEnabled === true,
    // 非法联系地址会让每次推送都失败，这里收敛成默认值，别把错误留到运行时。
    pushSubject: /^(mailto:|https:)/i.test(subject) ? subject.slice(0, 512) : DEFAULT_PUSH_SUBJECT,
    pushProxy: normalizeProxy(config.pushProxy),
    pushVapidPublicKey: typeof config.pushVapidPublicKey === 'string' ? config.pushVapidPublicKey : '',
    pushVapidPrivateKey: typeof config.pushVapidPrivateKey === 'string' ? config.pushVapidPrivateKey : '',
    pushSubscriptions: normalizeSubscriptions(config.pushSubscriptions),
  };
}

/**
 * 设置页可写的字段白名单。
 *
 * 设置页永远拿不到 VAPID 私钥与推送订阅，保存时也不该有机会覆盖它们；
 * 这个白名单是宿主侧的最后一道门（不依赖客户端自觉）。
 */
export const SAVE_FIELDS = Object.freeze([
  'endpoints',
  'notifyAttention',
  'notifyDone',
  'notifyError',
  'minIntervalMs',
  'timeoutMs',
  'textTemplate',
  'logDeliveries',
  'debug',
  'browserNotify',
  'browserAttention',
  'browserDone',
  'browserError',
  'browserCurrentQuiet',
  'browserDoneHiddenOnly',
  'browserIgnoreSubagent',
  'browserAutoFocus',
  'pwaEnabled',
  'pwaOffline',
  'pwaName',
  'pwaShortName',
  'pwaBackgroundColor',
  'pushEnabled',
  'pushSubject',
  'pushProxy',
]);

/** 从请求体里挑出允许保存的字段。 */
export function pickSaveFields(raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of SAVE_FIELDS) {
    if (Object.hasOwn(body, key)) out[key] = body[key];
  }
  return out;
}

/**
 * 清洗推送订阅列表：只保留端点与密钥，坏数据直接丢掉。
 *
 * @param {any} raw 原始值。
 * @returns {Array<object>} 规范化后的订阅。
 */
export function normalizeSubscriptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= LIMITS.subscriptions) break;
    if (!item || typeof item !== 'object') continue;
    const endpoint = typeof item.endpoint === 'string' ? item.endpoint.trim() : '';
    if (!isAllowedPushEndpoint(endpoint) || seen.has(endpoint)) continue;
    const keys = item.keys && typeof item.keys === 'object' ? item.keys : {};
    const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
    const auth = typeof keys.auth === 'string' ? keys.auth : '';
    if (p256dh === '' || auth === '') continue;
    seen.add(endpoint);
    out.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : newEndpointId(),
      endpoint,
      keys: { p256dh, auth },
      ua: typeof item.ua === 'string' ? item.ua.slice(0, 300) : '',
      createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
    });
  }
  return out;
}

/** 主题色只接受 #rgb / #rrggbb / #rrggbbaa，避免把任意字符串写进 manifest。 */
export function normalizeColor(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text === '') return '';
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ? text.toLowerCase() : '';
}

/** 代理地址只接受 http(s)，否则留空（直连）。 */
export function normalizeProxy(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text === '') return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}
