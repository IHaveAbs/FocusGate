// Generates Focus Gate icons (16/48/128) as PNGs with no dependencies.
// Design: an indigo target — amber ring, amber center dot — on a deep
// indigo disc. Run: node icons/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ---- minimal PNG encoder -------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- artwork -------------------------------------------------------------
const HEX = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const INK = HEX('#1C1440');   // disc fill
const RING = HEX('#3A2E6E');  // inner faint ring
const AMBER = HEX('#FFC53D'); // target ring + center dot

function sample(nx, ny) {
  // nx, ny in [-1, 1]; returns [r, g, b, a] with coverage alpha
  const r = Math.sqrt(nx * nx + ny * ny);
  let col = null;
  if (r <= 0.92) {
    if (r <= 0.16) col = AMBER;
    else if (r >= 0.42 && r <= 0.56) col = AMBER;
    else if (r >= 0.70 && r <= 0.82) col = RING;
    else col = INK;
  }
  if (!col) return [0, 0, 0, 0];
  // soft edge inside the disc
  let alpha = 255;
  if (r > 0.82) alpha = Math.round(((0.92 - r) / 0.10) * 255);
  if (r > 0.56 && r < 0.42 + 0.02) alpha = 255; // ring edges crisp
  return [col[0], col[1], col[2], Math.max(0, Math.min(255, alpha))];
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const nx = ((x + ox) / size) * 2 - 1;
        const ny = ((y + oy) / size) * 2 - 1;
        const c = sample(nx, ny);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += c[3];
      }
      const i = (y * size + x) * 4;
      px[i] = acc[0] / 4; px[i + 1] = acc[1] / 4; px[i + 2] = acc[2] / 4; px[i + 3] = acc[3] / 4;
    }
  }
  return encodePNG(size, size, px);
}

mkdirSync(__dir, { recursive: true });
for (const size of [16, 48, 128]) {
  const out = join(__dir, `icon${size}.png`);
  writeFileSync(out, render(size));
  console.log(`wrote ${out}`);
}
