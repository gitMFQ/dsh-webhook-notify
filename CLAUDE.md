# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

DSH（DeepSeek Harness）通知插件：宿主进程推 Webhook、浏览器系统通知、PWA 与 Web Push。
纯 ESM JavaScript，**无构建、无 lint / 格式化脚本、无 CI**，改完直接跑测试。中文注释与文档是既有风格。

**零运行时依赖**（只有可选 peer `@deepseek-ai/schemastery`）：`lib/push.js` 手写 VAPID / HKDF / aes128gcm，
`lib/icon.js` 手写 SVG 栅格化 + zlib PNG，`lib/sw.js` 手写 Service Worker。不要为这些已有能力引入库
（例如 `web-push`、图像库）。

## 命令

- `npm test` — 即 `node --test test/`，当前 116 项；测试自带本地 HTTP 假宿主，不访问外网。
- 单文件：`node --test test/send.test.js`
- 单用例：`node --test --test-name-pattern '节流' test/`
- `node_modules` 是指向 `/root/.dsh/profiles/web/node_modules` 的**绝对软链**，仅为测试解析 `@deepseek-ai/schemastery`。
  它已在 `.gitignore` 里，不要提交；删掉后测试全挂，但插件在宿主里照常工作。
- 加密测试对齐 RFC 8188 §3.1 官方向量与 RFC 5869，别为「跑通」放宽断言。

## 改动生效方式（无 HMR）

- `lib/index.js` 等宿主半边：需 profile 重组合（重载插件）才生效。
- `lib/client.js`：宿主以文本下发，改完刷新页面。

## 必须同步的多份实现

浏览器通知 / Service Worker 行为有**三份孪生代码**，只改一处会出现「测试绿、实际不对」：

- `lib/client.js` 内联的那份（真正在页面里跑）
- `lib/browser-notify.js`（ESM 孪生，`test/browser-notify.test.js` 跑它）
- `lib/sw.js`（Service Worker 源码，宿主以文本下发到 `/webhook-notify/sw.js`）

`lib/client.js` 是手写 bundle：包在 `window.__ModuleLoader__.load({ id, factory(require) { … } })` 里，
用 `h()` 而非 JSX，无 TypeScript。新增界面文案必须同时进 `DICTS.zh` 与 `DICTS.en`。

## 设置页

- 只用 `--dsw-*` 设计令牌 + `require('@deepseek-ai/dsh-client-ui-primitives')` 的原子组件（Switch / Button / Pill…），
  取不到时用自带 `.wn-*` 样式兜底。
- **绝不引用 DSH 的 class**：那些是 CSS Modules 哈希，每次构建都变。结构与尺寸细节见 `docs/settings-ui-spec.md`。

## 不要破坏的安全不变量

- manifest 回源 `?src=` 只接受宿主自己的 `/manifest.webmanifest`，拒绝 query / hash / 跨源地址。
- `3xx` 不自动跟随；响应体最多读 64 KiB；请求头必须单字节 ASCII（中文放请求体）。
- 正文上限：Webhook 21000 字；Web Push 载荷正文 400 字（推送服务 4 KiB 硬限）。
- `/save` 有字段白名单：`pushVapidPrivateKey`、`pushSubscriptions` 永不下发、也不可被保存请求覆盖；配置写回串行化。
- 端点配置（含 webhook token 与 VAPID 私钥）落在 profile 的 `cordis.patch.yml`；仓库里这份只是空默认值 patch。

## 仓库礼仪

- 版本号两处同步：`package.json` 的 `version` 与 `lib/index.js` 的 `PLUGIN_VERSION`。
- 提交信息：中文单行、不加前缀；直接提交并推 `main`。
- 用户可见行为变了就更新 `README.md`（完整用户文档，含触发事件、各通道行为与已知坑）。
- 本机出网需代理时用 `http://127.0.0.1:7890`（对应配置项 `pushProxy`）。
