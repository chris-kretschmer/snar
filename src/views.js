// Server-rendered templates. No framework, no external fonts,
// no client-side tracking – the tool itself is the tracking. :)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Theme = require('../public/theme-shared.js');
const Utm = require('../public/utm-shared.js');
const APP_VERSION = require('../package.json').version;

// Cache busting for /static/*: assets are cached aggressively (maxAge in
// server.js), so a content hash is appended as query parameter to make deploys
// take effect immediately.
function assetVersion(relPath) {
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'public', relPath));
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
  } catch {
    return String(Date.now()); // file missing (e.g. in tests) – never cache instead of crashing
  }
}
const CSS_URL = `/static/style.css?v=${assetVersion('style.css')}`;
const CHART_JS_URL = `/static/chart-shared.js?v=${assetVersion('chart-shared.js')}`;
const THEME_JS_URL = `/static/theme-shared.js?v=${assetVersion('theme-shared.js')}`;
const APP_JS_URL = `/static/app.js?v=${assetVersion('app.js')}`;
const FONT_URL = `/static/fonts/open-sans-latin.woff2?v=${assetVersion('fonts/open-sans-latin.woff2')}`;

const numberFormat = new Intl.NumberFormat('de-DE');
const fmtNum = (n) => numberFormat.format(n ?? 0);

// style.css references the font again: the placeholder is replaced once at
// startup with the font's content hash. server.js serves this result instead
// of the raw file.
function loadCssContent() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    return raw.replace('__FONT_VERSION__', assetVersion('fonts/open-sans-latin.woff2'));
  } catch {
    return ''; // file missing (e.g. in tests) – never crash, the page just stays unstyled
  }
}
const CSS_CONTENT = loadCssContent();

// Theme (admin page "Darstellung"): accent colour and instance name.
// /static/theme.css only sets --accent on :root and is linked after style.css.
// The URL carries a content hash like the other assets, so a change takes effect
// at once despite the long cache.
let themeCss = '';
let themeUrl = null;
let themeName = Theme.DEFAULT_NAME;
function setTheme({ accent = null, name = null } = {}) {
  const color = Theme.normalizeHex(accent);
  themeCss = color ? `:root { --accent: ${color}; }\n` : '';
  themeUrl = color ? `/static/theme.css?v=${crypto.createHash('sha256').update(themeCss).digest('hex').slice(0, 10)}` : null;
  themeName = name || Theme.DEFAULT_NAME;
}
const getThemeCss = () => themeCss;

// Newer release found by src/updates.js ({ version, url } or null); shown to admins only.
let updateInfo = null;
function setUpdateInfo(info) { updateInfo = info; }
function updateBox(user) {
  if (!updateInfo || user.role !== 'admin') return '';
  return `
  <aside class="update-box" id="update-box" data-version="${esc(updateInfo.version)}" aria-label="Update verfügbar">
    <button type="button" class="update-close" aria-label="Hinweis ausblenden">×</button>
    <b>Update verfügbar</b>
    <span>Version ${esc(updateInfo.version)} (installiert: ${esc(APP_VERSION)})</span>
    <a href="${esc(updateInfo.url)}" target="_blank" rel="noopener">Änderungen ansehen</a>
  </aside>`;
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Shared field-error rendering: only the input whose `matchField` equals the
// failed `errorField` gets styled/described.
// URL/domain inputs are type="text", not "url": browsers reject a scheme-less
// "example.com" natively, before the server can prepend "https://". The locked
// target field is readonly, not disabled – a disabled field isn't submitted and
// server-side validation would then fail although nothing was meant to change.
function fieldInvalidAttrs(matchField, errorField, htmlId) {
  if (matchField !== errorField) return '';
  return ` class="invalid" aria-invalid="true" aria-describedby="${htmlId}-error"`;
}
function fieldErrorSpan(matchField, errorField, error, htmlId) {
  if (matchField !== errorField) return '';
  return `<span class="field-error" id="${htmlId}-error">${esc(error)}</span>`;
}

// DB timestamp ('YYYY-MM-DD HH:MM:SS', UTC) as a Date object
const parseDbDate = (s) => new Date(s.replace(' ', 'T') + 'Z');
const stripProto = (u) => u.replace(/^https?:\/\//, '');

function fmtDate(iso) {
  if (!iso) return '–';
  return parseDbDate(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) + '\u00A0Uhr';
}

// Language tag ("de-DE") -> short code plus full name for tooltip/screen readers.
const langNames = new Intl.DisplayNames(['de'], { type: 'language' });
function langInfo(tag) {
  if (!tag) return { code: '–', name: 'Unbekannt' };
  let name = tag;
  try { name = langNames.of(tag); } catch { /* malformed tag: show it as is */ }
  return { code: tag.split('-')[0].toUpperCase(), name };
}

// Below 1000px the rows turn into two-line cards without the language column
// (see .clicks-table in style.css).
function recentClicksTable(clicks) {
  const ref = (c) => esc(c.referrer || '(direkt / QR-Scan)');
  const device = (c) => {
    const key = { Mobil: 'device-phone', Tablet: 'device-tablet', Desktop: 'device-desktop' }[c.device];
    // Icon only; name stays for screen readers. Unknown values fall back to text.
    return key ? `${icon(key, 'device-icon')}<span class="sr-only">${esc(c.device)}</span>` : esc(c.device);
  };
  return `<div class="table-scroll"><table class="tbl clicks-table" aria-label="Letzte Klicks">
    <thead><tr><th scope="col" class="col-time">Zeitpunkt</th><th scope="col" class="col-ref">Quelle</th><th scope="col" class="col-device">Gerät</th><th scope="col" class="col-browser">Browser</th><th scope="col" class="col-lang">Sprache</th></tr></thead>
    <tbody>${clicks.map(c => `<tr class="click-row">
      <td class="col-time"><time datetime="${parseDbDate(c.ts).toISOString()}">${fmtDate(c.ts)}</time></td>
      <td class="col-ref" translate="no" title="${ref(c)}">${ref(c)}</td>
      <td class="col-device" title="${esc(c.device)}">${device(c)}</td>
      <td class="col-browser">${esc(c.browser)}</td>
      <td class="col-lang">${(({ code, name }) => `<abbr title="${esc(name)}">${esc(code)}</abbr>`)(langInfo(c.lang))}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function isExpired(link) {
  return !!link.expires_at && link.expires_at <= new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function visibilityBadge(l) {
  return `<span class="badge${l.visibility === 'org' ? '' : ' muted'}">${l.visibility === 'org' ? 'Organisation' : 'Persönlich'}</span>`;
}

// Icons: mostly Material Symbols (Apache-2.0), vendored – no icon font at
// runtime. "Erstellen" (dashboard) is a stroke icon.
const ICON = {
  dashboard: `<path d="M0 0h24v24H0z" fill="none"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 6l2 -2c1 -1 3 -1 4 0l1 1c1 1 1 3 0 4l-5 5c-1 1 -3 1 -4 0M11 18l-2 2c-1 1 -3 1 -4 0l-1 -1c-1 -1 -1 -3 0 -4l5 -5c1 -1 3 -1 4 0"/>`,
  vault: `<path fill="currentColor" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h6l2 2h8q.825 0 1.413.588T22 8v10q0 .825-.587 1.413T20 20zm7-3h8v-.55q0-1.125-1.1-1.787T15 14t-2.9.663T11 16.45zm5.413-4.587Q17 11.825 17 11t-.587-1.412T15 9t-1.412.588T13 11t.588 1.413T15 13t1.413-.587"/>`,
  myvault: `<path fill="currentColor" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h6l2 2h8q.825 0 1.413.588T22 8v10q0 .825-.587 1.413T20 20z"/>`,
  qr: `<path fill="currentColor" d="M3 10V4q0-.425.288-.712T4 3h6q.425 0 .713.288T11 4v6q0 .425-.288.713T10 11H4q-.425 0-.712-.288T3 10m2-1h4V5H5zM3 20v-6q0-.425.288-.712T4 13h6q.425 0 .713.288T11 14v6q0 .425-.288.713T10 21H4q-.425 0-.712-.288T3 20m2-1h4v-4H5zm8-9V4q0-.425.288-.712T14 3h6q.425 0 .713.288T21 4v6q0 .425-.288.713T20 11h-6q-.425 0-.712-.288T13 10m2-1h4V5h-4zm4 12v-2h2v2zm-6-6v-2h2v2zm2 2v-2h2v2zm-2 2v-2h2v2zm2 2v-2h2v2zm2-2v-2h2v2zm0-4v-2h2v2zm2 2v-2h2v2z"/>`,
  logout: `<path fill="currentColor" d="M5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h7v2H5v14h7v2zm11-4l-1.375-1.45l2.55-2.55H9v-2h8.175l-2.55-2.55L16 7l5 5z"/>`,
  person: `<path fill="currentColor" d="M9.175 10.825Q8 9.65 8 8t1.175-2.825T12 4t2.825 1.175T16 8t-1.175 2.825T12 12t-2.825-1.175M4 20v-2.8q0-.85.438-1.562T5.6 14.55q1.55-.775 3.15-1.162T12 13t3.25.388t3.15 1.162q.725.375 1.163 1.088T20 17.2V20z"/>`,
  settings: `<path fill="currentColor" d="m9.25 22l-.4-3.2q-.325-.125-.612-.3t-.563-.375L4.7 19.375l-2.75-4.75l2.575-1.95Q4.5 12.5 4.5 12.338v-.675q0-.163.025-.338L1.95 9.375l2.75-4.75l2.975 1.25q.275-.2.575-.375t.6-.3l.4-3.2h5.5l.4 3.2q.325.125.613.3t.562.375l2.975-1.25l2.75 4.75l-2.575 1.95q.025.175.025.338v.674q0 .163-.05.338l2.575 1.95l-2.75 4.75l-2.95-1.25q-.275.2-.575.375t-.6.3l-.4 3.2zm2.8-6.5q1.45 0 2.475-1.025T15.55 12t-1.025-2.475T12.05 8.5q-1.475 0-2.488 1.025T8.55 12t1.013 2.475T12.05 15.5"/>`,
  chevron: `<path fill="currentColor" d="m12 21l-4.5-4.5l1.45-1.45L12 18.1l3.05-3.05l1.45 1.45zM8.95 9.05L7.5 7.6L12 3.1l4.5 4.5l-1.45 1.45L12 6z"/>`,
  'device-phone': `<rect x="7" y="2.5" width="10" height="19" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 18.5h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  'device-tablet': `<rect x="4.5" y="2.5" width="15" height="19" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 18.5h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  'device-desktop': `<rect x="3" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  'chevron-left': `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14.5 5 9 12 14.5 19"/>`,
  'chevron-right': `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9.5 5 15 12 9.5 19"/>`,
  copy: `<path fill="currentColor" d="M9 18q-.825 0-1.412-.587T7 16V4q0-.825.588-1.412T9 2h9q.825 0 1.413.588T20 4v12q0 .825-.587 1.413T18 18zm0-2h9V4H9zm-4 6q-.825 0-1.412-.587T3 20V7q0-.425.288-.712T4 6t.713.288T5 7v13h10q.425 0 .713.288T16 21t-.288.713T15 22zm4-6V4z"/>`,
  menu: `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16"/>`,
  plus: `<path fill="currentColor" d="M11.288 20.713Q11 20.425 11 20v-7H4q-.425 0-.712-.288T3 12t.288-.712T4 11h7V4q0-.425.288-.712T12 3t.713.288T13 4v7h7q.425 0 .713.288T21 12t-.288.713T20 13h-7v7q0 .425-.288.713T12 21t-.712-.288"/>`,
};
function icon(key, cls = 'navicon') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[key] || ''}</svg>`;
}

const NAV_GROUPS = [
  {
    items: [
      { key: 'dashboard', href: '/app', label: 'Erstellen' },
      { key: 'myvault', href: '/app/user-vault', label: 'Persönlicher Tresor' },
      { key: 'vault', href: '/app/org-vault', label: 'Gemeinsamer Tresor' },
      { key: 'qr', href: '/app/qr', label: 'QR-Code Generator' },
    ],
  },
  {
    adminOnly: true,
    items: [
      { key: 'users', href: '/app/users', label: 'Admin-Einstellungen', icon: 'settings', activeKeys: ['users', 'domains', 'design'] },
    ],
  },
];

function navGroup(group, user, page) {
  if (group.adminOnly && user.role !== 'admin') return '';
  const links = group.items.map(n => {
    const active = (n.activeKeys || [n.key]).includes(page);
    return `<a class="navlink${active ? ' active' : ''}" href="${n.href}" title="${esc(n.label)}"${active ? ' aria-current="page"' : ''}>${icon(n.icon || n.key)}<span class="label">${esc(n.label)}</span></a>`;
  }).join('');
  return links;
}

// Mobile bottom navigation (<=760px, see .bottom-nav in style.css); labels are
// shorter than in the sidenav because the tabs are narrow.
const BOTTOM_NAV_LEFT = [
  { key: 'myvault', href: '/app/user-vault', label: 'Persönlich' },
  { key: 'vault', href: '/app/org-vault', label: 'Gemeinsam' },
];
const BOTTOM_NAV_RIGHT = [
  { key: 'qr', href: '/app/qr', label: 'QR-Code' },
];
function bottomNavItem(n, page) {
  const active = page === n.key;
  return `<a class="bottom-nav-item${active ? ' active' : ''}" href="${n.href}"${active ? ' aria-current="page"' : ''}>${icon(n.key, 'navicon')}<span>${esc(n.label)}</span></a>`;
}
function bottomNav(page, user) {
  // Admins: direkter "Admin"-Link statt "Mehr". Ihr Weg zu "Abmelden" (nur im
  // Sidebar-Overlay) bleibt über /app/account erhalten, siehe accountPage().
  // Mitglieder: "Mehr" öffnet das Sidebar-Overlay.
  const isAdmin = user.role === 'admin';
  const moreActive = page === 'users' || page === 'domains' || page === 'design';
  const moreItem = isAdmin
    ? `<a class="bottom-nav-item${moreActive ? ' active' : ''}" href="/app/users"${moreActive ? ' aria-current="page"' : ''}>${icon('settings', 'navicon')}<span>Admin</span></a>`
    : `<button type="button" class="bottom-nav-item" id="bottom-nav-more" aria-haspopup="true" aria-controls="sidebar" aria-expanded="false">${icon('menu', 'navicon')}<span>Mehr</span></button>`;
  return `<nav class="bottom-nav" aria-label="Hauptnavigation">
    ${BOTTOM_NAV_LEFT.map(n => bottomNavItem(n, page)).join('')}
    <a class="bottom-nav-create" href="/app" aria-label="Neuen Kurzlink erstellen"${page === 'dashboard' ? ' aria-current="page"' : ''}>
      <span class="bottom-nav-create-circle">${icon('plus', 'bottom-nav-create-icon')}</span>
    </a>
    ${BOTTOM_NAV_RIGHT.map(n => bottomNavItem(n, page)).join('')}
    ${moreItem}
  </nav>`;
}

// Instance name (sidebar, mobile top bar, login page); data-brand-name lets the
// "Darstellung" page update it live while typing.
function brandInner() {
  return `<span translate="no" data-brand-name>${esc(themeName)}</span>`;
}

function layout({ title, body, user = null, flash = null, page = null, scripts = '' }) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f7f8fa">
<title>${esc(title)} · ${esc(themeName)}</title>
<link rel="preload" href="${FONT_URL}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${CSS_URL}">
${themeUrl ? `<link rel="stylesheet" href="${themeUrl}">` : ''}
</head>
<body>
${user ? `<a class="skip-link" href="#main-content">Zum Inhalt springen</a>
<div class="mobile-topbar">
  <a class="brand" href="/app">${brandInner()}</a>
  <a class="mobile-topbar-account" href="/app/account" aria-label="Konto: ${esc(user.username)}">
    <span class="avatar">${esc(user.username.slice(0, 1).toUpperCase())}</span>
  </a>
</div>` : ''}
<div class="shell">
${user ? `<div class="sidebar-backdrop" id="sidebar-backdrop"></div>
<aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <a class="brand" href="/app">${brandInner()}</a>
  </div>
  <div class="sidebar-account">
    <button type="button" id="account-menu-toggle" class="account-trigger" aria-expanded="false" aria-controls="account-menu">
      <span class="avatar">${esc(user.username.slice(0, 1).toUpperCase())}</span>
      <span class="who-chip">${esc(user.username)}</span>
      ${icon('chevron', 'chevron-icon')}
    </button>
    <div class="account-menu" id="account-menu">
      <a href="/app/account">${icon('person', 'menu-icon')}Dein Profil</a>
      <a href="/app/account">${icon('settings', 'menu-icon')}Einstellungen</a>
      <form method="post" action="/logout"><button type="submit">${icon('logout', 'menu-icon')}Abmelden</button></form>
    </div>
  </div>
  <nav class="sidenav">
    ${NAV_GROUPS.map(g => navGroup(g, user, page)).join('')}
  </nav>${updateBox(user)}
</aside>` : ''}
<div class="shell-main" id="main-content" tabindex="-1">
${flash ? `<div class="flash toast ${esc(flash.type)}" role="status">${esc(flash.text)}</div>` : ''}
${body}
</div>
</div>
${user ? bottomNav(page, user) : ''}
<div id="copy-announcer" class="sr-only" role="status" aria-live="polite"></div>
${user ? `<dialog id="confirm-dialog" class="confirm-dialog" aria-labelledby="confirm-dialog-title">
  <h2 id="confirm-dialog-title">Wirklich löschen?</h2>
  <p class="confirm-dialog-text"></p>
  <div class="dialog-actions">
    <button type="button" class="btn ghost" data-dialog-cancel>Abbrechen</button>
    <button type="button" class="destructive-ghost" data-dialog-confirm>Endgültig löschen</button>
  </div>
</dialog>` : ''}
<script src="${CHART_JS_URL}"></script>
${scripts}<script src="${APP_JS_URL}"></script>
</body>
</html>`;
}

function loginPage({ error = null, ssoEnabled = false } = {}) {
  const body = `
<main class="login-shell">
<div class="login-card">
  <h1 class="login-brand">${brandInner()}</h1>
  <h2>Willkommen zurück!</h2>
  <h3>Melde dich an, um fortzufahren.</h3>
  ${error ? `<div class="flash error">${esc(error)}</div>` : ''}
  ${ssoEnabled ? `
  <a class="login-sso-btn" href="/login/sso">Mit SSO anmelden</a>
  <div class="login-divider"><span>oder</span></div>` : ''}
  <form method="post" action="/login" class="login-form">
    <div class="field">
      <label for="username">Nutzername</label>
      <input id="username" name="username" type="text" autocomplete="username" spellcheck="false" required autofocus>
    </div>
    <div class="field">
      <label for="pw">Passwort</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" required>
    </div>
    <button type="submit">Anmelden</button>
  </form>
</div>
</main>`;
  return layout({ title: 'Anmelden', body });
}

// Returns only the content (no .radio-row wrapper) so callers can add elements.
// locked=true (org links, non-owner/non-admin; isOwnerOrAdmin in server.js):
// disabled, otherwise a member could lock themselves out by switching to
// "Persönlich" (canManage() only grants non-owners access while it stays 'org').
function visibilityRadios(current = 'privat', locked = false) {
  const dis = locked ? ' disabled' : '';
  return `<span class="label-inline">Sichtbarkeit:</span>
    <label><input type="radio" name="visibility" value="privat" ${current !== 'org' ? 'checked' : ''}${dis}>Persönlich</label>
    <label><input type="radio" name="visibility" value="org" ${current === 'org' ? 'checked' : ''}${dis}>Organisation</label>
    ${locked ? '<span class="muted hint">Nur Besitzer:in/Admin können das ändern</span>' : ''}`;
}

// Hidden unless domains are configured.
function domainField(current, domains) {
  if (!domains || domains.length === 0) return '';
  return `<div class="field">
      <label for="domain">Domain</label>
      <select id="domain" name="domain">
        ${domains.map(d => `<option value="${esc(d)}" ${d === current ? 'selected' : ''}>${esc(stripProto(d))}</option>`).join('')}
      </select>
    </div>`;
}

// "Erweiterte Link-Details": the utm_* parameters as separate fields, joined to the target URL on save
// (public/utm-shared.js). The panel is closed unless a value is set; readonly for those who may not change the URL.
const UTM_FIELDS = [
  ['source', 'utm_source', 'partner'],
  ['medium', 'utm_medium', 'email'],
  ['campaign', 'utm_campaign', 'aktion'],
  ['term', 'utm_term', 'stichwort'],
  ['content', 'utm_content', 'banner'],
];
// open: true only right after a failed submit that had parameters set (server.js re-render, see dashboard()/
// linkDetail() below) – a saved link never opens the card on its own on a plain page load any more, the
// effective-URL line under Ziel-URL (utmUrlLine()) says so without needing the card open. app.js keeps the
// label in sync when toggling client-side.
// standalone: detail page only – the button sits by itself right next to utmCard() instead of inside the
// create form's button row, and is hidden whenever the card is open (never both visible, no second "close"
// control needed beyond the card's own "×", see .utm-close in utmCard()).
function utmToggle(open, standalone = false) {
  return `<button type="button" class="ghost utm-toggle" aria-expanded="${open}" aria-controls="utm-panel" data-needs-js disabled${standalone ? ' data-standalone' : ''}${standalone && open ? ' hidden' : ''}>${open ? 'Schließen' : 'Erweiterte Link-Details'}</button>`;
}
// formId: form= on every input instead of nesting them inside the <form> (like the "Speichern" button on the
// detail page already does), so the card can sit outside it – see utmCard().
function utmFields(utm, locked, formId) {
  return UTM_FIELDS.map(([key, name, example]) => `<div class="field">
    <label for="${name}">${name}</label>
    <input id="${name}" name="${name}" type="text" maxlength="${Utm.MAX_UTM_VALUE}" placeholder="${example}" value="${esc(utm[key] || '')}"${locked ? ' readonly' : ''}${formId ? ` form="${formId}"` : ''} spellcheck="false" autocomplete="off">
  </div>`).join('');
}
// Create page: fieldset nested in the create form, right after "Erstellen" (no other card next to it).
function utmPanel(utm, open) {
  return `<fieldset class="utm-panel" id="utm-panel"${open ? '' : ' hidden'}>
    <legend>Kampagnen-Parameter</legend>
    <div class="grid-form">${utmFields(utm, false, null)}</div>
  </fieldset>`;
}
// Detail page: own full-width card below .detail-grid instead of growing the edit-card – that grid has the
// QR code next to it, gaining or losing several fields' worth of height there left an odd gap either way. Its
// open/close trigger (utmToggle(open, true)) sits up in .detail-head next to "Speichern" instead, the main
// action for this form, the same pairing the create page already has with "Erstellen".
function utmCard(utm, open, locked, formId) {
  return `<section class="card utm-card" id="utm-panel"${open ? '' : ' hidden'}>
    <div class="card-head"><h2>Kampagnen-Parameter</h2><button type="button" class="ghost utm-close" data-needs-js disabled>Schließen</button></div>
    <div class="grid-form">${utmFields(utm, locked, formId)}</div>
  </section>`;
}
// Small line under the Ziel-URL field once parameters are set, open or not: the field itself only ever shows
// the base URL (utmFields()/splitUtm()), so this is the only place the redirect target is shown in full.
function utmUrlLine(targetUrl, utm) {
  if (!Object.keys(utm).length) return '';
  return `<p class="muted hint utm-url-line">Aufgerufen wird: <span translate="no">${esc(Utm.buildTargetUrl(targetUrl, utm))}</span></p>`;
}

// Search/pagination table shared by dashboard, vaults, user & domain admin;
// app.js hooks in via #links-search/.linktable/.page-size-btn/#links-prev/
// #links-next. showSearch=false (domains): app.js's search does nothing
// without #links-search, no extra handling needed.
function searchTable({ links, theadHtml, rowsHtml, emptyText, showSearch = true }) {
  if (!links.length) return `<div class="empty">${emptyText}</div>`;
  const showToolbar = showSearch || links.length > 10;
  return `
  <div class="card table-card">
    ${showToolbar ? `
    <div class="table-toolbar">
      ${showSearch ? `<input id="links-search" class="search-input" placeholder="Suchen…" aria-label="Suchen" autocomplete="off">` : ''}
      ${links.length > 10 ? `
      <div class="page-size-group">
        <button type="button" class="page-size-btn" data-page-size="10">10</button>
        <button type="button" class="page-size-btn active" data-page-size="20">20</button>
        <button type="button" class="page-size-btn" data-page-size="50">50</button>
      </div>
      <div class="pagination-arrows">
        <button type="button" id="links-prev" class="pagination-arrow" aria-label="Vorherige Seite">${icon('chevron-left', 'navicon')}</button>
        <button type="button" id="links-next" class="pagination-arrow" aria-label="Nächste Seite">${icon('chevron-right', 'navicon')}</button>
      </div>` : ''}
    </div>` : ''}
    <div class="table-scroll">
    <table class="tbl linktable">
      <thead><tr>${theadHtml}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    </div>
  </div>`;
}

// Shared row for dashboard, personal vault & org vault; they differ in one
// column: dashboard shows visibility, org vault "Erstellt von" (org links
// belong to the team, so "Details" is open to every member, see canManage()
// in server.js), personal vault neither (always "Persönlich", see
// linksByOwnerPrivate in db.js – the column would be redundant).
function linkTableRow(l, short, { extraColumn = null } = {}) {
  const searchParts = [l.title || '', l.slug, l.target_url];
  if (extraColumn === 'owner') searchParts.push(l.owner_name || '');
  const searchHay = esc(searchParts.join(' ')).toLowerCase();
  const status = isExpired(l) ? `<span class="badge expired">Abgelaufen</span>` : `<span class="badge active">Aktiv</span>`;
  return `
<tr data-search="${searchHay}">
  <td class="url-cell" data-label="Ziel-URL"><a translate="no" href="${esc(l.target_url)}" target="_blank" rel="noopener" title="${esc(l.target_url)}">${esc(l.target_url)}</a></td>
  <td class="desc-cell" data-label="Beschreibung">${l.title ? esc(l.title) : '<span class="muted">–</span>'}</td>
  <td class="muted nowrap" data-label="Erstellt am">${fmtDate(l.created_at)}</td>
  ${extraColumn === 'visibility' ? `<td class="nowrap" data-label="Sichtbarkeit">${visibilityBadge(l)}</td>` : ''}
  <td class="nowrap" data-label="Status">${status}</td>
  ${extraColumn === 'owner' ? `<td class="cell-sub" data-label="Erstellt von" title="${esc(l.owner_name || '–')}">${esc(l.owner_name || '–')}</td>` : ''}
  <td class="nowrap short-cell" data-label="Kurzlink">
    <button type="button" class="copy-icon-btn" data-copy="${esc(short)}" title="Link kopieren" aria-label="Link kopieren">${icon('copy', 'copy-icon')}</button>
    <a class="slug" translate="no" href="${esc(short)}" target="_blank" rel="noopener" title="${esc(stripProto(short))}">${esc(stripProto(short))}</a>
  </td>
  <td class="num-cell" data-label="Klicks">${fmtNum(l.clicks_total)}</td>
  <td class="nowrap" data-label=""><a class="btn ghost" href="/app/links/${l.id}">Details</a></td>
</tr>`;
}

// error/errorField/values: only set on the direct re-render after a failed
// POST /app/links (see server.js), so the form keeps its input. errorField
// null with error set (generic DB fallback) shows a plain banner.
function dashboard({ links, shortUrl, domains, user, flash, error = null, errorField = null, values = null }) {
  const isRerender = !!values;
  const v = { target_url: '', slug: '', title: '', domain: domains[0] || '', expires_at: '', visibility: 'privat', utm: {}, ...values };
  const utmOpen = isRerender && Object.keys(v.utm).length > 0;
  const body = `
<main>
<div class="page">
<h1>Neuen Kurzlink erstellen</h1>
<section class="card">
  ${error && !errorField ? `<div class="flash error">${esc(error)}</div>` : ''}
  <form method="post" action="/app/links" class="flex-col">
    <div class="grid-form">
      <div class="field grow">
        <label for="target">Ziel-URL</label>
        <input id="target" name="target_url" type="text" maxlength="2048" placeholder="https://…" value="${esc(v.target_url)}"${fieldInvalidAttrs('target_url', errorField, 'target')} required autocomplete="off">
        ${fieldErrorSpan('target_url', errorField, error, 'target')}
        ${utmUrlLine(v.target_url, v.utm)}
      </div>
    </div>
    <div class="grid-form">
      <div class="field grow">
        <label for="title">Beschreibung <span class="muted">(optional)</span></label>
        <input id="title" name="title" type="text" placeholder="interner Name…" value="${esc(v.title)}" autocomplete="off">
      </div>
    </div>
    <div class="grid-form">
      <div class="field">
        <label for="slug">Wunsch-Kürzel <span class="muted">(optional)</span></label>
        <input id="slug" name="slug" type="text" pattern="[A-Za-z0-9\\-_]{1,64}" placeholder="sommerfest…" value="${esc(v.slug)}"${fieldInvalidAttrs('slug', errorField, 'slug')} spellcheck="false" autocomplete="off">
        ${fieldErrorSpan('slug', errorField, error, 'slug')}
      </div>
      ${domainField(v.domain, domains)}
      <div class="field">
        <label for="expires_at">Läuft ab <span class="muted">(optional)</span></label>
        <input id="expires_at" name="expires_at" type="datetime-local" value="${esc(v.expires_at)}" autocomplete="off">
      </div>
    </div>
    <div class="radio-row">
      ${visibilityRadios(v.visibility)}
      <div class="create-actions">
        ${utmToggle(utmOpen)}
        <button type="submit" id="create-btn" class="btn-create">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M7.5 1.5v12M1.5 7.5h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          Erstellen
        </button>
      </div>
    </div>
    ${utmPanel(v.utm, utmOpen)}
  </form>
</section>

<section>
  ${searchTable({
    links,
    theadHtml: `<th>Ziel-URL</th><th>Beschreibung</th><th>Erstellt am</th><th>Sichtbarkeit</th><th>Status</th><th>Kurzlink</th><th>Klicks</th><th></th>`,
    rowsHtml: links.map(l => linkTableRow(l, shortUrl(l), { extraColumn: 'visibility' })).join(''),
    emptyText: 'Noch keine eigenen Links. Leg oben den ersten an – der QR-Code dazu entsteht automatisch.',
  })}
</section>
</div>
</main>`;
  return layout({ title: 'Dashboard', body, user, flash, page: 'dashboard' });
}

function vaultPage({ links, shortUrl, user }) {
  const body = `
<main>
<div class="page">
<div class="hero">
  <h1>Gemeinsamer Tresor</h1>
</div>
${searchTable({
    links,
    theadHtml: `<th>Ziel-URL</th><th>Beschreibung</th><th>Erstellt am</th><th>Status</th><th>Erstellt von</th><th>Kurzlink</th><th>Klicks</th><th></th>`,
    rowsHtml: links.map(l => linkTableRow(l, shortUrl(l), { extraColumn: 'owner' })).join(''),
    emptyText: 'Der Tresor ist leer. Stelle einen Link auf „Organisation“, damit er hier für alle erscheint.',
  })}
</div>
</main>`;
  return layout({ title: 'Gemeinsamer Tresor', body, user, page: 'vault' });
}

function myVaultPage({ links, shortUrl, user }) {
  const body = `
<main>
<div class="page">
<div class="hero">
  <h1>Persönlicher Tresor</h1>
</div>
${searchTable({
    links,
    theadHtml: `<th>Ziel-URL</th><th>Beschreibung</th><th>Erstellt am</th><th>Status</th><th>Kurzlink</th><th>Klicks</th><th></th>`,
    rowsHtml: links.map(l => linkTableRow(l, shortUrl(l))).join(''),
    emptyText: 'Noch keine persönlichen Links. Lege unter „Erstellen“ einen mit Sichtbarkeit „Persönlich“ an.',
  })}
</div>
</main>`;
  return layout({ title: 'Persönlicher Tresor', body, user, page: 'myvault' });
}

// Chart math/markup lives in public/chart-shared.js, also loaded by the
// browser for the range chips, so server and client can't drift apart.
const Chart = require('../public/chart-shared.js');

// "YYYY-MM-DD" -> "DD.MM.YYYY", in full so the chip is unambiguous on its own.
function fullDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
}

// "vor 3 Std." / "gestern" / "vor 12 Tagen"; older than a month: the date.
const relTimeFmt = new Intl.RelativeTimeFormat('de', { numeric: 'auto', style: 'short' });
function relTime(iso) {
  const sec = Math.round((Date.now() - parseDbDate(iso).getTime()) / 1000);
  if (sec < 60) return 'gerade eben';
  if (sec < 3600) return relTimeFmt.format(-Math.floor(sec / 60), 'minute');
  if (sec < 86400) return relTimeFmt.format(-Math.floor(sec / 3600), 'hour');
  if (sec < 30 * 86400) return relTimeFmt.format(-Math.floor(sec / 86400), 'day');
  return parseDbDate(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Fixed core numbers, independent of the chart's range chips.
function kpiCard({ link, stats }) {
  const perDayDays = Math.max(1, Math.min(30, Math.ceil((Date.now() - parseDbDate(link.created_at).getTime()) / 86400000)));
  const avg = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(stats.ranges.monat.total / perDayDays);
  const tile = (value, label, title = '') => `<div class="stat-kpi"${title ? ` title="${esc(title)}"` : ''}><b>${value}</b><span>${label}</span></div>`;
  return `<section class="card kpi-card" aria-labelledby="kpi-title">
  <h2 id="kpi-title" class="sr-only">Auf einen Blick</h2>
  <div class="stat-kpis">
    ${tile(fmtNum(stats.recentTotal), 'Klicks gesamt')}
    ${tile(fmtNum(stats.ranges.tag.total), 'Heute')}
    ${tile(fmtNum(stats.ranges.woche.total), 'Letzte 7 Tage')}
    ${tile(fmtNum(stats.ranges.monat.total), 'Letzte 30 Tage')}
    ${tile(avg, `Ø pro Tag (${perDayDays} ${perDayDays === 1 ? 'Tag' : 'Tage'})`)}
    ${stats.lastClickTs ? tile(esc(relTime(stats.lastClickTs)), 'Letzter Klick', fmtDate(stats.lastClickTs)) : tile('–', 'Letzter Klick')}
  </div>
</section>`;
}

function statsChart(ranges, linkId, initialRange = 'monat', customFromTo = null) {
  const initial = ranges[initialRange] || ranges.monat;
  const { linePath, partialPath, areaPath, points, ticks } = Chart.chartGeometry(initial.values, initial.partialLast);
  const grid = Chart.gridHtml(ticks, fmtNum);
  const axisStyle = `--axis-w:${Chart.axisWidthPx(ticks.map(t => fmtNum(t.value)))}px`;
  const rangesForJs = {};
  for (const [key, r] of Object.entries(ranges)) {
    rangesForJs[key] = { label: r.label, total: r.total, values: r.values, labels: r.labels, pointLabels: r.pointLabels, partialLast: !!r.partialLast };
  }
  // Rolling windows, not calendar periods – "Woche"/"Monat"/"Jahr" would
  // suggest fixed calendar blocks.
  const fixedChips = [['tag', 'Heute'], ['woche', '7 Tage'], ['monat', '30 Tage'], ['jahr', '12 Monate'], ['gesamt', 'Gesamt']]
    .map(([key, label]) => `<button type="button" class="range-btn${initialRange === key ? ' active' : ''}" data-range="${key}" aria-pressed="${initialRange === key}">${label}</button>`)
    .join('');
  // <details>/<summary> instead of a JS popover: works without JS and needs no
  // click-outside/Escape handling. The summary doubles as the 6th chip once a
  // custom range is active (data-range="custom", see app.js); before that it is
  // a plain trigger without data-range.
  const customActive = initialRange === 'custom';
  const customLabel = ranges.custom ? `${esc(fullDate(customFromTo.from))}–${esc(fullDate(customFromTo.to))}` : 'Zeitraum';
  const customDataRange = ranges.custom ? ' data-range="custom"' : '';
  return `
<div class="stat-header">
  <h2>Klickverlauf</h2>
  <div class="range-group" id="stats-range-group" role="group" aria-label="Zeitraum" data-ranges="${esc(JSON.stringify(rangesForJs))}">
    ${fixedChips}
    <details class="range-custom-details">
      <summary class="range-btn range-custom-trigger${customActive ? ' active' : ''}"${customDataRange}>${customLabel}</summary>
      <div class="custom-range-panel">
        <form class="custom-range-form" method="get" action="/app/links/${linkId}">
          <div class="field">
            <label for="range-from">Von</label>
            <input id="range-from" type="date" name="from" autocomplete="off" value="${esc(customFromTo?.from || '')}">
          </div>
          <div class="field">
            <label for="range-to">Bis</label>
            <input id="range-to" type="date" name="to" autocomplete="off" value="${esc(customFromTo?.to || '')}">
          </div>
          <button type="submit" class="btn ghost">Anzeigen</button>
        </form>
      </div>
    </details>
    ${ranges.custom ? `<a href="/app/links/${linkId}" class="range-clear-btn" title="Zeitraum zurücksetzen" aria-label="Benutzerdefinierten Zeitraum zurücksetzen">×</a>` : ''}
  </div>
</div>
<div class="chart-wrap" id="stats-chart" style="${axisStyle}">
  <svg class="chart-svg" id="chart-svg" viewBox="0 0 ${Chart.CHART_W} ${Chart.CHART_H}" preserveAspectRatio="none" role="img" aria-label="${esc(Chart.chartSummary(initial.label, initial.total, initial.values, initial.pointLabels, fmtNum))}">
    <g id="chart-grid">${grid.lines}</g>
    <path class="chart-area" id="chart-area" d="${areaPath}"/>
    <path class="chart-line" id="chart-line" d="${linePath}"/>
    <path class="chart-line chart-line-partial" id="chart-line-partial" d="${partialPath}"/>
    <g id="chart-hover-group">${Chart.hoverBandsHtml(points, initial.values, initial.pointLabels)}</g>
  </svg>
  <div id="chart-y-labels" aria-hidden="true">${grid.labels}</div>
  <div class="chart-hover-point" id="chart-hover-dot" aria-hidden="true"></div>
  <div class="chart-tooltip" id="chart-tooltip" aria-hidden="true">
    <div class="chart-tooltip-title" id="chart-tooltip-title"></div>
    <div class="chart-tooltip-row"><span class="chart-tooltip-dot"></span>Klicks<b id="chart-tooltip-value"></b></div>
  </div>
</div>
<div class="chart-x-labels" id="chart-x-labels" style="${axisStyle}" aria-hidden="true">${Chart.xLabelsHtml(initial.labels, initial.values.length)}</div>`;
}

const pctFormat = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Percentages are shares of ALL clicks (allClicks), not of the fetched rows:
// queries are capped (100), so summing only those would inflate every share;
// the remainder becomes a static "Weitere" tail row.
//
// More than `limit` entries: top `limit` plus one clickable "Weitere (n)" row
// opening a <dialog> (data-open-dialog, see app.js) with all entries. Without
// `id` (devices) the list is always shown in full.
const clicksLabel = (n) => `${fmtNum(n)} ${n === 1 ? 'Klick' : 'Klicks'}`;

function splitBreakdownList(rows, allClicks, { title = '', id = '', limit = 5 } = {}) {
  if (!rows.length) return `<p class="muted">Noch keine Daten.</p>`;
  const shown = rows.reduce((a, r) => a + r.n, 0);
  const base = Math.max(allClicks || 0, shown);
  const items = rows.map(r => ({ name: r.ref ?? r.device ?? r.browser ?? r.lang ?? '–', n: r.n }));
  // Clicks beyond the query cap: not a real entry, so not counted as one.
  const tail = base > shown ? { name: 'Weitere', n: base - shown, rest: true } : null;
  const full = tail ? [...items, tail] : items;
  const pctOf = (n) => (n / base) * 100;
  const item = (it) => {
    const pct = pctOf(it.n);
    const name = esc(it.name || '–');
    return `<li${it.rest ? ' class="rest"' : ''}>
      <div class="row"><span class="name" title="${name}">${name}</span><span class="val-n">${clicksLabel(it.n)}</span><span class="val-pct">${pctFormat.format(pct)} %</span></div>
      <div class="meter"><span style="width:${pct.toFixed(2)}%"></span></div>
    </li>`;
  };
  if (!id || items.length <= limit) return `<ul class="split">${full.map(item).join('')}</ul>`;

  const rest = items.slice(limit);
  const restN = rest.reduce((a, it) => a + it.n, 0) + (tail ? tail.n : 0);
  const restPct = pctOf(restN);
  const more = tail ? '+' : ''; // "+" = there are even more entries than the query returned
  const restRow = `<li class="rest">
      <button type="button" class="rest-btn" data-open-dialog="${id}" aria-haspopup="dialog">
        <span class="row"><span class="name">Weitere (${fmtNum(rest.length)}${more})</span><span class="val-n">${clicksLabel(restN)}</span><span class="val-pct">${pctFormat.format(restPct)} %</span></span>
        <span class="meter"><span style="width:${restPct.toFixed(2)}%"></span></span>
      </button>
    </li>`;
  const dialog = `<dialog id="${id}" class="confirm-dialog dist-dialog" aria-labelledby="${id}-title">
    <div class="dist-dialog-head">
      <div><h3 id="${id}-title">${esc(title)}</h3><p class="dist-dialog-sub">${fmtNum(items.length)}${more} Einträge · Anteile an allen ${fmtNum(base)} Klicks</p></div>
      <button type="button" class="dist-dialog-close" data-close-dialog aria-label="Schließen">×</button>
    </div>
    <ul class="split dist-dialog-list">${full.map(item).join('')}</ul>
  </dialog>`;
  return `<ul class="split">${full.slice(0, limit).map(item).join('')}${restRow}</ul>${dialog}`;
}

// error/errorField/values: only set on re-render after a failed POST .../update
// (see renderLinkDetail() in server.js), like dashboard(). values overrides the
// DB fields; data-utc is skipped then, as it only fits the stored value.
function linkDetail({ link, origin, short, domains, stats, expiresAtLocal, expired, user, flash, page = 'dashboard', canEditRestricted = true, canDelete = true, audit = [], error = null, errorField = null, values = null }) {
  const split = Utm.splitUtm(link.target_url);
  const v = values || { target_url: split.base, utm: split.utm, title: link.title, domain: link.domain, expiresAtLocal };
  const utmOpen = !!values && Object.keys(v.utm).length > 0;
  const body = `
<main>
<div class="page">
<nav class="crumbs"><a href="/app" data-back>← Zurück</a></nav>

<div class="detail-head">
  <h1 translate="no">${esc(stripProto(origin))}<span class="accent">/${esc(link.slug)}</span></h1>
  <button type="button" class="copy-icon-btn" data-copy="${esc(short)}" title="Link kopieren" aria-label="Link kopieren">${icon('copy', 'copy-icon')}</button>
  ${expired ? `<span class="badge expired">Abgelaufen</span>` : link.expires_at ? `<span class="muted">läuft ab <time class="local-time" datetime="${parseDbDate(link.expires_at).toISOString()}">${fmtDate(link.expires_at)}</time></span>` : ''}
  <div class="head-actions">
    ${utmToggle(utmOpen, true)}
    <button type="submit" form="edit-form" class="head-action">Speichern</button>
  </div>
</div>

<div class="detail-grid">
<section class="qrbox">
  <img src="/app/links/${link.id}/qr.svg" alt="QR-Code für ${esc(short)}" width="220" height="220">
  <div class="dl">
    <a class="btn ghost" href="/app/links/${link.id}/qr.svg?download=1">SVG</a>
    <a class="btn ghost" href="/app/links/${link.id}/qr.png?size=1024&download=1">PNG</a>
  </div>
</section>

<section class="card edit-card">
  <div class="card-head"><h2>Link-Details</h2></div>
  <form id="edit-form" method="post" action="/app/links/${link.id}/update" class="flex-col gap-16">
    <div>
      <label for="target">Ziel-URL</label>
      <input id="target" name="target_url" type="text" value="${esc(v.target_url)}"${fieldInvalidAttrs('target_url', errorField, 'target')} required${canEditRestricted ? '' : ' readonly'} autocomplete="off">
      ${fieldErrorSpan('target_url', errorField, error, 'target')}
      ${canEditRestricted ? '' : '<span class="muted hint">Nur Besitzer:in/Admin können die Ziel-URL ändern</span>'}
      ${utmUrlLine(v.target_url, v.utm)}
    </div>
    <div class="grid-form">
      <div class="field">
        <label for="title">Beschreibung <span class="muted">(optional)</span></label>
        <input id="title" name="title" type="text" value="${esc(v.title)}" autocomplete="off">
      </div>
      ${domainField(v.domain, domains)}
      <div class="field">
        <label for="expires_at">Läuft ab <span class="muted">(optional)</span></label>
        <input id="expires_at" name="expires_at" type="datetime-local" value="${esc(v.expiresAtLocal)}"${!values && link.expires_at ? ` data-utc="${esc(link.expires_at)}"` : ''} autocomplete="off">
      </div>
    </div>
    <div class="radio-row">${visibilityRadios(v.visibility ?? link.visibility, !canEditRestricted)}</div>
  </form>
</section>
</div>

${utmCard(v.utm, utmOpen, !canEditRestricted, 'edit-form')}

${kpiCard({ link, stats })}

<section class="card">
  ${statsChart(stats.ranges, link.id, stats.initialRange, stats.customRange)}
</section>

<div class="detail-lower">
<section class="card dist-card">
  <div class="card-head"><h2>Besuchende</h2></div>
  <div class="dist-grid">
    <div><h3>Quelle</h3>${splitBreakdownList(stats.referrers, stats.recentTotal, { title: 'Quelle', id: 'dist-referrer' })}</div>
    <div><h3>Geräte</h3>${splitBreakdownList(stats.devices, stats.recentTotal)}</div>
    <div><h3>Browser</h3>${splitBreakdownList(stats.browsers, stats.recentTotal, { title: 'Browser', id: 'dist-browser' })}</div>
    <div><h3>Sprachen</h3>${splitBreakdownList((stats.languages || []).map(r => ({ lang: r.lang_code ? langInfo(r.lang_code).name : 'Unbekannt', n: r.n })), stats.recentTotal, { title: 'Sprachen', id: 'dist-language' })}</div>
  </div>
</section>

<section class="card" id="letzte-klicks">
  <div class="card-head">
    <h2>Letzte Klicks</h2>
    ${stats.recentTotal > stats.recentSize ? `
    <nav class="pagination-nav" aria-label="Letzte Klicks blättern">
      <div class="pagination-arrows">
        ${stats.recentNewerHref
          ? `<a href="${esc(stats.recentNewerHref)}" class="pagination-arrow labeled">${icon('chevron-left', 'navicon')}<span>Neuere</span></a>`
          : `<span class="pagination-arrow labeled disabled" role="link" aria-disabled="true">${icon('chevron-left', 'navicon')}<span>Neuere</span></span>`}
        ${stats.recentOlderHref
          ? `<a href="${esc(stats.recentOlderHref)}" class="pagination-arrow labeled"><span>Ältere</span>${icon('chevron-right', 'navicon')}</a>`
          : `<span class="pagination-arrow labeled disabled" role="link" aria-disabled="true"><span>Ältere</span>${icon('chevron-right', 'navicon')}</span>`}
      </div>
    </nav>` : ''}
  </div>
  ${stats.recent.length ? recentClicksTable(stats.recent) : `<p class="muted">Noch keine Klicks.</p>`}
  ${stats.recent.length && stats.recentTotal > stats.recentSize ? `
  <p class="range-info table-foot">${fmtNum(stats.recentFrom)}–${fmtNum(stats.recentFrom + stats.recent.length - 1)} von ${fmtNum(stats.recentTotal)}</p>` : ''}
</section>
</div>

${audit.length ? `
<section class="card">
  <h2>Änderungsverlauf der Ziel-URL</h2>
  <div class="table-scroll"><table class="tbl">
    <thead><tr><th class="th-date">Zeitpunkt</th><th>Von</th><th>Alte URL</th><th>Neue URL</th></tr></thead>
    <tbody>${audit.map(a => `<tr>
      <td class="cell-sub">${fmtDate(a.ts)}</td>
      <td>${esc(a.username || '–')}</td>
      <td class="cell-ellipsis" title="${esc(a.old_url)}">${esc(a.old_url)}</td>
      <td class="cell-ellipsis" title="${esc(a.new_url)}">${esc(a.new_url)}</td>
    </tr>`).join('')}</tbody>
  </table></div>
</section>` : ''}

${canDelete ? `
<section class="card danger danger-confirm" aria-labelledby="delete-title">
  <div class="copy">
    <h2 id="delete-title">Link löschen</h2>
    <p>Löscht den Link samt aller Klickdaten. Bereits gedruckte QR-Codes laufen danach ins Leere. Zur Bestätigung bitte <b translate="no">${esc(link.slug)}</b> eintippen.</p>
  </div>
  <form method="post" action="/app/links/${link.id}/delete" data-confirm="Diesen Link wirklich löschen?">
    <input type="text" data-confirm-slug="${esc(link.slug)}" placeholder="Kürzel eintippen…" aria-label="Kürzel zur Bestätigung eingeben" autocomplete="off">
    <button class="destructive-ghost" type="submit" disabled>Löschen…</button>
  </form>
</section>` : ''}
</div>
</main>`;
  return layout({ title: `/${link.slug}`, body, user, flash, page });
}

function colorFields(dark, light, transparentBg, lightPick = null) {
  // The native picker has no alpha (6-digit hex): #rrggbbaa is truncated for
  // display, the full value travels hidden for the download (see dlFields).
  const lightSwatch = lightPick || light.slice(0, 7);
  return `<div class="color-pills">
    <span class="label-inline">Farben:</span>
    <label>Vordergrund <input type="color" name="dark" value="${esc(dark)}"></label>
    <label>Hintergrund <input type="color" name="light" value="${esc(lightSwatch)}"></label>
    <label class="label-indent"><input type="checkbox" name="light_transparent" value="1" ${transparentBg ? 'checked' : ''}> Hintergrund transparent</label>
  </div>`;
}

// CSS-only tabs (hidden radio + label): :has() on .qr-form picks the visible
// .qr-type-panel (see style.css); tab IDs here must match the selectors there.
const QR_TYPES = [
  ['url', 'URL'],
  ['text', 'Text'],
  ['wlan', 'WLAN'],
  ['epc', 'EPC'],
];
function qrTypeTabs(active) {
  return `<div class="qr-type-tabs" role="tablist">
    ${QR_TYPES.map(([val, label]) => `<label><input type="radio" name="qr_type" id="qt-${val}" value="${val}" ${active === val ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('')}
  </div>`;
}

// All four panels are always rendered (one visible), so switching keeps
// values; server.js only reads the active qr_type's data.
// url_value is type="text", not "url": native validation would reject a
// scheme-less input before server.js can prepend "https://" (see
// buildQrTypeContent).
function qrTypePanels(v) {
  return `
  <div class="qr-type-panel" data-panel="url">
    <div class="grid-form">
      <div class="field grow">
        <label for="url_value">Ziel-URL</label>
        <input id="url_value" name="url_value" type="text" placeholder="https://…" value="${esc(v.url_value)}" autocomplete="off">
      </div>
    </div>
  </div>
  <div class="qr-type-panel" data-panel="text">
    <div class="grid-form">
      <div class="field grow">
        <label for="data">Inhalt</label>
        <textarea id="data" name="data" rows="3" autocomplete="off">${esc(v.data)}</textarea>
      </div>
    </div>
  </div>
  <div class="qr-type-panel" data-panel="wlan">
    <div class="grid-form">
      <div class="field"><label for="wlan_ssid">SSID</label><input id="wlan_ssid" name="wlan_ssid" type="text" value="${esc(v.wlan_ssid)}" autocomplete="off"></div>
      <div class="field"><label for="wlan_pass">Passwort</label><input id="wlan_pass" name="wlan_pass" type="text" value="${esc(v.wlan_pass)}" autocomplete="off"></div>
      <div class="field">
        <label for="wlan_enc">Verschlüsselung</label>
        <select id="wlan_enc" name="wlan_enc">
          <option value="WPA" ${v.wlan_enc === 'WPA' ? 'selected' : ''}>WPA/WPA2</option>
          <option value="WEP" ${v.wlan_enc === 'WEP' ? 'selected' : ''}>WEP</option>
          <option value="nopass" ${v.wlan_enc === 'nopass' ? 'selected' : ''}>keine</option>
        </select>
      </div>
    </div>
  </div>
  <div class="qr-type-panel" data-panel="epc">
    <div class="grid-form">
      <div class="field grow"><label for="epc_name">Begünstigter</label><input id="epc_name" name="epc_name" type="text" maxlength="70" value="${esc(v.epc_name)}" autocomplete="off"></div>
      <div class="field"><label for="epc_iban">IBAN</label><input id="epc_iban" name="epc_iban" type="text" placeholder="DE00…" spellcheck="false" value="${esc(v.epc_iban)}" autocomplete="off"></div>
    </div>
    <div class="grid-form">
      <div class="field"><label for="epc_bic">BIC <span class="muted">(optional)</span></label><input id="epc_bic" name="epc_bic" type="text" placeholder="nur außerhalb SEPA nötig…" spellcheck="false" value="${esc(v.epc_bic)}" autocomplete="off"></div>
      <div class="field"><label for="epc_amount">Betrag (EUR) <span class="muted">(optional)</span></label><input id="epc_amount" name="epc_amount" type="number" step="any" value="${esc(v.epc_amount)}" autocomplete="off"></div>
      <div class="field grow"><label for="epc_purpose">Verwendungszweck <span class="muted">(optional)</span></label><input id="epc_purpose" name="epc_purpose" type="text" maxlength="140" value="${esc(v.epc_purpose)}" autocomplete="off"></div>
    </div>
  </div>`;
}

// Layout like linkDetail(), but the preview only appears after the first
// "Erzeugen" click; until then the qrbox shows placeholder text.
function staticQrPage({ content = '', ec = 'M', dark = '#000000', light = '#ffffff', lightPick = null, transparentBg = false, svg = null, error = null, user, values = {} } = {}) {
  const v = {
    type: 'url', data: '', url_value: '', wlan_ssid: '', wlan_pass: '', wlan_enc: 'WPA',
    epc_name: '', epc_iban: '', epc_bic: '', epc_amount: '', epc_purpose: '',
    ...values,
  };
  // Resolved content travels in the POST body, not the URL, so it never ends
  // up in history or access logs.
  const dlFields = `<input type="hidden" name="data" value="${esc(content)}"><input type="hidden" name="ec" value="${esc(ec)}"><input type="hidden" name="dark" value="${esc(dark)}"><input type="hidden" name="light" value="${esc(light)}">`;
  const body = `
<main>
<div class="page">
<div class="flex-col gap-6">
  <div class="detail-head">
    <h1>Statischer QR-Code Generator</h1>
    <button type="submit" form="qr-form" class="head-action">Erzeugen</button>
  </div>
  <p class="muted flush">Inhalt landet direkt im QR-Code. Anders als bei „Erstellen“ nicht mehr änderbar, ohne Statistik, ohne Speicherung.</p>
</div>

<div class="detail-grid">
<section class="qrbox">
  ${svg ? `
  <div${transparentBg ? ' class="qr-preview-checker"' : ''}>${svg}</div>
  <div class="dl">
    <form method="post" action="/app/qr/download">${dlFields}<input type="hidden" name="format" value="svg"><button class="btn ghost" type="submit">SVG</button></form>
    <form method="post" action="/app/qr/download">${dlFields}<input type="hidden" name="format" value="png"><button class="btn ghost" type="submit">PNG</button></form>
  </div>` : `<p class="muted flush">Vorschau erscheint hier, sobald du „Erzeugen“ klickst.</p>`}
</section>

<section class="card">
  ${error ? `<div class="flash error">${esc(error)}</div>` : ''}
  <form id="qr-form" method="post" action="/app/qr" class="qr-form flex-col">
    ${qrTypeTabs(v.type)}
    ${qrTypePanels(v)}
    <div class="radio-row">
      ${colorFields(dark, light, transparentBg, lightPick)}
    </div>
  </form>
</section>
</div>
</div>
</main>`;
  return layout({ title: 'QR-Code Generator', body, user, page: 'qr' });
}

function userTableRow(u, currentUser) {
  const searchHay = esc(u.username).toLowerCase();
  return `
<tr data-search="${searchHay}">
  <td class="cell-sub" data-label="Nutzername" title="${esc(u.username)}">${esc(u.username)}</td>
  <td data-label="Rolle"><span class="badge${u.role === 'admin' ? '' : ' muted'}">${u.role === 'admin' ? 'Admin' : 'Mitglied'}</span></td>
  <td class="muted nowrap" data-label="Erstellt am">${fmtDate(u.created_at)}</td>
  <td class="muted nowrap" data-label="Letzter Login am">${fmtDate(u.last_login_at)}</td>
  <td class="num-cell" data-label="Links">${fmtNum(u.links_count)}</td>
  <td class="nowrap" data-label="">
    ${u.id === currentUser.id
      ? `<button class="ghost" type="button" disabled title="Selbstlöschung blockiert">Löschen</button>`
      : `<form method="post" action="/app/users/${u.id}/delete" class="inline" data-delete-user="${u.id}" data-username="${esc(u.username)}">
           <button class="destructive-ghost" type="submit" disabled data-needs-js>Löschen</button></form>`}
  </td>
</tr>`;
}

// Echte Links statt Client-Toggle, damit Zurück/Vorwärts und direkte URLs
// funktionieren.
function adminTabs(page) {
  const tabs = [
    ['users', '/app/users', 'Zugangsverwaltung'],
    ['domains', '/app/domains', 'Domainverwaltung'],
    ['design', '/app/design', 'Darstellung'],
  ];
  return `<div class="tab-group" role="tablist" aria-label="Admin-Einstellungen">
    ${tabs.map(([key, href, label]) =>
      `<a class="tab-link${page === key ? ' active' : ''}" href="${href}"${page === key ? ' aria-current="page"' : ''}>${esc(label)}</a>`
    ).join('')}
  </div>`;
}

// error/errorField/values: see dashboard(). The password is deliberately never
// part of `values` – not re-echoed into the form.
function usersPage({ users, ssoBlocked = [], user, flash, error = null, errorField = null, values = {} }) {
  const v = { username: '', role: 'member', ...values };
  const body = `
<main>
<div class="page">
<h1>Admin-Einstellungen</h1>
${adminTabs('users')}

<section class="card">
  <h2>Konto anlegen</h2>
  ${error && !errorField ? `<div class="flash error">${esc(error)}</div>` : ''}
  <form method="post" action="/app/users" class="grid-form">
    <div class="field">
      <label for="nu">Nutzername</label>
      <input id="nu" name="username" type="text" pattern="[A-Za-z0-9\\-_.]{2,32}" placeholder="clara…" value="${esc(v.username)}"${fieldInvalidAttrs('username', errorField, 'nu')} spellcheck="false" required autocomplete="off">
      ${fieldErrorSpan('username', errorField, error, 'nu')}
    </div>
    <div class="field">
      <label for="np">Startpasswort</label>
      <input id="np" name="password" type="text" minlength="8" placeholder="mind. 8 Zeichen…"${fieldInvalidAttrs('password', errorField, 'np')} autocomplete="off" required>
      ${fieldErrorSpan('password', errorField, error, 'np')}
    </div>
    <div class="field">
      <label for="nr">Rolle</label>
      <select id="nr" name="role">
        <option value="member" ${v.role !== 'admin' ? 'selected' : ''}>Mitglied</option>
        <option value="admin" ${v.role === 'admin' ? 'selected' : ''}>Admin</option>
      </select>
    </div>
    <div class="field submit"><button type="submit">Anlegen</button></div>
  </form>
</section>

<section>
  <h2>Alle Konten</h2>
  ${searchTable({
    links: users,
    theadHtml: `<th>Nutzername</th><th>Rolle</th><th>Erstellt am</th><th>Letzter Login am</th><th>Links</th><th></th>`,
    rowsHtml: users.map(u => userTableRow(u, user)).join(''),
    emptyText: 'Keine Konten vorhanden.',
  })}
</section>
${ssoBlocked.length ? `
<section class="card">
  <h2>Gesperrte SSO-Zugänge</h2>
  <p class="muted hint">Gelöschte SSO-Konten können sich nicht erneut anmelden, bis du sie hier freigibst. Bei der nächsten Anmeldung entsteht dann ein neues, leeres Konto.</p>
  <div class="table-scroll"><table class="tbl">
    <thead><tr><th>Nutzername</th><th class="th-date">Gesperrt am</th><th class="th-narrow"></th></tr></thead>
    <tbody>${ssoBlocked.map(b => `<tr>
      <td>${esc(b.username)}</td>
      <td class="cell-sub">${fmtDate(b.blocked_at)}</td>
      <td><form method="post" action="/app/users/sso-blocked/${b.id}/unblock"><button class="ghost" type="submit">Freigeben</button></form></td>
    </tr>`).join('')}</tbody>
  </table></div>
</section>` : ''}
<dialog id="delete-user-dialog" class="confirm-dialog" data-users='${esc(JSON.stringify(users.map(u => ({ id: u.id, username: u.username }))))}' data-current-user="${user.id}">
  <h3>Konto löschen</h3>
  <p class="confirm-dialog-text"></p>
  <div class="grid-form mb-20">
    <div class="field grow">
      <label for="reassign-to">Links übertragen an</label>
      <select id="reassign-to" name="reassign_to"></select>
    </div>
  </div>
  <div class="dialog-actions">
    <button type="button" class="btn ghost" data-dialog-cancel>Abbrechen</button>
    <button type="button" class="destructive-ghost" data-dialog-confirm>Endgültig löschen</button>
  </div>
</dialog>
</div>
</main>`;
  return layout({ title: 'Zugangsverwaltung', body, user, flash, page: 'users' });
}

// .cell-sub instead of .slug: .slug styling implies a clickable short link,
// but the domain here is plain text. isDefault only matters with more than one
// domain (drives the badge and "Als Standard setzen").
function domainTableRow(d, isDefault, showDefaultControl) {
  return `
<tr>
  <td class="cell-sub" data-label="Domain" title="${esc(stripProto(d.origin))}">${esc(stripProto(d.origin))}${isDefault && showDefaultControl ? ' <span class="badge">Standard</span>' : ''}</td>
  <td class="muted nowrap" data-label="Hinzugefügt am">${fmtDate(d.created_at)}</td>
  <td class="num-cell" data-label="Links">${fmtNum(d.links_count)}</td>
  <td class="nowrap" data-label="">
    <div class="row-actions">
      <button type="button" class="btn ghost reach-test-btn" data-domain-id="${d.id}">Testen</button>
      ${!isDefault && showDefaultControl ? `<form method="post" action="/app/domains/${d.id}/set-default">
        <button class="btn ghost" type="submit">Als Standard setzen</button>
      </form>` : ''}
      <form method="post" action="/app/domains/${d.id}/delete" data-confirm-modal="${esc(`„${stripProto(d.origin)}“ wird entfernt. Alle Links, die aktuell darüber laufen, ${showDefaultControl ? "werden automatisch auf eine andere konfigurierte Domain umgestellt" : "nutzen danach die Adresse, unter der die Seite aufgerufen wird"}. Kein gedruckter QR-Code bricht dadurch, der Redirect selbst prüft die Domain ohnehin nicht. Diese Aktion lässt sich nicht rückgängig machen.`)}">
        <button class="destructive-ghost" type="submit" disabled data-needs-js>Entfernen</button>
      </form>
    </div>
  </td>
</tr>`;
}

// error/errorField/values: see dashboard().
// Design page: name and accent colour, each in its own card with its own save. The accent live preview (app.js) sets --accent on <html> while picking.
function designPage({ accent, isCustom, name, nameCustom, errors = {}, user, flash }) {
  const ratio = Theme.contrastOnWhite(accent);
  const fmtRatio = (r) => r.toFixed(1).replace('.', ',');
  const nameErrorField = errors.name ? 'name' : null;
  const body = `
<main>
<div class="page">
<h1>Admin-Einstellungen</h1>
${adminTabs('design')}

<section class="card">
  <h2>Name</h2>
  <p class="muted hint">Erscheint in der Seitenleiste, auf der Anmeldeseite und im Titel des Browser-Tabs.</p>
  <form method="post" action="/app/design/name" class="flex-col" id="name-form">
    <div class="field">
      <label for="brand-name">Name</label>
      <input id="brand-name" name="name" type="text" maxlength="${Theme.MAX_NAME_LENGTH * 2}" placeholder="${esc(Theme.DEFAULT_NAME)}…" value="${esc(name)}"${fieldInvalidAttrs('name', nameErrorField, 'brand-name')} autocomplete="off">
      ${fieldErrorSpan('name', nameErrorField, errors.name, 'brand-name')}
    </div>
    <div class="row-actions design-actions">
      <button type="submit">Speichern</button>
      <button type="submit" name="reset" value="1" class="ghost"${nameCustom ? '' : ' disabled'}>Auf Standard zurücksetzen</button>
    </div>
  </form>
</section>

<section class="card">
  <h2>Akzentfarbe</h2>
  <p class="muted hint">Gilt für alle Nutzer: Links, aktive Navigation, Hover, Fokusrahmen und Diagramme.</p>
  ${errors.accent ? `<div class="flash error">${esc(errors.accent)}</div>` : ''}
  <form method="post" action="/app/design" class="flex-col" id="design-form" data-default="${esc(Theme.DEFAULT_ACCENT)}" data-min-contrast="${Theme.MIN_CONTRAST}">
    <div class="color-pills">
      <label for="accent">Akzentfarbe <input id="accent" type="color" name="accent" value="${esc(accent)}"></label>
      <span class="muted hint" id="accent-contrast" role="status">Kontrast auf Weiß: ${fmtRatio(ratio)}:1${ratio >= Theme.MIN_CONTRAST ? '' : ' (zu gering, mindestens ' + fmtRatio(Theme.MIN_CONTRAST) + ':1)'}</span>
    </div>
    <div class="design-preview" aria-hidden="true">
      <a href="#" tabindex="-1">Beispiel-Link</a>
      <span class="btn">Button</span>
      <svg viewBox="0 0 120 32" class="design-preview-chart"><path class="chart-area" d="M0 30 L20 22 L40 26 L60 10 L80 18 L100 6 L120 14 L120 32 L0 32 Z"/><path class="chart-line" d="M0 30 L20 22 L40 26 L60 10 L80 18 L100 6 L120 14"/></svg>
    </div>
    <div class="row-actions design-actions">
      <button type="submit">Speichern</button>
      <button type="submit" name="reset" value="1" class="ghost"${isCustom ? '' : ' disabled'}>Auf Standard zurücksetzen</button>
    </div>
  </form>
</section>
</div>
</main>`;
  return layout({ title: 'Darstellung', body, user, flash, page: 'design', scripts: `<script src="${THEME_JS_URL}"></script>\n` });
}

const ERROR_TITLES = { 400: 'Ungültige Anfrage', 403: 'Kein Zugriff', 404: 'Nicht gefunden', 410: 'Nicht mehr verfügbar', 500: 'Interner Fehler' };
function errorPage({ status, message, user = null }) {
  const title = ERROR_TITLES[status] || 'Fehler';
  const body = user
    ? `
<main>
<div class="page">
<h1>${esc(title)}</h1>
<p class="muted">${esc(message)}</p>
<p><a class="btn ghost" href="/app">Zur Übersicht</a></p>
</div>
</main>`
    : `
<main class="login-shell">
<div class="login-card">
  <h1 class="login-brand">${brandInner()}</h1>
  <h2>${esc(title)}</h2>
  <h3>${esc(message)}</h3>
  <a class="login-sso-btn" href="/login">Zur Anmeldung</a>
</div>
</main>`;
  return layout({ title, body, user });
}

function domainsPage({ domains, user, flash, error = null, errorField = null, values = {} }) {
  const v = { origin: '', ...values };
  const body = `
<main>
<div class="page">
<h1>Admin-Einstellungen</h1>
${adminTabs('domains')}

<section class="card">
  <form method="post" action="/app/domains" class="grid-form">
    <div class="field grow">
      <label for="origin">Domain</label>
      <input id="origin" name="origin" type="text" placeholder="example.com…" value="${esc(v.origin)}"${fieldInvalidAttrs('origin', errorField, 'origin')} spellcheck="false" required autocomplete="off">
      ${fieldErrorSpan('origin', errorField, error, 'origin')}
    </div>
    <div class="field submit"><button type="submit">Hinzufügen</button></div>
  </form>
</section>

<section>
  ${searchTable({
    links: domains,
    theadHtml: `<th>Domain</th><th class="th-date">Hinzugefügt am</th><th class="th-narrow">Links</th><th class="th-actions"></th>`,
    rowsHtml: domains.map((d, i) => domainTableRow(d, i === 0, domains.length > 1)).join(''),
    emptyText: 'Keine Domain konfiguriert. Kurzlinks nutzen automatisch die Adresse, unter der die Seite aufgerufen wird.',
    showSearch: false,
  })}
</section>
</div>
</main>`;
  return layout({ title: 'Domainverwaltung', body, user, flash, page: 'domains' });
}

function accountPage({ user, flash }) {
  const body = `
<main>
<div class="page">
<h1>Konto</h1>
<section class="card card-narrow">
  <h2>Passwort ändern</h2>
  ${user.sso_subject ? `
  <p class="muted prose">Dieses Konto ist über SSO angebunden, das Passwort wird bei deinem Identity Provider verwaltet, nicht in ${esc(themeName)}.</p>` : `
  <form id="password-form" method="post" action="/app/account/password" class="stack">
    <div><label for="cp">Aktuelles Passwort</label>
    <input id="cp" name="current" type="password" autocomplete="current-password" required></div>
    <div><label for="np2">Neues Passwort</label>
    <input id="np2" name="next" type="password" autocomplete="new-password" minlength="8" required></div>
    <div><label for="np3">Wiederholen</label>
    <input id="np3" name="next_repeat" type="password" autocomplete="new-password" minlength="8" required></div>
    <button type="submit">Passwort ändern</button>
  </form>
  <p class="muted prose mt-15">Nur gegen aktuelles Passwort möglich. Andere Geräte werden dabei abgemeldet, dieses bleibt angemeldet.</p>`}
</section>
<section class="card card-narrow">
  <h2>Sitzung</h2>
  <form method="post" action="/logout">
    <button type="submit" class="btn ghost">Abmelden</button>
  </form>
</section>
</div>
</main>`;
  return layout({ title: 'Konto', body, user, flash, page: 'account' });
}

module.exports = { errorPage, designPage, setTheme, getThemeCss, setUpdateInfo, loginPage, dashboard, vaultPage, myVaultPage, linkDetail, staticQrPage, usersPage, domainsPage, accountPage, isExpired, CSS_CONTENT };
