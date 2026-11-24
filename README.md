# dsh-webhook-notify

DSH 通知插件：**任务需要你操作 / 回复完成 / 本轮出错**时，从 DSH 宿主进程把通知推送到你自己的 Webhook，**同时（可选）在系统通知中心弹一条浏览器通知**（参考 `dsh-notify-me`，点击通知回到对应会话），并支持 **Web Push**（页面全关也能收到提醒）。

## 为什么不是「填个地址就行」的前端插件

`dsh-notify-me` 这类浏览器端插件用 `fetch` 直接 POST，会撞上两道墙：

1. **跨域（CORS）**：目标端点不放行 `Access-Control-Allow-Origin` 时，浏览器连请求体都读不到，只能降级成「已送出不可确认」；
2. **自定义请求头**：`Authorization: Bearer …` 会触发预检，端点不配合就发不出去——而这恰好是绝大多数 Bot / 推送网关的鉴权方式。

本插件把发送放在**宿主（Node）进程**里：任意请求头、任意目标、不受同源策略约束，页面关掉也照发。

## 触发事件

| 事件 | 时机 | kind |
|---|---|---|
| 需要你操作 | `approval/asked`（工具审批等） | `attention` |
| 回复完成 | `turn/end` 且 `reason.kind === 'completed'` | `done` |
| 本轮出错 | `turn/end` 且 `reason.kind === 'error'` | `error` |


## 浏览器通知（参考 dsh-notify-me）

除了推 Webhook，本插件还能在**系统通知中心**弹一条浏览器通知，页面开着也能立刻看到、点一下回到对应会话。

- **持久通知走 Service Worker**：页面被系统挂起后仍能弹出，点击通知带用户手势、能把窗口真正带到前台；没有 Service Worker（如 `dsh-app://` 桌面端、非安全上下文）时自动退回页面内 `new Notification()`。
- **触发规则与 Webhook 同源**：同一批事件，Webhook 推到端点、浏览器通知弹到桌面，两边独立开关。
- **点击回到会话**：点击通知把 DSH 带到前台并切到该条提醒所属的会话（可在设置里关掉）。
- **安静规则**：默认「当前对话的等待不弹」（卡片就在眼前）、「回复完成只在页面隐藏时弹」、「子代理会话不弹」——都可在设置页调整。

设置页「浏览器通知」卡片里有权限状态、Service Worker 状态和「发送测试通知」按钮。

> 浏览器通知权限需要在页面上点一次（浏览器要求用户手势才能询问）。首次点设置页的「请求通知权限」即可。

## Web Push：页面全关也能收到

浏览器通知依赖页面活着；**Web Push** 则由推送服务直接投给 Service Worker，页面全关、浏览器在后台都照收。

### 链路

```
宿主事件 → VAPID 签名 + aes128gcm 加密 → POST 推送服务 → Service Worker 的 push 事件 → 系统通知
```

- **VAPID**：插件自动生成 P-256 密钥对，公钥给浏览器订阅用，私钥留在宿主签名用。密钥存在 profile 配置里，**必须长期稳定**，换密钥等于所有订阅失效。
- **出站代理（`pushProxy`）**：推送服务都在公网。宿主只能经代理出网时，直连只会得到一句 `fetch failed`——什么都不说。填 `http://127.0.0.1:7890` 这样的地址后，推送走 undici 的 `ProxyAgent`；留空=直连。只影响 Web Push，Webhook 投递仍然直连（这些地址通常在内网）。改完记得保存配置，代理 Agent 会跟着重建。
- **载荷加密**：按 RFC 8188 的 `aes128gcm` 内容编码（密钥派生链与 `http_ece` 参考实现逐字节一致；测试里直接用 RFC 8188 §3.1 的官方测试向量对齐）。
- **点击行为**：推送通知的 `data` 与页面内通知同形，点击照样切回对应会话。

### 用法

1. 设置页 → 「Web Push」→ 打开「启用 Web Push」；
2. 点「订阅推送」（需要先授予通知权限；浏览器要求用户手势）；
3. 订阅信息会存到宿主（profile 配置），宿主在事件发生时向所有订阅推送；
4. 「发送测试推送」可验证整条链路。

推送端点默认要求 `https://`；本机回环地址（`127.0.0.1` / `localhost`）允许 `http://`，方便接自建推送中继。

## 端点字段

| 字段 | 说明 |
|---|---|
| `url` | 必填，可含模板变量 |
| `method` | `POST` / `PUT` / `PATCH` / `GET` / `HEAD` / `DELETE`（其它值回落成 `POST`） |
| `headers` | 对象，或每行一条 `Key: Value` 的文本 |
| `bodyMode` | `json`（通用载荷）/ `text`（只发正文）/ `none` |
| `body` | 自定义请求体模板，留空用 `bodyMode` 生成 |
| `kinds` | 订阅哪些事件；留空 = 全部 |
| `retries` / `timeoutMs` | 重试次数 / 单端点超时。`timeoutMs` 为 `0`（默认）时**跟随插件级 `timeoutMs`**，只有显式填了值才覆盖它。`4xx` 不重试（`408` / `425` / `429` 除外）；`3xx` 不自动跟随，按失败上报 |

## 模板变量

`{{title}}` `{{body}}` `{{content}}`（拼好的正文）`{{text}}` `{{session}}` `{{sessionId}}`
`{{kind}}` `{{event}}` `{{time}}` `{{tool}}` `{{reason}}` `{{json}}`（完整事件 JSON）

`body` 以 `{` 或 `[` 开头时按 JSON 拼装，变量自动转义——正文里的换行和引号不会把 JSON 拆坏。

## 例子

**OpeniLink Hub / 微信**

```
url:     https://oih.osai.eu.org:8443/bot/v1/message/send
headers: Authorization: Bearer app_xxx
body:    {"content":"{{content}}"}
```

**Discord**

```
url:  https://discord.com/api/webhooks/xxx/yyy
body: {"username":"DSH","content":"{{content}}"}
```

**Bark**

```
url:  https://api.day.app/<key>/{{title}}/{{content}}
bodyMode: none
```

**自定义接收端**

```
url:  https://example.com/hook
body: {"event":"{{event}}","text":"{{content}}","session":"{{session}}","at":"{{time}}"}
```

## 设置页

DSH Web → 设置 → **Webhook 通知**。面板按 DSH 自身设置页的样式与结构重做：

- 排版对齐宿主：行内「标签左 / 控件右」+ `.5px` 分隔线、14px 正文 / 12px 次要文字、36px 控件；颜色全部走 `--dsw-*` 设计令牌，**浅色 / 深色主题自动跟随**；
- 开关、按钮、事件胶囊直接复用宿主暴露的原子组件 `@deepseek-ai/dsh-client-ui-primitives`（`Switch` / `Button` / `Pill`），拿不到时退回等价的自绘样式；
- 分组：**Webhook 投递**（事件开关、默认超时、节流、正文模板、日志）→ **浏览器通知**（开关、静音规则、权限与测试）→ **Web Push**（开关、VAPID 联系地址、出站代理、订阅与测试）→ **推送端点** → **最近投递**；
- 保存 / 预览 / 添加端点固定在面板底部的操作条上，改动后随手可保存；
- 端点卡片：备注名、启用开关、地址、方法、订阅事件、超时、重试、请求体模式与模板、请求头，以及「发送测试消息」。

## 配置字段

除端点字段外，插件级配置如下（都存在 profile 的 `cordis.patch.yml`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `notifyAttention` / `notifyDone` / `notifyError` | `true` | 三类事件各自的投递总开关 |
| `minIntervalMs` | `0` | 同一会话的最小推送间隔（毫秒，0=不限） |
| `timeoutMs` | `10000` | **插件级**默认请求超时；端点自身的 `timeoutMs` 为 `0` 时用它 |
| `textTemplate` | `''` | 正文模板（留空用内置排版） |
| `logDeliveries` / `debug` | `true` / `false` | 投递日志 / 调试日志 |
| `pushEnabled` | `false` | 宿主向浏览器推送 |
| `pushSubject` | `mailto:dsh-webhook-notify@localhost` | VAPID 联系地址（须 `mailto:` 或 `https:`） |
| `pushProxy` | `''` | 推送出站代理（如 `http://127.0.0.1:7890`）；留空=直连 |
| `pushVapidPublicKey` / `pushVapidPrivateKey` | 自动生成 | VAPID 密钥对，**勿手改**（换密钥=订阅全废） |
| `pushSubscriptions` | `[]` | 浏览器订阅列表，自动维护 |

## 修复与行为变化（0.4.0）

这一版按代码审查结论做了一轮修复，并拿掉了对宿主窗口外观的改写：

- **停用端点也能自测**：此前对一个 `enabled: false` 的端点发「发送测试消息」，`notify()` 放行、投递层又按启用过滤，结果一律显示「找不到该端点」，一个请求都发不出去。现在自测路径绕过启用过滤；地址还没填的端点会得到真实的「地址无效」结果，真正不存在该 id 才报「找不到该端点」。广播路径仍然静默跳过空地址草稿行，不会往最近投递里塞红条。
- **反向代理下设置页不再全 403**：`trusted()` 只比对 `Origin` 与 `Host`，代理按默认改写 `Host` 后保存/测试/预览/订阅一律 403。现在 `X-Forwarded-Host` 存在时也计入允许集合。
- **插件级 `timeoutMs` 真的生效**：端点 `timeoutMs` 默认改成 `0`（跟随插件级超时），此前端点默认值总会覆盖插件级设置，导致 profile 里改 `timeoutMs` 毫无作用。
- **待处理交互不再重复提醒**：去重键此前用 `key.split(':')` 反推会话 id，而宿主下发的 key 是 `approval:<序号>` 这类不含会话 id 的形式，导致同一次等待被反复弹。
- **「点击通知回到对应对话」在持久通知路径下生效**：该开关此前只作用于页面降级通知；现在偏好随通知 `data` 交给 Service Worker，worker 不再无条件抢焦点，页面侧也再判一次。
- **结局分类不再用过期数据**：「本轮出错」判定新增 60 秒有效期，并在页面回到前台时立即刷新，避免上一轮的 `error` 把后台完成的一轮误报成出错。
- **i18n 补齐**：中文补上「推送代理」文案，并清掉中文词典里重复定义（英文值）的三个死条目。

## 安全与一致性（0.3.0）

这一版修掉了几个会造成数据泄露或「看起来成功其实没成功」的问题，行为变化如下：

- **设置页保存有字段白名单**：`pushVapidPrivateKey` 与 `pushSubscriptions` 永远不下发、也无法被保存请求覆盖。此前一次保存可能把订阅列表清空。
- **配置写回串行化**：订阅上报、VAPID 密钥生成与设置页保存并发时不再互相覆盖，各自只写自己负责的字段。
- **测试通知不再「空成功」**：没有可用端点时返回 `ok: false` 与具体原因。
- **`3xx` 不再自动跟随**：端点返回重定向会明确报错（避免对端决定请求最终发往哪里）。`429` / `408` 会重试，其余 `4xx` 不重试。
- **响应体有上限**：最多读取 64 KiB，对方回一个超大响应不会吃掉宿主内存。

浏览器侧同时修掉了：同一条点击消息触发两次导航、`showNotification()` 失败被当成成功（并产生未处理拒绝）、订阅上报失败仍显示「已订阅」、以及插件重载后监听器与通知残留。

## 注意

- **HTTP 头只能是单字节字符**：`X-Tag: 中文` 会被底层拒绝，插件会直接报「请求头含非 ASCII 字符」而不是静默失败。中文放请求体。
- 端点配置存在 profile 的 `cordis.patch.yml`，重启保留；`headers` 里的 token 也一并存在那里，注意该文件的读取权限。**VAPID 私钥同样存在这个文件里**。
- 同一会话的推送可用「最小间隔」节流，避免连续回合刷屏。
- **Webhook 正文上限 21000 字符**：助手最后一条回复先截到 21000 字（超出以 `…` 结尾），拼上标题/时间等附加行后再按同一上限截一次，所以端点收到的 `{{content}}` 不会超过 21000 字。Web Push 通知正文仍截到 400 字——推送服务对单条载荷有 4 KiB 硬上限。
- **Web Push 要求安全上下文**：`https://` 或 `http://localhost` / `127.0.0.1`。用 `http://` 访问一个域名（例如 `http://dsh.example.com`）时，浏览器不给注册 Service Worker，也就无法订阅推送。
- **Web Push 依赖推送服务可达**（Chrome 走 FCM / Edge 走 WNS）。网络不通时订阅会失败；本机自建中继可用 `http://127.0.0.1` 端点。
- 设置页保存时**不会**覆盖 `pushVapidPrivateKey` 与 `pushSubscriptions`（客户端根本拿不到这两个字段）。

## 测试

```bash
cd /root/dsh-webhook-notify && npm test
```

`npm test` 等价于 `node --test test/`；当前共 **73** 项，全绿。

覆盖：端点投递与模板、浏览器通知运行时、**RFC 8188 官方测试向量**（内容编码逐字节对齐）、HKDF（RFC 5869 + Node 内置实现交叉验证）、VAPID 签名、**Service Worker 源码真跑一遍**（push / notificationclick / 订阅失效）、以及一条**端到端推送**（宿主 → 本地 HTTP 推送服务 → 用浏览器侧私钥解密校验）。

## 开发说明

`node_modules` 是指向 profile 依赖的软链，只为本地跑测试时解析
`@deepseek-ai/schemastery` 用；删除它插件在宿主里仍能正常工作（宿主自己解析依赖），
但 `node --test` 会因找不到 schemastery 而失败。

新增文件：

| 文件 | 职责 |
|---|---|
| `lib/push.js` | VAPID 签名、aes128gcm 加密、推送发送 |
| `lib/sw.js` | Service Worker 源码（通知点击中转 + push；点击时按通知携带的 `autoFocus` 决定是否抢焦点） |
| `lib/browser-notify.js` | 浏览器通知运行时（页面半边的纯 ESM 孪生实现，页面侧那套由 `lib/client.js` 内联） |

宿主半边的改动需要宿主重新加载插件才会生效（Profile 重组合即可；`lib/index.js` 的改动不会热替换到已运行的进程里）。

