// Referrer host -> platform (src/sources.js) and the list reader behind src/data/sources.json (scripts/update-sources.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { platformOf, groupReferrers } = require('../src/sources.js');
const { parseList, toGroup } = require('../scripts/update-sources.js');
const list = require('../src/data/sources.json');

const name = (host) => platformOf(host)?.name ?? null;

test('sources: the hosts snar really sees become platform names', () => {
  const expected = {
    'l.instagram.com': 'Instagram', 'instagram.com': 'Instagram', 'lm.facebook.com': 'Facebook', 'm.facebook.com': 'Facebook',
    't.co': 'X', 'x.com': 'X', 'twitter.com': 'X', 'youtu.be': 'YouTube', 'm.youtube.com': 'YouTube', 'lnkd.in': 'LinkedIn',
    'web.telegram.org': 'Telegram', 'out.reddit.com': 'Reddit', 'bsky.app': 'Bluesky',
    'web.whatsapp.com': 'WhatsApp', 'wa.me': 'WhatsApp',
    'mail.google.com': 'Gmail', 'outlook.live.com': 'Outlook',
    'duckduckgo.com': 'DuckDuckGo', 'www.bing.com': 'Bing', 'search.yahoo.com': 'Yahoo',
    'chatgpt.com': 'ChatGPT', 'claude.ai': 'Claude', 'perplexity.ai': 'Perplexity',
    'com.reddit.frontpage': 'Reddit', 'linkedin.android': 'LinkedIn', // app ids arrive as the host of android-app://
  };
  for (const [host, want] of Object.entries(expected)) assert.equal(name(host), want, host);
});

test('sources: country endings, "www." and capital letters', () => {
  for (const h of ['google.de', 'www.google.de', 'google.co.uk', 'WWW.Google.COM.au', 'images.google.fr', 'news.google.com']) assert.equal(name(h), 'Google', h);
  assert.equal(name('de.bing.com'), 'Bing');
  assert.equal(name('l.instagram.com.'), 'Instagram', 'a trailing dot');
});

test('sources: the most specific entry wins, and the group comes along', () => {
  assert.equal(name('gemini.google.com'), 'Gemini');
  assert.equal(platformOf('gemini.google.com').group, 'ai');
  assert.equal(name('mail.google.com'), 'Gmail');
  assert.equal(platformOf('mail.google.com').label, 'E-Mail');
  assert.equal(platformOf('l.instagram.com').label, 'Soziale Netze');
  assert.equal(platformOf('google.de').label, 'Suche');
  assert.equal(name('mail.yahoo.com'), 'Yahoo Mail');
});

test('sources: look-alike hosts are not mistaken for a platform', () => {
  for (const h of ['instagram.com.evil.example', 'notinstagram.com', 'evil-t.co', 't.co.evil.example', 'google.evil.example', 'xgoogle.de', 'wwwinstagram.com']) {
    assert.equal(platformOf(h), null, h);
  }
});

test('sources: empty, odd and huge values give nothing instead of an error', () => {
  for (const h of ['', null, undefined, 'localhost', 'com', '(direkt / QR-Scan)', 'a'.repeat(300), '.', '..', 'x'.repeat(250) + '.com']) assert.equal(platformOf(h), null, String(h).slice(0, 20));
});

test('sources: platforms are folded together, unknown hosts stay visible, order is by clicks', () => {
  const rows = [
    { referrer: 'l.instagram.com', channel: '', n: 5 }, { referrer: 'instagram.com', channel: '', n: 2 }, { referrer: '', channel: '', n: 9 },
    { referrer: 'www.example.org', channel: '', n: 1 }, { referrer: 't.co', channel: '', n: 3 }, { referrer: 'twitter.com', channel: '', n: 1 },
    { referrer: 'wwwfoo.org', channel: '', n: 1 },
  ];
  const got = groupReferrers(rows);
  assert.deepEqual(got.map((r) => [r.ref, r.n]), [['Direkt / unbekannt', 9], ['Instagram', 7], ['X', 4], ['example.org', 1], ['wwwfoo.org', 1]]);
  assert.deepEqual(got.find((r) => r.ref === 'Instagram').hosts, ['l.instagram.com', 'instagram.com']);
  assert.equal(got.find((r) => r.ref === 'Instagram').hint, 'l.instagram.com, instagram.com');
  assert.equal(got.reduce((a, r) => a + r.n, 0), rows.reduce((a, r) => a + r.n, 0), 'no click gets lost');
  assert.deepEqual(groupReferrers([]), []);
});

test('sources: a QR scan is its own source whatever referrer came with it, and a visit without one is "Direkt / unbekannt"', () => {
  const got = groupReferrers([
    { referrer: '', channel: 'qr', n: 4 }, { referrer: 'l.instagram.com', channel: 'qr', n: 2 }, { referrer: '', channel: '', n: 3 }, { referrer: 'l.instagram.com', channel: '', n: 1 },
  ]);
  assert.deepEqual(got.map((r) => [r.ref, r.n, r.group]), [['QR-Scan', 6, 'qr'], ['Direkt / unbekannt', 3, null], ['Instagram', 1, 'social']]);
  assert.ok(got[0].hint.includes('?q'));
  assert.match(got[1].hint, /QR-Code/, 'says that old printed codes land here');
});

test('sources: the shipped list is complete enough and says where it comes from', () => {
  assert.ok(Object.keys(list.social).length >= 50 && Object.keys(list.search).length >= 150 && Object.keys(list.ai).length >= 8);
  assert.equal(list._meta.license, 'CC0-1.0');
  assert.match(list._meta.source, /matomo-org\/searchengine-and-social-list/);
  for (const group of ['social', 'search', 'ai']) {
    for (const hosts of Object.values(list[group])) for (const h of hosts) assert.match(h, /^[a-z0-9{}.-]+$/, `a host name, no path: ${h}`);
  }
});

test('update-sources: reads both list shapes, drops paths, and refuses what it does not understand', () => {
  const social = parseList('Badoo:\n  - badoo.com\n\n"Hacker News":\n  - news.ycombinator.com\nGoogle%2B:\n  - plus.google.com\n', 'simple', 'Socials.yml');
  assert.deepEqual([...social], [['Badoo', ['badoo.com']], ['Hacker News', ['news.ycombinator.com']], ['Google+', ['plus.google.com']]]);

  const search = parseList([
    'Alpha:', '  -', '    urls:', '      - alpha.com', "      - 'alpha.{}'", '    params:', '      - q', '    backlink: "s?q={k}"',
    '  -', '    urls:', '      - alpha.com/images', '    params:', '      - q',
    'Avira SafeSearch:', '  - urls:', '      - search.avira.com', '    params:', '      - ask', '',
  ].join('\n'), 'search', 'SearchEngines.yml');
  assert.deepEqual([...search], [['Alpha', ['alpha.com', 'alpha.{}', 'alpha.com/images']], ['Avira SafeSearch', ['search.avira.com']]]);

  const { groups, skipped } = toGroup(search);
  assert.deepEqual(groups, { Alpha: ['alpha.com', 'alpha.{}'], 'Avira SafeSearch': ['search.avira.com'] });
  assert.equal(skipped, 1, 'the entry with a path');

  assert.throws(() => parseList('Name:\n  * host\n', 'simple', 'x.yml'), /unexpected line/);
  assert.throws(() => parseList('  - orphan\n', 'simple', 'x.yml'), /before the first name/);
  assert.throws(() => parseList('Name:\n  -\n    surprise:\n      - x\n', 'search', 'x.yml'), /unknown key surprise/);
});
