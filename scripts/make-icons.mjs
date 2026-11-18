// Generates icons/icon{16,32,48,128}.png with no dependencies (Node zlib only).
// Run: node scripts/make-icons.mjs
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#1a1a1b');
const TILES = [hex('#3a6fd8'), hex('#e8893a'), hex('#8e44c4')];
const OUTLINE = hex('#5a5a5f');

// Signed distance to a rounded rectangle (centre cx,cy; half size hw,hh; radius r).
function roundedRectDist(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function render(size) {
  const SS = 4; // supersampling per axis
  const px = new Float64Array(size * size * 4);
  const u = size / 128; // design units on a 128 grid
  const tile = 46 * u, gap = 8 * u, pad = (128 * u - 2 * tile - gap) / 2;
  const cells = [
    [pad, pad], [pad + tile + gap, pad],
    [pad, pad + tile + gap], [pad + tile + gap, pad + tile + gap]
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
          let col = null;
          if (roundedRectDist(fx, fy, size / 2, size / 2, size / 2, size / 2, 26 * u) <= 0) col = BG;
          cells.forEach(([cx, cy], i) => {
            const d = roundedRectDist(fx, fy, cx + tile / 2, cy + tile / 2, tile / 2, tile / 2, 6 * u);
            if (i < 3 && d <= 0) col = TILES[i];
            if (i === 3 && d <= 0 && d > -Math.max(1, 5 * u)) col = OUTLINE;
          });
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }
      const n = SS * SS, o = (y * size + x) * 4;
      px[o] = a ? r / a : 0; px[o + 1] = a ? g / a : 0; px[o + 2] = a ? b / a : 0; px[o + 3] = (a / n) * 255;
    }
  }
  return px;
}

function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size * 4; x++) raw[y * (size * 4 + 1) + 1 + x] = Math.round(px[y * size * 4 + x]);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), png(size, render(size)));
  console.log(`icons/icon${size}.png`);
}
