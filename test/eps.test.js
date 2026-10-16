// EPS output for QR codes (src/eps.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');
const { qrToEps, EPS_SIZE_PT } = require('../src/eps.js');

// A 3x3 matrix, dark where the pattern has a 1: easy to check by eye.
const pattern = ['101', '010', '101'];
const matrix = { size: 3, get: (r, c) => pattern[r][c] === '1' };
const boxes = (eps) => eps.split('\n').filter((l) => / R$/.test(l));

test('eps: header, bounding box, and the dark modules at the right place (y counts from the bottom)', () => {
  const eps = qrToEps(matrix, { margin: 1 }); // 5 modules wide with the margin
  const lines = eps.split('\n');
  assert.equal(lines[0], '%!PS-Adobe-3.0 EPSF-3.0');
  assert.ok(lines.includes(`%%BoundingBox: 0 0 ${EPS_SIZE_PT} ${EPS_SIZE_PT}`));
  assert.ok(eps.endsWith('%%EOF\n'));
  // "width x y R": the top matrix row is the highest box
  assert.deepEqual(boxes(eps), ['1 1 3 R', '1 3 3 R', '1 2 2 R', '1 1 1 R', '1 3 1 R']);
  assert.equal(lines.filter((l) => l === 'fill').length, 1, 'one fill for all modules');
});

test('eps: neighbouring dark modules in a row become one box', () => {
  assert.deepEqual(boxes(qrToEps({ size: 4, get: () => false }, { margin: 0 })), []);
  // top row: dark, dark, light, dark
  assert.deepEqual(boxes(qrToEps({ size: 4, get: (r, c) => r === 0 && c !== 2 }, { margin: 0 })), ['2 0 3 R', '1 3 3 R']);
});

test('eps: colours are set, a transparent background is not painted, junk falls back to black on white', () => {
  const set = (eps) => eps.split('\n').filter((l) => /setrgbcolor/.test(l));
  assert.deepEqual(set(qrToEps(matrix)), ['1.0000 1.0000 1.0000 setrgbcolor', '0.0000 0.0000 0.0000 setrgbcolor']);
  assert.deepEqual(set(qrToEps(matrix, { color: { dark: '#ff0000', light: '#00ff00' } })), ['0.0000 1.0000 0.0000 setrgbcolor', '1.0000 0.0000 0.0000 setrgbcolor']);
  assert.deepEqual(set(qrToEps(matrix, { color: { dark: '#2140c8', light: '#ffffff00' } })), ['0.1294 0.2510 0.7843 setrgbcolor'], 'only the dark colour, no background');
  assert.deepEqual(set(qrToEps(matrix, { color: { dark: 'red); showpage (', light: '#12' } })), set(qrToEps(matrix)));
  assert.ok(!qrToEps(matrix, { color: { dark: 'red); showpage (' } }).includes('red'));
});

test('eps: a real QR code is exactly the dark modules, and the text is plain ASCII', () => {
  const { modules } = QRCode.create('https://snar.example/ab3x', { errorCorrectionLevel: 'M' });
  let dark = 0;
  for (let r = 0; r < modules.size; r++) for (let c = 0; c < modules.size; c++) if (modules.get(r, c)) dark++;
  const eps = qrToEps(modules, { margin: 2 });
  const area = boxes(eps).reduce((sum, l) => sum + Number(l.split(' ')[0]), 0);
  assert.equal(area, dark);
  assert.ok(/^[\x20-\x7e\n]+$/.test(eps), 'no byte outside printable ASCII');
  // every box lies inside the code area
  for (const l of boxes(eps)) {
    const [w, bx, by] = l.split(' ').map(Number);
    assert.ok(bx >= 2 && bx + w <= modules.size + 2 && by >= 2 && by < modules.size + 2, l);
  }
});
