// Draws the extension/website icons (a lightning bolt on a dark tile) as PNGs
// and an SVG favicon. Run once: node scripts/make-icons.js

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../server/config.js';

// Bolt outline on a 0..1 square.
const BOLT = [[0.58, 0.12], [0.26, 0.56], [0.47, 0.56], [0.40, 0.88], [0.74, 0.42], [0.53, 0.42]];
const BG = [17, 24, 39];
const FG = [250, 204, 21];

function inside(x, y, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function inTile(x, y, r = 0.2) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function png(size) {
  const ss = 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let a = 0; let bolt = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (inTile(x, y)) {
            a += 1;
            if (inside(x, y, BOLT)) bolt += 1;
          }
        }
      }
      const n = ss * ss;
      const t = a ? bolt / a : 0;
      const o = 1 + px * 4;
      for (let c = 0; c < 3; c++) row[o + c] = Math.round(BG[c] * (1 - t) + FG[c] * t);
      row[o + 3] = Math.round((a / n) * 255);
    }
    rows.push(row);
  }
  const crcTable = (buf) => zlib.crc32(buf);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcTable(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [16, 48, 128]) fs.writeFileSync(path.join(ROOT, 'extension', `icon${s}.png`), png(s));
fs.mkdirSync(path.join(ROOT, 'web', 'img'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'web', 'img', 'icon-192.png'), png(192));
const pts = BOLT.map(([x, y]) => `${(x * 64).toFixed(1)},${(y * 64).toFixed(1)}`).join(' ');
fs.writeFileSync(path.join(ROOT, 'web', 'img', 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="13" fill="#111827"/><polygon points="${pts}" fill="#facc15"/></svg>\n`);
console.log('Icons written.');
