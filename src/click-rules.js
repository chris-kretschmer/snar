// Which requests count as a click in the statistics. The redirect itself always works, only the counting
// is protected: no HEAD requests, no link previews or crawlers, at most one click per visitor and link
// every 5 seconds, and at most 120 counted clicks per visitor and minute.

const BOT_UA_RE = /\bbot\b|bot\/|crawler|spider|slurp|preview|facebookexternalhit|whatsapp|telegrambot|slackbot|discordbot|linkedinbot|twitterbot|googlebot|bingbot|applebot|yandex|baidu|semrush|ahrefs|uptime|pingdom|monitor|headlesschrome|lighthouse/i;

const SAME_LINK_MS = 5000;
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 120;
const MAP_LIMIT = 5000;

function createClickCounter({ now = Date.now } = {}) {
  const seen = new Map(); // "ip|linkId" -> time of the last counted click
  const rate = new Map(); // ip -> { count, reset }

  return function shouldCount({ method, ip, userAgent, linkId }) {
    if (method === 'HEAD' || BOT_UA_RE.test(userAgent || '')) return false;
    const t = now();
    if (seen.size > MAP_LIMIT) for (const [k, at] of seen) if (t - at > SAME_LINK_MS) seen.delete(k);
    if (rate.size > MAP_LIMIT) for (const [k, e] of rate) if (t > e.reset) rate.delete(k);
    const key = `${ip}|${linkId}`;
    if (t - (seen.get(key) || -Infinity) < SAME_LINK_MS) return false;
    const entry = rate.get(ip);
    if (entry && t <= entry.reset && entry.count >= RATE_MAX) return false;
    seen.set(key, t);
    if (!entry || t > entry.reset) rate.set(ip, { count: 1, reset: t + RATE_WINDOW_MS });
    else entry.count++;
    return true;
  };
}

module.exports = { createClickCounter, BOT_UA_RE };
