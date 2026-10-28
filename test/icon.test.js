/**
 * PWA 图标栅格化的测试。
 *
 * 没有图形库可用：SVG path 由插件自己解析、扫描线填充，PNG 由 Node 自带的
 * zlib 编码。这里验证「形状对不对」和「字节是不是合法 PNG」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import {
  buildIcons,
  composeIcon,
  encodePng,
  fallbackIcon,
  parseColor,
  parsePath,
  parseSvg,
  rasterize,
} from '../lib/icon.js';

/** 读回 PNG 的尺寸。 */
function pngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', '应有 PNG 签名');
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 解开 PNG 的像素（只看够用的部分）。 */
function decodePixels(buffer) {
  const { width, height } = pngSize(buffer);
  const idatAt = buffer.indexOf(Buffer.from('IDAT'));
  const length = buffer.readUInt32BE(idatAt - 4);
  const raw = zlib.inflateSync(buffer.subarray(idatAt + 4, idatAt + 4 + length));
  const stride = width * 4 + 1;
  return { width, height, raw, stride };
}

test('parsePath：解析矩形并闭合', () => {
  const points = parsePath('M0 0 L10 0 L10 10 L0 10 Z');
  assert.equal(points.length, 1);
  assert.deepEqual(points[0][0], [0, 0]);
  assert.deepEqual(points[0].at(-1), [0, 0], 'Z 应回到起点');
});

test('parsePath：三次贝塞尔被打散成折线', () => {
  const points = parsePath('M0 0 C0 10 10 10 10 0');
  assert.ok(points[0].length > 20, '曲线应被细分');
  // 开放子路径会按填充语义自动闭合，所以末点是起点；曲线终点在倒数第二个点。
  const curveEnd = points[0].at(-2);
  assert.ok(Math.abs(curveEnd[0] - 10) < 1e-6, `曲线应到达 x=10，实际 ${curveEnd[0]}`);
  assert.deepEqual(points[0].at(-1), [0, 0], '开放路径应自动闭合');
});

test('parsePath：参数不足或未知命令不会产生 NaN 点', () => {
  assert.deepEqual(parsePath('M10'), []);
  assert.deepEqual(parsePath('M0 0 C 1 2'), []);
  assert.deepEqual(parsePath('M0 0 A 5 5 0 0 1 10 10'), []);
  for (const path of ['M0 0 L5 5 L10 0', 'M0 0 Q5 10 10 0', 'M0 0 S5 10 10 0', 'M0 0 T10 0']) {
    for (const points of parsePath(path)) {
      for (const [x, y] of points) {
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `${path} 产生了非法坐标`);
      }
    }
  }
});

test('parsePath：viewBox 原点偏移会被带进栅格化', () => {
  // viewBox 从 (20,20) 开始时，logo 不应整体往右下偏。
  const icons = buildIcons('<svg viewBox="20 20 50 50"><path d="M20 20 L70 20 L70 70 L20 70 Z" fill="#000"/></svg>');
  assert.equal(icons.source, 'svg');
  const { raw, stride } = decodePixels(icons.any);
  const center = raw[256 * stride + 1 + 256 * 4];
  assert.ok(center > 220, `中心应是 logo，实际 ${center}`);
});

test('rasterize：矩形内全覆盖、矩形外无覆盖、边缘半覆盖', () => {
  // 边界落在 0.5 与 9.5：边缘像素正好被切一半（抗锯齿）。
  const square = parsePath('M0.5 0.5 L9.5 0.5 L9.5 9.5 L0.5 9.5 Z');
  // scale=1：10×10 的方块落在 20×20 的画布上。
  const coverage = rasterize(square, 20, 20, { scale: 1, offsetX: 0, offsetY: 0 });
  // 方块内部（像素 4,4）应被完全覆盖。
  assert.ok(coverage[4 * 20 + 4] > 200, '方块内部应被覆盖');
  // 方块外（15,15）应无覆盖。
  assert.equal(coverage[15 * 20 + 15], 0);
  // 右边缘（9,4）被切一半。
  const edge = coverage[4 * 20 + 9];
  assert.ok(edge > 90 && edge < 165, `边缘应接近半覆盖，实际 ${edge}`);
  // 总覆盖面积（按覆盖率求和）应接近 9×9 = 81。
  let area = 0;
  for (const value of coverage) area += value / 255;
  assert.ok(area > 76 && area < 86, `覆盖面积应接近 81，实际 ${area.toFixed(1)}`);
});

test('encodePng：产出合法的 PNG', () => {
  const pixels = Buffer.alloc(4 * 4 * 4, 0x80);
  const png = encodePng(4, 4, pixels);
  assert.deepEqual(pngSize(png), { width: 4, height: 4 });
  const { raw, stride } = decodePixels(png);
  assert.equal(raw.length, stride * 4);
  assert.equal(raw[1], 0x80, '首个像素应是填充值');
});

test('parseSvg：取出 path、viewBox 与填充色', () => {
  const svg = '<svg viewBox="0 0 50 50"><path d="M1 1 L2 2 Z" fill="#ff0000"/></svg>';
  const parsed = parseSvg(svg);
  assert.equal(parsed.paths.length, 1);
  assert.deepEqual(parsed.viewBox, { x: 0, y: 0, width: 50, height: 50 });
  assert.deepEqual(parseColor(parsed.fill), [255, 0, 0]);
});

test('parseColor：支持 #rgb 与 #rrggbb', () => {
  assert.deepEqual(parseColor('#0f0'), [0, 255, 0]);
  assert.deepEqual(parseColor('#0000ff'), [0, 0, 255]);
  assert.equal(parseColor('none'), null);
});

test('buildIcons：从 SVG 生成两张 PNG', () => {
  const svg = '<svg viewBox="0 0 50 50"><path d="M10 10 L40 10 L40 40 L10 40 Z" fill="#000000"/></svg>';
  const icons = buildIcons(svg);
  assert.equal(icons.source, 'svg');
  assert.deepEqual(pngSize(icons.any), { width: 512, height: 512 });
  assert.deepEqual(pngSize(icons.small), { width: 192, height: 192 });
  assert.deepEqual(pngSize(icons.maskable), { width: 512, height: 512 });

  // 「any」图标：品牌蓝底 + 白色 logo（三张图同一个样子，Windows 任务栏 /
  // 开始菜单 / 安装对话框挑哪张都一致）。
  const { raw, stride } = decodePixels(icons.any);
  const rgb = (x, y) => {
    const at = y * stride + 1 + x * 4;
    return [raw[at], raw[at + 1], raw[at + 2]];
  };
  const center = rgb(256, 256);
  assert.ok(center[0] > 220 && center[1] > 220 && center[2] > 220, `中心应是白色 logo，实际 ${center}`);
  // logo 上方的留白：圆角之内、logo 之外，应是品牌蓝。
  const pad = rgb(256, 40);
  assert.ok(Math.abs(pad[0] - 77) < 12 && Math.abs(pad[1] - 107) < 12 && Math.abs(pad[2] - 254) < 12,
    `留白应是品牌蓝，实际 ${pad}`);
});

test('buildIcons：SVG 解析不出来时退回内置图标', () => {
  const icons = buildIcons('<svg></svg>');
  assert.equal(icons.source, 'fallback');
  assert.deepEqual(pngSize(icons.any), { width: 512, height: 512 });
  assert.deepEqual(pngSize(icons.small), { width: 192, height: 192 });
});

test('fallbackIcon：产出合法 PNG', () => {
  const png = fallbackIcon(192);
  assert.deepEqual(pngSize(png), { width: 192, height: 192 });
});

test('composeIcon：半透明 logo 与底色混合', () => {
  const logo = new Uint8Array(4 * 4);
  logo.fill(255);
  const png = composeIcon({ size: 4, logo, background: [255, 255, 255], foreground: [0, 0, 0], rounded: false });
  const { raw, stride } = decodePixels(png);
  const r = raw[1 * stride + 1];
  assert.ok(r < 60, `前景应盖住底色，实际 ${r}`);
});
