# webhook-notify 设置面板重构规格（对齐 DSH 自身设置页样式）

> 只读调研产物。调研对象：本机 DSH 0.2.1-rc.2（`/usr/lib/node_modules/@deepseek-ai/dsh/`）+ 运行中的 Web GUI（`http://127.0.0.1:3080`）+ 本 profile 已装外部插件（`/root/.dsh/profiles/web/node_modules/`）。
> 本文不改任何代码；`lib/*` 由 Lead 负责。文中的 CSS / DOM 可直接粘贴落地。

---

## 0. 结论（TL;DR）

1. **DSH 的 class 不能依赖，DSH 的组件可以依赖。**
   - 所有客户端包的 class 名都是 CSS Modules 哈希（`._switch_1ik0f_5`、`pI_x6G_frame`、`VOzbGW_panel`、`_2vuxea_row`），随每次构建变化，**外部插件绝不能写 `._row_abcd_3`、`VOzbGW_navCell` 这类选择器**；DSH 并没有一套 `.dsw-*` 的稳定 class 供人引用。
   - 但设置页用的原子组件由 shell 以**外部模块**形式暴露，任何 client bundle 都能 `require('@deepseek-ai/dsh-client-ui-primitives')` 拿到 `Button / Switch / Checkbox / Input / Tag / StateDot / Tooltip / Modal / 图标` 及 `SettingsForm / SettingsValueField`。本 profile 的 `dsh-better-sidebar`、`@michengai/dsh-skills-manager`、`dsh-ego-browser`、`dshmarket`、`dsh-providers-hub` 都在用（见 §2.2 证据）。
2. **`--dsw-*` 设计令牌才是唯一稳定契约。** 语义色板共约 100 个别名令牌（`--dsw-alias-*`）+ 圆角/字体/高程/焦点环。全部定义在 `dsh-client-ui-theme`，暗色在 `body[data-ds-dark-theme]` 下**整套覆写**。
3. **暗色模式不需要 `prefers-color-scheme`。** body 上的布尔属性 `data-ds-dark-theme` 由主题 boot script 依据「跟随系统 / 强制浅色 / 强制深色」用户设置写入；令牌自动切换。只在令牌表达不了的地方（例如 select 的内联 SVG 箭头颜色）才写 `body[data-ds-dark-theme] .wn-select{…}` 补一条。
4. **设置页内容区实际只有约 564px 宽**（800px 面板 − 188px 导航 − 48px 内边距），且 **shell 不渲染任何分区标题**（内容列头部只有「动作 + 关闭」）。所以：单列布局、`max-width` 只是上限、每行「标签左 / 控件右」必须在 ~560px 内成立、分区标题与说明由插件自己画。
5. **落地方式**：保留现有 `injectStyle()` 注入一份 `.wn-*` 样式表，把里面的 rgba 灰改成 `--dsw-*` 令牌；布局换成「section → 分区小标题 → group 卡片 → row」；开关/按钮/徽标优先用 primitives，缺失时用本文附带的等价自绘 CSS 兜底。

---

## 1. 设置 shell 的真实结构与尺寸链

设置面板 = `dsh-client-ui-settings-general` 的 `SettingsRoot`，`createPortal` 到 body，注册 6 个 slot：`settings.trigger / header / action / close / section / onboarding`。

```
div[role=presentation]                 // 全屏遮罩层
├─ div (mask, aria-hidden)             // 点击关闭
└─ div[role=dialog][aria-modal]        // 面板：width 800px, radius --dsw-radius-panel(28px),
   ├─ nav                              //    bg --dsw-alias-bg-layer-2, shadow --dsw-elevation-prominent
   │  ├─ div.navTitle                  //   "设置"标题（slot settings.header）
   │  └─ div.navList > button.navCell  //   188px 宽；每个 settings.section 一项，order 排序
   │     ├─ svg (navIcon)              //   ★ 图标由 shell 硬编码 id→图标映射
   │     └─ span.navLabel              //   label()
   └─ div.content                      //   flex:1, min-width:0
      ├─ div.header                    //   height 54px, padding 20px 14px 8px 10px
      │  ├─ div.actions                //   slot settings.action
      │  └─ button.close               //   28×28
      └─ div.options                   //   flex:1, overflow-y:auto, padding 0 24px 24px
         └─ <你的 section 组件>        //   ★ 没有标题、没有卡片、没有内边距
```

由此得出的硬数字（默认 1280 视口）：

| 项 | 值 | 出处 |
| --- | --- | --- |
| 面板宽 | `800px`，`max-width:calc(100vw - 48px)` | `SettingsRoot.module.css` `.panel` |
| 面板高 | `min(800px, calc(100vh - 2*max(24px, var(--dsh-frame-overlay-top,24px))))` | 同上 |
| 导航列 | `188px`，`gap:18px`，`padding:22px 12px 0` | `.nav` |
| 内容列头 | `54px`，padding `20px 14px 8px 10px` | `.header` |
| 内容滚动区 | `padding:0 24px 24px`，`overflow-y:auto` | `.options` |
| **内容可用宽** | **≈ 564px**（800−188−48） | 推算 |
| 导航行 | 高 `40px`，radius `--dsw-radius-md`，字号 14/22，hover `--dsw-specific-sidebar-nav-item-hover`，选中 `…-active` | `.navCell` |
| 导航图标 | **固定映射**：`account`→User，`models`→Data，`agent-presets`→AgentPreset，`plugins`→Personalization，`archived-sessions`→Archive，**其他一律 `IconSettingsOutlineMedium`(16px)** | `navIcon()`，`client.js:244` |

> ⚠️ `register({…, icon:'skill'})` 这种写法（`dsh-skills-manager` 在用）**当前版本被忽略**；`dsh-better-sidebar` 因此改用「DOM 打标记 + ::before mask」换图标。webhook-notify 不必折腾，接受通用齿轮。

---

## 2. 证据：可依赖 / 不可依赖

### 2.1 设计令牌（可依赖）

单一权威来源：`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`

- `:root` 字号/圆角/字体：**line 1407**（`base_css_default`）
- 静态色阶 + `body{…}` 浅色别名 + `body[data-ds-dark-theme]{…}` 深色别名：**line 1413**（`design_platform_css_default`）
- 焦点环：`focus.css`，`:root{--dsw-focus-ring-width:2px}` + `html[data-input-modality=pointer] body :focus-visible:not(:read-write){--dsw-focus-ring-color:transparent}`（**指针操作不显示焦点环，键盘操作才显示**）
- 暗色属性写入：`dsh-client-ui-theme/lib/index.js:158` → `document.body.toggleAttribute('data-ds-dark-theme', dark)`，同时 `documentElement.dataset.dsThemeSource = preference('light'|'dark'|'system')`

浅色/深色对照（本文会用到的那批）：

| 令牌 | 浅色 | 深色 |
| --- | --- | --- |
| `--dsw-alias-bg-base` | `#fff` (neutral-bluish-00) | `#151517` |
| `--dsw-alias-bg-layer-1` | `#fff` | `#232324` |
| `--dsw-alias-bg-layer-2` | `#fff` | `#2c2c2e` |
| `--dsw-alias-bg-layer-3` | `#fff` | `#353638` |
| `--dsw-alias-bg-module-platform` | `#f5f6f7` | `#353638` |
| `--dsw-alias-border-l1/l2/l3/l4` | `#0000000a` / `1a` / `1f` / `29` | `#ffffff0f` / `1f` / `29` / `fff3` |
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` |
| `--dsw-alias-label-dimmed` | `#e1e5ee` | `#43454a` |
| `--dsw-alias-label-primary-foreground` | `#fff` | `#0f1115` |
| `--dsw-alias-brand-primary` | `#0f1115`（近黑） | `#f9fafb`（近白） |
| `--dsw-alias-button-primary-fill` | `=brand-primary` | `=brand-primary` |
| `--dsw-alias-button-primary-hover` | `#43454a` | `#ebeef2` |
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` |
| `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` |
| `--dsw-alias-interactive-bg-hover-solid` | `#f1f3f5` | `#353638` |
| `--dsw-alias-interactive-bg-hover-danger` | `#ec13130d` | `#f25a5a26` |
| `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` |
| `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` |
| `--dsw-alias-state-warn-primary` | `#f59e0b` | `#f59e0b` |
| `--dsw-alias-state-warn-label` | `#dd8629` | `#dd8629` |
| `--dsw-alias-state-business-primary` | `#4176e6` | `#7aaaff` |
| `--dsw-alias-link` | `#4176e6` | `#7aaaff` |
| `--dsw-alias-markdown-code-block` | `#f9fafb` | `#1b1b1c` |
| `--dsw-alias-switch-thumb` | `#fff` | `#adb2b8` |
| `--dsw-alias-settings-card-fill` | `=bg-layer-2` | `=bg-layer-2` |
| `--dsw-alias-settings-card-stroke` | `=border-l4` | `=border-l4` |
| `--dsw-radius-xs/sm/md/lg/xl/panel` | `4 / 8 / 12 / 16 / 20 / 28 px` | 同 |
| `--dsw-font-family` / `--ds-font-family-code` | 系统 UI 栈 / SF Mono 栈 | 同 |
| `--dsw-elevation-soft/panel/prominent` | `--dsw-elevation-stroke` + 阴影 | 同 |
| `--dsw-focus-ring-width` / `--dsw-focus-ring-color` | `2px` / 默认 `transparent`（指针态） | 同 |

**黑名单（0.2.1-rc.2 中「有引用、无定义」，写了等于失效）**：

`--dsw-alias-bg-layer-4`、`--dsw-alias-label-error`、`--dsw-alias-accent-soft`（DSH 自己的 CSS 里也在误用），以及不存在的 `--dsw-alias-settings-*` 变体。若要类似效果用：

- 浅一层的底色 → `--dsw-alias-bg-layer-3` / `--dsw-alias-interactive-bg-hover`
- 错误文字 → `--dsw-alias-state-error-primary`

### 2.2 primitives 组件（可依赖）

- 模块表：`dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 中 `SZ()` 返回的 externals 表（**字节偏移 ≈ 916299**）明确包含
  `react / react/jsx-runtime / react-dom / react-dom/client / @deepseek-ai/cordis / zod / @tanstack/react-virtual / @deepseek-ai/dsh-client-store / @deepseek-ai/dsh-client-ui-slots / @deepseek-ai/dsh-client-ui-primitives / @deepseek-ai/dsh-client-ui-dockkit`。
- 组件与 props（从 bundle 逆推，**已核对**）：

| 组件 | 签名 | 渲染 |
| --- | --- | --- |
| `Button` | `({variant='ghost'\|'primary'\|'outline'\|'toolbar', size='md'\|'sm', icon, className, children, ...rest}, ref)` | 原生 `<button type=button>`，`rest` 透传（`disabled/onClick/aria-*`）；`md`=36px/14px，`sm`=28px/12px/radius-sm |
| `Switch` | `({checked, onChange(next), label, disabled, title, className})` | `<button role="switch" aria-checked aria-label>` + 36×20 track + 16px thumb |
| `Checkbox` | `({checked, onChange(next), label, disabled, title, className})` | `<label><input type=checkbox><span>label</span></label>` |
| `Input` | `forwardRef(({icon, className, ...rest}))` | `<span class=wrap><span class=icon>…</span><input ...rest></span>`，wrap 高 32px、`.5px` 边框、focus-within 变蓝 |
| `Tag` | `tone: outline\|solid\|neutral\|quiet\|success\|info\|warning\|danger` | 11px 胶囊徽标 |
| `Pill` | `({active, onClick})` | 24px 可选胶囊 |
| `StateDot` | `done\|warning\|error\|idle\|ongoing` | 10px 状态点（`aria-hidden`） |
| `SettingsForm` | `{labels:{unavailable,readOnly,saveFailed,save,saving}, state, onSave, onDiscard, children}` | 表单框架：`save` 按钮 + 错误行 + 16px 顶部间距 footer |
| `SettingsValueField` | `{id,label,hint,overriddenLabel,resetLabel,invalidLabel,numeric,disabled,...field,onEdit,onReset}` | 「标签 + 控件 + hint + 覆盖徽标 + 重置」一体字段 |
| 图标 | `IconXxxOutlineRegular`(1px) / `…Medium`(1.3px)，`size` 控尺寸 | 装饰性，无 label |

- 生态内实际使用者（本机可验证）：`dsh-better-sidebar`（`Button/Switch/Input/Tag/Pill/StateDot/Tooltip/Modal/Menu/图标`）、`@michengai/dsh-skills-manager`（`Button/SegmentedTabs/Input/Modal`）。二者 `package.json` 的 `dsh.client.inject` 里**都没有**列 primitives —— 说明它作为 shell 内置 external 始终可用，**不需要改 package.json**。
- 引用方式建议（防御式，模块缺失时降级为自绘）：

```js
let P = null;
try { P = require('@deepseek-ai/dsh-client-ui-primitives'); } catch { P = null; }
const Button = P ? P.Button : null;   // null 时用 h('button', {className:'wn-btn …'})
```

### 2.3 现有外部插件的设置页写法（范本）

| 插件 | 位置 | 做法 | 结论 |
| --- | --- | --- | --- |
| `dsh-better-sidebar` | `lib/client.js`，`SideCardSection.module.css` 内联于 **line 518005** 起的 CSS 常量；section 组件在 `function SideCardSection` | **最贴近我们的范本**：自己写 CSS（全 `--dsw-*` 令牌），布局 `section(intro) → group(标题+row) → row(左 label/desc，右控件)`，开关用「原生 checkbox + `:checked + .track`」，按钮是 `background:--dsw-alias-label-primary;color:--dsw-alias-bg-layer-3`，另大量复用 primitives | 推荐照抄结构 |
| `@michengai/dsh-skills-manager` | `lib/client.js` | 自己写 `.dssm-*` CSS，`settings.section` 里渲染 `s('style', {key:'css'}, Zn)`（把 `<style>` 塞进组件树），重活交给 primitives（`Button/SegmentedTabs/Modal`） | `<style>` 进组件树可（React 19 会 hoist），但**不加 id 判重会重复插入**；我们仍用 head 注入更稳 |
| `dsh-client-ui-settings-models`（DSH 官方 section） | `lib/client.js:58` | `section` `max-width:720px;gap:12px`，`title` 16/500/24，`intro` 14/22 tertiary，`rowCard` = `.5px settings-card-stroke + radius-xl + settings-card-fill`，`primaryButton/secondaryButton/dangerButton/iconButton` 一整套 | 官方按钮三态的标准配方（见 §4） |
| `dsh-client-ui-settings-session-log` | `lib/client.js:55` | `.row{border-bottom:.5px solid border-l2; justify-content:space-between; align-items:center; gap:24px; padding:16px 0}` + `.title 14/20` + `.description 12/18 secondary` | **「设置行」的最小定义**，我们的 `.wn-row` 直接对齐它 |
| `dsh-client-ui-settings-web-search` | `lib/client.js:88` | `.toggleRow{justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5}` + `.hint 12/1.5 tertiary` | 开关行配方（开关多时用它） |
| `dsh-client-ui-settings-plugins` | `lib/client.js:11` | `section` `max-width:760px;gap:12px`，`heading` 18/600，`intro` 13，自定义 tabs（选中态 2px 下划线） | 分组/页签参考 |
| `dsh-client-ui-settings-plugin-inventory` | `lib/client.js:57` | `section` `max-width:760px;gap:14px; container:… inline-size`，卡片网格 + `@container (width<=520px)` 降为单列 | 窄屏策略参考（container query） |
| `dsh-client-ui-settings-shell`（官方插件配置页） | `lib/client.js`（全文件） | 直接 `SettingsForm + SettingsValueField + SettingsFormModel`，**一行 CSS 都不写** | 若想「零自绘」，这是官方唯一姿势 |

---

## 3. 推荐 DOM 结构

### 3.1 树

```
section.wn-section                                  ← 根：单列、gap 16、max-width 640
├─ header.wn-head
│  ├─ h2.wn-title                                   ← 16/500/24（可省略，导航已有名字）
│  └─ p.wn-intro                                    ← 13/20 tertiary
├─ div.wn-group                                     ← 卡片：hairline + 16px 圆角，内部行间用分隔线
│  ├─ div.wn-groupTitle                             ← 13/600/20 分组名（「通知时机」「浏览器通知」…）
│  ├─ div.wn-row                                    ← 开关行：左文本、右控件
│  │  ├─ div.wn-rowText
│  │  │  ├─ span.wn-rowLabel                        ← 14/22 primary
│  │  │  └─ span.wn-rowHint                         ← 12/18 tertiary（可缺）
│  │  └─ div.wn-rowControl                          ← Switch / Button / Tag
│  ├─ div.wn-row.wn-row--field                      ← 输入行：左文本、右输入（240px）
│  │  ├─ div.wn-rowText …（同上）
│  │  └─ div.wn-rowControl > input.wn-input
│  └─ div.wn-row.wn-row--stack                      ← 高控件行：textarea / 多按钮，标签在上
│     ├─ div.wn-rowText …
│     └─ div.wn-rowControl.wn-rowControl--fill > textarea.wn-textarea
├─ div.wn-subhead                                   ← 无卡片的分区小标题（端点、预览、最近记录）
│  ├─ h3.wn-h3
│  └─ p.wn-hint
├─ div.wn-card                                      ← 独立卡片（单个端点：名称 + 方法/URL + 订阅 + 测试/删除）
│  ├─ div.wn-cardHead  (input.wn-input.wn-input--name, Tag, iconBtn.wn-iconBtn--danger)
│  ├─ div.wn-field > label.wn-fieldLabel + input/select/textarea
│  └─ div.wn-actions
├─ div.wn-empty                                     ← 空状态（虚线框）
├─ div.wn-notice.wn-notice--warn|-error             ← 提示条
├─ pre.wn-pre                                       ← 预览/诊断代码块
├─ ul.wn-log > li.wn-logRow                         ← 最近记录
│  ├─ span.wn-logDot (或 primitives.StateDot)
│  ├─ span.wn-logTime / span.wn-logName
│  └─ span.wn-logMeta
└─ div.wn-actions.wn-actions--end                   ← [新增端点] [预览] [保存]
```

### 3.2 用 `React.createElement` 写（与现有代码同风格）

```js
const h = React.createElement;

const row = (label, hint, control, mod) =>
  h('div', { className: 'wn-row' + (mod ? ' ' + mod : '') }, [
    h('div', { className: 'wn-rowText', key: 't' }, [
      h('span', { className: 'wn-rowLabel', key: 'l' }, label),
      hint ? h('span', { className: 'wn-rowHint', key: 'h' }, hint) : null,
    ]),
    h('div', { className: 'wn-rowControl', key: 'c' }, control),
  ]);

// 开关：优先 primitives，缺失时用原生 checkbox + .wn-switch 皮肤
const toggle = (checked, onChange, label) =>
  P && P.Switch
    ? h(P.Switch, { checked: !!checked, onChange, label })
    : h('label', { className: 'wn-switch' }, [
        h('input', {
          type: 'checkbox',
          className: 'wn-switchInput',
          checked: !!checked,
          'aria-label': label,
          onChange: (e) => onChange(e.currentTarget.checked),
        }),
        h('span', { className: 'wn-switchTrack', 'aria-hidden': 'true' }, [
          h('span', { className: 'wn-switchThumb', key: 'th' }),
        ]),
      ]);
```

### 3.3 挂载点不变

```js
ctx.slots.inject('settings.section', () =>
  ctx.slots.register(
    { name: 'settings.section', id: 'webhook-notify', order: 46, label: () => t('nav'), locale: NS },
    function WebhookNotifySettingsSection() { … return h(Panel, { ctx, t }); },
  ),
);
```

组件收到的 props 只有 `{ close }`（+ 自身 `inject` 提供的东西），**shell 不给标题、不给卡片、不给滚动容器样式**。

---

## 4. 可直接粘贴的 CSS

> 全部变量都写了回退值；若某令牌在未来版本改名，面板仍可读。放进现有 `STYLE` 常量即可（`injectStyle()` 已有「内容不同才替换」逻辑，HMR 安全）。

```css
/* ==========================================================================
   webhook-notify 设置面板
   - 只吃 --dsw-* 设计令牌（暗色由令牌自动切换，见 §5）
   - 布局对齐 dsh-client-ui-settings-* 的 section / row / card 配方
   ========================================================================== */

/* ---- 1. 根容器与标题 ---------------------------------------------------- */
.wn-section {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 640px;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 13px;
  line-height: 20px;
}
.wn-head { display: flex; flex-direction: column; gap: 4px; }
.wn-title { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
.wn-intro {
  margin: 0;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 13px;
  line-height: 20px;
  text-wrap: pretty;
}

/* 无卡片的分区小标题 */
.wn-subhead { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.wn-h3 { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; }
.wn-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

/* ---- 2. 分组卡片 -------------------------------------------------------- */
/* 行间用 hairline 分隔（light 下 layer 全白，卡片只能靠边框区分，别指望底色差） */
.wn-group {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 4px 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16)));
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-settings-card-fill, transparent);
}
.wn-groupTitle {
  padding: 10px 0 2px;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}

/* 独立卡片（单个端点 / 预览容器） */
.wn-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16)));
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-settings-card-fill, transparent);
}
.wn-cards { display: flex; flex-direction: column; gap: 10px; }
.wn-cardHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* ---- 3. 行：标签左 / 控件右 -------------------------------------------- */
.wn-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
}
.wn-row + .wn-row { border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1)); }
.wn-groupTitle + .wn-row { padding-top: 8px; }   /* 紧跟分组标题的第一行收紧 */
.wn-row:last-child { padding-bottom: 10px; }

.wn-rowText { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; }
.wn-rowLabel {
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 14px;
  line-height: 22px;
}
.wn-rowHint {
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.wn-rowControl { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; min-width: 0; }

/* 高控件（textarea / 按钮组）：标签在上，控件占满 */
.wn-row--stack { align-items: stretch; flex-direction: column; gap: 8px; }
.wn-rowControl--fill { flex: 1 1 auto; width: 100%; flex-wrap: wrap; justify-content: flex-start; }

/* ---- 4. 开关（原生 checkbox 皮肤；有 primitives.Switch 时不必用） ------- */
.wn-switch { position: relative; display: inline-flex; flex: none; cursor: pointer; }
.wn-switchInput {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
}
.wn-switchTrack {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  width: 36px;
  height: 20px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  transition: background 0.12s ease;
}
.wn-switchThumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #fff);
  transition: transform 0.12s ease, background 0.12s ease;
}
.wn-switch:hover .wn-switchTrack { background: var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16)); }
.wn-switchInput:checked + .wn-switchTrack { background: var(--dsw-alias-brand-primary, #0f1115); }
.wn-switchInput:checked + .wn-switchTrack .wn-switchThumb {
  background: var(--dsw-alias-label-primary-foreground, #fff);
  transform: translateX(16px);
}
.wn-switchInput:focus-visible + .wn-switchTrack {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
  outline-offset: 2px;
}
.wn-switchInput:disabled + .wn-switchTrack { opacity: 0.5; cursor: default; }

/* ---- 5. 按钮 ----------------------------------------------------------- */
/* 主按钮 = 反色药丸（DSH 的 primary 是近黑/近白，不是蓝色！） */
.wn-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.wn-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.wn-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(38, 49, 72, 0.1)); }
.wn-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.wn-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
  outline-offset: 1px;
}

/* 主按钮：保存 / 立即发送测试 */
.wn-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #0f1115);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.wn-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #43454a); }

/* 中号（页面底部动作区） */
.wn-btn--md {
  height: 36px;
  padding: 0 14px;
  border-radius: var(--dsw-radius-md, 12px);
  font-size: 14px;
  line-height: 22px;
}

/* 危险：删除端点。常态透明 + 红字，hover 才上淡红底 */
.wn-btn--danger { border-color: transparent; background: transparent; color: var(--dsw-alias-state-error-primary, #ec1313); }
.wn-btn--danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
}
/* 需要「确认删除」强调时再加边框 */
.wn-btn--dangerSolid:not(:disabled) {
  border-color: var(--dsw-alias-state-error-primary, #ec1313);
  color: var(--dsw-alias-state-error-primary, #ec1313);
}

/* 图标按钮：28×28，删除端点、复制、显示/隐藏密钥 */
.wn-iconBtn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit;
  cursor: pointer;
}
.wn-iconBtn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-primary, #0f1115);
}
.wn-iconBtn--danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
  color: var(--dsw-alias-state-error-primary, #ec1313);
}
.wn-iconBtn:disabled { opacity: 0.4; cursor: not-allowed; }

/* 动作区 */
.wn-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wn-actions--end { justify-content: flex-end; padding-top: 4px; }
.wn-actions .wn-btn--primary { margin-left: auto; }

/* ---- 6. 输入 / 下拉 / 文本域 ------------------------------------------- */
.wn-input,
.wn-select,
.wn-textarea {
  box-sizing: border-box;
  width: 100%;
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  outline: none;
}
.wn-input,
.wn-select { height: 32px; padding: 0 10px; }
.wn-textarea {
  min-height: 64px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
}
.wn-input::placeholder,
.wn-textarea::placeholder { color: var(--dsw-alias-label-dimmed, #e1e5ee); }
.wn-input:focus,
.wn-select:focus,
.wn-textarea:focus { border-color: var(--dsw-alias-state-business-primary, #4176e6); }
.wn-input:focus-visible,
.wn-select:focus-visible,
.wn-textarea:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 18%, transparent);
}
.wn-input:disabled,
.wn-textarea:disabled { opacity: 0.6; cursor: default; }
.wn-input[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary, #ec1313); }

/* 行内尺寸变体 */
.wn-input--w240 { width: 240px; }
.wn-input--w120 { width: 120px; }
.wn-input--name { width: 180px; }
.wn-input--num { width: 120px; font-variant-numeric: tabular-nums; }
.wn-rowControl--fill .wn-input,
.wn-rowControl--fill .wn-textarea { width: 100%; }

/* 等宽场景（URL / 模板 / 密钥） */
.wn-input--mono,
.wn-textarea--mono,
.wn-pre,
.wn-mono {
  font-family: var(--ds-font-family-code, "SF Mono", Menlo, Consolas, monospace);
}
.wn-textarea--mono { font-size: 12px; line-height: 1.55; }

/* 下拉：去掉原生箭头，用中性灰 chevron（色值 = label-tertiary） */
.wn-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 30px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: right 10px center;
  background-repeat: no-repeat;
  background-size: 12px 12px;
  cursor: pointer;
}

/* 字段列布局（长文本/密钥这类，标签在上更省宽） */
.wn-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.wn-fieldLabel {
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}

/* ---- 7. 提示条 / 徽标 / 代码块 ----------------------------------------- */
.wn-notice {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--dsw-radius-md, 12px);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 8%, transparent);
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.wn-notice--warn {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 12%, transparent);
  color: var(--dsw-alias-state-warn-label, #dd8629);
}
.wn-notice--error {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 8%, transparent);
  color: var(--dsw-alias-state-error-primary, #ec1313);
}
.wn-notice--ok {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 10%, transparent);
  color: var(--dsw-alias-state-success-primary, #22c55e);
}

/* 徽标（事件类型、方法）。有 primitives.Tag 时优先用它 */
.wn-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 1px 8px;
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16));
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
  white-space: nowrap;
}
.wn-chip--ok {
  border-color: transparent;
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 10%, transparent);
  color: var(--dsw-alias-state-success-primary, #22c55e);
}
.wn-chip--fail {
  border-color: transparent;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 10%, transparent);
  color: var(--dsw-alias-state-error-primary, #ec1313);
}

/* 代码块 / 预览（等宽、可换行、横向不溢出） */
.wn-pre {
  box-sizing: border-box;
  margin: 0;
  max-height: 240px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-markdown-code-block, #f9fafb);
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow: auto;
  overflow-wrap: anywhere;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(0, 0, 0, 0.2)) transparent;
}
.wn-pre::-webkit-scrollbar { width: 8px; }
.wn-pre::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(0, 0, 0, 0.2));
  background-clip: padding-box;
}
.wn-pre::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, rgba(0, 0, 0, 0.3)); background-clip: padding-box; }

.wn-mono {
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

/* ---- 8. 空状态 --------------------------------------------------------- */
.wn-empty {
  padding: 16px;
  border: 1px dashed var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: var(--dsw-radius-lg, 16px);
  color: var(--dsw-alias-label-tertiary, #81858c);
  text-align: center;
  font-size: 13px;
  line-height: 20px;
}

/* ---- 9. 最近记录列表 --------------------------------------------------- */
.wn-log {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  max-height: 240px;
  list-style: none;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(0, 0, 0, 0.2)) transparent;
}
.wn-logRow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  font-size: 12px;
  line-height: 18px;
}
.wn-logRow + .wn-logRow { border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1)); }
.wn-logTime {
  flex: none;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-family: var(--ds-font-family-code, monospace);
  font-variant-numeric: tabular-nums;
}
.wn-logName {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, #0f1115);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wn-logMeta {
  flex: none;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
/* 状态点（或直接用 primitives.StateDot） */
.wn-logDot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.wn-logDot--ok { background: var(--dsw-alias-state-success-primary, #22c55e); }
.wn-logDot--fail { background: var(--dsw-alias-state-error-primary, #ec1313); }

/* ---- 10. 窄屏堆叠 ------------------------------------------------------ */
/* 论理内容列恒约 564px；viewport < 560 时面板本身被压到 calc(100vw - 48px) */
@media (max-width: 560px) {
  .wn-section { max-width: none; gap: 12px; }
  .wn-group { padding: 4px 12px; }
  .wn-row,
  .wn-row--stack { flex-direction: column; align-items: stretch; gap: 8px; }
  .wn-rowControl { width: 100%; flex-wrap: wrap; justify-content: flex-start; }
  .wn-input--w240,
  .wn-input--name { width: 100%; }
  .wn-input--w120,
  .wn-input--num { width: 120px; }
  .wn-actions--end { justify-content: stretch; }
  .wn-actions .wn-btn { flex: 1 1 auto; }
}

/* 减少动效偏好 */
@media (prefers-reduced-motion: reduce) {
  .wn-switchTrack,
  .wn-switchThumb,
  .wn-btn { transition: none; }
}
```

---

## 5. 暗色模式

**机制**：`body` 上的布尔属性 `data-ds-dark-theme`。

- 由主题 boot script 在首帧前写入（`document.body.toggleAttribute('data-ds-dark-theme', dark)`，`dsh-client-ui-theme/lib/index.js:158`），`preference` 来自用户设置（浅色 / 深色 / 跟随系统），`<html data-ds-theme-source="light|dark|system">` 记录来源。
- `dsh-client-ui-theme` 在同一张样式表里给出**两套完整令牌**：`body{…胜出=浅色…}` 与 `body[data-ds-dark-theme]{…同名的第二套…}`。因此**只要你的 CSS 用 `var(--dsw-*)`，暗色自动生效，零额外代码**。
- 现在的 `.wn-*` 用的是 `rgba(128,128,128,.x)` 手动灰 + 硬编码蓝色主按钮：在深色下对比度偏低、主按钮与 DSH 其余部分不一致——这正是要改掉的东西。

**需要手写暗色的极少数情况**（令牌表达不了）：

```css
/* select 的内联 SVG 箭头颜色是字面量，令牌管不到 */
body[data-ds-dark-theme] .wn-select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%23ADB2B8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
```

**不要**用 `@media (prefers-color-scheme: dark)`：那只是「跟随系统」时的输入条件；用户强制浅色/深色时它会给出错误结果。规则固定是：

1. 首选令牌（自动）；
2. 令牌不够 → `body[data-ds-dark-theme] <你的选择器>`；
3. 再不够 → 自定义属性在 `:root` 定义，在 `body[data-ds-dark-theme]` 覆写，页面里只用变量。

---

## 6. 复用决策表（照此执行）

| UI 元素 | 结论 | 做法 |
| --- | --- | --- |
| 分区标题 / 说明 | 必须自绘 | `.wn-title` 16/500/24 + `.wn-intro` 13/20 tertiary（shell 一个标题都不给） |
| 分组卡片 | 必须自绘（不可套 class） | `.wn-group`：`.5px` `--dsw-alias-settings-card-stroke` + `--dsw-radius-lg` |
| 行（label 左 / 控件右） | 结构自绘 | `.wn-row`，对齐 `dsh-client-ui-settings-session-log` 的 `.row` 配方 |
| 开关 | **优先 `primitives.Switch`**，否则 `.wn-switch`（原生 checkbox + `:checked +` 皮肤，键盘/无障碍零成本） | 两者视觉一致（36×20、thumb 16、on=brand-primary） |
| 按钮 | **优先 `primitives.Button`**（`variant:'primary'\|'outline'\|'ghost'`，`size:'sm'\|'md'`）；无 primitives 时用 `.wn-btn` | 注意：DSH 的 primary 是**反色**药丸，不是蓝色；`danger` 变体 primitives **没有**，必须自绘 `.wn-btn--danger` |
| 图标按钮（删除/复制/显示密钥） | 自绘 `.wn-iconBtn`（primitives 无此原子） | hover 用 `--dsw-alias-interactive-bg-hover(-danger)` |
| 输入框 | **优先 `primitives.Input`**（高 32、`.5px` 边框、focus-within 变蓝）；需要 `type=number`/自定义宽度时用 `.wn-input` | `primitives.Input` 是 wrap+input，宽度靠 `className` 控 |
| 下拉 | 自绘 `.wn-select`（primitives 无 Select） | 用 DSH 同款 chevron；`appearance:none` |
| 文本域 | 自绘 `.wn-textarea`（primitives 无 TextArea） | 模板/请求体用 `--mono` 变体 |
| 提示条 | 自绘 `.wn-notice--warn/-error/-ok` | `color-mix` 8~12% 状态色底 + 状态色文字（DSH 的 Tag/notice 就是这个比例） |
| 代码块 / 预览 | 自绘 `.wn-pre`；若已引 primitives，可用 `CodeBlock` / `TerminalBlock` 获得带复制按钮的卡片 | 底色 `--dsw-alias-markdown-code-block` |
| 空状态 | 自绘 `.wn-empty` | 虚线 `--dsw-alias-border-l3` + 居中 tertiary |
| 最近记录列表 | 自绘 `.wn-log` + `.wn-logRow`（状态点可用 `StateDot`） | 三列：时间 / 名称 / 状态，`max-height:240` 内部滚动 |
| 徽标 | **优先 `primitives.Tag`**（8 种 tone），否则 `.wn-chip` | — |
| 表单「保存/重置」框架 | 可选：`SettingsForm + SettingsValueField + SettingsFormModel`（官方插件配置页零 CSS 的做法） | 若沿用现有「整面板一张表单 + 底部保存」，不要引入它，避免两套提交语义 |
| 设置页导航图标 | **做不到** | shell 硬编码 id→图标，`icon:` 字段被忽略 |

**稳定性评估**

- 可依赖：`settings.section` 契约（`name/id/order/label/locale`，组件收 `{close, renderSlot}`）、primitives 组件 API、`--dsw-*` 令牌、`body[data-ds-dark-theme]`。
- 不可依赖：任何哈希 class、`data-slot` 之外的内部 DOM 结构、`--dsw-alias-bg-layer-4` 等无定义令牌、`settings.section` 的 `icon`。
- 升级风险点（每次 DSH 升版值得瞄一眼）：令牌改名、primitives 组件 props 变更、面板宽度/内边距调整（`--dsw-radius-panel` 仍为 28、面板 800 若变会让 564px 假设失效；但因为是单列流式布局，变宽只会更好看，不会崩）。

---

## 7. `.wn-*` → 新结构迁移映射

| 现有 | 改为 |
| --- | --- |
| `.wn-root` | `.wn-section`（gap 16 / max-width 640，去掉 `font-size:13px` 之外的假设） |
| `.wn-head .wn-title`（15/600） | `.wn-title`（16/500/24）+ `.wn-intro` |
| `.wn-card`（同时用于「设置分组」和「端点卡片」） | 分组 → `.wn-group`（行间分隔线）；实体卡片 → `.wn-card`（gap 10、padding 12/14） |
| `.wn-row`（label 42% + control 58%） | `.wn-row` / `.wn-row--stack`，label `flex:1`、控件 `flex:none`；输入行 `.wn-input--w240` |
| `.wn-rowLabel`（13/500） | 14/22 primary（对齐 settings-session-log `.title`） |
| `.wn-rowHint`（opacity .72） | `--dsw-alias-label-tertiary` 12/18（**不要用 opacity**，深色下会糊） |
| `toggle()` 返回裸 `<input type=checkbox>` | `primitives.Switch` 或 `.wn-switch`（原生 checkbox + 皮肤） |
| `.wn-btn`（灰底+灰边） | `.wn-btn`（透明 + `.5px border-l3`） |
| `.wn-primary`（`#4f7fe0` 蓝底白字） | `.wn-btn--primary`（`--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`） |
| `.wn-danger`（hover 变红边） | `.wn-btn--danger`（红字 + `--dsw-alias-interactive-bg-hover-danger` 底） |
| `.wn-input/.wn-select/.wn-textarea`（`rgba(128,128,128,…)`） | §4 第 6 节（`border-l4` / `bg-layer-1` / focus 蓝边 + 18% ring） |
| `.wn-note`（蓝底 14%） | `.wn-notice`（8%）/ `.wn-notice--warn|error|ok` |
| `.wn-pre`（灰底） | `--dsw-alias-markdown-code-block` + `--ds-font-family-code` + 滚动条令牌 |
| `.wn-empty` | 虚线 `border-l3` + tertiary 居中 13/20 |
| `.wn-recent`（单行等宽文本） | `.wn-log > .wn-logRow`（时间/名称/状态三段 + 状态点） |
| `.wn-mono`（opacity .82） | `--dsw-alias-label-tertiary`（同样别用 opacity） |
| `.wn-sectionHead` + `.wn-h3` | `.wn-subhead` + `.wn-h3`（13/600/20）+ `.wn-hint`（12/18） |
| `.wn-kinds`（flex 12px gap） | `.wn-chip` 胶囊列表，或 `primitives.Tag` |
| `@media (max-width:720px)` 竖排 | `@media (max-width:560px)`（面板被压窄的真实阈值） |

---

## 8. 落地注意（实现层，供 Lead 参考）

1. **样式注入**：继续用 `injectStyle()`（`<style id="dsh-webhook-notify-style">` + 文本比较），不要像 skills-manager 那样往组件树里塞 `<style>`（重复渲染会重复插入，除非有 key 去重）。HMR 下文本变化会就地替换，安全。
2. **primitives 引用放在 factory 顶部并 try/catch**（见 §2.2），模块表变化时降级而不是整块 entry 加载失败。
3. **焦点样式**：用 `outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, …)`。指针点击时不显示（shell 会把 `--dsw-focus-ring-color` 覆盖成 transparent），键盘 Tab 才显示 —— 这是 DSH 的既定行为，别自己写 `:focus{outline:…}`。
4. **不要用 `opacity` 表达「次要文字」**：深色下会糊。统一 tertiary / secondary 令牌。
5. **数字用 `font-variant-numeric: tabular-nums`**：节流毫秒、状态码、耗时都对得齐。
6. **动效**：只用 `background/transform` 的 0.12–0.15s，并给 `prefers-reduced-motion` 兜底（DSH 全站如此）。
7. **无障碍**：自绘开关必须 `role`/`aria-checked`（用 primitives.Switch 或原生 checkbox 即可自动满足）；图标按钮必须 `aria-label`；最近记录列表用 `<ul>/<li>`。
8. **i18n**：所有新出现的字符串继续走 `DICTS`，不要在 CSS 里写内容文字（`content:"✓"` 之类）。

---

## 9. 验收清单

- [ ] 浅色/深色切换（设置 → 外观 → 浅色/深色/跟随系统）后，面板无「白底白字 / 黑底黑字 / 硬编码蓝色」残留。
- [ ] 指针点击控件后无焦点环；键盘 Tab 有 2px 蓝色焦点环（自动，不需额外 CSS）。
- [ ] 面板内容区在 1280 视口下不出现横向滚动条（≈564px 内布局成立）。
- [ ] 把视口压到 ≤560px（或用移动端模拟）时，行内控件堆叠、输入框全宽。
- [ ] 开关在浅色为「近黑 track + 白 thumb」，深色为「近白 track + 深 thumb」；关闭态 track 是半透明描边色。
- [ ] 主按钮观感与 DSH「保存」一致（反色药丸），而不是蓝色。
- [ ] 危险操作（删除端点）默认不抢眼，hover 才泛红底；有 `aria-label`。
- [ ] 最近记录空态显示 `.wn-empty` 文案，非空时列表最多 240px 高、内部滚动、有分隔线。
- [ ] 预览/诊断代码块可横向滚动不撑破面板，长 URL 换行。
- [ ] `grep -n "rgba(128,128,128" lib/client.js` 无结果；`grep -n "#4f7fe0\|#e5534b" lib/client.js` 无结果。
- [ ] `node --test test/` 仍绿（样式改动不应影响逻辑测试）。

---

## 附录 A：调研文件索引（含行号/偏移）

| 用途 | 路径 | 位置 |
| --- | --- | --- |
| 设置 shell（面板/导航/内容区/图标映射） | `…/dsh-client-ui-settings-general/lib/client.js` | CSS `line 60`；`navIcon` `line 244`；`SettingsPanel` `line 269` |
| `settings.section` 契约 | `…/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts` | `line 66–77`（slot）、`line 154–157`（owner props `{close}`） |
| 令牌定义（浅/深两套）、圆角、字体、焦点环 | `…/dsh-client-ui-theme/lib/client.js` | `line 1407`（`:root`）、`line 1413`（色板 + `body[data-ds-dark-theme]`）、focus 片段在同文件 `focus_css_default` |
| 暗色属性写入 | `…/dsh-client-ui-theme/lib/index.js` | `line 158` `toggleAttribute('data-ds-dark-theme', dark)` |
| primitives externals 表 | `…/dsh-web-frontend/dist/assets/index-CN7NIWNw.js` | 字节偏移 ≈ `916299`（`"@deepseek-ai/dsh-client-ui-primitives":zU`） |
| primitives 组件 CSS（哈希类，仅供比对数值） | `…/dsh-web-frontend/dist/assets/index-BxpfOGf3.css` | `._button_1rv3m_*`、`._switch_1ik0f_*`、`._checkbox_1wz3s_*`、`._wrap_14sgc_*`、`._tag_brmue_*`、`._pill_1bqmh_*`、`._input_bjqpo_*` |
| primitives 官方说明（组件目录/语义） | 备份快照 `…/dsh-update-checker-backups/2026-10-16T00-42-41-962Z/main-snapshot/…/dsh-client-ui-primitives/README.md` | `line 26–110`（0.2.0 文档，API 与 0.2.1 一致） |
| 官方设置节 CSS 参考 | `…/dsh-client-ui-settings-models/lib/client.js` | `line 58`（按钮三态、rowCard、input、select） |
| 「设置行」最小配方 | `…/dsh-client-ui-settings-session-log/lib/client.js` | `line 55` |
| 开关行配方 | `…/dsh-client-ui-settings-web-search/lib/client.js` | `line 88` |
| 分组/tabs | `…/dsh-client-ui-settings-plugins/lib/client.js` | `line 11` |
| 卡片网格 + container query | `…/dsh-client-ui-settings-plugin-inventory/lib/client.js` | `line 57` |
| **外部插件范本（最贴近）** | `/root/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/client.js` | `SideCardSection.module.css` CSS 常量 `line 518005` 起；`function SideCardSection` / `Switch` / `renderCard` |
| 外部插件范本（primitives 重度使用者） | `/root/.dsh/profiles/web/node_modules/@michengai/dsh-skills-manager/lib/client.js` | `settings.section` 注册（`icon:"skill"` 被忽略的实例）；`s('style',{key:'css'},…)` |
| 官方「零 CSS」插件配置页 | `…/dsh-client-ui-settings-shell/lib/client.js` | 全文（`SettingsForm + SettingsValueField`） |
| 本文改造对象 | `/root/dsh-webhook-notify/lib/client.js` | `STYLE` 常量、`injectStyle()`、`row()`、`toggle()`、`Panel` 返回的 `.wn-root` 树、`settings.section` 注册（行号随 Lead 并行编辑而浮动） |

## 附录 B：反例（别做）

- ❌ `.wn-panel{width:800px;border-radius:28px}` 之类模仿 shell 外壳：section 已经在外壳里了，画第二层外壳会双层圆角/双层遮罩。
- ❌ 用 `[data-slot="settings.section"]` 反查宿主 DOM 改样式（better-sidebar 为图标 hack 过，代价是 MutationObserver + 版本判定，不值得为配色复制）。
- ❌ `background: var(--dsw-alias-bg-layer-4)`（当前版本无定义）。
- ❌ `@media (prefers-color-scheme: dark)` 做面板暗色。
- ❌ 用 `opacity:.72` 表示次要文字。
- ❌ 沿用 `#4f7fe0` 蓝色主按钮（DSH 主按钮是反色，蓝色只用于链接/焦点/业务强调 `--dsw-alias-state-business-primary`）。
