#!/usr/bin/env node
/**
 * make-icons.mjs — zero-dependency SVG -> PNG icon generator for the
 * Volume Monitor Stream Deck plugin.
 *
 * Reads the hand-written SVGs in `imgs/` (a deliberately small subset of
 * SVG: rect, circle, ellipse, polygon, path with M/L/H/V/C/S/Q/T/A/Z,
 * fill / fill-rule / stroke / stroke-width, nested <g>) and rasterizes
 * them to PNG using only Node built-ins (fs, zlib). No npm packages.
 *
 * Usage:
 *   node make-icons.mjs               # regenerate all imgs/*.png
 *   node make-icons.mjs --check       # decode + verify generated PNGs
 *   node make-icons.mjs --size 144    # render feedback icons at 144px
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMG_DIR = path.join(ROOT, 'com.tech127x.volume-monitor.sdPlugin', 'imgs');

const FILES = {
  plugin: [
    { name: 'category', svg: 'category.svg' },
    { name: 'master', svg: 'master.svg' },
    { name: 'appknob', svg: 'appknob.svg' },
    { name: 'toggle', svg: 'toggle.svg' },
  ],
  feedback: [
    { name: 'speaker', svg: 'speaker.svg' },
    { name: 'speaker-muted', svg: 'speaker-muted.svg' },
    { name: 'wave', svg: 'wave.svg' },
    { name: 'wave-muted', svg: 'wave-muted.svg' },
  ],
};

// ---------------------------------------------------------------------------
// Small SVG parser (tolerant subset)
// ---------------------------------------------------------------------------

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1]] = m[2];
  return attrs;
}

function parseSvg(text) {
  const rootMatch = /<svg([^>]*)>([\s\S]*)<\/svg>/i.exec(text.trim());
  if (!rootMatch) throw new Error('No <svg> root found');
  const rootAttrs = parseAttrs(rootMatch[1]);
  const body = rootMatch[2];

  const width = parseFloat(rootAttrs.width) || 72;
  const height = parseFloat(rootAttrs.height) || 72;
  const vb = (rootAttrs.viewBox || `0 0 ${width} ${height}`).split(/[\s,]+/).map(Number);

  const shapes = [];
  collectShapes(body, {}, shapes);
  return { width, height, viewBox: vb, shapes };
}

function collectShapes(inner, inherited, out) {
  // Process elements in document order with a nesting stack.
  const result = [];
  const open = [];
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*)(\/?)>/g;
  let cur;
  while ((cur = re.exec(inner))) {
    const isClose = cur[1] === '/';
    const tag = cur[2];
    const attrRaw = cur[3];
    const selfClose = cur[4] === '/';
    if (isClose) {
      if (open.length > 1) {
        const done = open.pop();
        open[open.length - 1].children.push(done);
      } else if (open.length === 1) {
        result.push(open.pop());
      }
    } else {
      const attrs = Object.assign({}, open.length ? open[open.length - 1].attrs : inherited, parseAttrs(attrRaw));
      const node = { tag, attrs, children: [] };
      if (selfClose) {
        if (open.length) open[open.length - 1].children.push(node);
        else result.push(node);
      } else {
        open.push(node);
      }
    }
  }
  for (const node of result) emitNode(node, out);
  for (const leftover of open) emitNode(leftover, out);
}

function emitNode(node, out) {
  if (node.tag === 'g') {
    for (const child of node.children) emitNode(child, out);
    return;
  }
  if (!['rect', 'circle', 'ellipse', 'polygon', 'path'].includes(node.tag)) return;
  out.push({
    tag: node.tag,
    attrs: node.attrs,
    d: node.tag === 'path' ? (node.attrs.d || '') : '',
  });
}

// ---------------------------------------------------------------------------
// Path data parsing + flattening
// ---------------------------------------------------------------------------

function parsePath(d) {
  // Tokenize commands and numbers.
  const tokens = [];
  const re = /[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
  let m;
  while ((m = re.exec(d))) tokens.push(m[0]);
  return tokens;
}

function argNum(tokens, i) {
  return parseFloat(tokens[i]);
}

function arcToCubic(x1, y1, rx, ry, phi, largeArc, sweep, x2, y2) {
  // Standard SVG arc -> two cubic Bezier segments.
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [[x2, y2, x2, y2, x2, y2]];

  const phiRad = (phi * Math.PI) / 180;
  const cosP = Math.cos(phiRad);
  const sinP = Math.sin(phiRad);

  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;

  let num = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2;
  let den = rx2 * y1p2 + ry2 * x1p2;
  if (den === 0) return [[x2, y2, x2, y2, x2, y2]];
  let rad = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) rad = -rad;
  const cxp = (rad * rx * y1p) / ry;
  const cyp = (-rad * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;

  let theta1 = Math.atan2(uy, ux);
  let dTheta = Math.atan2(vy, vx) - theta1;
  if (sweep === 0 && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep === 1 && dTheta < 0) dTheta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const out = [];
  for (let i = 0; i < segments; i++) {
    const t0 = theta1 + (dTheta * i) / segments;
    const t1 = theta1 + (dTheta * (i + 1)) / segments;
    const cosT0 = Math.cos(t0);
    const sinT0 = Math.sin(t0);
    const cosT1 = Math.cos(t1);
    const sinT1 = Math.sin(t1);
    const alpha = (4 / 3) * Math.tan((t1 - t0) / 4);
    const p1x = cx + rx * (cosT0 - alpha * sinT0);
    const p1y = cy + ry * (sinT0 + alpha * cosT0);
    const p2x = cx + rx * (cosT1 + alpha * sinT1);
    const p2y = cy + ry * (sinT1 - alpha * cosT1);
    const p3x = cx + rx * cosT1;
    const p3y = cy + ry * sinT1;
    out.push([p1x, p1y, p2x, p2y, p3x, p3y]);
  }
  return out;
}

function flattenPath(d) {
  // Returns { polys: [[{x,y}...]...] } — closed subpaths as point arrays.
  const tokens = parsePath(d);
  const polys = [];
  let cur = null; // current polyline being built
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let i = 0;

  const ensure = () => {
    if (!cur) cur = [];
  };
  const close = () => {
    if (cur && cur.length) polys.push(cur);
    cur = null;
  };
  const push = (px, py) => {
    ensure();
    cur.push({ x: px, y: py });
    x = px;
    y = py;
  };

  while (i < tokens.length) {
    const cmd = tokens[i];
    if (/[Mm]/.test(cmd)) {
      const rel = cmd === 'm';
      let px = argNum(tokens, i + 1);
      let py = argNum(tokens, i + 2);
      i += 3;
      if (rel) {
        px += x;
        py += y;
      }
      close();
      push(px, py);
      sx = x;
      sy = y;
      // Treat subsequent coordinate pairs as implicit lineto.
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
        let nx = argNum(tokens, i);
        let ny = argNum(tokens, i + 1);
        i += 2;
        if (rel) {
          nx += x;
          ny += y;
        }
        push(nx, ny);
      }
    } else if (/[Ll]/.test(cmd)) {
      const rel = cmd === 'l';
      i += 1;
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
        let nx = argNum(tokens, i);
        let ny = argNum(tokens, i + 1);
        i += 2;
        if (rel) {
          nx += x;
          ny += y;
        }
        push(nx, ny);
      }
    } else if (/[Hh]/.test(cmd)) {
      const rel = cmd === 'h';
      i += 1;
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
        let nx = argNum(tokens, i);
        i += 1;
        if (rel) nx += x;
        push(nx, y);
      }
    } else if (/[Vv]/.test(cmd)) {
      const rel = cmd === 'v';
      i += 1;
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
        let ny = argNum(tokens, i);
        i += 1;
        if (rel) ny += y;
        push(x, ny);
      }
    } else if (/[Cc]/.test(cmd)) {
      const rel = cmd === 'c';
      i += 1;
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
        let c1x = argNum(tokens, i);
        let c1y = argNum(tokens, i + 1);
        let c2x = argNum(tokens, i + 2);
        let c2y = argNum(tokens, i + 3);
        let ex = argNum(tokens, i + 4);
        let ey = argNum(tokens, i + 5);
        i += 6;
        if (rel) {
          c1x += x;
          c1y += y;
          c2x += x;
          c2y += y;
          ex += x;
          ey += y;
        }
        flattenCubic(cur, x, y, c1x, c1y, c2x, c2y, ex, ey, push);
      }
    } else if (/[Ss]/.test(cmd)) {
      const rel = cmd === 's';
      i += 1;
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
        let c2x = argNum(tokens, i);
        let c2y = argNum(tokens, i + 1);
        let ex = argNum(tokens, i + 2);
        let ey = argNum(tokens, i + 3);
        i += 4;
        let c1x;
        let c1y;
        if (cur && cur.length >= 2) {
          const p1 = cur[cur.length - 1];
          const p2 = cur[cur.length - 2];
          c1x = 2 * p1.x - p2.x;
          c1y = 2 * p1.y - p2.y;
        } else {
          c1x = x;
          c1y = y;
        }
        if (rel) {
          c2x += x;
          c2y += y;
          ex += x;
          ey += y;
        }
        flattenCubic(cur, x, y, c1x, c1y, c2x, c2y, ex, ey, push);
      }
    } else if (/[Qq]/.test(cmd)) {
      const rel = cmd === 'q';
      i += 1;
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
        let cx = argNum(tokens, i);
        let cy = argNum(tokens, i + 1);
        let ex = argNum(tokens, i + 2);
        let ey = argNum(tokens, i + 3);
        i += 4;
        if (rel) {
          cx += x;
          cy += y;
          ex += x;
          ey += y;
        }
        flattenQuad(cur, x, y, cx, cy, ex, ey, push);
      }
    } else if (/[Tt]/.test(cmd)) {
      const rel = cmd === 't';
      i += 1;
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
        let ex = argNum(tokens, i);
        let ey = argNum(tokens, i + 1);
        i += 2;
        let cx;
        let cy;
        if (cur && cur.length >= 2) {
          const p1 = cur[cur.length - 1];
          const p2 = cur[cur.length - 2];
          cx = 2 * p1.x - p2.x;
          cy = 2 * p1.y - p2.y;
        } else {
          cx = x;
          cy = y;
        }
        if (rel) {
          ex += x;
          ey += y;
        }
        flattenQuad(cur, x, y, cx, cy, ex, ey, push);
      }
    } else if (/[Aa]/.test(cmd)) {
      const rel = cmd === 'a';
      i += 1;
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
        let rx = argNum(tokens, i);
        let ry = argNum(tokens, i + 1);
        const phi = argNum(tokens, i + 2);
        const large = argNum(tokens, i + 3);
        const sweep = argNum(tokens, i + 4);
        let ex = argNum(tokens, i + 5);
        let ey = argNum(tokens, i + 6);
        i += 7;
        if (rel) {
          ex += x;
          ey += y;
        }
        const cubics = arcToCubic(x, y, rx, ry, phi, large, sweep, ex, ey);
        for (const c of cubics) {
          flattenCubic(cur, x, y, c[0], c[1], c[2], c[3], c[4], c[5], push);
        }
      }
    } else if (/[Zz]/.test(cmd)) {
      i += 1;
      close();
      x = sx;
      y = sy;
    } else {
      i += 1; // skip junk
    }
  }
  close();
  return { polys };
}

function flattenCubic(cur, x, y, c1x, c1y, c2x, c2y, ex, ey, push) {
  const flat = [];
  subdivCubic(x, y, c1x, c1y, c2x, c2y, ex, ey, flat, 0);
  for (let i = 0; i < flat.length; i += 2) push(flat[i], flat[i + 1]);
}

function subdivCubic(x0, y0, x1, y1, x2, y2, x3, y3, out, depth) {
  if (depth > 12) {
    out.push(x3, y3);
    return;
  }
  const dx = x3 - x0;
  const dy = y3 - y0;
  const d2 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d3 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  if ((d2 * d2 + d3 * d3) < 0.03 * (dx * dx + dy * dy)) {
    out.push(x3, y3);
    return;
  }
  const mx = (x0 + 3 * (x1 + x2) + x3) / 8;
  const my = (y0 + 3 * (y1 + y2) + y3) / 8;
  subdivCubic(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, (x0 + 2 * x1 + x2) / 4, (y0 + 2 * y1 + y2) / 4, mx, my, out, depth + 1);
  subdivCubic(mx, my, (x1 + 2 * x2 + x3) / 4, (y1 + 2 * y2 + y3) / 4, (x2 + x3) / 2, (y2 + y3) / 2, x3, y3, out, depth + 1);
}

function flattenQuad(cur, x, y, cx, cy, ex, ey, push) {
  const flat = [];
  subdivQuad(x, y, cx, cy, ex, ey, flat, 0);
  for (let i = 0; i < flat.length; i += 2) push(flat[i], flat[i + 1]);
}

function subdivQuad(x0, y0, x1, y1, x2, y2, out, depth) {
  if (depth > 12) {
    out.push(x2, y2);
    return;
  }
  const dx = x2 - x0;
  const dy = y2 - y0;
  const d = Math.abs((x1 - x2) * dy - (y1 - y2) * dx);
  if (d * d < 0.06 * (dx * dx + dy * dy)) {
    out.push(x2, y2);
    return;
  }
  const mx = (x0 + 2 * x1 + x2) / 4;
  const my = (y0 + 2 * y1 + y2) / 4;
  subdivQuad(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, mx, my, out, depth + 1);
  subdivQuad(mx, my, (x1 + x2) / 2, (y1 + y2) / 2, x2, y2, out, depth + 1);
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function parseColor(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return null;
  const named = {
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    green: '#008000',
    blue: '#0000ff',
    gray: '#808080',
    grey: '#808080',
    orange: '#ffa500',
    purple: '#800080',
    yellow: '#ffff00',
  };
  const hex = named[s] || s;
  let m = /^#([0-9a-f]{6})$/.exec(hex);
  if (m) {
    const v = parseInt(m[1], 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 255 };
  }
  m = /^#([0-9a-f]{3})$/.exec(hex);
  if (m) {
    const v = parseInt(m[1], 16);
    const r = ((v >> 8) & 15) * 17;
    const g = ((v >> 4) & 15) * 17;
    const b = (v & 15) * 17;
    return { r, g, b, a: 255 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rasterizer
// ---------------------------------------------------------------------------

function isLeft(a, b, px, py) {
  return (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y);
}

function pointInPolygon(px, py, poly) {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.y <= py) {
      if (b.y > py && isLeft(a, b, px, py) > 0) w++;
    } else if (b.y <= py && isLeft(a, b, px, py) < 0) w--;
  }
  return w;
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return Math.hypot(px - qx, py - qy);
}

function strokeDistance(px, py, polys, width) {
  const half = width / 2;
  let best = Infinity;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const d = distToSegment(px, py, poly[i], poly[(i + 1) % poly.length]);
      if (d < best) best = d;
    }
  }
  return best <= half;
}

function renderShapes(shapes, width, height, viewBox, scale) {
  const [vbx, vby, vbw, vbh] = viewBox;
  const s = Math.min(width / vbw, height / vbh);
  const ox = (width - vbw * s) / 2;
  const oy = (height - vbh * s) / 2;

  // Pre-flatten every shape into local (viewBox) coordinates.
  const prepared = shapes.map((shape) => {
    const flattened = flattenPath(shape.d || defaultPathFor(shape));
    const fill = parseColor(shape.attrs.fill);
    const stroke = parseColor(shape.attrs.stroke);
    const strokeWidth = shape.attrs['stroke-width'] ? parseFloat(shape.attrs['stroke-width']) : 1;
    const fillRule = (shape.attrs['fill-rule'] || 'nonzero').toLowerCase();
    const polys = flattened.polys.map((p) =>
      p.map((pt) => ({ x: pt.x - vbx, y: pt.y - vby }))
    );
    if (process.env.ICON_DEBUG) {
      console.log('shape', shape.tag, 'fill=', shape.attrs.fill, 'stroke=', shape.attrs.stroke, 'sw=', strokeWidth, 'npolys=', polys.length, 'pts=', polys.length ? polys[0].length : 0);
    }
    return { polys, fill, stroke, strokeWidth, fillRule };
  });

  const SS = 2; // supersampling factor
  const W = width * SS;
  const H = height * SS;
  const buf = new Float64Array(W * H * 4);
  const local = (px, py) => ({ x: (px - ox) / s, y: (py - oy) / s });

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const pt = local((px + 0.5) / SS, (py + 0.5) / SS);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const sh of prepared) {
        if (sh.fill) {
          let w = 0;
          for (const poly of sh.polys) w += pointInPolygon(pt.x, pt.y, poly);
          const inside = sh.fillRule === 'evenodd' ? w % 2 !== 0 : w !== 0;
          if (inside) {
            r = sh.fill.r;
            g = sh.fill.g;
            b = sh.fill.b;
            a = sh.fill.a;
          }
        }
        if (sh.stroke && sh.polys.length && strokeDistance(pt.x, pt.y, sh.polys, sh.strokeWidth)) {
          r = sh.stroke.r;
          g = sh.stroke.g;
          b = sh.stroke.b;
          a = sh.stroke.a;
        }
      }
      const idx = (py * W + px) * 4;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = a;
    }
  }

  // Downsample.
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const idx = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += buf[idx];
          g += buf[idx + 1];
          b += buf[idx + 2];
          a += buf[idx + 3];
        }
      }
      const n = SS * SS;
      const oi = (y * width + x) * 4;
      out[oi] = Math.round(r / n);
      out[oi + 1] = Math.round(g / n);
      out[oi + 2] = Math.round(b / n);
      out[oi + 3] = Math.round(a / n);
    }
  }
  return out;
}

function defaultPathFor(shape) {
  const a = shape.attrs;
  switch (shape.tag) {
    case 'rect': {
      const x = parseFloat(a.x || 0);
      const y = parseFloat(a.y || 0);
      const w = parseFloat(a.width || 0);
      const h = parseFloat(a.height || 0);
      const rx = parseFloat(a.rx || 0);
      if (rx > 0) {
        const r = Math.min(rx, w / 2, h / 2);
        return (
          `M ${x + r} ${y} ` +
          `L ${x + w - r} ${y} ` +
          `Q ${x + w} ${y} ${x + w} ${y + r} ` +
          `L ${x + w} ${y + h - r} ` +
          `Q ${x + w} ${y + h} ${x + w - r} ${y + h} ` +
          `L ${x + r} ${y + h} ` +
          `Q ${x} ${y + h} ${x} ${y + h - r} ` +
          `L ${x} ${y + r} ` +
          `Q ${x} ${y} ${x + r} ${y} Z`
        );
      }
      return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
    }
    case 'circle': {
      const cx = parseFloat(a.cx || 0);
      const cy = parseFloat(a.cy || 0);
      const r = parseFloat(a.r || 0);
      return `M ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} Z`;
    }
    case 'ellipse': {
      const cx = parseFloat(a.cx || 0);
      const cy = parseFloat(a.cy || 0);
      const rx = parseFloat(a.rx || 0);
      const ry = parseFloat(a.ry || 0);
      return `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} Z`;
    }
    case 'polygon':
      return `M ${(a.points || '').trim().replace(/\s+/g, ' ').replace(/ /g, ' ')} Z`;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// PNG encode / decode (zero deps)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: None
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error(`Unsupported PNG format (depth ${data[8]}, color ${data[9]})`);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
    prev.set(cur);
  }
  return { width, height, rgba: out };
}

// ---------------------------------------------------------------------------
// Icon manifest + CLI
// ---------------------------------------------------------------------------

function renderFile(svgName, pngName, size) {
  const svgPath = path.join(IMG_DIR, svgName);
  const pngPath = path.join(IMG_DIR, pngName);
  const svg = fs.readFileSync(svgPath, 'utf8');
  const doc = parseSvg(svg);
  const rgba = renderShapes(doc.shapes, size, size, doc.viewBox, 1);
  const png = encodePng(size, size, rgba);
  fs.writeFileSync(pngPath, png);
  return { pngPath, size, doc };
}

function buildAll(size) {
  const out = [];
  for (const entry of FILES.plugin) {
    out.push(renderFile(entry.svg, entry.name + '.png', 72));
  }
  for (const entry of FILES.feedback) {
    out.push(renderFile(entry.svg, entry.name + '.png', size));
  }
  return out;
}

function checkAll(size) {
  // Round-trip decode + pixel assertions for every generated PNG.
  const assertions = {
    // 72px plugin/action icons (scale 1)
    'category.png': [
      { x: 18, y: 36, name: 'speaker box (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 36, y: 6, name: 'badge (blue)', pred: (px) => px.b > 150 && px.r < 120 },
      { x: 2, y: 2, name: 'corner (transparent)', pred: (px) => px.a < 64 },
    ],
    'master.png': [
      { x: 18, y: 36, name: 'speaker box (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 36, y: 6, name: 'badge (blue)', pred: (px) => px.b > 150 && px.r < 120 },
    ],
    'appknob.png': [
      { x: 44, y: 23, name: 'knob 1 (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 26, y: 41, name: 'knob 2 (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 38, y: 59, name: 'knob 3 (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 10, y: 10, name: 'badge (teal)', pred: (px) => px.g > 120 && px.b >= 110 && px.r < 80 },
    ],
    'toggle.png': [
      { x: 36, y: 36, name: 'badge (orange)', pred: (px) => px.r > 180 && px.g < 130 && px.b < 80 },
      { x: 48, y: 18, name: 'arrowhead (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 36, y: 24, name: 'arc top (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
    ],
    // 144px feedback icons (scale 2)
    'speaker.png': [
      { x: 36, y: 72, name: 'speaker box (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 4, y: 4, name: 'corner (transparent)', pred: (px) => px.a === 0 },
    ],
    'speaker-muted.png': [
      { x: 36, y: 72, name: 'speaker box (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 92, y: 72, name: 'slash (red)', pred: (px) => px.r > 200 && px.g < 100 && px.b < 100 },
    ],
    'wave.png': [
      { x: 34, y: 72, name: 'bar 1 (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 100, y: 72, name: 'bar 4 (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 4, y: 4, name: 'corner (transparent)', pred: (px) => px.a === 0 },
    ],
    'wave-muted.png': [
      { x: 34, y: 72, name: 'bar 1 (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
      { x: 76, y: 64, name: 'slash (red)', pred: (px) => px.r > 200 && px.g < 100 && px.b < 100 },
      { x: 100, y: 72, name: 'bar 4 (white)', pred: (px) => px.r > 200 && px.g > 200 && px.b > 200 },
    ],
  };
  let ok = true;
  for (const file of Object.keys(assertions)) {
    const expectSize = file === 'category.png' || file === 'master.png' || file === 'appknob.png' || file === 'toggle.png' ? 72 : size;
    const png = fs.readFileSync(path.join(IMG_DIR, file));
    const dec = decodePng(png);
    const at = (x, y) => {
      const i = (y * dec.width + x) * 4;
      return { r: dec.rgba[i], g: dec.rgba[i + 1], b: dec.rgba[i + 2], a: dec.rgba[i + 3] };
    };
    if (dec.width !== expectSize || dec.height !== expectSize) {
      console.log(`FAIL ${file}: expected ${expectSize}x${expectSize}, got ${dec.width}x${dec.height}`);
      ok = false;
      continue;
    }
    for (const a of assertions[file]) {
      const px = at(a.x, a.y);
      if (!a.pred(px)) {
        console.log(`FAIL ${file} @ (${a.x},${a.y}) ${a.name}: rgba(${px.r},${px.g},${px.b},${px.a})`);
        ok = false;
      }
    }
    if (ok) console.log(`OK   ${file} (${dec.width}x${dec.height})`);
  }
  return ok;
}

const args = process.argv.slice(2);
const size = args.includes('--size') ? parseInt(args[args.indexOf('--size') + 1], 10) : 144;

if (import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/')) {
  if (args.includes('--check')) {
    process.exit(checkAll(size) ? 0 : 1);
  } else {
    const built = buildAll(size);
    for (const b of built) console.log(`wrote ${path.relative(ROOT, b.pngPath)} (${b.size}x${b.size})`);
  }
}

export { parseSvg, renderShapes, encodePng, decodePng, parseColor, flattenPath, FILES };
