/**
 * 模板渲染与请求构造 —— webhook 的「自由」全在这里。
 *
 * 设计要点：
 * - 模板变量用 `{{path.to.value}}`，取值来自事件的扁平视图；
 * - 变量可出现在 URL、请求头、请求体任意位置；
 * - JSON 变量插入时按类型序列化（字符串不加引号，对象/数字直接内联），
 *   所以 `{"content":"{{text}}"}` 与 `{"n":{{count}}}` 都成立；
 * - `{{json}}` 是整条事件的标准 JSON，方便直接把插件原始载荷转给别的服务。
 */

/**
 * 取 a.b.c 形式的路径；缺失返回 undefined。
 *
 * 只走自有属性：模板由用户编写，`{{constructor.name}}` 之类的路径不该把
 * 原型链上的对象带进请求体。
 */
function pick(source, path) {
  let cur = source;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 字符串化一个模板值：对象走 JSON，null/undefined 走空串。 */
function stringify(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * 替换模板里的全部变量。
 *
 * @param template 模板字符串；非字符串原样返回。
 * @param vars 变量表。
 * @param options.json 为 true 时按「正在拼 JSON」处理：字符串做 JSON 转义
 *   （否则正文里的换行会直接把这个 JSON 拆坏），数字/布尔原样内联，
 *   对象序列化成 JSON 文本。
 */
export function render(template, vars, options = {}) {
  if (typeof template !== 'string') return template;
  const json = options.json === true;
  return template.replace(TOKEN, (_match, path) => {
    const value = path === 'json' ? vars.json : pick(vars, path);
    if (!json) return stringify(value);
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') return JSON.stringify(JSON.stringify(value)).slice(1, -1);
    return JSON.stringify(String(value)).slice(1, -1);
  });
}

/**
 * 深度渲染：递归处理对象/数组里的每个字符串。
 * 请求头、请求体模板都用它，省得调用方自己判断结构。
 *
 * @param value 任意结构。
 * @param vars 变量表。
 * @param options 透传给 {@link render}（例如 `{ json: true }`）。
 */
export function renderDeep(value, vars, options = {}) {
  if (typeof value === 'string') return render(value, vars, options);
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, vars, options));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = renderDeep(item, vars, options);
    return out;
  }
  return value;
}

/**
 * 把一条通知事件压成模板可用的扁平变量表。
 *
 * 同时提供两套名字：语义名（title/body/kind…）和插件生态里常见的
 * 兼容名（content/text/message…），这样同一份模板换个后端不用改。
 */
export function buildVars(event) {
  const vars = {
    kind: event.kind,
    event: event.kind,
    title: event.title,
    body: event.body,
    sessionId: event.sessionId ?? '',
    session: event.sessionLabel ?? '',
    time: event.time,
    timestamp: event.time,
    tool: event.toolName ?? '',
    reason: event.reason ?? '',
    snippet: event.snippet ?? '',
    // 兼容别名：多数 webhook 后端只需要其中一个
    content: event.text,
    text: event.text,
    message: event.text,
    msg: event.text,
    json: JSON.stringify(event, null, 2),
  };
  return vars;
}

/**
 * 组装一条通知的纯文本正文。
 * 这是 `{{text}}` 的来源，也是设置页「预览」看到的内容。
 */
export function composeText(event, template) {
  const lines = [];
  const title = String(event.title ?? '').trim();
  const body = String(event.body ?? '').trim();
  if (title) lines.push(title);
  if (body && body !== title) lines.push(body);
  if (event.toolName) lines.push(`工具：${event.toolName}`);
  if (event.reason) lines.push(`原因：${event.reason}`);
  if (event.time) lines.push(`时间：${formatTime(event.time)}`);
  const base = lines.join('\n');
  if (typeof template !== 'string' || template.trim() === '') return base;
  return render(template, { ...buildVars({ ...event, text: base }), text: base });
}

function formatTime(iso, timeZone = 'Asia/Shanghai') {
  try {
    return new Date(iso).toLocaleString('zh-CN', { timeZone, hour12: false });
  } catch {
    return iso;
  }
}
