// Target URL, referrer host and request origin rules (src/url-rules.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { isHttpUrl, targetUrlError, refHost, isSameOriginRequest, MAX_HOST_LENGTH } = require('../src/url-rules.js');

test('target URL: ordinary http(s) addresses are fine, also with a port, query, fragment and non-ASCII parts', () => {
  for (const u of ['https://example.org', 'http://example.org/a?b=c#d', 'HTTPS://EXAMPLE.ORG/x', 'https://example.org:8443/', 'https://münchen.example/straße', 'http://localhost:3000/x', 'http://192.168.1.10/intern']) {
    assert.equal(targetUrlError(u), null, u);
  }
});

test('target URL: other schemes and junk are refused', () => {
  for (const u of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://example.org', 'file:///etc/passwd', 'example.org', '', null, undefined, 'https://']) {
    assert.match(targetUrlError(u), /gültige http\(s\)-URL/, String(u));
  }
});

test('target URL: control characters are refused, the parser would drop them without telling', () => {
  for (const u of ['https://example.org/a\r\nSet-Cookie: x=1', 'https://example.org/a\tb', 'https://exa\nmple.org', 'https://example.org/\u0000', 'https://example.org/\u007f']) {
    assert.match(targetUrlError(u), /Steuerzeichen/, JSON.stringify(u));
  }
  assert.equal(targetUrlError('https://example.org/a b'), null, 'a plain space is encoded by the parser and stays allowed');
});

test('target URL: no user name or password before the @', () => {
  for (const u of ['https://paypal.com@evil.example/', 'https://user:pass@example.org/', 'http://:secret@example.org/', 'https://a%40b@example.org/']) {
    assert.match(targetUrlError(u), /Benutzername oder Passwort/, u);
  }
  assert.equal(targetUrlError('https://example.org/path@with-at'), null, 'an @ after the host is fine');
  assert.equal(targetUrlError('https://example.org/?mail=a@b.de'), null);
});

test('isHttpUrl is the plain scheme check used for domains', () => {
  assert.equal(isHttpUrl('https://example.org'), true);
  assert.equal(isHttpUrl('javascript:1'), false);
  assert.equal(isHttpUrl('nonsense'), false);
});

test('referrer host: the host name only, and nothing absurdly long is stored', () => {
  assert.equal(refHost('https://l.instagram.com/?u=https%3A%2F%2Fx'), 'l.instagram.com');
  assert.equal(refHost('android-app://com.reddit.frontpage/'), 'com.reddit.frontpage');
  assert.equal(refHost(''), '');
  assert.equal(refHost('not a url'), '');
  assert.equal(refHost(undefined), '');
  const limit = ['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50), 'd'.repeat(50), 'e'.repeat(50)].join('.').slice(0, MAX_HOST_LENGTH);
  assert.equal(refHost(`http://${limit}/`).length, limit.length, 'exactly the maximum is kept');
  assert.equal(refHost(`http://${'a'.repeat(5000)}.com/`), '', 'longer than a host name can be: dropped');
});

test('same origin: Sec-Fetch-Site decides when the browser sends it, otherwise the Origin header, no header passes', () => {
  const host = 'kurz.example';
  assert.equal(isSameOriginRequest({ secFetchSite: 'same-origin', origin: 'https://evil.example', host }), true, 'the browser header wins');
  assert.equal(isSameOriginRequest({ secFetchSite: 'none', host }), true, 'typed address or bookmark');
  assert.equal(isSameOriginRequest({ secFetchSite: 'cross-site', origin: 'https://kurz.example', host }), false);
  assert.equal(isSameOriginRequest({ secFetchSite: 'same-site', host }), false, 'another subdomain is not this site');
  assert.equal(isSameOriginRequest({ origin: 'https://kurz.example', host }), true);
  assert.equal(isSameOriginRequest({ origin: 'https://evil.example', host }), false);
  assert.equal(isSameOriginRequest({ origin: 'https://kurz.example:8443', host: 'kurz.example' }), false, 'the port counts');
  assert.equal(isSameOriginRequest({ origin: 'null', host }), false);
  assert.equal(isSameOriginRequest({ host }), true, 'curl and scripts send neither header');
});

test('ids: plain decimal digits only, everything Number() would still accept is refused', () => {
  const { parseId } = require('../src/url-rules.js');
  assert.equal(parseId('73'), 73);
  assert.equal(parseId(73), 73);
  assert.equal(parseId('9007199254740991'), 9007199254740991);
  for (const bad of ['073', '0x49', '1e1', ' 73', '73 ', '+73', '-73', '0', '', '7.3', '١٢', '１２', '1_0', '9007199254740993', '99999999999999999', null, undefined, {}, [], ['7', '8']]) {
    assert.equal(parseId(bad), 0, JSON.stringify(bad));
  }
});
