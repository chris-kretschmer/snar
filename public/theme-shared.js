// Accent colour helpers, shared by both sides so they can't disagree: the server
// require()s it (src/server.js validates the saved colour, src/views.js renders
// the page) and the browser loads it as /static/theme-shared.js on the
// "Darstellung" admin page for the live preview. No DOM access, no globals.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnarTheme = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_ACCENT = '#2140c8';
  // The accent is link text and the background of white button text, so it
  // must reach WCAG AA (4.5:1) against white.
  const MIN_CONTRAST = 4.5;

  // Instance name shown in the sidebar, on the login page and in the tab title.
  const DEFAULT_NAME = 'snar';
  const MAX_NAME_LENGTH = 32;

  // Trim, collapse whitespace, drop control characters. May return '' (= use the default).
  function normalizeName(value) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Only "#rrggbb": what <input type="color"> submits. Returns lower case or null.
  function normalizeHex(value) {
    const s = String(value == null ? '' : value).trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(s) ? s : null;
  }

  // WCAG relative luminance.
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastOnWhite(hex) {
    return 1.05 / (luminance(hex) + 0.05);
  }

  return { DEFAULT_ACCENT, MIN_CONTRAST, DEFAULT_NAME, MAX_NAME_LENGTH, normalizeHex, normalizeName, contrastOnWhite };
}));
