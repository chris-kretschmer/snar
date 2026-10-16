// QR code as PNG, written directly from the module matrix. The qrcode library's own PNG output draws a full RGBA
// image pixel by pixel (~170 ms for 1024 px in the 0.5-CPU container, and it blocks the event loop meanwhile).
// A QR code has two colours, so a 1-bit palette image is all it needs: 128 KB of raw data instead of 4 MB, and the
// deflate step is a few milliseconds. Takes { size, get(row, col) } from QRCode.create().
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEX_RE = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;

// "#rrggbb" or "#rrggbbaa" -> [r, g, b, a]; anything else gives the fallback.
function rgba(value, fallback) {
  const m = HEX_RE.exec(String(value || ''));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] === undefined ? 255 : parseInt(m[2], 16)];
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// size: width and height in pixels (at least one pixel per module). margin: quiet zone in modules.
// color: { dark, light } as hex strings, both optional; an alpha part (#rrggbbaa) is kept via a tRNS chunk.
function qrToPng(modules, { size = 512, margin = 2, color = {} } = {}) {
  const n = modules.size;
  const total = n + margin * 2;
  const width = Math.max(Math.round(size), total);
  const dark = rgba(color.dark, [0, 0, 0, 255]);
  const light = rgba(color.light, [255, 255, 255, 255]);

  // Pixel column / row -> module index (negative or >= n lies in the quiet zone).
  const at = new Int32Array(width);
  for (let p = 0; p < width; p++) at[p] = Math.floor((p * total) / width) - margin;

  // One packed row per module row (1 bit per pixel, 1 = dark, filter byte 0 in front); the pixel rows reuse them.
  const rowBytes = Math.ceil(width / 8);
  const stride = rowBytes + 1;
  const blank = Buffer.alloc(stride);
  const packed = new Array(n);
  for (let r = 0; r < n; r++) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const c = at[x];
      if (c >= 0 && c < n && modules.get(r, c)) line[1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
    packed[r] = line;
  }
  const raw = Buffer.alloc(stride * width);
  for (let y = 0; y < width; y++) {
    const r = at[y];
    (r >= 0 && r < n ? packed[r] : blank).copy(raw, y * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 3; // colour type: palette
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('PLTE', Buffer.from([light[0], light[1], light[2], dark[0], dark[1], dark[2]]))];
  if (light[3] !== 255 || dark[3] !== 255) parts.push(chunk('tRNS', Buffer.from([light[3], dark[3]])));
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

module.exports = { qrToPng };
