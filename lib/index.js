/**
 * dsh-webhook-notify —— 宿主半边。
 *
 * 为什么把推送放在宿主而不是浏览器：
 * - 浏览器里的 `fetch` 受同源策略约束，跨域端点若不放行 CORS 就只能「送出但不可确认」；
 * - 浏览器无法设置 `Authorization` 之外的自定义头（会触发预检，端点不放行就失败）；
 * - 页面关闭、后台休眠时推送就断了。
 * 宿主（Node）里这三点都不存在：任意请求头、任意目标、页面关了照样发。
 *
 * 触发源是 `session/event`：
 * - `turn/end` 且原因为 `completed` → done（回复完成）；
 * - `turn/end` 且原因为 `error` → error；
 * - `approval/asked` → attention（需要你批准）；
 * - `tool/call` 命中 `ask` 类交互时同样归为 attention。
 *
 * @module dsh-webhook-notify
 */
import Schema from '@deepseek-ai/schemastery';
import {
  Config,
  normalizeConfig,
  newEndpointId,
  pickSaveFields,
} from './config.js';
import { deliverAll, describe, makeEvent } from './send.js';
import { buildServiceWorkerSource } from './sw.js';
import {
  CAPTURE_PATH,
  CAPTURE_SOURCE,
  MANIFEST_PATH,
  disablePullToRefresh,
  fetchHostManifest,
  injectInstallCapture,
  localizeManifestUrls,
  mergeManifest,
  queryOf,
  resolveHostManifestSource,
  rewriteManifestLink,
} from './pwa.js';
import { generateVapidKeys, isAllowedPushEndpoint, resetProxyCache, sendPush } from './push.js';
import { buildIcons, fallbackIcon } from './icon.js';

export const name = 'webhook-notify';

/** 插件版本（/state 与设置页显示用；与 package.json 保持一致）。 */
export const PLUGIN_VERSION = '0.4.0';

/**
 * 推送到 Webhook 端点的正文上限（字符数）。
 *
 * 两条通道各有一个上限：
 * - Webhook 端点：21000 字符。长回复（代码、报告）常常几千字，400 字的老上限
 *   会把真正有用的内容砍掉；21000 也仍然是「一条消息」，不会把端点撑爆。
 * - Web Push：见 {@link PUSH_BODY_CHARS}，推送服务对单条载荷有 4 KiB 硬上限。
 *
 * 会话事件里会先按这个上限截一次（`lastText` 只留最近的正文，避免长驻进程
 * 把所有会话的长回复都留在内存里），组装好的正文再截一次，保证最终「文字
 * 数量」不会因为标题/时间等附加行超出去。
 */
export const MAX_TEXT_CHARS = 21000;

/**
 * Web Push 通知正文上限（字符数）。
 *
 * 推送服务（FCM / WNS / Mozilla）单条载荷上限 4 KiB，加密与 JSON 包装还要
 * 占掉一部分；正文按 400 字符截断，纯中文约 1.2 KB，留足余量。
 */
export const PUSH_BODY_CHARS = 400;

/** 只有 agents / sessions 是硬依赖；webServer 缺失时设置页不可用，投递照常。 */
export const inject = [];

export { Config };

/** 设置页/自测路由前缀。 */
export const ROUTE_PREFIX = '/webhook-notify';
export const ROUTES = {
  state: `${ROUTE_PREFIX}/state`,
  save: `${ROUTE_PREFIX}/save`,
  test: `${ROUTE_PREFIX}/test`,
  preview: `${ROUTE_PREFIX}/preview`,
  sw: `${ROUTE_PREFIX}/sw.js`,
  manifest: MANIFEST_PATH,
  capture: CAPTURE_PATH,
  icon192: `${ROUTE_PREFIX}/icon-192.png`,
  icon512: `${ROUTE_PREFIX}/icon-512.png`,
  iconMaskable: `${ROUTE_PREFIX}/icon-maskable-512.png`,
  pushKey: `${ROUTE_PREFIX}/push/key`,
  pushSubscribe: `${ROUTE_PREFIX}/push/subscribe`,
  pushUnsubscribe: `${ROUTE_PREFIX}/push/unsubscribe`,
  pushTest: `${ROUTE_PREFIX}/push/test`,
  pushList: `${ROUTE_PREFIX}/push/list`,
};

/**
 * 插件入口。
 *
 * @param ctx cordis 上下文。
 * @param rawConfig 已由 schema 校验的配置。
 */
export function apply(ctx, rawConfig) {
  const logger = createLogger(ctx, rawConfig?.debug === true);
  let config = normalizeConfig(rawConfig ?? {});

  /** 每个会话最近一次推送时间，用于 minIntervalMs 节流。 */
  const lastSentAt = new Map();
  /**
   * 每个会话最后一条助手正文。
   *
   * 在事件流里顺带累积，而不是 turn/end 时回读会话日志：同步读会话事件
   * 的 API 已被标记废弃（新代码禁用），而这里的累积成本是常数级。
   */
  const lastText = new Map();
  /**
   * 每个会话最近一次回合的结局（`done` / `error`）。
   *
   * 页面侧靠会话列表的 running 边沿判断「刚结束」，但列表行**没有**失败字段
   * （当前 Harness 的 SessionSummary 只有 running 等），于是失败的回合会被
   * 误报成「回复完成」。宿主是唯一知道 turn/end reason 的地方，所以在这里
   * 记一份，由 /state 下发给页面做精确分类。
   */
  const lastOutcome = new Map();
  /** 最近若干次投递结果，设置页展示用。 */
  const recent = [];
  const MAX_RECENT = 50;
  /**
   * 会话级缓存的清理阈值。
   *
   * `lastSentAt` / `lastText` 只服务「当前还活着的会话」；宿主是长驻进程，
   * 不设上限就等于把所有会话的正文永久留在内存里。超过阈值时按插入顺序
   * 丢掉最老的一半（Map 保证顺序），成本常数级。
   */
  const MAX_SESSION_ENTRIES = 200;

  function remember(entry) {
    recent.unshift(entry);
    if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  }

  /** 往会话级 Map 写入并维持上限。 */
  function rememberSession(map, key, value) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    if (map.size <= MAX_SESSION_ENTRIES) return;
    const drop = Math.ceil(map.size / 2);
    let removed = 0;
    for (const oldKey of map.keys()) {
      map.delete(oldKey);
      removed += 1;
      if (removed >= drop) break;
    }
  }

  /**
   * 把一条事件推给所有订阅它的端点。
   *
   * @param raw 原始字段（kind/title/body/sessionId…）。
   * @param options.force 跳过所有开关与节流（自测按钮用）。
   * @param options.only 只投递给指定端点 id（自测按钮用）。
   */
  async function notify(raw, options = {}) {
    const kind = raw.kind ?? 'notice';
    if (!options.force) {
      if (!kindEnabled(kind)) return [];
      if (throttled(raw.sessionId)) {
        logger.debug(`节流：${raw.sessionId} 距上次推送不足 ${config.minIntervalMs}ms`);
        return [];
      }
      if (raw.sessionId) rememberSession(lastSentAt, raw.sessionId, Date.now());
    }

    const event = makeEvent(raw, config);
    // 端点看到的正文（`{{text}}` / `{{content}}` / 默认载荷里的 content）统一
    // 收在这个上限内：标题、工具名、时间等附加行也算在内。
    event.text = truncate(event.text, MAX_TEXT_CHARS);
    const endpoints = config.endpoints.filter((endpoint) => {
      // 自测指定端点时，即便它被停用也要能测通——否则用户拿不到任何反馈。
      if (options.only) return endpoint.id === options.only;
      if (!endpoint.enabled) return false;
      if (endpoint.kinds.length === 0) return true;
      return endpoint.kinds.includes(kind);
    });
    if (endpoints.length === 0) return [];

    // 自测的目标端点强制当成「启用」：停用只表示平时不广播，手动测通正是
    // 它的用途。不这么做的话，deliverAll 会按 enabled 再过滤一次，停用端点
    // 得到空结果，设置页就会误报成「找不到该端点」。
    const targets = options.only
      ? endpoints.map((endpoint) => ({ ...endpoint, enabled: true }))
      : endpoints;

    const results = await deliverAll(targets, event, {
      timeoutMs: config.timeoutMs,
      // 只有自测才让空地址通过：广播路径里「刚加、还没填地址」的草稿行要
      // 静默跳过（否则每条事件都在最近投递里记一条「地址无效」）；自测要给
      // 用户真实原因，所以让它走一遍 deliver() 拿到「地址无效」。
      includeEmptyUrl: Boolean(options.only),
    });
    for (const result of results) {
      const line = `${result.name || result.id}: ${result.ok ? `OK ${result.status}` : `失败 ${result.error}`} (${result.ms}ms)`;
      if (config.logDeliveries) {
        if (result.ok) logger.info(`[${kind}] ${line}`);
        else logger.warn(`[${kind}] ${line}`);
      }
      remember({ kind, time: event.time, at: Date.now(), ...result });
    }
    return results;
  }

  /** 事件类型开关是否放行。 */
  function kindEnabled(kind) {
    if (kind === 'attention') return config.notifyAttention !== false;
    if (kind === 'done') return config.notifyDone !== false;
    if (kind === 'error') return config.notifyError !== false;
    return true;
  }

  /** 同一会话是否还在节流窗口内（0 = 不限制）。 */
  function throttled(sessionId) {
    if (!sessionId || config.minIntervalMs <= 0) return false;
    const last = lastSentAt.get(sessionId) ?? 0;
    return Date.now() - last < config.minIntervalMs;
  }

  /**
   * 分发一条会话事件：开关与节流只判定一次，两条通道各自独立失败。
   *
   * `void promise` 不会挂 catch：任何一层抛出都会变成未处理拒绝，在 Node 里
   * 直接终结宿主进程。这里统一兜住并降级成一条日志。
   */
  function dispatch(raw) {
    const kind = raw.kind ?? 'notice';
    if (!kindEnabled(kind)) return;
    if (throttled(raw.sessionId)) {
      logger.debug(`节流：${raw.sessionId} 距上次推送不足 ${config.minIntervalMs}ms`);
      return;
    }
    if (raw.sessionId) rememberSession(lastSentAt, raw.sessionId, Date.now());
    void notify(raw, { force: true }).catch((error) => {
      logger.warn(`Webhook 投递失败：${describe(error)}`);
    });
    void notifyPush(raw).catch((error) => {
      logger.warn(`Web Push 投递失败：${describe(error)}`);
    });
  }

  // ── 触发源：会话事件 ────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          handleSessionEvent(session, event);
        } catch (error) {
          logger.warn(`处理会话事件失败：${describe(error)}`);
        }
      }),
    'webhook-notify.session-events',
  );

  /**
   * 把一条事件推给浏览器（Web Push）。
   *
   * 与 Webhook 是两条独立通道：这里走推送服务，页面全关也能收到。
   * 事件类型开关与 Webhook 共用（同一批事件，两边独立开关）。
   */
  async function notifyPush(raw) {
    if (config.pushEnabled !== true) return [];
    const kind = raw.kind ?? 'notice';
    if (!kindEnabled(kind)) return [];
    const list = Array.isArray(config.pushSubscriptions) ? config.pushSubscriptions : [];
    if (list.length === 0) return [];
    const keys = await ensureVapidKeys();
    const payload = {
      title: raw.title ?? '',
      // 推送服务的载荷硬上限是 4 KiB，正文不能跟着 Webhook 的 21000 字符走。
      body: truncate(String(raw.body ?? ''), PUSH_BODY_CHARS),
      kind,
      sessionId: raw.sessionId ?? null,
      sessionLabel: raw.sessionLabel ?? '',
      time: raw.time ?? new Date().toISOString(),
      tag: `dsh-webhook-notify-${kind}:${raw.sessionId ?? 'global'}`,
    };
    const results = await pushToSubscriptions(list, payload, keys);
    for (const result of results) {
      const line = `${result.host}: ${result.ok ? `OK ${result.status}` : `失败 ${result.error}`} (${result.ms}ms)`;
      if (config.logDeliveries) {
        if (result.ok) logger.info(`[push:${kind}] ${line}`);
        else logger.warn(`[push:${kind}] ${line}`);
      }
    }
    return results;
  }

  function handleSessionEvent(session, event) {
    if (!event || typeof event.type !== 'string') return;
    const sessionId = session?.header?.id ?? session?.id ?? null;
    const sessionLabel = readSessionLabel(session);

    if (event.type === 'assistant/message') {
      const text = assistantTextOf(event);
      if (text && sessionId) rememberSession(lastText, sessionId, text);
      return;
    }

    if (event.type === 'turn/start' && sessionId) {
      lastText.delete(sessionId);
      lastOutcome.delete(sessionId);
      return;
    }

    if (event.type === 'turn/end') {
      const reason = event.data?.reason ?? {};
      if (sessionId) {
        rememberSession(lastOutcome, sessionId, {
          kind: reason.kind === 'error' ? 'error' : reason.kind === 'completed' ? 'done' : 'other',
          at: Date.now(),
        });
      }
      if (reason.kind === 'error') {
        const failure = reason.error ?? {};
        dispatch({
          kind: 'error',
          title: 'DSH · 本轮出错',
          body: [failure.code, failure.message].filter(Boolean).join('：') || '未知错误',
          sessionId,
          sessionLabel,
        });
        return;
      }
      if (reason.kind === 'completed') {
        dispatch({
          kind: 'done',
          title: 'DSH · 回复完成',
          body: (sessionId && lastText.get(sessionId)) || '本轮已结束',
          sessionId,
          sessionLabel,
        });
      }
      return;
    }

    if (event.type === 'approval/asked') {
      const data = event.data ?? {};
      dispatch({
        kind: 'attention',
        title: 'DSH · 需要你操作',
        body: data.reason || `工具 ${data.toolName ?? '?'} 请求批准`,
        sessionId,
        sessionLabel,
        toolName: data.toolName ?? '',
        reason: data.reason ?? '',
      });
    }
  }

  // ── 设置页与自测路由 ────────────────────────────────────────────
  ctx.inject(['webServer'], (webCtx) => {
    const disposers = [
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.state, handler: (req, res) => handleState(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.save, handler: (req, res) => handleSave(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.test, handler: (req, res) => handleTest(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.preview, handler: (req, res) => handlePreview(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.sw, handler: (req, res) => handleServiceWorker(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.manifest, handler: (req, res) => handleManifest(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.capture, handler: (req, res) => handleCapture(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.icon192, handler: (req, res) => handleIcon(req, res, 'any192') }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.icon512, handler: (req, res) => handleIcon(req, res, 'any512') }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.iconMaskable, handler: (req, res) => handleIcon(req, res, 'maskable512') }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.pushKey, handler: (req, res) => handlePushKey(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.pushSubscribe, handler: (req, res) => handlePushSubscribe(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.pushUnsubscribe, handler: (req, res) => handlePushUnsubscribe(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.pushTest, handler: (req, res) => handlePushTest(req, res) }),
      webCtx.webServer.register({ kind: 'exact', path: ROUTES.pushList, handler: (req, res) => handlePushList(req, res) }),
    ];
    // PWA manifest：把 index.html 里的 <link rel="manifest"> 指向插件路由，
    // 由插件在宿主原 manifest 基础上合并出可安装的版本。
    // 老版本宿主没有 tapIndex，客户端半边还有一份兜底（见 lib/client.js）。
    try {
      const dispose = webCtx.webServer.tapIndex((html) => {
        try {
          if (config.pwaEnabled === false) return html;
          // 依次：早期捕获脚本（必须在 `<head>` 最前面，赶在浏览器派发
          // beforeinstallprompt 之前）→ manifest 链接 → 禁止下滑刷新。
          // 状态栏 / 导航栏 / 窗口显示模式归宿主所有，这里一概不碰。
          return disablePullToRefresh(injectInstallCapture(rewriteManifestLink(html)));
        } catch (error) {
          logger.warn(`改写 index.html 失败：${describe(error)}`);
          return html;
        }
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      logger.warn(`宿主不支持 tapIndex，manifest 改写交给客户端兜底：${describe(error)}`);
    }
    webCtx.effect(
      () => () => {
        for (const dispose of disposers.reverse()) dispose();
      },
      'webhook-notify.routes',
    );
  });

  async function handleState(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    // 图标是从宿主 logo 栅格化出来的，还是退回内置铃铛——设置页要能看见，
    // 否则「装出来的图标不对」只能靠猜。只读已有缓存：设置页会轮询这个接口，
    // 不该在这里触发几百毫秒的栅格化。
    const iconSource = iconCache?.source ?? null;
    sendJson(res, 200, {
      config: publicConfig(),
      recent: recent.slice(0, 20),
      version: PLUGIN_VERSION,
      pwa: { iconSource },
      // 页面用它把「刚结束」精确分类成 error / done（会话列表行没有失败字段）。
      outcomes: recentOutcomes(),
    });
  }

  /** 最近的回合结局（最多 20 条，按时间倒序）。 */
  function recentOutcomes() {
    const out = [];
    for (const [sessionId, value] of lastOutcome) {
      if (!value || typeof value !== 'object') continue;
      out.push({ sessionId, kind: value.kind, at: value.at });
    }
    out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return out.slice(0, 20);
  }

  async function handleSave(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = await readJsonBody(req, 256 * 1024);
    } catch (error) {
      return sendJson(res, 400, { error: describe(error) });
    }
    // 只接受白名单字段：设置页拿不到 VAPID 私钥与推送订阅，也就不该能覆盖它们。
    const fields = pickSaveFields(body);
    // 新端点没有 id 的补一个，保证设置页行 key 稳定。
    if (Array.isArray(fields.endpoints)) {
      fields.endpoints = fields.endpoints.map((endpoint) => ({
        ...(endpoint && typeof endpoint === 'object' ? endpoint : {}),
        id: endpoint?.id || newEndpointId(),
      }));
    }
    const saved = await persist(fields);
    if (!saved.ok) return sendJson(res, 200, { ok: false, error: saved.error, config: publicConfig() });
    // 代理地址可能变了：缓存的 ProxyAgent 跟着作废。
    resetProxyCache();
    // manifest 的合并结果也依赖这些字段（名字、背景色、图标来源）。
    invalidateManifestCache();
    logger.info(`配置已保存：${config.endpoints.length} 个端点`);
    return sendJson(res, 200, { ok: true, config: publicConfig() });
  }

  async function handleTest(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = await readJsonBody(req, 64 * 1024);
    } catch (error) {
      return sendJson(res, 400, { error: describe(error) });
    }
    const only = typeof body?.endpointId === 'string' && body.endpointId !== '' ? body.endpointId : undefined;
    const results = await notify(
      {
        kind: 'notice',
        title: 'DSH · 测试通知',
        body: `这是一条来自 dsh-webhook-notify 的测试消息（${new Date().toLocaleString('zh-CN')}）`,
        sessionId: null,
        sessionLabel: '',
      },
      { force: true, ...(only ? { only } : {}) },
    );
    if (results.length === 0) {
      return sendJson(res, 200, {
        ok: false,
        error: only ? '找不到该端点' : '还没有启用的端点',
        results,
      });
    }
    sendJson(res, 200, { ok: results.every((item) => item.ok), results });
  }

  /**
   * 下发浏览器通知用的 Service Worker 脚本。
   *
   * 同源、且显式标注 text/javascript：Service Worker 注册要求同源脚本，
   * 而这里刻意不走 /plugins/… 的组合脚本通道（那条通道会把多个插件拼成
   * 一段脚本，当 worker 注册会把别人的工厂也执行掉）。
   */
  async function handleServiceWorker(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    const source = buildServiceWorkerSource({ offline: config.pwaOffline !== false });
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      // 内容随版本变；worker 更新由浏览器的字节对比负责，这里允许短缓存即可。
      'cache-control': 'no-cache',
      'service-worker-allowed': '/',
    });
    res.end(req.method === 'HEAD' ? undefined : source);
  }

  /**
   * 下发早期捕获 `beforeinstallprompt` 的脚本。
   *
   * 脚本极小、必须尽早执行：宿主把它作为 `<head>` 里第一个 `<script>` 注入
   * （见 tapIndex），这里只负责把源码发出去。缓存放短一点，升级插件后下一次
   * 页面加载就能拿到新版本。
   */
  async function handleCapture(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    });
    res.end(req.method === 'HEAD' ? undefined : CAPTURE_SOURCE);
  }

  // ── PWA manifest ───────────────────────────────────────────────
  /**
   * manifest 合并结果的短期缓存（避免每次加载都回源抓宿主 manifest）。
   *
   * 缓存键必须包含影响输出的配置：只按 src 缓存时，改完应用名 / 背景色
   * 最长要等一分钟才生效，看起来像「保存没生效」。
   */
  const manifestCache = new Map();
  const MANIFEST_TTL = 60_000;
  const MANIFEST_CACHE_MAX = 8;

  /** 让 manifest 缓存失效（配置保存后调用）。 */
  function invalidateManifestCache() {
    manifestCache.clear();
  }

  /**
   * 图标缓存：宿主 SVG 栅格化出来的 PNG。
   *
   * 栅格化要几百毫秒，所以只做一次并缓存在内存里；宿主换 logo 后重启宿主
   * 即可（缓存不落盘，免得留下过期副本）。
   */
  let iconCache = null;
  let iconPromise = null;
  /** 兜底图标缓存的时间戳：兜底结果只留一会儿，等宿主起来后自动换成真 logo。 */
  let iconFallbackAt = 0;
  const FALLBACK_TTL = 60_000;
  /** VAPID 密钥生成的并发闸门（见 ensureVapidKeys）。 */
  let vapidPromise = null;
  /** 配置写回队列（见 persist）。 */
  let writeQueue = Promise.resolve();

  /**
   * 取（必要时生成）三张图标。
   *
   * @param {string} origin 站点 origin，用来抓宿主 logo。
   * @returns {Promise<{any192: Buffer, any512: Buffer, maskable512: Buffer, source: string}>}
   */
  async function loadIcons(origin) {
    // 兜底铃铛不长期缓存：宿主刚启动时 webServer 可能还没开始监听，这时抓
    // favicon 会 ECONNREFUSED，若把兜底图钉死在缓存里，之后装出来的应用图标
    // 就一直是铃铛。兜底只留一分钟，之后重新尝试真 logo。
    if (iconCache && (iconCache.source !== 'fallback' || Date.now() - iconFallbackAt < FALLBACK_TTL)) {
      return iconCache;
    }
    if (!iconPromise) {
      iconPromise = (async () => {
        let icons = null;
        try {
          const response = await fetch(`${origin}/favicon.svg`, { cache: 'no-cache' });
          if (!response.ok) {
            logger.warn(`抓取宿主 logo 失败（HTTP ${response.status}），先用内置图标`);
          }
          if (response.ok) {
            const svg = await response.text();
            const built = buildIcons(svg);
            icons = {
              any192: built.small,
              any512: built.any,
              maskable512: built.maskable,
              source: built.source,
            };
          }
        } catch (error) {
          logger.warn(`抓取宿主 logo 失败，改用内置图标：${describe(error)}`);
        }
        if (!icons) {
          icons = {
            any192: fallbackIcon(192),
            any512: fallbackIcon(512),
            maskable512: fallbackIcon(512, true),
            source: 'fallback',
          };
        }
        iconCache = icons;
        iconFallbackAt = icons.source === 'fallback' ? Date.now() : 0;
        if (icons.source === 'fallback') iconPromise = null;
        return icons;
      })();
    }
    return iconPromise;
  }

  /**
   * 下发一张图标。
   *
   * @param {object} req 请求。
   * @param {object} res 响应。
   * @param {'any192'|'any512'|'maskable512'} which 哪一张。
   */
  async function handleIcon(req, res, which) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    const icons = await loadIcons(internalOrigin());
    const body = icons[which];
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /**
   * 下发合并后的 PWA manifest。
   *
   * 宿主原本的 manifest 是品牌资产的唯一来源，所以这里回源抓一份再合并：
   * - 补上 192/512 的位图图标（宿主只有 SVG 时过不了可安装性检查）；
   * - 相对 URL 全部按原 manifest 的地址解析成根相对地址。
   * 窗口显示模式与主题色不动，宿主写什么就下发什么（这就是「保持宿主默认
   * 全屏」）。抓不到原 manifest 就跳回原地址：宁可少一层合并，也不要让应用
   * 变得不可安装。
   */
  async function handleManifest(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    if (config.pwaEnabled === false) return sendJson(res, 404, { error: 'pwa disabled' });

    const query = queryOf(req.url);
    const publicOrigin = publicOriginOf(req);
    const internal = internalOrigin();
    const source = resolveHostManifestSource(query.src, {
      publicOrigin,
      internalOrigin: internal,
      referer: req?.headers?.referer,
    });
    if (!source) {
      // 显式给了 src 却解析不合法：拒绝，而不是把它当「没有 manifest」。
      // 否则 ?src=/webhook-notify/state 这类探测会被当成正常请求放过去。
      if (typeof query.src === 'string' && query.src !== '') {
        return sendJson(res, 400, { error: 'invalid manifest src' });
      }
      // 宿主没有 manifest 链接：给一份最小可用的。
      // URL 一律根相对：origin 由浏览器按当前访问地址补，代理/端口都不怕。
      const fallback = mergeManifest(
        { name: 'DeepSeek Harness', short_name: 'DSH', start_url: '/', scope: '/' },
        await manifestOptions(),
      );
      return sendJson(res, 200, fallback, 'application/manifest+json; charset=utf-8');
    }

    // 缓存键包含影响输出的配置，避免改完设置后最长一分钟仍是旧 manifest。
    const cacheKey = `${source.public}|${manifestSignature()}`;
    const cached = manifestCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MANIFEST_TTL) {
      return sendJson(res, 200, cached.manifest, 'application/manifest+json; charset=utf-8');
    }

    // 回源只抓本机 /manifest.webmanifest（resolveHostManifestSource 已限定）。
    const host = await fetchHostManifest(source.fetch);
    if (!host) {
      // 抓不到就跳回原地址，保住「可安装」这件事。
      res.writeHead(302, { location: source.public, 'cache-control': 'no-store' });
      return res.end();
    }
    const manifest = mergeManifest(
      localizeManifestUrls(host, source.public),
      await manifestOptions(),
    );
    if (manifestCache.size >= MANIFEST_CACHE_MAX) manifestCache.clear();
    manifestCache.set(cacheKey, { at: Date.now(), manifest });
    return sendJson(res, 200, manifest, 'application/manifest+json; charset=utf-8');
  }

  /** 影响 manifest 输出的配置摘要（缓存键用）。 */
  function manifestSignature() {
    return [
      config.pwaName,
      config.pwaShortName,
      config.pwaBackgroundColor,
      iconCache?.source ?? '',
    ].join('|');
  }

  /**
   * 合并 manifest 时用的可覆盖项（外加插件生成的位图图标）。
   *
   * 图标永远从**本机** origin 抓：这里曾经传入浏览器推导出的公开 origin，
   * 于是伪造 Host / X-Forwarded-* 就能让宿主去抓任意地址（SSRF）。
   *
   * @returns {Promise<object>} 合并选项。
   */
  async function manifestOptions() {
    await loadIcons(internalOrigin());
    return {
      name: config.pwaName || '',
      shortName: config.pwaShortName || '',
      backgroundColor: config.pwaBackgroundColor || '',
      icons: [
        { src: ROUTES.icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: ROUTES.icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: ROUTES.iconMaskable, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
  }

  /**
   * 站点对浏览器呈现的 origin。
   *
   * 走反向代理时，宿主自己的 origin（127.0.0.1:3080）和浏览器看到的
   * （https://dsh.example.com）不是一回事——manifest 里的图标、start_url
   * 必须是浏览器能访问的那个，否则远程用户拿到的 manifest 全是死链。
   * 所以这里按请求头推导，并把代理转发的头（X-Forwarded-*）算进去。
   */
  function publicOriginOf(req) {
    const headers = req?.headers ?? {};
    const host = headers['x-forwarded-host'] || headers.host;
    if (!host) return internalOrigin();
    const proto = headers['x-forwarded-proto']
      || (req?.socket?.encrypted ? 'https' : 'http');
    return `${String(proto).split(',')[0].trim()}://${host}`;
  }

  /** 宿主自己的 origin（回源抓取静态文件用，永远指向本机）。 */
  function internalOrigin() {
    try {
      const origin = ctx.get?.('webServer')?.getOrigin?.();
      if (typeof origin === 'string' && origin !== '') return origin.replace(/\/$/, '');
    } catch {
      /* ignore */
    }
    return 'http://127.0.0.1:3080';
  }

  async function handlePreview(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = await readJsonBody(req, 256 * 1024);
    } catch (error) {
      return sendJson(res, 400, { error: describe(error) });
    }
    const draft = normalizeConfig({ ...config, ...pickSaveFields(body) });
    const sample = makeEvent(
      {
        kind: 'done',
        title: 'DSH · 回复完成',
        body: '这条消息用于预览请求长什么样，不会真的发出去。',
        sessionId: 'preview-session',
        sessionLabel: '示例会话',
        time: new Date().toISOString(),
      },
      draft,
    );
    const { buildRequest } = await import('./send.js');
    const previews = draft.endpoints.map((endpoint) => {
      try {
        const request = buildRequest(endpoint, sample);
        return {
          id: endpoint.id,
          name: endpoint.name,
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body ?? '',
        };
      } catch (error) {
        return { id: endpoint.id, name: endpoint.name, error: describe(error) };
      }
    });
    sendJson(res, 200, { ok: true, previews, text: sample.text });
  }

  // ── Web Push ───────────────────────────────────────────────────
  /**
   * 取（必要时生成并落盘）VAPID 密钥对。
   *
   * 密钥必须长期稳定：浏览器订阅时用公钥签名订阅，宿主签名推送时要用同一对
   * 密钥，否则推送服务会拒绝。生成后写进 profile 配置，重启不丢。
   */
  async function ensureVapidKeys() {
    if (config.pushVapidPublicKey && config.pushVapidPrivateKey) {
      return { publicKey: config.pushVapidPublicKey, privateKey: config.pushVapidPrivateKey };
    }
    // 并发调用（订阅 + 测试推送）只生成一次：两把不同密钥会让先写入的订阅全废。
    if (!vapidPromise) {
      vapidPromise = (async () => {
        const keys = generateVapidKeys();
        config = { ...config, pushVapidPublicKey: keys.publicKey, pushVapidPrivateKey: keys.privateKey };
        const saved = await persist(config);
        if (!saved.ok) logger.warn(`VAPID 密钥未能写回配置：${saved.error}`);
        return keys;
      })().finally(() => {
        vapidPromise = null;
      });
    }
    return vapidPromise;
  }

  /** 读取 VAPID 公钥与推送开关状态。 */
  async function handlePushKey(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    const keys = await ensureVapidKeys();
    sendJson(res, 200, {
      ok: true,
      enabled: config.pushEnabled === true,
      publicKey: keys.publicKey,
      subject: config.pushSubject,
      count: (config.pushSubscriptions ?? []).length,
    });
  }

  /** 记录（新增或更新）一个浏览器推送订阅。 */
  async function handlePushSubscribe(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = await readJsonBody(req, 64 * 1024);
    } catch (error) {
      return sendJson(res, 400, { error: describe(error) });
    }
    const raw = body?.subscription ?? body;
    const endpoint = typeof raw?.endpoint === 'string' ? raw.endpoint.trim() : '';
    const keys = raw?.keys ?? {};
    if (!isAllowedPushEndpoint(endpoint)) {
      return sendJson(res, 400, { error: '订阅缺少合法的 endpoint（需 https，或本机回环地址）' });
    }
    if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
      return sendJson(res, 400, { error: '订阅缺少 keys.p256dh / keys.auth' });
    }
    await ensureVapidKeys();
    const list = Array.isArray(config.pushSubscriptions) ? [...config.pushSubscriptions] : [];
    const entry = {
      id: newEndpointId(),
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      ua: String(req.headers['user-agent'] ?? '').slice(0, 300),
      createdAt: Date.now(),
    };
    const at = list.findIndex((item) => item?.endpoint === endpoint);
    if (at >= 0) {
      entry.id = list[at].id ?? entry.id;
      list[at] = entry;
    } else {
      list.push(entry);
    }
    // 写回的是「订阅列表」这一个字段：设置页同时保存也不会互相覆盖。
    const saved = await persist({ pushSubscriptions: list });
    if (saved.ok) logger.info(`已记录推送订阅：${safeHost(endpoint)}（共 ${config.pushSubscriptions.length} 个）`);
    sendJson(res, 200, {
      ok: saved.ok,
      count: config.pushSubscriptions.length,
      persisted: saved.ok,
      error: saved.ok ? undefined : saved.error,
    });
  }

  /** 移除一个推送订阅。 */
  async function handlePushUnsubscribe(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = await readJsonBody(req, 64 * 1024);
    } catch (error) {
      return sendJson(res, 400, { error: describe(error) });
    }
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : '';
    if (endpoint === '') return sendJson(res, 400, { error: '缺少 endpoint' });
    const list = Array.isArray(config.pushSubscriptions) ? config.pushSubscriptions : [];
    const next = list.filter((item) => item?.endpoint !== endpoint);
    const saved = await persist({ pushSubscriptions: next });
    sendJson(res, 200, {
      ok: saved.ok,
      count: config.pushSubscriptions.length,
      persisted: saved.ok,
      error: saved.ok ? undefined : saved.error,
    });
  }

  /** 推送订阅列表（不返回密钥）。 */
  async function handlePushList(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    const list = Array.isArray(config.pushSubscriptions) ? config.pushSubscriptions : [];
    sendJson(res, 200, {
      ok: true,
      enabled: config.pushEnabled === true,
      subscriptions: list.map((item) => ({
        id: item?.id ?? '',
        host: safeHost(item?.endpoint),
        createdAt: item?.createdAt ?? 0,
        ua: item?.ua ?? '',
      })),
    });
  }

  /** 给所有订阅发一条测试推送。 */
  async function handlePushTest(req, res) {
    if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const keys = await ensureVapidKeys();
    const list = Array.isArray(config.pushSubscriptions) ? config.pushSubscriptions : [];
    if (list.length === 0) return sendJson(res, 200, { ok: false, error: '还没有推送订阅', results: [] });
    const results = await pushToSubscriptions(
      list,
      {
        title: 'DSH · 测试推送',
        body: `这是一条来自 dsh-webhook-notify 的 Web Push 测试（${new Date().toLocaleString('zh-CN')}）`,
        kind: 'notice',
        sessionId: null,
        sessionLabel: '',
        time: new Date().toISOString(),
        tag: 'dsh-webhook-notify-test',
      },
      keys,
    );
    sendJson(res, 200, { ok: results.every((item) => item.ok), results });
  }

  /** 往一批订阅发推送，并顺手清理已经失效的订阅（404/410）。 */
  async function pushToSubscriptions(list, payload, keys) {
    const results = [];
    const dead = [];
    for (const subscription of list) {
      const result = await sendPush(subscription, payload, {
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        subject: config.pushSubject,
        // 只能经代理出网时（FCM 等），这里让推送走代理。
        proxy: config.pushProxy,
      });
      results.push({
        id: subscription?.id ?? '',
        host: safeHost(subscription?.endpoint),
        ok: result.ok,
        status: result.status,
        error: result.error,
        ms: result.ms,
      });
      // 404/410：订阅已被推送服务注销，删掉免得每次都失败。
      if (result.status === 404 || result.status === 410) dead.push(subscription?.endpoint);
    }
    if (dead.length > 0) {
      // 只清理仍在列表里的失效订阅；不要用一份可能过期的快照整体覆盖。
      const current = Array.isArray(config.pushSubscriptions) ? config.pushSubscriptions : [];
      const remaining = current.filter((item) => !dead.includes(item?.endpoint));
      const saved = await persist({ pushSubscriptions: remaining });
      if (saved.ok) logger.info(`已清理 ${dead.length} 个失效的推送订阅`);
      else logger.warn(`失效订阅未能写回：${saved.error}`);
    }
    return results;
  }

  /**
   * 写回 profile 配置行。
   *
   * 两条保证：
   * 1. **串行**：configEditor 自己虽有文件锁，但两次读改写仍会互相覆盖——
   *    订阅上报与设置页保存同时发生时，后写入的那份会带走前一份的改动；
   * 2. **只写自己负责的字段**：入参是 patch，合并基准取自编辑器里的当前值，
   *    而不是调用方可能已经过期的内存快照。
   *
   * 失败时保留内存配置（重启会丢，但不影响本次使用）。
   *
   * @param {object} patch 本次要写入的字段。
   */
  function persist(patch) {
    const run = () => persistNow(patch);
    const queued = writeQueue.then(run, run);
    // 队列本身不能因为一次失败而断掉。
    writeQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async function persistNow(patch) {
    let editor;
    try {
      editor = ctx.get?.('configEditor');
    } catch {
      editor = undefined;
    }
    if (!editor) return { ok: false, error: '当前 profile 不支持配置写回（缺少 configEditor）' };
    const entry = ctx.fiber?.entry;
    if (!entry) return { ok: false, error: '无法定位本插件的配置行' };
    let merged = null;
    try {
      await editor.edit(entry, (current) => {
        merged = normalizeConfig({ ...current, ...(patch ?? {}) });
        return merged;
      });
      if (merged) config = merged;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }

  /**
   * 对外暴露的配置（headers 里可能含 token，原样回给同源设置页是必要的）。
   *
   * 但 VAPID 私钥与推送订阅不下发：设置页用不到，私钥更不该出现在前端。
   * 保存时宿主用字段白名单合并，客户端带不带这两个字段都覆盖不了它们。
   */
  function publicConfig() {
    const { pushVapidPrivateKey, pushSubscriptions, ...rest } = config;
    return { ...rest, endpoints: config.endpoints.map((endpoint) => ({ ...endpoint })) };
  }

  logger.info(
    config.endpoints.length > 0
      ? `[webhook-notify] 已加载，${config.endpoints.filter((e) => e.enabled).length}/${config.endpoints.length} 个端点启用`
      : '[webhook-notify] 已加载，尚未配置端点（设置 → Webhook 通知）',
  );

  return { notify, config: () => config };
}

// ── 辅助 ────────────────────────────────────────────────────────

function createLogger(ctx, debug) {
  let base;
  try {
    base = ctx.logger(name);
  } catch {
    base = ctx.logger ?? console;
  }
  return {
    info: (...args) => base.info?.(...args),
    warn: (...args) => base.warn?.(...args),
    error: (...args) => base.error?.(...args),
    debug: debug ? (...args) => (base.debug ?? base.info)?.(...args) : () => {},
  };
}

/** 会话标题：不同版本存在 header.title / header.meta.title 等位置。 */
function readSessionLabel(session) {
  const header = session?.header ?? {};
  return String(header.title ?? header.meta?.title ?? header.name ?? '').trim();
}

/** 从一条 assistant/message 事件里取纯文本正文。 */
function assistantTextOf(event) {
  const content = event?.data?.message?.content ?? [];
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text ? truncate(text, MAX_TEXT_CHARS) : '';
}

/** 截到至多 max 个字符；截断时省略号也占一个字符，保证总长度不超上限。 */
function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 最小同源校验：设置页只应被本页面调用。
 *
 * 反向代理会把 Host 改写成后端地址（`127.0.0.1:3080`），而浏览器发的 Origin
 * 仍是公开域名——只比 `req.headers.host` 时，代理后面的写接口会全部 403。
 * 所以把 `X-Forwarded-Host` 也算进允许集合，判据与 publicOriginOf 一致。
 * 没有 Origin 的请求（同源 GET、非浏览器调用）照旧放行。
 */
function trusted(req) {
  const headers = req?.headers ?? {};
  const origin = headers.origin;
  if (origin === undefined) return true;
  const allowed = new Set();
  for (const raw of [headers.host, headers['x-forwarded-host']]) {
    if (typeof raw !== 'string') continue;
    // 代理链可能是逗号分隔的一串，取最靠前（客户端侧）的那个。
    const host = raw.split(',')[0].trim();
    if (host !== '') allowed.add(host);
  }
  if (allowed.size === 0) return false;
  try {
    return allowed.has(new URL(origin).host);
  } catch {
    return false;
  }
}

/** 只取推送端点的主机名（日志与设置页展示，不泄露完整端点）。 */
function safeHost(endpoint) {
  try {
    return new URL(String(endpoint ?? '')).host;
  } catch {
    return '未知';
  }
}

function sendJson(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}
