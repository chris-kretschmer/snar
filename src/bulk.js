// What the bulk download (POST /app/links/bulk) does before it renders anything: which action, how many links,
// which of them the user may see, and what the files in the ZIP are called. Kept free of Express and the
// database so the caps and the visibility rule can be tested (server.js is not importable, it starts listening).

// Links per action. Every format is cheap (src/png.js writes a PNG in ~1 ms; 1000 codes are ~0.3 s of rendering and a
// ZIP of ~0.5 MB for SVG, ~1 MB for PNG, measured outside the container), so the caps mostly keep a single request
// and its in-memory ZIP within reason.
const LIMITS = { 'qr-svg': 1000, 'qr-eps': 1000, 'qr-png': 1000, csv: 2000 };
// The form posts one "ids" field per link. The urlencoded parser refuses more parameters than this
// (its default is 1000): the largest cap plus the other fields, with room to spare.
const MAX_BODY_PARAMS = Math.max(...Object.values(LIMITS)) + 100;
const { parseId } = require('./url-rules');

// body: the parsed urlencoded body. getLink(id) returns the link row or undefined, canSee(link) is the same
// visibility rule as for a single link. Returns { error } (a message for the flash) or { action, links }.
function selectLinks(body, { getLink, canSee, limits = LIMITS }) {
  const action = String(body.action || '');
  // hasOwn: "constructor" or "__proto__" as the action must not find an inherited member and skip the cap.
  if (!Object.hasOwn(limits, action)) return { error: 'Unbekannte Aktion.' };
  const limit = limits[action];
  // Plain decimal ids only: Number() would also accept "1e3", "0x10", " 1" or "+1" and map them onto other links.
  const ids = [...new Set([].concat(body.ids || []).map(parseId).filter(Boolean))];
  if (!ids.length) return { error: 'Bitte zuerst Links auswählen.' };
  if (ids.length > limit) {
    const hint = action === 'qr-png' && limits['qr-svg'] > limit ? ` Als SVG sind bis zu ${limits['qr-svg']} möglich.` : '';
    return { error: `Zu viele Links auf einmal: höchstens ${limit} bei dieser Aktion, ausgewählt sind ${ids.length}.${hint}` };
  }
  // An id that is missing or not the user's is just left out, like a link that does not exist.
  const links = ids.map((id) => getLink(id)).filter((l) => l && canSee(l));
  if (!links.length) return { error: 'Die gewählten Links sind nicht verfügbar.' };
  return { action, links };
}

// One file name per link, in the same order. Slugs are case-sensitive but most file systems are not: "Abc"
// and "abc" would overwrite each other when unpacked, so the later one gets its id appended.
function zipNames(links, ext) {
  const taken = new Set();
  return links.map((l) => {
    let base = `qr-${l.slug}`;
    if (taken.has(base.toLowerCase())) base += `-${l.id}`;
    while (taken.has(base.toLowerCase())) base += '_'; // a link whose slug already looks like "abc-82"
    taken.add(base.toLowerCase());
    return `${base}.${ext}`;
  });
}

// Concurrency guard for the QR ZIP downloads. Every code is synchronous work; the loop hands the event loop back
// between two codes, but N parallel downloads still make everything else wait N codes' worth per round (measured with
// the old, slow PNG encoder: 6 parallel ZIPs of 30 turned a 0.2 s /healthz into 0.7 s, and it grows with N). So only a
// couple run at a time overall and one per user; a further request is told to try again instead of queueing up.
// acquire(userId) returns a release function, or null when there is no free slot.
function createSlots({ total = 2, perUser = 1 } = {}) {
  let running = 0;
  const byUser = new Map();
  return {
    acquire(userId) {
      const own = byUser.get(userId) || 0;
      if (running >= total || own >= perUser) return null;
      running++;
      byUser.set(userId, own + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        running--;
        const left = byUser.get(userId) - 1;
        if (left > 0) byUser.set(userId, left); else byUser.delete(userId);
      };
    },
  };
}

module.exports = { LIMITS, MAX_BODY_PARAMS, selectLinks, zipNames, createSlots };
