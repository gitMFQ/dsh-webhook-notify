/**
 * 端点投递 —— 真正把请求发出去的地方。
 *
 * 全部运行在宿主（Node）进程里，因此：
 * - 没有浏览器的 CORS 限制，跨域端点可直连；
 * - 请求头、请求方法、请求体完全自定义（`Authorization: Bearer …` 想加就加）；
 * - 超时、重试、并发都在这里统一处理。
 */
import { buildVars, composeText, render, renderDeep } from './template.js';

/** 一次投递的默认超时（毫秒）。 */
const DEFAULT_TIMEOUT = 10_000;

/**
 * 解析端点配置里的 headers：
 * 允许写成对象，也允许写成 `Key: Value` 的行文本（设置页更好填）。
 */
export function parseHeaders(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  if (Array.isArray(raw)) {
    const out = {};
    for (const line of raw) Object.assign(out, parseHeaders(String(line)));
    return out;
  }
  const out = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    const at = text.indexOf(':');
    if (at <= 0) continue;
    out[text.slice(0, at).trim()] = text.slice(at + 1).trim();
  }
  return out;
}

/**
 * 组装一条通知事件：把原始事件补上 `text` 等派生字段。
 *
 * @param raw 触发源给的原始字段（kind/title/body/sessionId/…）。
 * @param config 插件配置（用于取正文模板与时区）。
 */
export function makeEvent(raw, config = {}) {
  const event = {
    kind: raw.kind ?? 'notice',
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    sessionId: raw.sessionId ?? null,
    sessionLabel: raw.sessionLabel ?? '',
    toolName: raw.toolName ?? '',
    reason: raw.reason ?? '',
    snippet: raw.snippet ?? '',
    time: raw.time ?? new Date().toISOString(),
  };
  event.text = composeText(event, config.textTemplate);
  return event;
}

/**
 * 用端点配置 + 事件造出最终请求。
 *
 * 端点字段：
 *   url      必填，可含模板变量
 *   method   默认 POST
 *   headers  对象或行文本，可含模板变量
 *   body     请求体模板；为空时按 `bodyMode` 生成默认 JSON
 *   bodyMode 'json'(默认，插件通用载荷) | 'text'(纯文本，只有正文) | 'none'
 */
export function buildRequest(endpoint, event) {
  const vars = buildVars(event);
  const method = String(endpoint.method || 'POST').toUpperCase();
  const url = render(String(endpoint.url ?? ''), vars).trim();
  const headers = parseHeaders(renderDeep(endpoint.headers ?? {}, vars));

  let body;
  const mode = endpoint.bodyMode || 'json';
  if (typeof endpoint.body === 'string' && endpoint.body.trim() !== '') {
    // 用户自己写的模板：以 `{` / `[` 开头就按 JSON 拼装（变量做转义，
    // 正文里的换行不会破坏结构），否则按纯文本原样替换。
    const template = endpoint.body.trim();
    const looksJson = template.startsWith('{') || template.startsWith('[');
    body = render(endpoint.body, vars, { json: looksJson });
    if (looksJson && !hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
  } else if (mode === 'none' || method === 'GET' || method === 'HEAD') {
    body = undefined;
  } else if (mode === 'text') {
    body = event.text;
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'text/plain; charset=utf-8';
  } else {
    // 默认载荷：既照顾通用 webhook（source/event/title/body），
    // 也带一条现成的纯文本 content 给聊天类后端直接用。
    body = JSON.stringify({
      source: 'dsh-webhook-notify',
      event: event.kind,
      title: event.title,
      body: event.body,
      content: event.text,
      text: event.text,
      sessionId: event.sessionId,
      time: event.time,
    });
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  return { method, url, headers, body };
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * 投递到一个端点，永不抛出。
 *
 * @returns {{ok: boolean, status?: number, error?: string, ms: number, body?: string}}
 */
export async function deliver(endpoint, event, options = {}) {
  const started = Date.now();
  let request;
  try {
    request = buildRequest(endpoint, event);
  } catch (error) {
    return { ok: false, error: `构造请求失败：${describe(error)}`, ms: Date.now() - started };
  }
  const target = safeHttpUrl(request.url);
  if (!target) {
    return { ok: false, error: `地址无效：${request.url || '(空)'}`, ms: Date.now() - started };
  }

  // 端点显式配置了超时才覆盖插件默认值；0/空表示「跟随插件设置」。
  const timeout = Number(endpoint.timeoutMs) > 0
    ? Number(endpoint.timeoutMs)
    : (Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT);
  const attempts = Math.max(1, Math.min(5, Number(endpoint.retries ?? options.retries ?? 0) + 1));
  let last = { ok: false, error: '未执行', ms: 0 };

  // HTTP 头只能是单字节字符：带中文的请求头会被底层直接拒绝。
  // 提前给出可读原因，而不是让它变成一条含糊的 fetch 异常。
  const badHeader = findInvalidHeader(request.headers);
  if (badHeader) {
    return {
      ok: false,
      error: `请求头 ${badHeader} 含非 ASCII 字符（HTTP 头只能是单字节），请改用英文/数字，或把中文放进请求体`,
      ms: Date.now() - started,
    };
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const began = Date.now();
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
        // 不自动跟随：重定向到内网/非 http(s) 目标会把「往哪发」的决定
        // 交给对端。3xx 当作失败上报，让用户自己修正端点地址。
        redirect: 'manual',
      });
      const text = await readCappedText(response);
      const redirected = response.status >= 300 && response.status < 400;
      last = {
        ok: response.ok,
        status: response.status,
        ms: Date.now() - began,
        body: text.slice(0, 500),
        ...(response.ok
          ? {}
          : {
            error: redirected
              ? `HTTP ${response.status}：端点返回重定向（${response.headers?.get?.('location') ?? '无 location'}），请直接填最终地址`
              : `HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`,
          }),
      };
    } catch (error) {
      last = {
        ok: false,
        error: controller.signal.aborted ? `超时（${timeout}ms）` : describe(error),
        ms: Date.now() - began,
      };
    } finally {
      clearTimeout(timer);
    }
    if (last.ok) return last;
    // 4xx 是确定性错误，重试只会重复失败——但 408 / 429 是「现在不行」，
    // 不是「请求错了」，重试正是它们期望的处理方式。
    if (isDeterministicFailure(last.status)) return last;
    if (attempt < attempts) await sleep(retryDelay(last, attempt));
  }
  return last;
}

/** 4xx 里仍然值得重试的状态码。 */
const RETRYABLE_4XX = new Set([408, 425, 429]);

/** 这次失败重试有意义吗？ */
function isDeterministicFailure(status) {
  if (status === undefined) return false;
  if (status < 400) return false;
  if (status >= 500) return false;
  return !RETRYABLE_4XX.has(status);
}

/** 退避时间：429 的 Retry-After 优先，否则线性退避。 */
function retryDelay(last, attempt) {
  return 300 * attempt;
}

/**
 * 并发投递到所有启用端点；顺序与输入一致。
 *
 * 两条路径语义不同：
 * - 广播（默认）：`enabled` 且地址非空的端点才发。设置页里刚加、还没填地址
 *   的草稿行要**静默跳过**——否则每条事件都会记一条「地址无效」失败。
 * - 自测（`includeEmptyUrl: true`）：地址为空的端点也交给 {@link deliver}
 *   判定，用户看到的是真实的「地址无效」结果，而不是一条被过滤掉的空结果。
 *
 * @param {Array<object>} endpoints 候选端点。
 * @param {object} event 通知事件。
 * @param {object} [options] 投递选项；`includeEmptyUrl` 只影响本函数的过滤。
 * @returns {Promise<Array<object>>} 每个真正尝试过的端点的结果。
 */
export async function deliverAll(endpoints, event, options = {}) {
  const { includeEmptyUrl = false, ...deliverOptions } = options;
  const targets = (Array.isArray(endpoints) ? endpoints : []).filter(
    (item) => item
      && item.enabled !== false
      && typeof item.url === 'string'
      && (includeEmptyUrl || item.url.trim() !== ''),
  );
  const results = await Promise.all(targets.map((target) => deliver(target, event, deliverOptions)));
  return targets.map((target, index) => ({
    id: target.id ?? '',
    name: target.name ?? target.url,
    ...results[index],
  }));
}

/** 响应体上限：对方回了 50 MB 也不能把宿主内存吃掉。 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** 读响应正文，最多 MAX_RESPONSE_BYTES；失败时返回空串。 */
async function readCappedText(response) {
  try {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      return `[响应体 ${declared} 字节，已忽略]`;
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      const text = await response.text();
      return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(Math.min(size, MAX_RESPONSE_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      if (offset + chunk.byteLength > merged.length) break;
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  } catch {
    return '';
  }
}

/** 只接受 http(s) 的绝对地址（相对地址在宿主里没有意义）。 */
function safeHttpUrl(raw) {
  try {
    const url = new URL(String(raw ?? ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把异常压成一句话，日志里好读。 */
export function describe(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  const cause = error.cause?.code || error.cause?.message;
  return cause ? `${error.message || error.name}（${cause}）` : (error.message || String(error));
}

/**
 * 找出第一个含非 ASCII 字符的请求头名或值。
 *
 * @returns 命中时的头名，全部合法时返回 undefined。
 */
function findInvalidHeader(headers) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!isLatin1(name)) return name;
    if (!isLatin1(String(value))) return name;
  }
  return undefined;
}

/** 是否全部字符都在单字节范围内（HTTP 头的硬限制）。 */
function isLatin1(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 255) return false;
  }
  return true;
}
