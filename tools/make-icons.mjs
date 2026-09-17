/**
 * 鐢熸垚鎵╁睍鍥炬爣锛?6/48/128 PNG锛屾棤绗笁鏂逛緷璧栵級銆? *   node tools/make-icons.mjs
 * 鍥炬锛氳摑缁挎笎鍙樺渾瑙掓柟鍧?+ 鐧借壊銆岃瘧銆嶅瓧褰㈡爡鏍硷紙鐢ㄧ煩褰㈡嫾鍑猴紝閬垮厤渚濊禆瀛椾綋锛夈€? */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../public/icons');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const p = pixels(x, y);
      raw[i] = p[0]; raw[i + 1] = p[1]; raw[i + 2] = p[2]; raw[i + 3] = p[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 銆岃瘧銆嶇殑绠€鍖栨爡鏍硷細宸﹁竟瑷€瀛楁梺涓ゆí + 鍙宠竟涓夋í涓€绔?*/
function glyph(x, y, s) {
  const u = Math.floor((x / s) * 12);   // 0..11
  const v = Math.floor((y / s) * 12);
  const bars = (u0, u1, v0) => u >= u0 && u <= u1 && (v === v0 || v === v0 + 1);
  return (
    bars(1, 4, 3) || bars(1, 4, 6) ||          // 瑷€瀛楁梺涓ゆí
    bars(1, 2, 1) || bars(3, 4, 1) ? false : false
  ) || (
    bars(6, 10, 2) || bars(6, 10, 5) || bars(6, 10, 8) ||  // 鍙充晶涓夋í
    (u >= 8 && u <= 9 && v >= 1 && v <= 9)                 // 鍙充晶绔?  ) || (u >= 5 && u <= 10 && v >= 10 && v <= 10);          // 搴曟í
}

function makeIcon(size) {
  const radius = size * 0.22;
  return encodePng(size, (x, y) => {
    // 鍦嗚
    const rx = Math.min(x, size - 1 - x);
    const ry = Math.min(y, size - 1 - y);
    if (rx < radius && ry < radius) {
      const dx = radius - rx;
      const dy = radius - ry;
      if (dx * dx + dy * dy > radius * radius) return [0, 0, 0, 0];
    }
    // 娓愬彉搴?    const t = (x + y) / (2 * size);
    const bg = [
      Math.round(37 + (34 - 37) * t),
      Math.round(99 + (197 - 99) * t),
      Math.round(235 + (94 - 235) * t),
      255,
    ];
    if (size >= 32 && glyph(x, y, size)) return [255, 255, 255, 255];
    if (size < 32) {
      // 灏忓昂瀵稿彧鐢讳袱鏉＄櫧鏉狅紝淇濊瘉娓呮櫚
      const bar = (x > size * 0.22 && x < size * 0.78) && ((y > size * 0.34 && y < size * 0.45) || (y > size * 0.58 && y < size * 0.69));
      if (bar) return [255, 255, 255, 255];
    }
    return bg;
  });
}

fs.mkdirSync(OUT, { recursive: true });
[16, 48, 128].forEach((size) => {
  const file = path.join(OUT, 'icon' + size + '.png');
  fs.writeFileSync(file, makeIcon(size));
  console.log('鐢熸垚 ' + path.relative(path.resolve(__dirname, '..'), file) + ' (' + size + 'px)');
});
