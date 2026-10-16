// ZIP and CSV writers for the bulk download of selected links.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createZip } = require('../src/zip.js');
const { toCsv } = require('../src/csv.js');

// Reads an archive back the way an unzip tool does: end record, central directory, then each local entry.
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end of central directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    assert.equal(buf.readUInt32LE(local), 0x04034b50, 'local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.equal(data.length, usize);
    assert.equal(zlib.crc32(data), crc, `crc of ${name}`);
    out.push({ name, method, data });
    p += 46 + nameLen;
  }
  return out;
}

test('zip: entries survive a round trip, compressible ones are deflated, incompressible ones stored', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg">' + '<path d="M0 0h1v1z"/>'.repeat(200) + '</svg>';
  const noise = crypto.randomBytes(400); // random bytes do not deflate, like a PNG
  const zip = createZip([
    { name: 'qr-sommerfest.svg', data: svg },
    { name: 'qr-zufall.png', data: noise },
    { name: 'leer.txt', data: '' },
  ], { date: new Date(2026, 9, 13, 12, 30, 0) });
  const files = readZip(zip);
  assert.deepEqual(files.map((f) => f.name), ['qr-sommerfest.svg', 'qr-zufall.png', 'leer.txt']);
  assert.equal(files[0].method, 8);
  assert.equal(files[0].data.toString(), svg);
  assert.equal(files[1].method, 0);
  assert.deepEqual(files[1].data, noise);
  assert.equal(files[2].data.length, 0);
});

test('zip: an empty archive is still a valid one, and names with umlauts are kept', () => {
  assert.deepEqual(readZip(createZip([])), []);
  assert.equal(readZip(createZip([{ name: 'größe.txt', data: 'x' }]))[0].name, 'größe.txt');
});

test('zip: names that could unpack outside the folder are refused', () => {
  for (const name of ['', '/etc/passwd', '../x.svg', 'a/../b.svg', 'a\\b.svg', 'a\nb.svg']) {
    assert.throws(() => createZip([{ name, data: 'x' }]), /invalid zip entry name/, JSON.stringify(name));
  }
});

test('csv: German Excel format with BOM, quoting and formula protection', () => {
  const csv = toCsv(['Kurzlink', 'Titel', 'Klicks'], [
    ['https://x.de/abc', 'Sommer; "Fest"', 12],
    ['https://x.de/def', '=HYPERLINK("http://böse")', 0],
    ['https://x.de/ghi', '-1+1', null],
    ['https://x.de/jkl', 'Zeile 1\nZeile 2', 3],
  ]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.slice(1), [
    'Kurzlink;Titel;Klicks',
    'https://x.de/abc;"Sommer; ""Fest""";12',
    'https://x.de/def;"\'=HYPERLINK(""http://böse"")";0',
    'https://x.de/ghi;\'-1+1;',
    'https://x.de/jkl;"Zeile 1\nZeile 2";3',
    '',
  ].join('\r\n'));
});

// --- Which links a bulk request gets (src/bulk.js) ---------------------------------------------------------
const { selectLinks, zipNames, createSlots, LIMITS, MAX_BODY_PARAMS } = require('../src/bulk.js');

const rows = new Map([
  [1, { id: 1, slug: 'eigener', owner_id: 10, visibility: 'privat' }],
  [2, { id: 2, slug: 'team', owner_id: 20, visibility: 'org' }],
  [3, { id: 3, slug: 'fremd', owner_id: 20, visibility: 'privat' }],
]);
const member = { id: 10, role: 'member' };
// the same rule as canManage() in server.js
const canSee = (user) => (l) => user.role === 'admin' || l.owner_id === user.id || l.visibility === 'org';
const pick = (body, user = member, extra = {}) => selectLinks(body, { getLink: (id) => rows.get(id), canSee: canSee(user), ...extra });

test('bulk: own and shared links are taken, a foreign private link is left out, the order is kept', () => {
  const r = pick({ action: 'csv', ids: ['3', '2', '1', '999'] });
  assert.deepEqual(r.links.map((l) => l.id), [2, 1]);
  assert.equal(r.action, 'csv');
  // an admin may see all of them
  assert.deepEqual(pick({ action: 'qr-svg', ids: ['1', '2', '3'] }, { id: 1, role: 'admin' }).links.map((l) => l.id), [1, 2, 3]);
});

test('bulk: a single id arrives as a string, repeated ids count once, junk is ignored', () => {
  assert.deepEqual(pick({ action: 'csv', ids: '2' }).links.map((l) => l.id), [2]);
  assert.deepEqual(pick({ action: 'csv', ids: ['2', '2', ' 2 '] }).links.map((l) => l.id), [2]);
  for (const ids of [undefined, [], ['abc', '-5', '1.5', '0', '', '99999999999999999999']]) {
    assert.equal(pick({ action: 'csv', ids }).error, 'Bitte zuerst Links auswählen.');
  }
});

test('bulk: unknown actions are refused, also names that exist on every object', () => {
  for (const action of [undefined, '', 'zip', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(pick({ action, ids: '2' }).error, 'Unbekannte Aktion.', String(action));
  }
});

test('bulk: the cap per action holds, a lower PNG cap points to SVG, and nothing is looked up beyond it', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => String(i + 1));
  let lookups = 0;
  const counting = { getLink: (id) => { lookups++; return rows.get(id); }, canSee: canSee(member) };
  assert.match(selectLinks({ action: 'qr-png', ids: many(LIMITS['qr-png'] + 1) }, counting).error, /höchstens 1000/);
  assert.doesNotMatch(selectLinks({ action: 'qr-png', ids: many(LIMITS['qr-png'] + 1) }, counting).error, /Als SVG/, 'no hint while PNG is as generous as SVG');
  const tight = { ...counting, limits: { 'qr-svg': 200, 'qr-png': 30 } };
  assert.match(selectLinks({ action: 'qr-png', ids: many(31) }, tight).error, /höchstens 30.*Als SVG sind bis zu 200 möglich/);
  assert.match(selectLinks({ action: 'qr-svg', ids: many(LIMITS['qr-svg'] + 1) }, counting).error, /höchstens 1000/);
  assert.match(selectLinks({ action: 'csv', ids: many(LIMITS.csv + 1) }, counting).error, /höchstens 2000/);
  assert.equal(lookups, 0, 'too many ids are refused before any database lookup');
  assert.ok(selectLinks({ action: 'qr-png', ids: many(LIMITS['qr-png']) }, counting).links, 'exactly the cap is fine');
  assert.match(selectLinks({ action: 'qr-eps', ids: many(LIMITS['qr-eps'] + 1) }, counting).error, /höchstens 1000/);
});

test('bulk: only links the user cannot see leaves nothing to download', () => {
  assert.equal(pick({ action: 'csv', ids: ['3', '999'] }).error, 'Die gewählten Links sind nicht verfügbar.');
});

test('bulk: the parser limit stays above the largest cap, with room for the other fields', () => {
  assert.ok(MAX_BODY_PARAMS >= Math.max(...Object.values(LIMITS)) + 3);
});

test('bulk: ZIP file names are unique even on a case-insensitive file system', () => {
  const l = (id, slug) => ({ id, slug });
  assert.deepEqual(zipNames([l(1, 'abc'), l(2, 'def')], 'svg'), ['qr-abc.svg', 'qr-def.svg']);
  assert.deepEqual(zipNames([l(81, 'Bulk-C'), l(82, 'bulk-c')], 'png'), ['qr-Bulk-C.png', 'qr-bulk-c-82.png']);
  // a later link whose slug already looks like the renamed one
  const names = zipNames([l(1, 'abc'), l(2, 'ABC'), l(3, 'abc-2')], 'svg');
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 3, names.join(', '));
});

test('bulk: only plain decimal ids count, odd spellings of numbers do not map onto other links', () => {
  const got = (ids) => pick({ action: 'csv', ids });
  for (const bad of ['1e0', '0x1', '+1', ' 1', '1 ', '01', '1.0', '١', '１', '-1', '0', '1_0']) {
    assert.equal(got(bad).error, 'Bitte zuerst Links auswählen.', JSON.stringify(bad));
  }
  assert.deepEqual(got(['1', '1e0', '2']).links.map((l) => l.id), [1, 2]);
  assert.equal(got('9'.repeat(17)).error, 'Bitte zuerst Links auswählen.', 'more digits than a safe integer');
});

test('bulk: slots limit the QR ZIP work in parallel, overall and per person, and hand a slot back once', () => {
  const slots = createSlots({ total: 2, perUser: 1 });
  const a = slots.acquire(1);
  assert.equal(typeof a, 'function');
  assert.equal(slots.acquire(1), null, 'second download of the same person');
  const b = slots.acquire(2);
  assert.equal(typeof b, 'function');
  assert.equal(slots.acquire(3), null, 'no free slot overall');
  a(); a(); // releasing twice must not free a second slot
  const c = slots.acquire(3);
  assert.equal(typeof c, 'function');
  assert.equal(slots.acquire(4), null, 'still only two running');
  b(); c();
  assert.equal(typeof slots.acquire(1), 'function', 'everything free again');
});
