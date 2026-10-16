// In-memory limiter for failed logins (and failed password checks). Counts only FAILED attempts, so users
// behind one NAT do not lock each other out. The map is bounded: expired entries are purged, and when it is
// still full the oldest keys go, so many (spoofed) keys cannot grow it without limit.

function createLoginLimiter({ windowMs = 15 * 60 * 1000, maxKeys = 10000, now = Date.now } = {}) {
  const attempts = new Map();

  return {
    isLimited(key, max) {
      const entry = attempts.get(key);
      if (!entry) return false;
      if (now() > entry.reset) { attempts.delete(key); return false; }
      return entry.count >= max;
    },
    fail(key) {
      const t = now();
      if (attempts.size >= Math.min(1000, maxKeys)) {
        for (const [k, e] of attempts) if (t > e.reset) attempts.delete(k);
      }
      while (attempts.size >= maxKeys) attempts.delete(attempts.keys().next().value);
      const entry = attempts.get(key) || { count: 0, reset: t + windowMs };
      if (t > entry.reset) { entry.count = 0; entry.reset = t + windowMs; }
      entry.count++;
      attempts.set(key, entry);
    },
    reset(key) { attempts.delete(key); },
    size() { return attempts.size; },
  };
}

// Caps how many password checks (scrypt: ~100 ms of CPU and 32 MB each) run at the same time. Without it, attempts
// that dodge the per-IP limit (a spoofed X-Forwarded-For, many user names) could keep every CPU busy. A request that
// finds no free place is turned away instead of queued. enter() returns a release function, or null when full.
function createGate({ max = 4 } = {}) {
  let running = 0;
  return {
    enter() {
      if (running >= max) return null;
      running++;
      let done = false;
      return () => { if (!done) { done = true; running--; } };
    },
    size() { return running; },
  };
}

module.exports = { createLoginLimiter, createGate };
