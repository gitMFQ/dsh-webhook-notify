/**
 * PWA 图标 —— 把宿主的 SVG logo 栅格化成 Chrome 要的 PNG 尺寸。
 *
 * 为什么需要：Chrome/Edge 的可安装性检查要求 manifest 里有 **192×192 与
 * 512×512 的位图**图标。DSH 自带的 manifest 只有一个 `favicon.svg`
 * （`sizes: "any"`），SVG 尺寸是 0×0，过不了「至少 192px 宽的图标」这一关——
 * 于是页面明明满足其它条件，浏览器却不给装。
 *
 * 为什么不带 PNG 资源文件：图标的形状来自宿主的品牌 SVG，宿主一改 logo
 * 就不该让插件留一份旧副本。所以这里在宿主侧现栅格化：
 *
 *   宿主 /favicon.svg → 解析 <path d> → 扫描线填充（非零环绕规则 + 4×4 超采样）
 *   → 合成 PNG（Node 自带 zlib，不需要任何图形库）
 *
 * 产物：
 * - `any`：浅色圆角底 + 品牌 logo；
 * - `maskable`：深色满幅底 + 白色 logo（收在 80% 安全区内）。
 *
 * @module dsh-webhook-notify/lib/icon
 */
import zlib from 'node:zlib';

/** 超采样倍数：每个像素取 4×4 个采样点，边缘才有抗锯齿。 */
const SUPERSAMPLE = 4;

// ── PNG 编码 ───────────────────────────────────────────────────────

/** CRC32 查表。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC32。 */
function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** 拼一个 PNG chunk。 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * 把 RGBA 像素编码成 PNG。
 *
 * @param {number} width 宽。
 * @param {number} height 高。
 * @param {Uint8Array} rgba 长度 = width×height×4 的像素。
 * @returns {Buffer} PNG 字节。
 */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 6; // 颜色类型：RGBA
  header[10] = 0; // 压缩
  header[11] = 0; // 过滤
  header[12] = 0; // 隔行

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // 过滤器：None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── SVG path 解析与栅格化 ──────────────────────────────────────────

/**
 * 解析 SVG path 的 `d` 属性，把曲线打散成折线。
 *
 * 支持 M/m L/l H/h V/v C/c S/s Q/q T/t Z/z（本插件只需要前几个，
 * 但多写一点省得宿主换 logo 样式后失效）。
 *
 * @param {string} d path 数据。
 * @returns {Array<Array<[number, number]>>} 若干子路径，每条是一串点。
 */
export function parsePath(d) {
  const subpaths = [];
  let current = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl = null;

  const tokens = String(d ?? '').match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  const isCommand = (token) => /^[a-zA-Z]$/.test(token);
  /**
   * 读一个数字。
   *
   * 参数不足时返回 NaN 而不是 undefined：旧实现让 NaN 一路乘进坐标，
   * 生成一串 null 点（栅格化后是一团噪声）。
   */
  const readNumber = () => {
    if (i >= tokens.length || isCommand(tokens[i])) return Number.NaN;
    return Number(tokens[i++]);
  };
  /** 当前游标处是否还有足够的数字参数。 */
  const hasNumbers = (count) => {
    for (let at = i; at < i + count; at += 1) {
      if (at >= tokens.length || isCommand(tokens[at])) return false;
    }
    return true;
  };
  const valid = (...values) => values.every((value) => Number.isFinite(value));

  const moveTo = (nx, ny) => {
    current = [[nx, ny]];
    subpaths.push(current);
    x = nx;
    y = ny;
    startX = nx;
    startY = ny;
  };
  const lineTo = (nx, ny) => {
    if (!current) moveTo(nx, ny);
    else current.push([nx, ny]);
    x = nx;
    y = ny;
  };
  const curveTo = (x1, y1, x2, y2, nx, ny) => {
    const steps = 24;
    const fromX = x;
    const fromY = y;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const mt = 1 - t;
      const px = mt * mt * mt * fromX + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * nx;
      const py = mt * mt * mt * fromY + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * ny;
      current.push([px, py]);
    }
    x = nx;
    y = ny;
  };

  while (i < tokens.length) {
    let command = tokens[i];
    if (!isCommand(command)) {
      i += 1;
      continue;
    }
    i += 1;
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const rx = () => (relative ? x : 0);
    const ry = () => (relative ? y : 0);

    switch (upper) {
      case 'M': {
        if (!hasNumbers(2)) break;
        const nx = readNumber() + rx();
        const ny = readNumber() + ry();
        if (!valid(nx, ny)) break;
        moveTo(nx, ny);
        lastControl = null;
        // 后续的坐标对当作折线（SVG 规范：M 之后的隐含命令是 L）。
        while (hasNumbers(2)) {
          const lx = readNumber() + rx();
          const ly = readNumber() + ry();
          if (!valid(lx, ly)) break;
          lineTo(lx, ly);
        }
        break;
      }
      case 'L': {
        while (hasNumbers(2)) {
          const nx = readNumber() + rx();
          const ny = readNumber() + ry();
          if (!valid(nx, ny)) break;
          lineTo(nx, ny);
          lastControl = null;
        }
        break;
      }
      case 'H': {
        while (hasNumbers(1)) {
          const nx = readNumber() + rx();
          if (!valid(nx)) break;
          lineTo(nx, y);
          lastControl = null;
        }
        break;
      }
      case 'V': {
        while (hasNumbers(1)) {
          const ny = readNumber() + ry();
          if (!valid(ny)) break;
          lineTo(x, ny);
          lastControl = null;
        }
        break;
      }
      case 'C': {
        while (hasNumbers(6)) {
          const x1 = readNumber() + rx();
          const y1 = readNumber() + ry();
          const x2 = readNumber() + rx();
          const y2 = readNumber() + ry();
          const nx = readNumber() + rx();
          const ny = readNumber() + ry();
          if (!valid(x1, y1, x2, y2, nx, ny)) break;
          if (!current) moveTo(x, y);
          curveTo(x1, y1, x2, y2, nx, ny);
          lastControl = [x2, y2];
        }
        break;
      }
      case 'S': {
        while (hasNumbers(4)) {
          const x1 = lastControl ? 2 * x - lastControl[0] : x;
          const y1 = lastControl ? 2 * y - lastControl[1] : y;
          const x2 = readNumber() + rx();
          const y2 = readNumber() + ry();
          const nx = readNumber() + rx();
          const ny = readNumber() + ry();
          if (!valid(x2, y2, nx, ny)) break;
          if (!current) moveTo(x, y);
          curveTo(x1, y1, x2, y2, nx, ny);
          lastControl = [x2, y2];
        }
        break;
      }
      case 'Q': {
        while (hasNumbers(4)) {
          const qx = readNumber() + rx();
          const qy = readNumber() + ry();
          const nx = readNumber() + rx();
          const ny = readNumber() + ry();
          if (!valid(qx, qy, nx, ny)) break;
          if (!current) moveTo(x, y);
          // 二次贝塞尔按三次处理（控制点置为二次控制点）。
          curveTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny);
          // 下一次 S/T 的反射控制点取二次控制点本身。
          lastControl = [qx, qy];
        }
        break;
      }
      case 'T': {
        while (hasNumbers(2)) {
          const nx = readNumber() + rx();
          const ny = readNumber() + ry();
          if (!valid(nx, ny)) break;
          if (!current) moveTo(x, y);
          const qx = lastControl ? 2 * x - lastControl[0] : x;
          const qy = lastControl ? 2 * y - lastControl[1] : y;
          curveTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny);
          lastControl = [qx, qy];
        }
        break;
      }
      case 'Z': {
        if (current) {
          current.push([startX, startY]);
          x = startX;
          y = startY;
          current = null;
        }
        lastControl = null;
        break;
      }
      default:
        // 不认识的命令（A 弧线等）：跳过它的数字参数，别让它们被当成
        // 下一条命令的坐标。
        while (i < tokens.length && !isCommand(tokens[i])) i += 1;
        lastControl = null;
        break;
    }
  }
  // 开放子路径按填充规则闭合（SVG 的填充语义）；少于 3 个点的子路径
  // 画不出面积，直接丢掉。
  for (const points of subpaths) {
    if (points.length < 3) continue;
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) points.push([first[0], first[1]]);
  }
  return subpaths.filter((points) => points.length > 2);
}

/**
 * 用非零环绕规则填充路径，输出每个像素的覆盖率（0–255）。
 *
 * @param {Array<Array<[number, number]>>} subpaths 折线子路径。
 * @param {number} width 输出宽（像素）。
 * @param {number} height 输出高（像素）。
 * @param {object} transform 从 path 坐标到像素坐标的变换 {scale, offsetX, offsetY}。
 * @returns {Uint8Array} 覆盖率数组。
 */
export function rasterize(subpaths, width, height, transform) {
  const { scale, offsetX, offsetY } = transform;
  const coverage = new Uint8Array(width * height);
  const rows = height * SUPERSAMPLE;
  const cols = width * SUPERSAMPLE;

  // 边表：每条边记录 (x0,y0,x1,y1) 与方向。
  const edges = [];
  for (const points of subpaths) {
    for (let i = 0; i + 1 < points.length; i += 1) {
      const [ax, ay] = points[i];
      const [bx, by] = points[i + 1];
      const x0 = ax * scale + offsetX;
      const y0 = ay * scale + offsetY;
      const x1 = bx * scale + offsetX;
      const y1 = by * scale + offsetY;
      if (y0 === y1) continue;
      edges.push({ x0, y0, x1, y1, dir: y0 < y1 ? 1 : -1, top: Math.min(y0, y1), bottom: Math.max(y0, y1) });
    }
  }
  if (edges.length === 0) return coverage;

  // 按行分桶：每条边只进它覆盖的那几行，避免每行都扫全部边。
  const buckets = new Array(rows);
  for (let i = 0; i < rows; i += 1) buckets[i] = [];
  for (const edge of edges) {
    const from = Math.max(0, Math.floor(edge.top * SUPERSAMPLE));
    const to = Math.min(rows - 1, Math.ceil(edge.bottom * SUPERSAMPLE));
    for (let row = from; row <= to; row += 1) buckets[row].push(edge);
  }

  const crossings = [];
  for (let row = 0; row < rows; row += 1) {
    const sampleY = (row + 0.5) / SUPERSAMPLE;
    const rowEdges = buckets[row];
    crossings.length = 0;
    for (const edge of rowEdges) {
      if (sampleY < edge.top || sampleY >= edge.bottom) continue;
      const t = (sampleY - edge.y0) / (edge.y1 - edge.y0);
      crossings.push({ x: edge.x0 + t * (edge.x1 - edge.x0), dir: edge.dir });
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a.x - b.x);
    const pixelRow = Math.floor(row / SUPERSAMPLE);
    const rowBase = pixelRow * width;
    let winding = 0;
    for (let i = 0; i < crossings.length - 1; i += 1) {
      winding += crossings[i].dir;
      if (winding === 0) continue;
      const from = Math.max(0, Math.round(crossings[i].x * SUPERSAMPLE));
      const to = Math.min(cols, Math.round(crossings[i + 1].x * SUPERSAMPLE));
      // 直接把覆盖到的采样点累加进像素覆盖率。
      for (let col = from; col < to; col += 1) {
        const pixelCol = (col / SUPERSAMPLE) | 0;
        coverage[rowBase + pixelCol] += 1;
      }
    }
  }

  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let i = 0; i < coverage.length; i += 1) {
    const value = coverage[i];
    coverage[i] = value === 0 ? 0 : Math.round((value * 255) / samples);
  }
  return coverage;
}

/** 圆角矩形的覆盖率（用于「any」图标的浅色底）。 */
function roundedRectCoverage(width, height, radius) {
  const coverage = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // 到圆角矩形边界的距离（正数在内）；用平方比较省掉开方。
      const dx = Math.max(radius - x - 0.5, x + 0.5 - (width - radius), 0);
      const dy = Math.max(radius - y - 0.5, y + 0.5 - (height - radius), 0);
      const distance2 = dx * dx + dy * dy;
      const inner = (radius - 0.5) * (radius - 0.5);
      const outer = (radius + 0.5) * (radius + 0.5);
      let value;
      if (distance2 <= inner) value = 255;
      else if (distance2 >= outer) value = 0;
      else {
        const distance = Math.sqrt(distance2);
        value = Math.round(255 * (radius + 0.5 - distance));
      }
      coverage[y * width + x] = value;
    }
  }
  return coverage;
}

/**
 * 合成一张图标。
 *
 * @param {object} options
 * @param {number} options.size 边长（像素）。
 * @param {Uint8Array} [options.logo] logo 覆盖率。
 * @param {number[]} options.background 背景色 RGB。
 * @param {number[]} options.foreground logo 颜色 RGB。
 * @param {boolean} [options.rounded] 背景是否圆角。
 * @param {boolean} [options.opaque] 背景是否满幅不透明。
 * @returns {Buffer} PNG。
 */
export function composeIcon(options = {}) {
  const {
    size,
    logo,
    background = [255, 255, 255],
    foreground = [0, 0, 0],
    rounded = true,
    opaque = true,
  } = options;
  const pixels = Buffer.alloc(size * size * 4);
  const base = rounded ? roundedRectCoverage(size, size, Math.round(size * 0.22)) : null;
  const [br, bg, bb] = background;
  const [fr, fg, fb] = foreground;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const alpha = (logo ? logo[index] : 0) / 255;
      // 内联混合，避免每个像素都分配数组。
      const r = br + (fr - br) * alpha;
      const g = bg + (fg - bg) * alpha;
      const b = bb + (fb - bb) * alpha;
      const out = index * 4;
      pixels[out] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
      pixels[out + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
      pixels[out + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      pixels[out + 3] = opaque ? (base ? base[index] : 255) : base ? base[index] : 255;
    }
  }
  return encodePng(size, size, pixels);
}

/**
 * 从 SVG 文本里取出 path 数据与 viewBox。
 *
 * @param {string} svg SVG 文本。
 * @returns {{paths: string[], viewBox: {x: number, y: number, width: number, height: number}|null, fill: string}}
 */
export function parseSvg(svg) {
  const text = String(svg ?? '');
  const paths = [...text.matchAll(/<path\b[^>]*\sd\s*=\s*"([^"]*)"/gi)].map((match) => match[1]);
  const viewBoxMatch = /viewBox\s*=\s*"([^"]*)"/i.exec(text);
  let viewBox = null;
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      viewBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
  }
  const fillMatch = /<path\b[^>]*\sfill\s*=\s*"([^"]*)"/i.exec(text);
  return { paths, viewBox, fill: fillMatch ? fillMatch[1] : '#000000' };
}

/**
 * 解析颜色（#rgb / #rrggbb / none）。
 *
 * @param {string} value 颜色文本。
 * @returns {number[]|null} RGB 数组。
 */
export function parseColor(value) {
  const text = String(value ?? '').trim();
  if (text === '' || text === 'none') return null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return [parseInt(short[1] + short[1], 16), parseInt(short[2] + short[2], 16), parseInt(short[3] + short[3], 16)];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (long) return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16)];
  return null;
}

/**
 * 用宿主 SVG 生成图标。
 *
 * @param {string} svg 宿主 SVG 文本。
 * @param {object} [options]
 * @param {number} [options.size] 大图边长（默认 512）。
 * @param {number} [options.small] 小图边长（默认 192）。
 * @returns {{any: Buffer, small: Buffer, maskable: Buffer, source: 'svg'|'fallback'}} PNG 与来源。
 */
export function buildIcons(svg, options = {}) {
  const { size = 512, small = 192 } = options;
  const parsed = parseSvg(svg);
  const subpaths = parsed.paths.flatMap((d) => parsePath(d));
  if (subpaths.length === 0) {
    return {
      any: fallbackIcon(size),
      small: fallbackIcon(small),
      maskable: fallbackIcon(size, true),
      source: 'fallback',
    };
  }
  const viewBox = parsed.viewBox ?? { x: 0, y: 0, width: 50, height: 50 };

  const draw = (edge, logoScale, background, foreground, rounded, opaque) => {
    const scale = (edge * logoScale) / Math.max(viewBox.width, viewBox.height);
    // viewBox 的 x/y 是原点偏移：logo 画在 (0,0) 起而 viewBox 从 (8,8) 起时，
    // 不减掉这个偏移就会整体往右下跑，装出来的图标偏一大块。
    const offsetX = (edge - viewBox.width * scale) / 2 - viewBox.x * scale;
    const offsetY = (edge - viewBox.height * scale) / 2 - viewBox.y * scale;
    const coverage = rasterize(subpaths, edge, edge, { scale, offsetX, offsetY });
    return composeIcon({ size: edge, logo: coverage, background, foreground, rounded, opaque });
  };

  // 品牌底色 + 白色 logo，三张图同一个样子：Windows/macOS 的任务栏、
  // 开始菜单、安装对话框可能各自挑不同的那张，长得不一样就会显得很怪。
  // 深色满幅的那版在浅色任务栏上像一块黑板，蓝底反而最稳。
  const brand = [77, 107, 254]; // DeepSeek 品牌蓝
  const white = [255, 255, 255];

  return {
    // 「any」：圆角蓝底 + 白色 logo。两种尺寸各出一张，manifest 里声明的
    // sizes 必须和真实像素对得上，浏览器才会认这张图。
    any: draw(size, 0.76, brand, white, true, true),
    small: draw(small, 0.76, brand, white, true, true),
    // 「maskable」：满幅（系统自己裁形状），logo 收在 80% 安全区里。
    maskable: draw(size, 0.56, brand, white, false, true),
    source: 'svg',
  };
}

/**
 * 宿主 SVG 取不到时的兜底图标（一个简单的铃铛）。
 *
 * @param {number} size 边长。
 * @param {boolean} [maskable] 是否是 maskable 版本。
 * @returns {Buffer} PNG。
 */
export function fallbackIcon(size = 512, maskable = false) {
  const background = maskable ? [17, 17, 23] : [255, 255, 255];
  const foreground = maskable ? [255, 255, 255] : [17, 17, 23];
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const bellWidth = size * 0.34;
  const top = size * 0.26;
  const bottom = size * 0.68;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5;
      let inside = 0;
      // 钟身：上窄下宽的梯形 + 顶部的半圆。
      if (dy >= top && dy <= bottom) {
        const t = (dy - top) / (bottom - top);
        const halfWidth = bellWidth * (0.45 + 0.55 * t);
        if (Math.abs(dx) <= halfWidth) inside = 1;
      }
      // 顶部圆头。
      const headR = bellWidth * 0.45;
      if (Math.hypot(dx, dy - (top + headR)) <= headR) inside = 1;
      // 底座。
      if (dy > bottom && dy <= bottom + size * 0.05 && Math.abs(dx) <= bellWidth * 1.05) inside = 1;
      // 铃铛底部的圆锤。
      if (Math.hypot(dx, dy - (bottom + size * 0.11)) <= size * 0.055) inside = 1;
      const color = inside ? foreground : background;
      const index = (y * size + x) * 4;
      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
      pixels[index + 3] = 255;
    }
  }
  return encodePng(size, size, pixels);
}
