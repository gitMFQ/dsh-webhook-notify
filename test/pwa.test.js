/**
 * PWA manifest 的测试：改写 index.html 里的链接、合并宿主 manifest、
 * 以及 manifest 路由的行为（含抓不到原 manifest 时的降级）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAPTURE_PATH,
  NO_PULL_TO_REFRESH_MARKER,
  absolutizeManifestUrls,
  disablePullToRefresh,
  injectInstallCapture,
  localizeManifestUrls,
  manifestHref,
  mergeManifest,
  queryOf,
  resolveHostManifestSource,
  rewriteManifestLink,
} from '../lib/pwa.js';

const HOST_MANIFEST = {
  name: 'DeepSeek Harness',
  short_name: 'DSH',
  start_url: './',
  scope: './',
  display: 'fullscreen',
  icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
};

test('rewriteManifestLink：改写 manifest 链接并保留其它属性', () => {
  const html = '<html><head><link rel="manifest" href="./manifest.webmanifest" /><link rel="icon" href="./favicon.svg" /></head><body></body></html>';
  const out = rewriteManifestLink(html);
  assert.match(out, /<link rel="manifest" href="\/webhook-notify\/manifest\.webmanifest\?src=\.%2Fmanifest\.webmanifest"/);
  // 其它 link 不受影响。
  assert.match(out, /<link rel="icon" href="\.\/favicon\.svg"/);
  // 原地址被编码进 src，宿主路由据此回源抓取。
  assert.match(out, /src=\.%2Fmanifest\.webmanifest/);
});

test('rewriteManifestLink：没有 manifest 链接时补一条', () => {
  const html = '<html><head><title>x</title></head><body></body></html>';
  const out = rewriteManifestLink(html);
  assert.match(out, /<link rel="manifest" href="\/webhook-notify\/manifest\.webmanifest"/);
  assert.ok(out.indexOf('<link rel="manifest"') < out.indexOf('</head>'));
});

test('rewriteManifestLink：属性顺序不同也能改到', () => {
  const html = '<head><link href="/m.webmanifest" rel="manifest" /></head>';
  const out = rewriteManifestLink(html);
  assert.match(out, /href="\/webhook-notify\/manifest\.webmanifest\?src=%2Fm\.webmanifest"/);
  assert.match(out, /rel="manifest"/);
});

test('mergeManifest：宿主的 display=fullscreen 原样保留，且不产生 display_override', () => {
  // 插件不再改写窗口显示模式：宿主写 fullscreen 就下发 fullscreen（dsh 默认全屏）。
  const merged = mergeManifest(HOST_MANIFEST, {});
  assert.equal(merged.display, 'fullscreen');
  assert.equal(merged.display_override, undefined);
  assert.equal(merged.theme_color, undefined);
  // 名字与图标沿用宿主的。
  assert.equal(merged.name, 'DeepSeek Harness');
  assert.equal(merged.icons.length, 1);
});

test('mergeManifest：不覆盖宿主自己的 theme_color 与 display_override', () => {
  const host = {
    ...HOST_MANIFEST,
    theme_color: '#123456',
    display_override: ['fullscreen', 'standalone'],
  };
  const merged = mergeManifest(host, { backgroundColor: '#000000' });
  assert.equal(merged.theme_color, '#123456', '宿主主题色不该被插件改写');
  assert.deepEqual(merged.display_override, ['fullscreen', 'standalone']);
  // 背景色仍可覆盖：它是启动画面的底色，属于插件提供的可配置项。
  assert.equal(merged.background_color, '#000000');
});

test('mergeManifest：稳定 id 与单窗口 launch_handler', () => {
  const merged = mergeManifest({ ...HOST_MANIFEST, start_url: '/?x=1' }, {});
  assert.equal(merged.id, '/?x=1');
  assert.deepEqual(merged.launch_handler.client_mode, ['navigate-existing', 'auto']);
  // 宿主自己声明过 launch_handler 就不覆盖。
  const own = mergeManifest({ ...HOST_MANIFEST, launch_handler: { client_mode: ['auto'] } }, {});
  assert.deepEqual(own.launch_handler.client_mode, ['auto']);
});

test('mergeManifest：可覆盖名字/短名，主题色仍归宿主', () => {
  const merged = mergeManifest(HOST_MANIFEST, { name: '我的 DSH', shortName: 'DSH', themeColor: '#123456' });
  assert.equal(merged.name, '我的 DSH');
  assert.equal(merged.short_name, 'DSH');
  // 主题色已经不是插件的选项：传进来也无效，宿主没有就保持没有。
  assert.equal(merged.theme_color, undefined);
  // 宿主没给短名时截取应用名，而不是留空。
  const auto = mergeManifest({ ...HOST_MANIFEST, short_name: undefined }, { name: '一个很长很长的应用名字' });
  assert.equal(auto.short_name, '一个很长很长的应用名字'.slice(0, 12));
});

test('localizeManifestUrls：同源地址写成根相对，跨域地址保持绝对', () => {
  const base = 'http://127.0.0.1:3080/manifest.webmanifest';
  const out = localizeManifestUrls(
    {
      start_url: './',
      scope: './',
      id: './',
      icons: [{ src: 'favicon.svg' }, { src: 'https://cdn.example.com/i.png' }],
      shortcuts: [{ name: 'x', url: '/s', icons: [{ src: 'i.png' }] }],
      protocol_handlers: [{ protocol: 'x', url: '/p' }],
    },
    base,
  );
  // 根相对：origin 交给浏览器补，代理换协议/域名都不会变成混合内容。
  assert.equal(out.start_url, '/');
  assert.equal(out.scope, '/');
  assert.equal(out.id, '/');
  assert.equal(out.icons[0].src, '/favicon.svg');
  assert.equal(out.icons[1].src, 'https://cdn.example.com/i.png');
  assert.equal(out.shortcuts[0].url, '/s');
  assert.equal(out.shortcuts[0].icons[0].src, '/i.png');
  assert.equal(out.protocol_handlers[0].url, '/p');
});

test('localizeManifestUrls：旧名字仍然可用', () => {
  const out = absolutizeManifestUrls({ start_url: './' }, 'https://dsh.example.com/manifest.webmanifest');
  assert.equal(out.start_url, '/');
});

test('manifestHref：带 src 参数时正确编码', () => {
  assert.equal(manifestHref(''), '/webhook-notify/manifest.webmanifest');
  // encodeURIComponent 不转义「.」，所以是 ".%2F…"。
  assert.equal(manifestHref('./m.webmanifest'), '/webhook-notify/manifest.webmanifest?src=.%2Fm.webmanifest');
  assert.equal(manifestHref('/m.webmanifest'), '/webhook-notify/manifest.webmanifest?src=%2Fm.webmanifest');
});

test('queryOf：解析查询串', () => {
  assert.deepEqual(queryOf('/webhook-notify/manifest.webmanifest?src=%2Fm.webmanifest&x=1'), {
    src: '/m.webmanifest',
    x: '1',
  });
  assert.deepEqual(queryOf('/webhook-notify/manifest.webmanifest'), {});
});

test('injectInstallCapture：把捕获脚本插到 head 最前面，且只插一次', () => {
  const html = '<html><head><meta charset="utf-8" /></head><body></body></html>';
  const out = injectInstallCapture(html);
  assert.ok(out.includes(CAPTURE_PATH));
  // 必须在 <head> 之后、其它内容之前：要在浏览器派发 beforeinstallprompt 之前跑。
  assert.ok(out.indexOf(CAPTURE_PATH) < out.indexOf('<meta'));
  // 重复调用不会叠出多个 script。
  assert.equal(injectInstallCapture(out), out);
  assert.equal(out.split(CAPTURE_PATH).length - 1, 1);
});

test('injectInstallCapture：没有 head 时前置，空输入原样返回', () => {
  assert.ok(injectInstallCapture('<body>x</body>').startsWith('<script'));
  assert.equal(injectInstallCapture(''), '');
  assert.equal(injectInstallCapture(null), null);
});

test('disablePullToRefresh：注入禁止下滑刷新的样式，且只插一次', () => {
  const html = '<html><head><meta charset="utf-8" /></head><body></body></html>';
  const out = disablePullToRefresh(html);
  assert.match(out, /<style data-dsh-webhook-notify="no-pull-to-refresh">html,body\{overscroll-behavior-y:contain\}<\/style>/);
  // 必须在 head 里：devtools 里能一眼看到，也不影响 body 结构。
  assert.ok(out.indexOf('no-pull-to-refresh') < out.indexOf('</head>'));
  // 重复调用不会叠出多个 style。
  assert.equal(disablePullToRefresh(out), out);
  assert.equal(out.split(NO_PULL_TO_REFRESH_MARKER).length - 1, 1);
});

test('disablePullToRefresh：用 contain 而不是 none（保留根容器自身的回弹）', () => {
  const out = disablePullToRefresh('<head></head>');
  assert.match(out, /overscroll-behavior-y:contain/);
  assert.ok(!out.includes('overscroll-behavior-y:none'));
});

test('disablePullToRefresh：没有 head 时前置，空输入原样返回', () => {
  assert.ok(disablePullToRefresh('<body>x</body>').startsWith('<style'));
  assert.equal(disablePullToRefresh(''), '');
  assert.equal(disablePullToRefresh(null), null);
  assert.equal(disablePullToRefresh('<head></head>', ''), '<head></head>');
});

test('resolveHostManifestSource：只允许宿主 manifest，拒绝内部路由与跨源', () => {
  const options = {
    publicOrigin: 'https://dsh.example.com',
    internalOrigin: 'http://127.0.0.1:3080',
    referer: 'https://dsh.example.com/',
  };
  for (const src of ['./manifest.webmanifest', '/manifest.webmanifest', 'https://dsh.example.com/manifest.webmanifest']) {
    const resolved = resolveHostManifestSource(src, options);
    assert.ok(resolved, `${src} 应被接受`);
    assert.equal(resolved.public, 'https://dsh.example.com/manifest.webmanifest');
    assert.equal(resolved.fetch, 'http://127.0.0.1:3080/manifest.webmanifest');
  }
  for (const src of [
    '/webhook-notify/state',
    '/webhook-notify/save',
    'https://evil.example/manifest.webmanifest',
    '/manifest.webmanifest?x=1',
    '/manifest.webmanifest#frag',
    '//evil.example/manifest.webmanifest',
    'file:///etc/passwd',
  ]) {
    assert.equal(resolveHostManifestSource(src, options), null, `${src} 应被拒绝`);
  }
});

test('rewriteManifestLink：无引号 href 不会产生重复属性', () => {
  const html = '<head><link rel=manifest href=./manifest.webmanifest></head>';
  const out = rewriteManifestLink(html);
  assert.equal(out.split('href=').length - 1, 1, `不应重复 href：${out}`);
  assert.match(out, /href="\/webhook-notify\/manifest\.webmanifest\?src=\.%2Fmanifest\.webmanifest"/);
});
