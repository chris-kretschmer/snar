// CSV for the link export, written for German Excel: semicolon as separator, CRLF, UTF-8 with BOM.
// Titles and URLs come from users, so a cell that starts with = + - @ (or a tab/CR) would be run as a
// formula when the file is opened in a spreadsheet. Those text cells get a leading apostrophe, the usual
// mitigation; numbers are written as they are.
const BOM = String.fromCharCode(0xfeff);
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (typeof value === 'number') return String(value);
  let s = value == null ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// header: [string], rows: [[string|number|null]]
function toCsv(header, rows) {
  return BOM + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

module.exports = { toCsv };
