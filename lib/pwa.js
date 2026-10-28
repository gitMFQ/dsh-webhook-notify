/**
 * PWA manifest —— 把宿主自己的 manifest 升级成「可安装」，其余字段保持宿主原样。
 *
 * 为什么不自己另写一份 manifest：DSH 自带的 `manifest.webmanifest` 里已经有
 * 品牌名、图标、start_url。插件另起一份等于把品牌信息抄一遍（宿主一改就漂移），
 * 两份 manifest 同时存在时浏览器只认第一份。所以这里的做法是：
 *
 *   1. 在宿主下发的 index.html 里（`tapIndex` 变换，纯字符串，不碰 DOM）：
 *      - 最前面注入一个早期捕获 `beforeinstallprompt` 的小脚本（见 CAPTURE_SOURCE）；
 *      - 把 `<link rel="manifest">` 指向插件的路由；
 *      - 顺手关掉下滑刷新（见 disablePullToRefresh）。
 *   2. 插件的路由回源抓取宿主原本的 manifest，在其基础上**合并**：
 *      - 补上 192/512 位图图标（宿主只有 SVG 时过不了可安装性检查）；
 *      - `id` 稳定化，避免同一应用被认成两个；
 *      - 所有 URL（start_url / scope / icon.src …）按原 manifest 的地址解析，
 *        同源的写成根相对地址——写死 `http://host` 时，反向代理后的 https 页面
 *        会把它们当混合内容拦掉，应用就静默变成「不可安装」（见 localizeManifestUrls）。
 *
 * 窗口显示模式（`display` / `display_override`）与状态栏、导航栏颜色
 * （`theme_color`）**归宿主所有**：插件不再改写它们，宿主 manifest 里写什么就
 * 是什么（DSH 自己声明的是全屏）。插件只负责让它变得可安装。
 *
 * 抓不到原 manifest 时回退成 302 跳回原地址：宁可少一层合并，也不要让应用
 * 突然变得不可安装。
 *
 * @module dsh-webhook-notify/lib/pwa
 */

/** 插件托管的 manifest 路由。 */
export const MANIFEST_PATH = '/webhook-notify/manifest.webmanifest';

/** 宿主原 manifest 的唯一合法路径（回源只允许这一个）。 */
export const HOST_MANIFEST_PATH = '/manifest.webmanifest';

/** 回源 manifest 的最大字节数；manifest 不该有几百 KB。 */
export const MANIFEST_MAX_BYTES = 256 * 1024;

/** HTML 属性转义：链接地址来自宿主，拼进属性前必须转义。 */
function escapeAttribute(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * 把宿主 manifest 的 href 解析成「公开地址 + 本机回源地址」。
 *
 * 安全边界（这是本插件唯一的服务端回源入口）：
 * - 只允许 canonical 路径 `/manifest.webmanifest`，query / hash 一律拒绝；
 * - 只允许 http(s)，且解析后的 origin 必须与公开 origin 或本机 origin 一致；
 * - 回源地址永远由本机 origin 重建，调用方拿不到任意 URL 的抓取能力。
 *
 * 这样 `/webhook-notify/manifest.webmanifest?src=/webhook-notify/state`
 * 之类的请求不会变成「读取本机内部接口并原样返回」。
 *
 * @param {string} src 宿主 manifest 的 href（可相对、可省略）。
 * @param {object} options
 * @param {string} options.publicOrigin 浏览器看到的 origin。
 * @param {string} options.internalOrigin 本机回源 origin。
 * @param {string} [options.referer] 请求 Referer（作为相对地址基准）。
 * @returns {{public: string, fetch: string}|null} 非法时返回 null。
 */
export function resolveHostManifestSource(src, options = {}) {
  const publicOrigin = typeof options.publicOrigin === 'string' && options.publicOrigin !== ''
    ? options.publicOrigin
    : null;
  const internalOrigin = typeof options.internalOrigin === 'string' && options.internalOrigin !== ''
    ? options.internalOrigin
    : null;
  if (!publicOrigin || !internalOrigin) return null;
  const raw = typeof src === 'string' && src.trim() !== '' ? src.trim() : HOST_MANIFEST_PATH;
  const base = typeof options.referer === 'string' && options.referer !== ''
    ? options.referer
    : `${publicOrigin}/`;
  let resolved;
  try {
    resolved = new URL(raw, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  if (resolved.search !== '' || resolved.hash !== '') return null;
  // 浏览器地址与宿主地址都可能出现（反代把 Host 改写成后端时用后者）。
  const allowedOrigins = new Set([publicOrigin, internalOrigin]);
  if (!allowedOrigins.has(resolved.origin)) return null;
  // canonical 路径校验：%2e%2e 之类的编码已在 URL 解析时归一化，
  // 这里再确认最终 pathname 完全相等。
  if (resolved.pathname !== HOST_MANIFEST_PATH) return null;
  let target;
  try {
    target = new URL(HOST_MANIFEST_PATH, internalOrigin);
  } catch {
    return null;
  }
  return { public: `${resolved.origin}${HOST_MANIFEST_PATH}`, fetch: target.href };
}

/** 早期捕获 beforeinstallprompt 的脚本路由。 */
export const CAPTURE_PATH = '/webhook-notify/pwa-capture.js';

/**
 * 在页面最早期捕获 `beforeinstallprompt` 的小脚本。
 *
 * 为什么不能只在客户端插件里监听：Chromium 只在**每次页面加载时**派发一次
 * `beforeinstallprompt`，而客户端插件是宿主启动后才异步加载的。插件代码跑
 * 起来之前事件就过去的页面，安装入口会永久丢失（设置页只能显示「浏览器没有
 * 给安装入口」）。这个脚本放在 `<head>` 最前面，几乎和解析同步执行，先把事件
 * 存下来，插件随后从 `window.__dshWebhookNotifyPwa` 取。
 *
 * 刻意**不调用** `preventDefault()`：默认行为被拦掉后，浏览器自己的安装 UI
 * （地址栏的安装图标）就没有了。插件提供的按钮只是多一个入口，不该成为唯一入口。
 */
export const CAPTURE_SOURCE = `/* dsh-webhook-notify — early beforeinstallprompt capture. */
(function (w) {
  if (!w || typeof w.addEventListener !== 'function' || w.__dshWebhookNotifyPwa) return;
  var state = { prompt: null, at: 0, installed: false };
  w.__dshWebhookNotifyPwa = state;
  function announce(kind) {
    try {
      w.dispatchEvent(new w.CustomEvent('dsh-webhook-notify:install-state', { detail: { kind: kind } }));
    } catch (e) {}
  }
  w.addEventListener('beforeinstallprompt', function (event) {
    state.prompt = event;
    state.at = Date.now();
    announce('prompt');
  });
  w.addEventListener('appinstalled', function () {
    state.prompt = null;
    state.at = 0;
    state.installed = true;
    announce('installed');
  });
})(typeof window === 'undefined' ? undefined : window);
`;

/**
 * 把早期捕获脚本注入 index.html 的 `<head>` 最前面。
 *
 * 纯函数、可重复调用：已经注入过（页面里出现该脚本地址）就直接返回原串，
 * 免得宿主多次 tap 后叠出好几个 `<script>`。
 *
 * @param {string} html 原始 index.html。
 * @param {string} [src] 捕获脚本地址。
 * @returns {string} 注入后的 html。
 */
export function injectInstallCapture(html, src = CAPTURE_PATH) {
  if (typeof html !== 'string' || html === '') return html;
  if (!src || html.includes(src)) return html;
  const tag = `<script src="${src}" data-dsh-webhook-notify="pwa-capture"></script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (m) => `${m}${tag}`);
  return tag + html;
}

/**
 * 构造插件 manifest 的链接（带原 manifest 的位置）。
 *
 * @param {string} src 宿主原 manifest 的 href（可相对）。
 * @returns {string} 绝对路径（含查询串）。
 */
export function manifestHref(src) {
  const base = MANIFEST_PATH;
  if (!src) return base;
  return `${base}?src=${encodeURIComponent(src)}`;
}

/**
 * 在 index.html 里把 manifest 链接改指到插件路由。
 *
 * 纯函数：同样的输入总是同样的输出，`tapIndex` 可以反复调用。
 *
 * @param {string} html 原始 index.html。
 * @param {string} [href] 目标链接；默认按原 href 拼出来。
 * @returns {string} 改写后的 html。
 */
export function rewriteManifestLink(html, href) {
  if (typeof html !== 'string' || html === '') return html;
  const linkPattern = /<link\b[^>]*>/gi;
  let replaced = false;
  let originHref = '';
  const out = html.replace(linkPattern, (tag) => {
    if (replaced) return tag;
    const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag);
    if (!rel || !/(^|\s)manifest(\s|$)/i.test(rel[1])) return tag;
    // 引号可省略（HTML 允许 href=./m.webmanifest）。旧实现只认带引号的值，
    // 于是无引号时走「没有 href」分支又补了一个 href，产出重复属性。
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    originHref = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '') : '';
    replaced = true;
    const target = escapeAttribute(href ?? manifestHref(originHref));
    if (hrefMatch) {
      return tag.replace(hrefMatch[0], `href="${target}"`);
    }
    return tag.replace(/<link\b/i, `<link href="${target}"`);
  });
  if (replaced) return out;
  // 宿主没有 manifest 链接：补一条，让应用具备可安装性。
  const link = `<link rel="manifest" href="${escapeAttribute(href ?? manifestHref(''))}" />`;
  if (/<head[^>]*>/i.test(out)) {
    return out.replace(/<head([^>]*)>/i, (m) => `${m}${link}`);
  }
  return link + out;
}

/**
 * 关掉浏览器自带的下滑刷新（pull-to-refresh）的样式。
 *
 * 装成应用之后，从页面顶部往下拽会拉起 Chrome 那个「转圈 → 整页重载」的手势。
 * 对原生感的界面来说这是纯粹的灾难：聊到一半的表单、展开的面板、滚动位置全
 * 被一次误触抹掉。Chrome 从 63 起把决定权交给 CSS 的 `overscroll-behavior`：
 * 在 `html, body` 上写 `contain`，越过顶部的那段 overscroll 就不会再冒泡到
 * 浏览器窗口，页面重载也就不会发生（`none` 更狠，连橡皮筋回弹一起去掉，
 * 但那种「拽不动」的手感反而更假，这里用 `contain`）。
 *
 * 只加在根滚动容器上：嵌套的滚动区域（消息列表、抽屉）保持原生滚动链，不去
 * 动它们——root 上已经兜住了，越界也不会冒到浏览器那一层。
 */
export const NO_PULL_TO_REFRESH_STYLE = 'html,body{overscroll-behavior-y:contain}';

/** 注入的 `<style>` 上的标记属性，用来判断「已经加过了」。 */
export const NO_PULL_TO_REFRESH_MARKER = 'data-dsh-webhook-notify="no-pull-to-refresh"';

/**
 * 在 index.html 里注入「禁止下滑刷新」的样式。
 *
 * 纯函数、可重复调用：带标记的 `<style>` 已经在页面里就直接返回原串。
 *
 * @param {string} html 原始 index.html。
 * @param {string} [css] 覆盖样式内容。
 * @returns {string} 改写后的 html。
 */
export function disablePullToRefresh(html, css = NO_PULL_TO_REFRESH_STYLE) {
  if (typeof html !== 'string' || html === '') return html;
  if (!css) return html;
  if (html.includes(NO_PULL_TO_REFRESH_MARKER)) return html;
  const tag = `<style ${NO_PULL_TO_REFRESH_MARKER}>${css}</style>`;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, (m) => `${tag}${m}`);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (m) => `${m}${tag}`);
  return tag + html;
}

/**
 * 把 manifest 里的 URL 字段换成「浏览器一定能访问」的形式。
 *
 * manifest 被挪到 `/webhook-notify/` 下之后，相对 URL 的基准就变了
 * （`favicon.svg` 会解析成 `/webhook-notify/favicon.svg`），所以必须按**原**
 * manifest 的地址解析。
 *
 * 解析结果里**与本文件同源**的地址一律写成 `/<path>` 这种根相对形式，而不是
 * `http://host/path`：
 *
 * - 走反向代理时，宿主看到的 `http://127.0.0.1:3080` 和浏览器看到的
 *   `https://dsh.example.com` 不是一回事，写死协议/域名会让 manifest 里的图标
 *   变成混合内容而被浏览器拦掉——那会直接让应用变得不可安装；
 * - 根相对地址的 origin 由浏览器自己补，https / 端口 / 域名怎么变都对；
 * - 跨域资源（CDN 图标之类）保持绝对地址，不做改写。
 *
 * @param {object} manifest 宿主 manifest。
 * @param {string} baseUrl 原 manifest 的绝对地址。
 * @returns {object} 新的 manifest（不修改入参）。
 */
export function localizeManifestUrls(manifest, baseUrl) {
  let base = null;
  try {
    base = new URL(baseUrl);
  } catch {
    base = null;
  }
  const resolve = (value) => {
    if (typeof value !== 'string' || value === '') return value;
    let url;
    try {
      url = new URL(value, baseUrl);
    } catch {
      return value;
    }
    if (!base || url.origin !== base.origin) return url.href;
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const out = { ...manifest };
  for (const key of ['start_url', 'scope', 'id']) {
    if (typeof out[key] === 'string') out[key] = resolve(out[key]);
  }
  if (Array.isArray(out.icons)) {
    out.icons = out.icons.map((icon) => (icon && typeof icon === 'object' ? { ...icon, src: resolve(icon.src) } : icon));
  }
  if (Array.isArray(out.screenshots)) {
    out.screenshots = out.screenshots.map((shot) => (shot && typeof shot === 'object' ? { ...shot, src: resolve(shot.src) } : shot));
  }
  if (Array.isArray(out.shortcuts)) {
    out.shortcuts = out.shortcuts.map((shortcut) => {
      if (!shortcut || typeof shortcut !== 'object') return shortcut;
      const next = { ...shortcut };
      if (typeof next.url === 'string') next.url = resolve(next.url);
      if (Array.isArray(next.icons)) {
        next.icons = next.icons.map((icon) => (icon && typeof icon === 'object' ? { ...icon, src: resolve(icon.src) } : icon));
      }
      return next;
    });
  }
  for (const key of ['protocol_handlers', 'related_applications', 'prefer_related_applications']) {
    if (Array.isArray(out[key])) {
      out[key] = out[key].map((item) => (item && typeof item === 'object' ? { ...item, url: resolve(item.url) } : item));
    }
  }
  if (out.file_handlers && Array.isArray(out.file_handlers.launch_queue)) {
    out.file_handlers = {
      ...out.file_handlers,
      launch_queue: out.file_handlers.launch_queue.map((item) => (item && typeof item === 'object' ? { ...item, url: resolve(item.url) } : item)),
    };
  }
  return out;
}

/** 旧名字保留：行为从「绝对化」改成了「同源转根相对」。 */
export const absolutizeManifestUrls = localizeManifestUrls;

/**
 * 判断一条 manifest 图标是不是「真位图」。
 *
 * SVG / `sizes: "any"` 的图标在可安装性检查里尺寸算 0×0，而且在安装时会被
 * 优先选中——这正好是「装出来的图标很奇怪」的来源。
 *
 * @param {object} icon manifest 里的一条 icon。
 * @returns {boolean} 是否是带明确像素尺寸的位图。
 */
export function isBitmapIcon(icon) {
  if (!icon || typeof icon !== 'object') return false;
  const sizes = String(icon.sizes ?? '').trim();
  if (!/^\d+x\d+$/i.test(sizes)) return false;
  const type = String(icon.type ?? '').toLowerCase();
  const src = String(icon.src ?? '').toLowerCase();
  const rasterType = /^image\/(png|jpeg|jpg|webp|avif)$/.test(type);
  const rasterExt = /\.(png|jpe?g|webp|avif)(\?|#|$)/.test(src);
  return rasterType || (type === '' && rasterExt);
}

/**
 * 在宿主 manifest 基础上合并「可安装」需要的字段。
 *
 * 窗口显示模式（`display` / `display_override`）与 `theme_color` 一律不动：
 * 它们是宿主界面的决定权，插件只负责补齐可安装性。
 *
 * @param {object} hostManifest 宿主原 manifest。
 * @param {object} options
 * @param {string} [options.name] 覆盖应用名（留空沿用宿主的）。
 * @param {string} [options.shortName] 覆盖短名。
 * @param {string} [options.backgroundColor] 覆盖背景色。
 * @param {boolean} [options.launchHandler] 是否补 launch_handler。
 * @returns {object} 合并后的 manifest。
 */
export function mergeManifest(hostManifest, options = {}) {
  const {
    name = '',
    shortName = '',
    backgroundColor = '',
    launchHandler = true,
    icons = [],
  } = options;
  const manifest = { ...(hostManifest && typeof hostManifest === 'object' ? hostManifest : {}) };

  if (name) manifest.name = name;
  if (shortName) manifest.short_name = shortName;
  else if (name && !manifest.short_name) manifest.short_name = name.slice(0, 12);
  if (backgroundColor) manifest.background_color = backgroundColor;

  // 图标：宿主自己的位图保留（品牌资产），再补上 Chrome 要的 192/512 位图。
  //
  // 宿主只有 SVG（sizes: "any" → 尺寸 0×0）时，「至少 192px 宽的图标」这条
  // 可安装性要求过不去，页面明明满足其它条件浏览器也不给装。
  //
  // 非位图图标（SVG）要从 manifest 里**换掉**，不是留着当备选：浏览器挑图标
  // 时会把 `sizes: "any"` 的标量图当成万能解，装出来的应用就是一张透明底的
  // logo（深色任务栏上几乎看不见）。插件补的位图本来就是把宿主 logo 栅格化
  // 出来的，换掉不丢品牌。
  if (Array.isArray(icons) && icons.length > 0) {
    const existing = Array.isArray(manifest.icons) ? manifest.icons : [];
    const bitmaps = existing.filter(isBitmapIcon);
    const added = icons.filter((icon) => icon && typeof icon === 'object' && !bitmaps.some(
      (item) => item?.src === icon.src && item?.sizes === icon.sizes && item?.purpose === icon.purpose,
    ));
    manifest.icons = [...bitmaps, ...added];
  }

  // 显示模式（display / display_override）与 theme_color 原样保留宿主的：
  // 「装成应用之后要不要全屏、状态栏什么颜色」是宿主界面的决定，插件不插嘴。
  // 这里刻意不写这几个字段，宿主 manifest 里有就跟着下发，没有就不出现。

  // 稳定的应用标识：没有 id 时用 start_url，避免同一应用被认成两个。
  if (!manifest.id) {
    const id = typeof manifest.start_url === 'string' ? manifest.start_url : '/';
    manifest.id = id;
  }
  if (launchHandler && !manifest.launch_handler) {
    // 单窗口应用：复用已有窗口，不新开一堆。
    manifest.launch_handler = { client_mode: ['navigate-existing', 'auto'] };
  }
  if (manifest.prefer_related_applications === undefined) {
    manifest.prefer_related_applications = false;
  }
  return manifest;
}

/**
 * 抓取宿主原 manifest。
 *
 * @param {string} url 原 manifest 的绝对地址。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<object|null>} 解析后的 manifest；失败返回 null。
 */
export async function fetchHostManifest(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/manifest+json, application/json' },
      cache: 'no-cache',
      // 回源只允许本机静态 manifest，重定向到别处一律不跟。
      redirect: 'error',
    });
    if (!response.ok) return null;
    // 只做防御性排除：明确是 HTML 的响应不可能是 manifest。其余类型仍要求
    // 正文能解析成 JSON 对象——真实宿主对 .webmanifest 的 MIME 并不总规范，
    // 一刀切只认 manifest+json 会把正常的品牌 manifest 拒掉。
    const type = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
    if (/^text\/html\b/.test(type)) return null;
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MANIFEST_MAX_BYTES) return null;
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MANIFEST_MAX_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从请求里取出查询参数。
 *
 * @param {string} url 请求 URL（可能带查询串）。
 * @returns {Record<string, string>} 参数表。
 */
export function queryOf(url) {
  const out = {};
  const at = String(url ?? '').indexOf('?');
  if (at < 0) return out;
  const search = new URLSearchParams(String(url).slice(at + 1));
  for (const [key, value] of search) out[key] = value;
  return out;
}
