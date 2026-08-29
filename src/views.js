// Server-rendered templates. No framework, no external fonts,
// no client-side tracking – the tool itself is the tracking. :)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cache busting for /static/*: browsers are allowed to cache style.css/
// app.js aggressively (see maxAge in server.js), but so deploys still take
// effect immediately instead of requiring a manual hard refresh, the
// content hash is appended as a query parameter – it only changes when the
// file actually changes.
function assetVersion(relPath) {
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'public', relPath));
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
  } catch {
    return String(Date.now()); // file missing (e.g. in tests) – never cache instead of crashing
  }
}
const CSS_URL = `/static/style.css?v=${assetVersion('style.css')}`;
const APP_JS_URL = `/static/app.js?v=${assetVersion('app.js')}`;
const FONT_URL = `/static/fonts/open-sans-latin.woff2?v=${assetVersion('fonts/open-sans-latin.woff2')}`;

const numberFormat = new Intl.NumberFormat('de-DE');
const fmtNum = (n) => numberFormat.format(n ?? 0);

// style.css itself references the font file again via /static/* – it gets
// the same hash cache-busting treatment as CSS/JS here, by replacing the
// placeholder in the source once at startup with the font file's real
// content hash. server.js serves this result instead of the raw file (see
// the /static/style.css route there), so the embedded font URL is actually
// versioned instead of forever carrying the same query string.
function loadCssContent() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    return raw.replace('__FONT_VERSION__', assetVersion('fonts/open-sans-latin.woff2'));
  } catch {
    return ''; // file missing (e.g. in tests) – never crash, the page just stays unstyled
  }
}
const CSS_CONTENT = loadCssContent();

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Shared field-error rendering: `matchField` is which field a given <input>
// represents, `errorField` is which field (if any) actually failed
// validation on the last submit – only the matching input gets styled/
// described, every other field on the same form stays untouched.
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
  return parseDbDate(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) + ' Uhr';
}

function isExpired(link) {
  return !!link.expires_at && link.expires_at <= new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Visibility badge for a link
function visibilityBadge(l) {
  return `<span class="badge${l.visibility === 'org' ? '' : ' muted'}">${l.visibility === 'org' ? 'Organisation' : 'Persönlich'}</span>`;
}

// Icons: mostly Material Symbols (Google, Apache-2.0, filled paths), vendored
// in once — no icon font/library at runtime, same approach as the font.
// "Erstellen" (dashboard) is a line icon with its own stroke markup.
const ICON = {
  dashboard: `<path d="M0 0h24v24H0z" fill="none"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 6l2 -2c1 -1 3 -1 4 0l1 1c1 1 1 3 0 4l-5 5c-1 1 -3 1 -4 0M11 18l-2 2c-1 1 -3 1 -4 0l-1 -1c-1 -1 -1 -3 0 -4l5 -5c1 -1 3 -1 4 0"/>`,
  vault: `<path fill="currentColor" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h6l2 2h8q.825 0 1.413.588T22 8v10q0 .825-.587 1.413T20 20zm7-3h8v-.55q0-1.125-1.1-1.787T15 14t-2.9.663T11 16.45zm5.413-4.587Q17 11.825 17 11t-.587-1.412T15 9t-1.412.588T13 11t.588 1.413T15 13t1.413-.587"/>`,
  myvault: `<path fill="currentColor" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h6l2 2h8q.825 0 1.413.588T22 8v10q0 .825-.587 1.413T20 20z"/>`,
  qr: `<path fill="currentColor" d="M3 10V4q0-.425.288-.712T4 3h6q.425 0 .713.288T11 4v6q0 .425-.288.713T10 11H4q-.425 0-.712-.288T3 10m2-1h4V5H5zM3 20v-6q0-.425.288-.712T4 13h6q.425 0 .713.288T11 14v6q0 .425-.288.713T10 21H4q-.425 0-.712-.288T3 20m2-1h4v-4H5zm8-9V4q0-.425.288-.712T14 3h6q.425 0 .713.288T21 4v6q0 .425-.288.713T20 11h-6q-.425 0-.712-.288T13 10m2-1h4V5h-4zm4 12v-2h2v2zm-6-6v-2h2v2zm2 2v-2h2v2zm-2 2v-2h2v2zm2 2v-2h2v2zm2-2v-2h2v2zm0-4v-2h2v2zm2 2v-2h2v2z"/>`,
  logout: `<path fill="currentColor" d="M5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h7v2H5v14h7v2zm11-4l-1.375-1.45l2.55-2.55H9v-2h8.175l-2.55-2.55L16 7l5 5z"/>`,
  person: `<path fill="currentColor" d="M9.175 10.825Q8 9.65 8 8t1.175-2.825T12 4t2.825 1.175T16 8t-1.175 2.825T12 12t-2.825-1.175M4 20v-2.8q0-.85.438-1.562T5.6 14.55q1.55-.775 3.15-1.162T12 13t3.25.388t3.15 1.162q.725.375 1.163 1.088T20 17.2V20z"/>`,
  settings: `<path fill="currentColor" d="m9.25 22l-.4-3.2q-.325-.125-.612-.3t-.563-.375L4.7 19.375l-2.75-4.75l2.575-1.95Q4.5 12.5 4.5 12.338v-.675q0-.163.025-.338L1.95 9.375l2.75-4.75l2.975 1.25q.275-.2.575-.375t.6-.3l.4-3.2h5.5l.4 3.2q.325.125.613.3t.562.375l2.975-1.25l2.75 4.75l-2.575 1.95q.025.175.025.338v.674q0 .163-.05.338l2.575 1.95l-2.75 4.75l-2.95-1.25q-.275.2-.575.375t-.6.3l-.4 3.2zm2.8-6.5q1.45 0 2.475-1.025T15.55 12t-1.025-2.475T12.05 8.5q-1.475 0-2.488 1.025T8.55 12t1.013 2.475T12.05 15.5"/>`,
  chevron: `<path fill="currentColor" d="m12 21l-4.5-4.5l1.45-1.45L12 18.1l3.05-3.05l1.45 1.45zM8.95 9.05L7.5 7.6L12 3.1l4.5 4.5l-1.45 1.45L12 6z"/>`,
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
      { key: 'users', href: '/app/users', label: 'Admin-Einstellungen', icon: 'settings', activeKeys: ['users', 'domains'] },
    ],
  },
];

function navGroup(group, user, page) {
  if (group.adminOnly && user.role !== 'admin') return '';
  const title = group.title ? `<div class="group-title">${esc(group.title)}</div>` : '';
  const links = group.items.map(n => {
    const active = (n.activeKeys || [n.key]).includes(page);
    return `<a class="navlink${active ? ' active' : ''}" href="${n.href}" title="${esc(n.label)}">${icon(n.icon || n.key)}<span class="label">${esc(n.label)}</span></a>`;
  }).join('');
  return title + links;
}

// Mobile bottom navigation (<=760px, see .bottom-nav in style.css) – takes
// over the primary-destinations role the hamburger+sidebar used to carry on
// mobile. Shorter labels than the desktop sidenav (narrow 10px tabs).
// "Mehr" opens the same sidebar overlay the old hamburger button did –
// that's still where Account/Admin-Einstellungen live, see app.js.
const BOTTOM_NAV_LEFT = [
  { key: 'myvault', href: '/app/user-vault', label: 'Mein Tresor' },
  { key: 'vault', href: '/app/org-vault', label: 'Team-Tresor' },
];
const BOTTOM_NAV_RIGHT = [
  { key: 'qr', href: '/app/qr', label: 'QR-Code' },
];
function bottomNavItem(n, page) {
  const active = page === n.key;
  return `<a class="bottom-nav-item${active ? ' active' : ''}" href="${n.href}"${active ? ' aria-current="page"' : ''}>${icon(n.key, 'navicon')}<span>${esc(n.label)}</span></a>`;
}
function bottomNav(page, user) {
  // Admins: Zahnrad + "Admin" statt generischem "Mehr" – direkter Link auf
  // die Admin-Einstellungen (ein Tap, analog zum Sidebar-Link, siehe
  // NAV_GROUPS), statt erst das Sidebar-Overlay zu öffnen. Damit Admins über
  // diesen direkten Link nicht ihren einzigen mobilen Weg zu "Abmelden"
  // verlieren (das Dropdown dafür steckt nur im Sidebar-Overlay), gibt es
  // "Abmelden" zusätzlich direkt auf /app/account, siehe accountPage() –
  // dorthin führt schon der Profil-Avatar in der mobilen Topbar.
  // Mitglieder haben keine Admin-Seiten, für sie bleibt "Mehr" der generische
  // Sidebar-Zugang (Overlay mit Konto/Abmelden).
  const isAdmin = user.role === 'admin';
  const moreActive = page === 'users' || page === 'domains';
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

function layout({ title, body, user = null, flash = null, page = null }) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f7f8fa">
<title>${esc(title)} · snar</title>
<link rel="preload" href="${FONT_URL}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${CSS_URL}">
</head>
<body>
${user ? `<a class="skip-link" href="#main-content">Zum Inhalt springen</a>
<div class="mobile-topbar">
  <a class="brand" href="/app"><span translate="no">snar</span></a>
  <a class="mobile-topbar-account" href="/app/account" aria-label="Konto: ${esc(user.username)}">
    <span class="avatar">${esc(user.username.slice(0, 1).toUpperCase())}</span>
  </a>
</div>` : ''}
<div class="shell">
${user ? `<div class="sidebar-backdrop" id="sidebar-backdrop"></div>
<aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <a class="brand" href="/app"><span translate="no">snar</span></a>
  </div>
  <div class="sidebar-account">
    <button type="button" id="account-menu-toggle" class="account-trigger" aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu">
      <span class="avatar">${esc(user.username.slice(0, 1).toUpperCase())}</span>
      <span class="who-chip">${esc(user.username)}</span>
      ${icon('chevron', 'chevron-icon')}
    </button>
    <div class="account-menu" id="account-menu" role="menu">
      <a href="/app/account" role="menuitem">${icon('person', 'menu-icon')}Dein Profil</a>
      <a href="/app/account" role="menuitem">${icon('settings', 'menu-icon')}Einstellungen</a>
      <form method="post" action="/logout" role="none"><button type="submit" role="menuitem">${icon('logout', 'menu-icon')}Abmelden</button></form>
    </div>
  </div>
  <nav class="sidenav">
    ${NAV_GROUPS.map(g => navGroup(g, user, page)).join('')}
  </nav>
</aside>` : ''}
<div class="shell-main" id="main-content" tabindex="-1">
${flash ? `<div class="flash toast ${esc(flash.type)}" role="status">${esc(flash.text)}</div>` : ''}
${body}
</div>
</div>
${user ? bottomNav(page, user) : ''}
<div id="copy-announcer" class="sr-only" role="status" aria-live="polite"></div>
${user ? `<dialog id="confirm-dialog" class="confirm-dialog">
  <h3>Wirklich löschen?</h3>
  <p class="confirm-dialog-text"></p>
  <div class="dialog-actions">
    <button type="button" class="btn ghost" data-dialog-cancel>Abbrechen</button>
    <button type="button" class="destructive-ghost" data-dialog-confirm>Endgültig löschen</button>
  </div>
</dialog>` : ''}
<script src="${APP_JS_URL}"></script>
</body>
</html>`;
}

function loginPage({ error = null, ssoEnabled = false } = {}) {
  const body = `
<main class="login-shell">
<div class="login-card">
  <h1 class="login-brand"><span translate="no">snar</span></h1>
  <h2>Willkommen zurück!</h2>
  <h3>Melde dich an, um fortzufahren.</h3>
  ${error ? `<div class="flash error">${esc(error)}</div>` : ''}
  ${ssoEnabled ? `
  <a class="login-sso-btn" href="/login/sso">Mit SSO anmelden</a>
  <div class="login-divider"><span>oder</span></div>` : ''}
  <form method="post" action="/login" class="login-form">
    <div class="field">
      <label for="username">Anmeldename</label>
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

// Returns only the content (no wrapping .radio-row div), so callers can
// hang further elements (e.g. a submit button) onto the same row if needed.
// locked=true (existing org links only, non-owner/non-admin, see
// isOwnerOrAdmin in server.js): the radios stay visible but disabled –
// otherwise a member could lock themselves out by switching to "Persönlich"
// (canManage() only grants non-owners access as long as visibility stays
// 'org').
function visibilityRadios(current = 'privat', locked = false) {
  const dis = locked ? ' disabled' : '';
  return `<span class="label-inline">Sichtbarkeit:</span>
    <label><input type="radio" name="visibility" value="privat" ${current !== 'org' ? 'checked' : ''}${dis}>Persönlich</label>
    <label><input type="radio" name="visibility" value="org" ${current === 'org' ? 'checked' : ''}${dis}>Organisation</label>
    ${locked ? '<span class="muted" style="font-size:12.5px">Nur Besitzer:in/Admin können das ändern</span>' : ''}`;
}

// Only when domains are actually configured – otherwise there's nothing to
// pick from and the field stays hidden.
function domainField(current, domains) {
  if (!domains || domains.length === 0) return '';
  return `<div class="field">
      <label for="domain">Domain</label>
      <select id="domain" name="domain">
        ${domains.map(d => `<option value="${esc(d)}" ${d === current ? 'selected' : ''}>${esc(stripProto(d))}</option>`).join('')}
      </select>
    </div>`;
}

// Search/pagination table (dashboard, personal vault, user & domain
// management share the toolbar, page size, and arrows – app.js hooks in
// generically via #links-search/.linktable/.page-size-btn/
// #links-prev/#links-next). showSearch=false (e.g. the domains list):
// realistically never enough rows for a search to help – app.js's search
// code is tied to #links-search anyway and just does nothing without the
// field, no separate handling needed.
function searchTable({ links, theadHtml, rowsHtml, emptyText, showSearch = true }) {
  if (!links.length) return `<div class="empty">${emptyText}</div>`;
  const showToolbar = showSearch || links.length > 10;
  return `
  <div class="card table-card">
    ${showToolbar ? `
    <div class="table-toolbar">
      ${showSearch ? `<input id="links-search" class="search-input" placeholder="Suchen…" aria-label="Suchen">` : ''}
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
    <div class="table-scroll"${showToolbar ? '' : ' style="border-top:none"'}>
    <table class="tbl linktable">
      <thead><tr>${theadHtml}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    </div>
  </div>`;
}

// Shared row for the dashboard, personal vault & org vault – the three
// tables only differ in one column: the dashboard shows visibility (before
// status), the org vault shows "Erstellt von" (after status, see
// canManage() in server.js – org links belong to the whole team, so
// "Details" is available to every member), the personal vault shows
// neither (it only ever lists links with visibility "Persönlich", see
// linksByOwnerPrivate in db.js – the column would be identical on every row
// there and thus redundant).
function linkTableRow(l, short, { extraColumn = null } = {}) {
  const searchParts = [l.title || '', l.slug, l.target_url];
  if (extraColumn === 'owner') searchParts.push(l.owner_name || '');
  const searchHay = esc(searchParts.join(' ')).toLowerCase();
  const status = isExpired(l) ? `<span class="badge expired">Abgelaufen</span>` : `<span class="badge active">Aktiv</span>`;
  return `
<tr data-search="${searchHay}">
  <td class="url-cell" data-label="Ziel-URL"><a href="${esc(l.target_url)}" target="_blank" rel="noopener" title="${esc(l.target_url)}">${esc(l.target_url)}</a></td>
  <td class="desc-cell" data-label="Beschreibung">${l.title ? esc(l.title) : '<span class="muted">–</span>'}</td>
  <td class="muted nowrap" data-label="Erstellt am">${fmtDate(l.created_at)}</td>
  ${extraColumn === 'visibility' ? `<td class="nowrap" data-label="Sichtbarkeit">${visibilityBadge(l)}</td>` : ''}
  <td class="nowrap" data-label="Status">${status}</td>
  ${extraColumn === 'owner' ? `<td class="cell-sub" data-label="Erstellt von" title="${esc(l.owner_name || '–')}">${esc(l.owner_name || '–')}</td>` : ''}
  <td class="nowrap short-cell" data-label="Short-Link">
    <button type="button" class="copy-icon-btn" data-copy="${esc(short)}" title="Link kopieren" aria-label="Link kopieren">${icon('copy', 'copy-icon')}</button>
    <a class="slug" href="${esc(short)}" target="_blank" rel="noopener" title="${esc(stripProto(short))}">${esc(stripProto(short))}</a>
  </td>
  <td class="num-cell" data-label="Klicks">${fmtNum(l.clicks_total)}</td>
  <td class="nowrap" data-label=""><a class="btn ghost" href="/app/links/${l.id}">Details</a></td>
</tr>`;
}

// error/errorField/values: only set on the direct re-render after a failed
// POST /app/links (see server.js) – lets the form keep what was typed and
// highlight the one field that failed, instead of losing everything to a
// redirect+flash. errorField null with error set (e.g. the generic "Link
// konnte nicht angelegt werden" DB fallback) falls back to a plain banner.
function dashboard({ links, shortUrl, domains, user, flash, error = null, errorField = null, values = {} }) {
  const v = { target_url: '', slug: '', title: '', domain: domains[0] || '', expires_at: '', visibility: 'privat', ...values };
  const body = `
<main>
<div class="page">
<h1>Neuen Kurzlink erstellen</h1>
<section class="card">
  ${error && !errorField ? `<div class="flash error">${esc(error)}</div>` : ''}
  <form method="post" action="/app/links" style="display:flex;flex-direction:column;gap:20px">
    <div class="grid-form">
      <div class="field">
        <label for="target">Ziel-URL</label>
        <!-- type="text" instead of type="url": browsers reject type="url"
             input without a scheme (e.g. "example.com") natively, before
             readLinkFields() in server.js can prepend "https://". -->
        <input id="target" name="target_url" type="text" placeholder="https://…" value="${esc(v.target_url)}"${fieldInvalidAttrs('target_url', errorField, 'target')} required>
        ${fieldErrorSpan('target_url', errorField, error, 'target')}
      </div>
      <div class="field">
        <label for="slug">Wunsch-Kürzel <span class="muted">(optional)</span></label>
        <input id="slug" name="slug" type="text" pattern="[A-Za-z0-9\\-_]{1,64}" placeholder="sommerfest…" value="${esc(v.slug)}"${fieldInvalidAttrs('slug', errorField, 'slug')} spellcheck="false">
        ${fieldErrorSpan('slug', errorField, error, 'slug')}
      </div>
    </div>
    <div class="grid-form">
      <div class="field grow">
        <label for="title">Beschreibung <span class="muted">(optional)</span></label>
        <input id="title" name="title" type="text" placeholder="interner Name…" value="${esc(v.title)}">
      </div>
    </div>
    <div class="grid-form">
      ${domainField(v.domain, domains)}
      <div class="field">
        <label for="expires_at">Läuft ab <span class="muted">(optional)</span></label>
        <input id="expires_at" name="expires_at" type="datetime-local" value="${esc(v.expires_at)}">
      </div>
    </div>
    <div class="radio-row divided">
      ${visibilityRadios(v.visibility)}
      <div class="create-actions">
        <button type="submit" id="create-btn" class="btn-create">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M7.5 1.5v12M1.5 7.5h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          Erstellen
        </button>
      </div>
    </div>
  </form>
</section>

<section>
  ${searchTable({
    links,
    theadHtml: `<th>Ziel-URL</th><th>Beschreibung</th><th>Erstellt am</th><th>Sichtbarkeit</th><th>Status</th><th>Short-Link</th><th>Klicks</th><th></th>`,
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
  <h1>Organisations-Tresor</h1>
</div>
${searchTable({
    links,
    theadHtml: `<th>Ziel-URL</th><th>Beschreibung</th><th>Erstellt am</th><th>Status</th><th>Erstellt von</th><th>Short-Link</th><th>Klicks</th><th></th>`,
    rowsHtml: links.map(l => linkTableRow(l, shortUrl(l), { extraColumn: 'owner' })).join(''),
    emptyText: 'Der Tresor ist leer. Stelle einen Link auf „Organisation", damit er hier für alle erscheint.',
  })}
</div>
</main>`;
  return layout({ title: 'Organisations-Tresor', body, user, page: 'vault' });
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
    theadHtml: `<th>Ziel-URL</th><th>Beschreibung</th><th>Erstellt am</th><th>Status</th><th>Short-Link</th><th>Klicks</th><th></th>`,
    rowsHtml: links.map(l => linkTableRow(l, shortUrl(l))).join(''),
    emptyText: 'Noch keine persönlichen Links. Lege unter „Erstellen" einen mit Sichtbarkeit „Persönlich" an.',
  })}
</div>
</main>`;
  return layout({ title: 'Persönlicher Tresor', body, user, page: 'myvault' });
}

// Path math for the clicks line chart (stats section of the detail page).
// Runs server-side for the initial render AND client-side when switching
// the time-range chips (app.js) – hence a pure function with no DOM access,
// so the logic ports 1:1 in both directions.
const CHART_W = 800, CHART_TOP = 15, CHART_BASE = 185;
function chartGeometry(values) {
  // max = the real highest value for the label (can be 0, e.g. a fresh link
  // with no clicks); denom = the same value but never 0 – pure division
  // safeguard for the bar-height calculation. The two must not be mixed up,
  // or the label would wrongly show "1" for actually 0 clicks.
  const max = Math.max(...values, 0);
  const denom = max || 1;
  const n = values.length;
  const points = values.map((v, i) => ({
    x: n > 1 ? (i / (n - 1)) * CHART_W : CHART_W / 2,
    y: CHART_BASE - (v / denom) * (CHART_BASE - CHART_TOP),
  }));
  const linePath = 'M' + points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L');
  const areaPath = `${linePath} L${CHART_W},${CHART_BASE} L0,${CHART_BASE} Z`;
  // floor instead of round: at max=1, round(0.5)=1 would show the same
  // number as the maximum (two "1"s at different heights) – floor
  // guarantees mid < max for every max >= 1.
  return { linePath, areaPath, points, max, mid: Math.floor(max / 2) };
}

// Invisible hover columns spanning the full chart height, one per data
// point (not just a small circle around the line – this way you can hover
// anywhere in the column, not only exactly on the point). Carries
// label/value/point position as data attributes; app.js reads them for its
// own styled tooltip (see #chart-tooltip in statsChart()).
function chartHoverBands(points, values, pointLabels) {
  const n = points.length;
  const spacing = n > 1 ? CHART_W / (n - 1) : CHART_W;
  return points.map((p, i) => {
    const left = Math.max(0, p.x - spacing / 2);
    const right = Math.min(CHART_W, p.x + spacing / 2);
    const label = pointLabels?.[i] ?? '';
    return `<rect class="chart-hover" x="${left.toFixed(1)}" y="0" width="${(right - left).toFixed(1)}" height="190" fill="transparent" data-label="${esc(label)}" data-value="${values[i]}" data-px="${p.x.toFixed(1)}" data-py="${p.y.toFixed(1)}"/>`;
  }).join('');
}

// Complete chart including the time-range chips. The server fully renders
// the "Monat" range (works without JS), the other three ranges travel along
// as a data attribute – app.js redraws on chip click via a chartGeometry
// equivalent, without a server request.
// Positions every axis label at its real data-point index (not evenly
// spaced) – otherwise e.g. a forced last label (uneven spacing from the
// second-to-last) would drift from the actual point.
function xLabelsHtml(labels, n) {
  return labels.map(({ i, text }) => {
    const pct = n > 1 ? (i / (n - 1)) * 100 : 50;
    return `<span style="left:${pct.toFixed(2)}%">${esc(text)}</span>`;
  }).join('');
}

function statsChart(total, ranges) {
  const initial = ranges.monat;
  const { linePath, areaPath, points, max, mid } = chartGeometry(initial.values);
  const rangesForJs = {};
  for (const [key, r] of Object.entries(ranges)) {
    rangesForJs[key] = { label: r.label, total: r.total, values: r.values, labels: r.labels, pointLabels: r.pointLabels };
  }
  return `
<div class="stat-header">
  <div class="stat-row">
    <h2 style="margin:0">Statistik</h2>
    <span class="num"><b id="stat-total-all">${fmtNum(total)}</b> <span>gesamt</span></span>
    <span class="num"><b id="stat-total-range">${fmtNum(initial.total)}</b> <span id="stat-range-label">${initial.label}</span></span>
  </div>
  <div class="range-group" id="stats-range-group" role="group" aria-label="Zeitraum" data-ranges="${esc(JSON.stringify(rangesForJs))}">
    <button type="button" class="range-btn" data-range="tag">Tag</button>
    <button type="button" class="range-btn" data-range="woche">Woche</button>
    <button type="button" class="range-btn active" data-range="monat">Monat</button>
    <button type="button" class="range-btn" data-range="jahr">Jahr</button>
    <button type="button" class="range-btn" data-range="gesamt">Gesamt</button>
  </div>
</div>
<div class="chart-wrap" id="stats-chart">
  <svg class="chart-svg" id="chart-svg" viewBox="0 0 ${CHART_W} 190" preserveAspectRatio="none" role="img" aria-label="Klicks im Zeitverlauf">
    <line x1="0" y1="${CHART_TOP}" x2="${CHART_W}" y2="${CHART_TOP}" class="chart-grid"/>
    <line x1="0" y1="100" x2="${CHART_W}" y2="100" class="chart-grid"/>
    <line x1="0" y1="${CHART_BASE}" x2="${CHART_W}" y2="${CHART_BASE}" class="chart-grid chart-grid-base"/>
    <path class="chart-area" id="chart-area" d="${areaPath}"/>
    <path class="chart-line" id="chart-line" d="${linePath}"/>
    <g id="chart-hover-group">${chartHoverBands(points, initial.values, initial.pointLabels)}</g>
  </svg>
  <span class="chart-label" id="chart-label-max" style="top:2px">${fmtNum(max)}</span>
  <span class="chart-label" id="chart-label-mid" style="top:88px">${fmtNum(mid)}</span>
  <div class="chart-hover-point" id="chart-hover-dot"></div>
  <div class="chart-tooltip" id="chart-tooltip">
    <div class="chart-tooltip-title" id="chart-tooltip-title"></div>
    <div class="chart-tooltip-row"><span class="chart-tooltip-dot"></span>Klicks<b id="chart-tooltip-value"></b></div>
  </div>
</div>
<div class="chart-x-labels" id="chart-x-labels">${xLabelsHtml(initial.labels, initial.values.length)}</div>`;
}

function splitBreakdownList(rows) {
  if (!rows.length) return `<p class="muted">Noch keine Daten.</p>`;
  const total = rows.reduce((a, r) => a + r.n, 0);
  return `<ul class="split">` + rows.map(r => {
    const pct = Math.round((r.n / total) * 100);
    const name = r.ref ?? r.device ?? r.browser ?? '–';
    return `<li>
      <div class="row"><span class="name">${esc(name || '–')}</span><span class="val">${pct} %</span></div>
      <div class="meter"><span style="width:${pct}%"></span></div>
    </li>`;
  }).join('') + `</ul>`;
}

// error/errorField/values: only set on the direct re-render after a failed
// POST .../update (see renderLinkDetail() in server.js) – same principle as
// dashboard() above. values, when present, overrides the DB-backed link
// fields with what was actually submitted (so a rejected edit isn't lost),
// and the data-utc attribute is deliberately skipped in that case – it's
// only meaningful for the real stored value, not a raw resubmitted string.
function linkDetail({ link, origin, short, domains, stats, expiresAtLocal, expired, user, flash, page = 'dashboard', canEditRestricted = true, canDelete = true, audit = [], error = null, errorField = null, values = null }) {
  const v = values || { target_url: link.target_url, title: link.title, domain: link.domain, expiresAtLocal };
  const body = `
<main>
<div class="page">
<nav class="crumbs"><a href="/app" data-back>← Zurück</a></nav>

<div class="detail-head">
  <h1>${esc(stripProto(origin))}<span class="accent">/${esc(link.slug)}</span></h1>
  <button type="button" class="copy-icon-btn" data-copy="${esc(short)}" title="Link kopieren" aria-label="Link kopieren">${icon('copy', 'copy-icon')}</button>
  ${visibilityBadge(link)}
  ${expired ? `<span class="badge expired">Abgelaufen</span>` : link.expires_at ? `<span class="muted">läuft ab ${fmtDate(link.expires_at)}</span>` : ''}
  <button type="submit" form="edit-form" style="margin-left:auto;padding:9px 36px">Speichern</button>
</div>

<div class="detail-grid">
<section class="qrbox">
  <img src="/app/links/${link.id}/qr.svg" alt="QR-Code für ${esc(short)}" width="220" height="220">
  <div class="dl">
    <a class="btn ghost" href="/app/links/${link.id}/qr.svg?download=1">SVG</a>
    <a class="btn ghost" href="/app/links/${link.id}/qr.png?size=1024&download=1">PNG</a>
  </div>
</section>

<div class="page">
<section class="card">
  <h2>Bearbeiten</h2>
  <form id="edit-form" method="post" action="/app/links/${link.id}/update" style="display:flex;flex-direction:column;gap:16px">
    <div>
      <label for="target">Ziel-URL</label>
      <!-- type="text" instead of type="url", see the comment at dashboard().
           readonly (not disabled) for non-owners on org links: the value
           still has to be submitted, otherwise server-side validation would
           fail even though no change was intended (see POST .../update). -->
      <input id="target" name="target_url" type="text" value="${esc(v.target_url)}"${fieldInvalidAttrs('target_url', errorField, 'target')} required${canEditRestricted ? '' : ' readonly'}>
      ${fieldErrorSpan('target_url', errorField, error, 'target')}
      ${canEditRestricted ? '' : '<span class="muted" style="font-size:12.5px">Nur Besitzer:in/Admin können die Ziel-URL ändern</span>'}
    </div>
    <div class="grid-form">
      <div class="field">
        <label for="title">Beschreibung <span class="muted">(optional)</span></label>
        <input id="title" name="title" type="text" value="${esc(v.title)}">
      </div>
      ${domainField(v.domain, domains)}
      <div class="field">
        <label for="expires_at">Läuft ab <span class="muted">(optional)</span></label>
        <input id="expires_at" name="expires_at" type="datetime-local" value="${esc(v.expiresAtLocal)}"${!values && link.expires_at ? ` data-utc="${esc(link.expires_at)}"` : ''}>
      </div>
    </div>
    <div class="radio-row divided">${visibilityRadios(link.visibility, !canEditRestricted)}</div>
  </form>
</section>

<section class="card">
  ${statsChart(stats.total, stats.ranges)}
  <div class="cols cols-3" style="gap:24px;margin-top:20px">
    <div><h3>Herkunft (Referrer)</h3>${splitBreakdownList(stats.referrers)}</div>
    <div><h3>Geräte</h3>${splitBreakdownList(stats.devices)}</div>
    <div><h3>Browser</h3>${splitBreakdownList(stats.browsers)}</div>
  </div>
  <h3 style="margin-top:20px">Letzte Klicks</h3>
  ${stats.recent.length ? `<div class="table-scroll" style="border-top:none"><table class="tbl">
    <thead><tr><th style="width:155px;white-space:nowrap">Zeitpunkt</th><th>Referrer</th><th>Gerät</th><th>Browser</th><th>Sprache</th></tr></thead>
    <tbody>${stats.recent.map(c => `<tr>
      <td class="cell-sub">${fmtDate(c.ts)}</td>
      <td>${esc(c.referrer || '(direkt / QR-Scan)')}</td>
      <td>${esc(c.device)}</td><td>${esc(c.browser)}</td><td>${esc(c.lang || '–')}</td>
    </tr>`).join('')}</tbody>
  </table></div>` : `<p class="muted">Noch keine Klicks.</p>`}
</section>

${audit.length ? `
<section class="card">
  <h2>Änderungsverlauf der Ziel-URL</h2>
  <div class="table-scroll" style="border-top:none"><table class="tbl">
    <thead><tr><th style="width:155px;white-space:nowrap">Zeitpunkt</th><th>Von</th><th>Alte URL</th><th>Neue URL</th></tr></thead>
    <tbody>${audit.map(a => `<tr>
      <td class="cell-sub">${fmtDate(a.ts)}</td>
      <td>${esc(a.username || '–')}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.old_url)}">${esc(a.old_url)}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.new_url)}">${esc(a.new_url)}</td>
    </tr>`).join('')}</tbody>
  </table></div>
</section>` : ''}

${canDelete ? `
<section class="card danger danger-confirm">
  <div class="copy"><b>Link löschen</b>
    <p>Zur Bestätigung bitte das Kürzel eintippen. Mit dem Löschen werden auch alle Klickdaten gelöscht, und bereits gedruckte QR-Codes laufen danach ins Leere.</p>
  </div>
  <form method="post" action="/app/links/${link.id}/delete" data-confirm="Diesen Link wirklich löschen?">
    <input type="text" data-confirm-slug="${esc(link.slug)}" placeholder="${esc(link.slug)} eintippen…" aria-label="Kürzel zur Bestätigung eingeben" autocomplete="off">
    <button class="destructive-ghost" type="submit">Löschen…</button>
  </form>
</section>` : ''}
</div>
</div>
</div>
</main>`;
  return layout({ title: `/${link.slug}`, body, user, flash, page });
}

// Only foreground/background color (no logo/shapes) – deliberately the
// first, simple step toward an "actually used" tool, see chat context.
function colorFields(dark, light, transparentBg) {
  // The native picker doesn't know alpha (6-digit hex only) – a value
  // resolved with transparency (#rrggbbaa) is truncated for display, the
  // full value only travels along hidden for the download (see dlFields).
  const lightSwatch = light.slice(0, 7);
  return `<div class="color-pills">
    <span class="label-inline">Farben:</span>
    <label>Vordergrund <input type="color" name="dark" value="${esc(dark)}"></label>
    <label>Hintergrund <input type="color" name="light" value="${esc(lightSwatch)}"></label>
    <label style="margin-left:12px"><input type="checkbox" name="light_transparent" value="1" ${transparentBg ? 'checked' : ''}> Hintergrund transparent</label>
  </div>`;
}

// Type selection as CSS-only tabs (hidden radio + label/span), so switching
// still works without JS: :has() on .qr-form decides which .qr-type-panel
// is visible (see style.css). The order/tab IDs here and the style.css
// selectors have to match up.
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

// All four panels are always rendered (only one visible), so switching
// doesn't lose values and every tab's form data arrives on submit – server.js
// only reads the active qr_type's data anyway. Fields grouped in
// .grid-form/.field like dashboard()/"Erstellen", even with just one field
// per row (see the description row there).
// url_value deliberately type="text" instead of type="url": browsers reject
// type="url" input without a scheme (e.g. "example.com") via native
// validation before server.js can even prepend "https://" (see
// buildQrTypeContent).
function qrTypePanels(v) {
  return `
  <div class="qr-type-panel" data-panel="url">
    <div class="grid-form">
      <div class="field grow">
        <label for="url_value">Ziel-URL</label>
        <input id="url_value" name="url_value" type="text" placeholder="https://…" value="${esc(v.url_value)}">
      </div>
    </div>
  </div>
  <div class="qr-type-panel" data-panel="text">
    <div class="grid-form">
      <div class="field grow">
        <label for="data">Inhalt</label>
        <textarea id="data" name="data" rows="3">${esc(v.data)}</textarea>
      </div>
    </div>
  </div>
  <div class="qr-type-panel" data-panel="wlan">
    <div class="grid-form">
      <div class="field"><label for="wlan_ssid">SSID</label><input id="wlan_ssid" name="wlan_ssid" type="text" value="${esc(v.wlan_ssid)}"></div>
      <div class="field"><label for="wlan_pass">Passwort</label><input id="wlan_pass" name="wlan_pass" type="text" value="${esc(v.wlan_pass)}"></div>
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
      <div class="field grow"><label for="epc_name">Begünstigter</label><input id="epc_name" name="epc_name" type="text" maxlength="70" value="${esc(v.epc_name)}"></div>
      <div class="field"><label for="epc_iban">IBAN</label><input id="epc_iban" name="epc_iban" type="text" placeholder="DE00…" spellcheck="false" value="${esc(v.epc_iban)}"></div>
    </div>
    <div class="grid-form">
      <div class="field"><label for="epc_bic">BIC <span class="muted">(optional)</span></label><input id="epc_bic" name="epc_bic" type="text" placeholder="nur außerhalb SEPA nötig" spellcheck="false" value="${esc(v.epc_bic)}"></div>
      <div class="field"><label for="epc_amount">Betrag (EUR) <span class="muted">(optional)</span></label><input id="epc_amount" name="epc_amount" type="number" step="0.01" min="0" value="${esc(v.epc_amount)}"></div>
      <div class="field grow"><label for="epc_purpose">Verwendungszweck <span class="muted">(optional)</span></label><input id="epc_purpose" name="epc_purpose" type="text" maxlength="140" value="${esc(v.epc_purpose)}"></div>
    </div>
  </div>`;
}

// Same basic layout as linkDetail() (.detail-grid + .qrbox on the left): QR
// preview on the left, form on the right as a card. Unlike there, the
// preview only appears after the first "Erzeugen" click – until then the
// qrbox shows placeholder text.
function staticQrPage({ content = '', ec = 'M', dark = '#000000', light = '#ffffff', transparentBg = false, svg = null, error = null, user, values = {} } = {}) {
  const v = {
    type: 'url', data: '', url_value: '', wlan_ssid: '', wlan_pass: '', wlan_enc: 'WPA',
    epc_name: '', epc_iban: '', epc_bic: '', epc_amount: '', epc_purpose: '',
    ...values,
  };
  // Hidden fields for the POST downloads: the already-resolved content
  // (not the individual tab fields) travels in the body, not the URL – so
  // it never ends up in history or access logs.
  const dlFields = `<input type="hidden" name="data" value="${esc(content)}"><input type="hidden" name="ec" value="${esc(ec)}"><input type="hidden" name="dark" value="${esc(dark)}"><input type="hidden" name="light" value="${esc(light)}">`;
  const body = `
<main>
<div class="page">
<div style="display:flex;flex-direction:column;gap:6px">
  <div class="detail-head">
    <h1>Statischer QR-Code Generator</h1>
    <button type="submit" form="qr-form" style="margin-left:auto;padding:9px 36px">Erzeugen</button>
  </div>
  <p class="muted" style="margin:0">Inhalt landet direkt im QR-Code — anders als bei „Erstellen" nicht mehr änderbar, ohne Statistik, ohne Speicherung.</p>
</div>

<div class="detail-grid">
<section class="qrbox">
  ${svg ? `
  <div${transparentBg ? ' class="qr-preview-checker"' : ''}>${svg}</div>
  <div class="dl">
    <form method="post" action="/app/qr/download">${dlFields}<input type="hidden" name="format" value="svg"><button class="btn ghost" type="submit">SVG</button></form>
    <form method="post" action="/app/qr/download">${dlFields}<input type="hidden" name="format" value="png"><button class="btn ghost" type="submit">PNG</button></form>
  </div>` : `<p class="muted" style="margin:0">Vorschau erscheint hier, sobald du „Erzeugen" klickst.</p>`}
</section>

<section class="card">
  ${error ? `<div class="flash error">${esc(error)}</div>` : ''}
  <form id="qr-form" method="post" action="/app/qr" class="qr-form" style="display:flex;flex-direction:column;gap:20px">
    ${qrTypeTabs(v.type)}
    ${qrTypePanels(v)}
    <div class="radio-row divided">
      ${colorFields(dark, light, transparentBg)}
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
  <td class="cell-sub" data-label="Anmeldename" title="${esc(u.username)}">${esc(u.username)}</td>
  <td data-label="Rolle"><span class="badge${u.role === 'admin' ? '' : ' muted'}">${u.role === 'admin' ? 'Admin' : 'Mitglied'}</span></td>
  <td class="muted nowrap" data-label="Erstellt am">${fmtDate(u.created_at)}</td>
  <td class="muted nowrap" data-label="Letzter Login am">${fmtDate(u.last_login_at)}</td>
  <td class="num-cell" data-label="Links">${fmtNum(u.links_count)}</td>
  <td class="nowrap" data-label="">
    ${u.id === currentUser.id
      ? `<button class="ghost" type="button" disabled title="Selbstlöschung blockiert">Löschen</button>`
      : `<form method="post" action="/app/users/${u.id}/delete" class="inline" data-delete-user="${u.id}" data-username="${esc(u.username)}">
           <button class="destructive-ghost" type="submit">Löschen</button></form>`}
  </td>
</tr>`;
}

// Zwei eigenständige Seiten (/app/users, /app/domains) unter einem gemeinsamen
// Titel – echte Links statt Client-Toggle, damit Zurück/Vorwärts und direkte
// URLs funktionieren.
function adminTabs(page) {
  const tabs = [
    ['users', '/app/users', 'Zugangsverwaltung'],
    ['domains', '/app/domains', 'Domainverwaltung'],
  ];
  return `<div class="tab-group" role="tablist" aria-label="Admin-Einstellungen">
    ${tabs.map(([key, href, label]) =>
      `<a class="tab-link${page === key ? ' active' : ''}" href="${href}"${page === key ? ' aria-current="page"' : ''}>${esc(label)}</a>`
    ).join('')}
  </div>`;
}

// error/errorField/values: only set on the direct re-render after a failed
// POST /app/users (see server.js) – same principle as dashboard() above.
// Password is deliberately never part of `values` – re-echoing a rejected
// password back into the form isn't worth the security/UX tradeoff.
function usersPage({ users, user, flash, error = null, errorField = null, values = {} }) {
  const v = { username: '', role: 'member', ...values };
  const body = `
<main>
<div class="page">
<h1>Admin-Einstellungen</h1>
${adminTabs('users')}

<section class="card">
  <h2>Account anlegen</h2>
  ${error && !errorField ? `<div class="flash error">${esc(error)}</div>` : ''}
  <form method="post" action="/app/users" class="grid-form">
    <div class="field">
      <label for="nu">Nutzername</label>
      <input id="nu" name="username" type="text" pattern="[A-Za-z0-9\\-_.]{2,32}" placeholder="clara" value="${esc(v.username)}"${fieldInvalidAttrs('username', errorField, 'nu')} spellcheck="false" required>
      ${fieldErrorSpan('username', errorField, error, 'nu')}
    </div>
    <div class="field">
      <label for="np">Startpasswort</label>
      <input id="np" name="password" type="text" minlength="8" placeholder="mind. 8 Zeichen"${fieldInvalidAttrs('password', errorField, 'np')} autocomplete="off" required>
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
  <h2>Alle Accounts</h2>
  ${searchTable({
    links: users,
    theadHtml: `<th>Anmeldename</th><th>Rolle</th><th>Erstellt am</th><th>Letzter Login am</th><th>Links</th><th></th>`,
    rowsHtml: users.map(u => userTableRow(u, user)).join(''),
    emptyText: 'Keine Accounts vorhanden.',
  })}
</section>
<dialog id="delete-user-dialog" class="confirm-dialog" data-users='${esc(JSON.stringify(users.map(u => ({ id: u.id, username: u.username }))))}' data-current-user="${user.id}">
  <h3>Account löschen</h3>
  <p class="confirm-dialog-text"></p>
  <div class="grid-form" style="margin-bottom:20px">
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

// Same table scaffold as the dashboard/vaults (searchTable() + .linktable),
// so app.js's search/pagination (generic via #links-search/.linktable)
// applies here too without any extra code.
// .cell-sub instead of .slug: .slug is always a real, clickable short link
// everywhere else in the app – here the domain name is just text, and
// .slug's styling would suggest clickability that doesn't exist. isDefault
// (only relevant with more than one domain) drives both the badge and
// whether "Als Standard setzen" is needed – with only one domain there's
// nothing for it to stand out from.
function domainTableRow(d, isDefault, showDefaultControl) {
  const searchHay = esc(stripProto(d.origin)).toLowerCase();
  return `
<tr data-search="${searchHay}">
  <td class="cell-sub" data-label="Domain" title="${esc(stripProto(d.origin))}">${esc(stripProto(d.origin))}${isDefault && showDefaultControl ? ' <span class="badge">Standard</span>' : ''}</td>
  <td class="muted nowrap" data-label="Hinzugefügt am">${fmtDate(d.created_at)}</td>
  <td class="num-cell" data-label="Links">${fmtNum(d.links_count)}</td>
  <td class="nowrap" data-label="">
    <div class="row-actions">
      <button type="button" class="btn ghost reach-test-btn" data-domain-id="${d.id}">Testen</button>
      ${!isDefault && showDefaultControl ? `<form method="post" action="/app/domains/${d.id}/set-default">
        <button class="btn ghost" type="submit">Als Standard setzen</button>
      </form>` : ''}
      <form method="post" action="/app/domains/${d.id}/delete" data-confirm-modal="${esc(`„${stripProto(d.origin)}" wird entfernt. Alle Links, die aktuell darüber laufen, werden automatisch auf eine andere konfigurierte Domain umgestellt — kein gedruckter QR-Code bricht dadurch, der Redirect selbst prüft die Domain ohnehin nicht. Diese Aktion lässt sich nicht rückgängig machen.`)}">
        <button class="destructive-ghost" type="submit">Entfernen</button>
      </form>
    </div>
  </td>
</tr>`;
}

// error/errorField/values: only set on the direct re-render after a failed
// POST /app/domains (see server.js) – same principle as dashboard() above.
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
      <!-- type="text" instead of type="url": browsers reject type="url"
           input without a scheme natively, before server.js can prepend
           "https://" (readLinkFields/POST /app/domains, see URI_SCHEME_RE). -->
      <input id="origin" name="origin" type="text" placeholder="example.com…" value="${esc(v.origin)}"${fieldInvalidAttrs('origin', errorField, 'origin')} spellcheck="false" required>
      ${fieldErrorSpan('origin', errorField, error, 'origin')}
    </div>
    <div class="field submit"><button type="submit">Hinzufügen</button></div>
  </form>
</section>

<section>
  ${searchTable({
    links: domains,
    theadHtml: `<th>Domain</th><th style="width:155px;white-space:nowrap">Hinzugefügt am</th><th style="width:50px;white-space:nowrap">Links</th><th style="width:450px"></th>`,
    rowsHtml: domains.map((d, i) => domainTableRow(d, i === 0, domains.length > 1)).join(''),
    emptyText: 'Keine Domain konfiguriert — Kurzlinks nutzen automatisch die Adresse, unter der die Seite aufgerufen wird.',
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
<section class="card" style="max-width:400px">
  <h2>Passwort ändern</h2>
  ${user.sso_subject ? `
  <p class="muted" style="line-height:1.55">Dieser Account ist über SSO angebunden — das Passwort wird bei deinem Identity Provider verwaltet, nicht in snar.</p>` : `
  <form id="password-form" method="post" action="/app/account/password" class="stack">
    <div><label for="cp">Aktuelles Passwort</label>
    <input id="cp" name="current" type="password" autocomplete="current-password" required></div>
    <div><label for="np2">Neues Passwort</label>
    <input id="np2" name="next" type="password" autocomplete="new-password" minlength="8" required></div>
    <div><label for="np3">Wiederholen</label>
    <input id="np3" name="next_repeat" type="password" autocomplete="new-password" minlength="8" required></div>
    <button type="submit">Passwort ändern</button>
  </form>
  <p class="muted" style="margin-top:15px;line-height:1.55">Nur gegen aktuelles Passwort möglich. Andere Geräte werden dabei abgemeldet — dieses bleibt angemeldet.</p>`}
</section>
<section class="card" style="max-width:400px">
  <h2>Sitzung</h2>
  <form method="post" action="/logout">
    <button type="submit" class="btn ghost">Abmelden</button>
  </form>
</section>
</div>
</main>`;
  return layout({ title: 'Konto', body, user, flash, page: 'account' });
}

module.exports = { loginPage, dashboard, vaultPage, myVaultPage, linkDetail, staticQrPage, usersPage, domainsPage, accountPage, isExpired, CSS_CONTENT };
