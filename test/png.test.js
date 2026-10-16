// PNG output for QR codes (src/png.js): written by hand, so read back the way a decoder does.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const QRCode = require('qrcode');
const { qrToPng } = require('../src/png.js');

// Splits the file into chunks (checking every CRC), inflates the image data and unpacks the 1-bit rows.
function readPng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'signature');
  const chunks = {};
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    assert.equal(buf.readUInt32BE(p + 8 + len), zlib.crc32(buf.subarray(p + 4, p + 8 + len)), `crc of ${type}`);
    chunks[type] = data;
    p += 12 + len;
  }
  assert.equal(p, buf.length);
  const width = chunks.IHDR.readUInt32BE(0);
  const height = chunks.IHDR.readUInt32BE(4);
  assert.deepEqual([...chunks.IHDR.subarray(8)], [1, 3, 0, 0, 0], '1 bit, palette, no interlace');
  const raw = zlib.inflateSync(chunks.IDAT);
  const stride = Math.ceil(width / 8) + 1;
  assert.equal(raw.length, stride * height);
  const bit = (x, y) => {
    assert.equal(raw[y * stride], 0, 'filter byte');
    return (raw[y * stride + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
  };
  return { width, height, bit, plte: chunks.PLTE, trns: chunks.tRNS };
}

const qr = (text, ec = 'M') => QRCode.create(text, { errorCorrectionLevel: ec }).modules;

test('png: the size is exact and every module sits where the matrix says (quiet zone included)', () => {
  const modules = qr('https://snar.example/ab3x');
  const img = readPng(qrToPng(modules, { size: 1024, margin: 2 }));
  assert.equal(img.width, 1024);
  assert.equal(img.height, 1024);
  const total = modules.size + 4;
  const px = (m) => Math.floor(((m + 0.5) * 1024) / total); // centre of module column/row m (quiet zone counted)
  for (let r = -2; r < modules.size + 2; r++) {
    for (let c = -2; c < modules.size + 2; c++) {
      const dark = r >= 0 && c >= 0 && r < modules.size && c < modules.size && modules.get(r, c);
      assert.equal(img.bit(px(c + 2), px(r + 2)), dark ? 1 : 0, `module ${r},${c}`);
    }
  }
});

test('png: colours go into the palette, a transparent colour into tRNS, junk falls back to black on white', () => {
  const m = qr('x');
  const plain = readPng(qrToPng(m));
  assert.deepEqual([...plain.plte], [255, 255, 255, 0, 0, 0]);
  assert.equal(plain.trns, undefined, 'opaque: no tRNS chunk');
  const blue = readPng(qrToPng(m, { color: { dark: '#2140c8', light: '#ffffff00' } }));
  assert.deepEqual([...blue.plte], [255, 255, 255, 0x21, 0x40, 0xc8]);
  assert.deepEqual([...blue.trns], [0, 255]);
  assert.deepEqual([...readPng(qrToPng(m, { color: { dark: 'red', light: '#12' } })).plte], [255, 255, 255, 0, 0, 0]);
});

test('png: never smaller than one pixel per module, and odd sizes work', () => {
  const m = qr('https://snar.example/ab3x');
  assert.equal(readPng(qrToPng(m, { size: 10 })).width, m.size + 4);
  const odd = readPng(qrToPng(m, { size: 333 }));
  assert.equal(odd.width, 333);
  assert.equal(odd.bit(0, 0), 0, 'quiet zone is light');
});
