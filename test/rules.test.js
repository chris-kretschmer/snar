// Click counting rules, login limiter and SSO access rules (pure modules, injectable clock).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClickCounter } = require('../src/click-rules.js');
const { createLoginLimiter } = require('../src/login-limiter.js');
const { createSsoAccess } = require('../src/sso-access.js');

const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
const CUBOT = 'Mozilla/5.0 (Linux; Android 12; CUBOT KingKong) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';

test('clicks: HEAD requests and bots are not counted, normal browsers (also with "bot" in a device name) are', () => {
  const count = createClickCounter();
  assert.equal(count({ method: 'HEAD', ip: '1.1.1.1', userAgent: FIREFOX, linkId: 1 }), false);
  for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'WhatsApp/2.23', 'Slackbot-LinkExpanding 1.0', 'facebookexternalhit/1.1', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'UptimeRobot/2.0', 'curl-monitor', 'Mozilla/5.0 (compatible; SemrushBot)']) {
    assert.equal(count({ method: 'GET', ip: '2.2.2.2', userAgent: ua, linkId: 1 }), false, ua);
  }
  assert.equal(count({ method: 'GET', ip: '3.3.3.3', userAgent: FIREFOX, linkId: 1 }), true);
  assert.equal(count({ method: 'GET', ip: '4.4.4.4', userAgent: CUBOT, linkId: 1 }), true);
  assert.equal(count({ method: 'GET', ip: '5.5.5.5', userAgent: '', linkId: 1 }), true, 'missing user agent still counts');
});

test('clicks: one per visitor and link every 5 seconds, and a per-visitor ceiling per minute', () => {
  let t = 1000;
  const count = createClickCounter({ now: () => t });
  const hit = (ip, linkId) => count({ method: 'GET', ip, userAgent: FIREFOX, linkId });
  assert.equal(hit('9.9.9.9', 1), true);
  assert.equal(hit('9.9.9.9', 1), false, 'same visitor, same link, right away');
  assert.equal(hit('9.9.9.9', 2), true, 'another link is fine');
  assert.equal(hit('8.8.8.8', 1), true, 'another visitor is fine');
  t += 5001;
  assert.equal(hit('9.9.9.9', 1), true, 'after 5 seconds it counts again');
  // ceiling: 120 counted clicks per visitor and minute (each on a different link, so the 5 second rule does not apply)
  t = 100000;
  let counted = 0;
  for (let i = 0; i < 200; i++) { t += 10; if (hit('7.7.7.7', 1000 + i)) counted++; }
  assert.equal(counted, 120);
  t += 61000;
  assert.equal(hit('7.7.7.7', 5000), true, 'window resets');
});

test('login limiter: counts failures per key, resets, expires and stays bounded', () => {
  let t = 0;
  const limiter = createLoginLimiter({ windowMs: 1000, maxKeys: 5, now: () => t });
  for (let i = 0; i < 3; i++) limiter.fail('pair:1.1.1.1|admin');
  assert.equal(limiter.isLimited('pair:1.1.1.1|admin', 3), true);
  assert.equal(limiter.isLimited('pair:1.1.1.1|admin', 4), false);
  assert.equal(limiter.isLimited('pair:2.2.2.2|admin', 3), false, 'another IP is not locked out');
  limiter.reset('pair:1.1.1.1|admin');
  assert.equal(limiter.isLimited('pair:1.1.1.1|admin', 1), false);
  limiter.fail('user:x'); t = 1001;
  assert.equal(limiter.isLimited('user:x', 1), false, 'entries expire');
  for (let i = 0; i < 50; i++) limiter.fail('k' + i);
  assert.ok(limiter.size() <= 5, 'map stays bounded');
});

test('sso access: no rule means open, groups or verified e-mail domains restrict', () => {
  assert.equal(createSsoAccess().allowed({}), true);
  const rules = createSsoAccess({ groups: 'snar-users, Admins', domains: 'Example.org' });
  assert.equal(rules.restricted, true);
  assert.equal(rules.needsGroupsClaim, true);
  assert.equal(rules.allowed({ groups: ['other', 'ADMINS'] }), true, 'group match, case-insensitive');
  assert.equal(rules.allowed({ groups: ['other'] }), false);
  assert.equal(rules.allowed({ email: 'a@example.org', email_verified: true }), true);
  assert.equal(rules.allowed({ email: 'a@example.org', email_verified: false }), false, 'unverified e-mail does not count');
  assert.equal(rules.allowed({ email: 'a@example.org' }), false);
  assert.equal(rules.allowed({ email: 'a@evil.example', email_verified: true }), false);
  assert.equal(rules.allowed({ groups: 'snar-users' }), false, 'groups must be an array');
  assert.equal(createSsoAccess({ domains: 'example.org' }).needsGroupsClaim, false);
});
