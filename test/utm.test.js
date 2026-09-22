// utm_* parameters on a target URL (public/utm-shared.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitUtm, withUtm, readUtmFields, buildTargetUrl, canonicalUrl, MAX_UTM_VALUE } = require('../public/utm-shared.js');

test('splitUtm takes the parameters out and leaves the rest byte-for-byte', () => {
  assert.deepEqual(splitUtm('https://x.de/p'), { base: 'https://x.de/p', utm: {} });
  assert.deepEqual(
    splitUtm('https://x.de/p?a=1&utm_source=news%20letter&b=%C3%A4+c&utm_medium=email#top'),
    { base: 'https://x.de/p?a=1&b=%C3%A4+c#top', utm: { source: 'news letter', medium: 'email' } },
  );
  // only utm_ parameters that are ours; the first repeated value wins; keys are case-insensitive
  assert.deepEqual(splitUtm('https://x.de/?utm_id=7&UTM_Source=a&utm_source=b'), { base: 'https://x.de/?utm_id=7', utm: { source: 'a' } });
  // a "?" after "#" belongs to the fragment
  assert.deepEqual(splitUtm('https://x.de/#/route?utm_source=a'), { base: 'https://x.de/#/route?utm_source=a', utm: {} });
  assert.deepEqual(splitUtm('https://x.de/?utm_term=x'), { base: 'https://x.de/', utm: { term: 'x' } });
});

test('withUtm appends in a fixed order, encoded, before the fragment', () => {
  assert.equal(withUtm('https://x.de/p', {}), 'https://x.de/p');
  assert.equal(withUtm('https://x.de/p', { campaign: 'Sommer Fest', source: 'ä&b=c' }), 'https://x.de/p?utm_source=%C3%A4%26b%3Dc&utm_campaign=Sommer%20Fest');
  assert.equal(withUtm('https://x.de/p?a=1#top', { medium: 'email' }), 'https://x.de/p?a=1&utm_medium=email#top');
  assert.equal(withUtm('https://x.de/p?', { medium: 'email' }), 'https://x.de/p?utm_medium=email');
  assert.equal(withUtm('https://x.de/p?a=1&', { medium: 'email' }), 'https://x.de/p?a=1&utm_medium=email');
});

test('split and join survive a round trip, also with odd values', () => {
  for (const utm of [{ source: 'a b', term: 'ü/?#&=%' }, { content: '100 %' }]) {
    const url = withUtm('https://x.de/p?a=1#f', utm);
    assert.deepEqual(splitUtm(url), { base: 'https://x.de/p?a=1#f', utm });
  }
});

test('form fields: trimmed, control characters removed, capped, empty ones left out', () => {
  assert.deepEqual(readUtmFields({ utm_source: '  news\r\nletter ', utm_medium: '   ', utm_campaign: 'x'.repeat(500), other: 'y' }),
    { source: 'news  letter', campaign: 'x'.repeat(MAX_UTM_VALUE) });
  assert.deepEqual(readUtmFields(undefined), {});
});

test('buildTargetUrl: parameters typed into the URL are kept, the fields win per key', () => {
  assert.equal(buildTargetUrl('https://x.de/p?utm_source=a&utm_term=t', { source: 'b' }), 'https://x.de/p?utm_source=b&utm_term=t');
  assert.equal(buildTargetUrl('https://x.de/p', {}), 'https://x.de/p');
  assert.equal(buildTargetUrl('https://x.de/p?a=1', { medium: 'email' }), 'https://x.de/p?a=1&utm_medium=email');
});

test('canonicalUrl normalises order only, so an unchanged link compares equal', () => {
  const stored = 'https://x.de/p?utm_medium=email&a=1&utm_source=n';
  assert.equal(canonicalUrl(stored), 'https://x.de/p?a=1&utm_source=n&utm_medium=email');
  const { base, utm } = splitUtm(stored);
  assert.equal(buildTargetUrl(base, utm), canonicalUrl(stored));
  assert.equal(canonicalUrl('https://x.de/p'), 'https://x.de/p');
});
