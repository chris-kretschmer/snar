// QR code as EPS (Encapsulated PostScript): print shops and layout programs (InDesign, Illustrator, CorelDRAW) still
// ask for it. Pure vector, one filled path, so the code stays sharp at any size and has no seams between modules.
// Kept free of the qrcode library: it takes the module matrix (size, get(row, col)) from QRCode.create().

const EPS_SIZE_PT = 288; // 4 inch (101.6 mm); a vector file scales, this is only the size it opens with
const HEX_RE = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;

// "#rrggbb" or "#rrggbbaa" -> { rgb: 'r g b' (0..1), transparent }. EPS has no alpha: a fully transparent colour
// means "do not paint it", any other alpha is ignored. Anything that is not a hex colour falls back to the default,
// so no user text can end up in the PostScript.
function colorOf(value, fallback) {
  const m = HEX_RE.exec(String(value || ''));
  if (!m) return { rgb: fallback, transparent: false };
  const n = parseInt(m[1], 16);
  const part = (shift) => (((n >> shift) & 255) / 255).toFixed(4);
  return { rgb: `${part(16)} ${part(8)} ${part(0)}`, transparent: m[2] !== undefined && m[2].toLowerCase() === '00' };
}

// modules: { size, get(row, col) }. margin in modules (the quiet zone), like the SVG and PNG output.
// color: { dark, light } as hex strings, both optional.
function qrToEps(modules, { margin = 2, color = {} } = {}) {
  const n = modules.size;
  const total = n + margin * 2;
  const dark = colorOf(color.dark, '0.0000 0.0000 0.0000');
  const light = colorOf(color.light, '1.0000 1.0000 1.0000');
  // One box per horizontal run of dark modules, written as "width x y R". Y counts from the bottom in
  // PostScript, the matrix from the top.
  const runs = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!modules.get(row, col)) continue;
      const start = col;
      while (col + 1 < n && modules.get(row, col + 1)) col++;
      runs.push(`${col - start + 1} ${start + margin} ${total - margin - row - 1} R`);
    }
  }
  const lines = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%Creator: snar',
    '%%Title: QR code',
    `%%BoundingBox: 0 0 ${EPS_SIZE_PT} ${EPS_SIZE_PT}`,
    `%%HiResBoundingBox: 0 0 ${EPS_SIZE_PT} ${EPS_SIZE_PT}`,
    '%%LanguageLevel: 1',
    '%%Pages: 1',
    '%%EndComments',
    '%%Page: 1 1',
    'gsave',
    `${(EPS_SIZE_PT / total).toFixed(6)} dup scale`,
    // width x y R: a box one module high, counter-clockwise (all boxes the same way, so overlaps never cancel out)
    '/R { moveto dup 0 rlineto 0 1 rlineto neg 0 rlineto closepath } bind def',
  ];
  if (!light.transparent) {
    lines.push(`${light.rgb} setrgbcolor`, `newpath 0 0 moveto ${total} 0 rlineto 0 ${total} rlineto ${-total} 0 rlineto closepath fill`);
  }
  lines.push('newpath', ...runs, `${dark.rgb} setrgbcolor`, 'fill', 'grestore', 'showpage', '%%EOF', '');
  return lines.join('\n');
}

module.exports = { qrToEps, EPS_SIZE_PT };
