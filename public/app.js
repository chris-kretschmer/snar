// The only client-side JS; everything else is rendered server-side.

// Close a popover on an outside click or Escape. composedPath() instead of
// contains() survives DOM rebuilds inside the wrapper (e.g. the day grid).
function closeOnOutside(wrapper, close) {
  document.addEventListener('click', (e) => { if (!e.composedPath().includes(wrapper)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// Shared scaffold for custom dropdown/datetime: the real element moves into a
// wrapper and out of tab order; the trigger button takes over.
function wrapControl(el, wrapperClass) {
  const wrapper = document.createElement('div');
  wrapper.className = wrapperClass;
  el.insertAdjacentElement('beforebegin', wrapper);
  wrapper.appendChild(el);
  el.tabIndex = -1;
  el.setAttribute('aria-hidden', 'true'); // the visible trigger is the accessible control
  return wrapper;
}

// <label for> should focus the visible trigger, not the hidden original.
function reassignLabel(sourceEl, trigger) {
  if (!sourceEl.id) return;
  trigger.id = sourceEl.id + '-trigger';
  document.querySelector(`label[for="${sourceEl.id}"]`)?.setAttribute('for', trigger.id);
}

// Custom dropdown instead of the unstylable native <option> list. The real
// <select> stays hidden as source of truth (form value, no-JS fallback).
const CHEVRON_SVG = '<svg class="chevron-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.625 14.913q-.175-.063-.325-.213l-4.6-4.6q-.275-.275-.275-.7t.275-.7t.7-.275t.7.275l3.9 3.9l3.9-3.9q.275-.275.7-.275t.7.275t.275.7t-.275.7l-4.6 4.6q-.15.15-.325.213t-.375.062t-.375-.062"/></svg>';

document.querySelectorAll('select').forEach((select) => {
  const wrapper = wrapControl(select, 'custom-select');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  reassignLabel(select, trigger);

  const label = document.createElement('span');
  label.className = 'select-label';
  const syncLabel = () => { label.textContent = select.options[select.selectedIndex]?.textContent || ''; };
  trigger.appendChild(label);
  trigger.insertAdjacentHTML('beforeend', CHEVRON_SVG);
  wrapper.appendChild(trigger);

  const menu = document.createElement('div');
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');
  wrapper.appendChild(menu);

  // Rebuilds label + entries from the current options; needed for selects
  // whose options are set via JS after render (delete-account modal).
  function buildMenu() {
    syncLabel();
    menu.innerHTML = '';
    [...select.options].forEach((opt, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'custom-select-option' + (i === select.selectedIndex ? ' active' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === select.selectedIndex));
      item.textContent = opt.textContent;
      item.addEventListener('click', () => {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        menu.querySelectorAll('.custom-select-option').forEach((el) => { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); });
        item.classList.add('active');
        item.setAttribute('aria-selected', 'true');
        closeMenu();
      });
      menu.appendChild(item);
    });
  }
  buildMenu();
  select.addEventListener('options-changed', buildMenu);

  // Opens down or up, whichever has more room, and caps its height to the
  // available space (own scroll, see style.css). A fixed direction fails for
  // option counts only known at runtime. Measured against the viewport, since
  // a top-layer <dialog> doesn't scroll an overflowing menu.
  const MENU_MAX = 240, MENU_MARGIN = 12;
  function positionMenu() {
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - MENU_MARGIN;
    const spaceAbove = rect.top - MENU_MARGIN;
    const openDown = spaceBelow >= spaceAbove;
    menu.style.top = openDown ? 'calc(100% + 4px)' : 'auto';
    menu.style.bottom = openDown ? 'auto' : 'calc(100% + 4px)';
    menu.style.maxHeight = `${Math.max(80, Math.min(MENU_MAX, openDown ? spaceBelow : spaceAbove))}px`;
  }

  function closeMenu() { menu.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); }
  // No stopPropagation: the click must reach document so other open popovers close.
  trigger.addEventListener('click', () => {
    if (!menu.classList.contains('open')) positionMenu();
    const open = menu.classList.toggle('open');
    trigger.setAttribute('aria-expanded', String(open));
  });
  closeOnOutside(wrapper, closeMenu);
});

// Custom date/time picker (same principle as the dropdown): the real
// <input type="datetime-local"> stays hidden as source of truth.
const DT_MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const DT_WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DT_CALENDAR_SVG = '<svg class="dt-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 22q-.825 0-1.412-.587T3 20V6q0-.825.588-1.412T5 4h1V2h2v2h8V2h2v2h1q.825 0 1.413.588T21 6v14q0 .825-.587 1.413T19 22zm0-2h14V10H5zM5 8h14V6H5zm0 0V6zm7 6q-.425 0-.712-.288T11 13t.288-.712T12 12t.713.288T13 13t-.288.713T12 14m-4.712-.288Q7 13.426 7 13t.288-.712T8 12t.713.288T9 13t-.288.713T8 14t-.712-.288M16 14q-.425 0-.712-.288T15 13t.288-.712T16 12t.713.288T17 13t-.288.713T16 14m-4 4q-.425 0-.712-.288T11 17t.288-.712T12 16t.713.288T13 17t-.288.713T12 18m-4.712-.288Q7 17.426 7 17t.288-.712T8 16t.713.288T9 17t-.288.713T8 18t-.712-.288M16 18q-.425 0-.712-.288T15 17t.288-.712T16 16t.713.288T17 17t-.288.713T16 18"/></svg>';
// same thin line-chevrons as the pagination arrows (views.js)
const DT_PREV_SVG = '<svg class="navicon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14.5 5 9 12 14.5 19"/></svg>';
const DT_NEXT_SVG = '<svg class="navicon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9.5 5 15 12 9.5 19"/></svg>';
const dtPad = (n) => String(n).padStart(2, '0');

document.querySelectorAll('input[type="datetime-local"]').forEach((input) => {
  const wrapper = wrapControl(input, 'custom-datetime');

  // The browser's UTC offset (minutes) goes along as a hidden field so the
  // server converts exactly; without JS it falls back to its own timezone.
  const tzField = document.createElement('input');
  tzField.type = 'hidden';
  tzField.name = 'tz_offset';
  input.closest('form')?.appendChild(tzField);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger custom-datetime-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  reassignLabel(input, trigger);
  trigger.insertAdjacentHTML('beforeend', DT_CALENDAR_SVG);
  const label = document.createElement('span');
  label.className = 'dt-label';
  trigger.appendChild(label);
  wrapper.appendChild(trigger);

  const panel = document.createElement('div');
  panel.className = 'custom-datetime-panel';
  panel.setAttribute('role', 'dialog');
  panel.innerHTML = `
    <div class="dt-cal-header">
      <button type="button" class="pagination-arrow dt-prev" aria-label="Vorheriger Monat">${DT_PREV_SVG}</button>
      <span class="dt-cal-title"></span>
      <button type="button" class="pagination-arrow dt-next" aria-label="Nächster Monat">${DT_NEXT_SVG}</button>
    </div>
    <div class="dt-weekdays">${DT_WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="dt-days"></div>
    <div class="dt-time-row">
      <span class="dt-time-label">Uhrzeit</span>
      <div class="dt-time-inputs">
        <input type="number" class="dt-hour" min="0" max="23" aria-label="Stunde">
        <span class="dt-time-sep">:</span>
        <input type="number" class="dt-minute" min="0" max="59" aria-label="Minute">
      </div>
    </div>
    <div class="dt-panel-footer">
      <button type="button" class="btn ghost dt-clear-btn">Entfernen</button>
      <button type="button" class="btn dt-apply-btn">Übernehmen</button>
    </div>`;
  wrapper.appendChild(panel);

  const titleEl = panel.querySelector('.dt-cal-title');
  const daysEl = panel.querySelector('.dt-days');
  const hourInput = panel.querySelector('.dt-hour');
  const minuteInput = panel.querySelector('.dt-minute');

  let viewDate = new Date();
  let selectedDate = null; // { y, m (0-11), d } or null = no expiry date
  let hour = 23;
  let minute = 59;

  function parseValue() {
    // data-utc carries the stored UTC value; display in the browser's timezone
    // (the plain value is only the no-JS fallback in server local time).
    const utc = input.dataset.utc;
    if (utc) {
      const d = new Date(utc.replace(' ', 'T') + 'Z');
      selectedDate = { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
      hour = d.getHours(); minute = d.getMinutes();
      viewDate = new Date(selectedDate.y, selectedDate.m, 1);
      writeValue(); // sync value + tz_offset to the browser's local time
      return;
    }
    const v = input.value;
    if (v) {
      const [datePart, timePart] = v.split('T');
      const [y, m, d] = datePart.split('-').map(Number);
      const [hh, mm] = (timePart || '00:00').split(':').map(Number);
      selectedDate = { y, m: m - 1, d };
      hour = hh; minute = mm;
      viewDate = new Date(y, m - 1, 1);
      // No data-utc after a failed validation (re-rendered with browser-local
      // input): without this the resubmit has no tz_offset.
      tzField.value = String(new Date(y, m - 1, d, hh, mm).getTimezoneOffset());
    } else {
      selectedDate = null;
      hour = 23; minute = 59;
      viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    }
  }

  function syncLabel() {
    if (selectedDate) {
      label.textContent = `${dtPad(selectedDate.d)}.${dtPad(selectedDate.m + 1)}.${selectedDate.y}, ${dtPad(hour)}:${dtPad(minute)} Uhr`;
      trigger.classList.remove('dt-empty');
    } else {
      label.textContent = 'Kein Ablaufdatum';
      trigger.classList.add('dt-empty');
    }
  }

  function writeValue() {
    if (selectedDate) {
      input.value = `${selectedDate.y}-${dtPad(selectedDate.m + 1)}-${dtPad(selectedDate.d)}T${dtPad(hour)}:${dtPad(minute)}`;
      // Offset of the SELECTED moment (not "now"), because of daylight saving time
      tzField.value = String(new Date(selectedDate.y, selectedDate.m, selectedDate.d, hour, minute).getTimezoneOffset());
    } else {
      input.value = '';
      tzField.value = '';
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function renderCalendar() {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    titleEl.textContent = `${DT_MONTH_NAMES[month]} ${year}`;

    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const prevM = (month + 11) % 12, prevY = month === 0 ? year - 1 : year;
    const nextM = (month + 1) % 12, nextY = month === 11 ? year + 1 : year;
    const today = new Date();

    const cells = [];
    for (let i = 0; i < firstWeekday; i++) {
      cells.push({ d: daysInPrevMonth - firstWeekday + 1 + i, m: prevM, y: prevY, other: true });
    }
    for (let d = 1; d <= daysInMonth; d++) cells.push({ d, m: month, y: year, other: false });
    const remaining = (7 - (cells.length % 7)) % 7;
    for (let d = 1; d <= remaining; d++) cells.push({ d, m: nextM, y: nextY, other: true });

    daysEl.innerHTML = cells.map((c) => {
      const cls = ['dt-day'];
      if (c.other) cls.push('other-month');
      if (c.y === today.getFullYear() && c.m === today.getMonth() && c.d === today.getDate()) cls.push('today');
      if (selectedDate && c.y === selectedDate.y && c.m === selectedDate.m && c.d === selectedDate.d) cls.push('selected');
      return `<button type="button" class="${cls.join(' ')}" data-y="${c.y}" data-m="${c.m}" data-d="${c.d}">${c.d}</button>`;
    }).join('');
  }

  daysEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.dt-day');
    if (!btn) return;
    selectedDate = { y: Number(btn.dataset.y), m: Number(btn.dataset.m), d: Number(btn.dataset.d) };
    viewDate = new Date(selectedDate.y, selectedDate.m, 1);
    renderCalendar();
  });

  panel.querySelector('.dt-prev').addEventListener('click', () => {
    viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
    renderCalendar();
  });
  panel.querySelector('.dt-next').addEventListener('click', () => {
    viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
    renderCalendar();
  });

  hourInput.addEventListener('input', () => { hourInput.value = hourInput.value.replace(/[^0-9]/g, '').slice(0, 2); });
  minuteInput.addEventListener('input', () => { minuteInput.value = minuteInput.value.replace(/[^0-9]/g, '').slice(0, 2); });

  // The panel sits inside the form: Enter would submit it, so confirm the panel instead.
  [hourInput, minuteInput].forEach((field) => field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); panel.querySelector('.dt-apply-btn').click(); }
  }));

  panel.querySelector('.dt-apply-btn').addEventListener('click', () => {
    if (!selectedDate) {
      const t = new Date();
      selectedDate = { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
    }
    hour = Math.min(23, Math.max(0, Number(hourInput.value) || 0));
    minute = Math.min(59, Math.max(0, Number(minuteInput.value) || 0));
    writeValue();
    syncLabel();
    closePanel();
  });
  panel.querySelector('.dt-clear-btn').addEventListener('click', () => {
    selectedDate = null;
    writeValue();
    syncLabel();
    closePanel();
  });

  function openPanel() {
    renderCalendar();
    hourInput.value = dtPad(hour);
    minuteInput.value = dtPad(minute);
    panel.classList.remove('align-right');
    panel.classList.add('open');
    // Only measurable once shown: align right if it overflows the viewport.
    if (panel.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
      panel.classList.add('align-right');
    }
    trigger.setAttribute('aria-expanded', 'true');
  }
  function closePanel() {
    panel.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  }
  // No stopPropagation (see the custom dropdown above).
  trigger.addEventListener('click', () => {
    if (panel.classList.contains('open')) closePanel(); else openPanel();
  });
  closeOnOutside(wrapper, closePanel);

  parseValue();
  syncLabel();
});

const COPY_CHECK_SVG = '<svg class="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m10 13.6l5.9-5.9q.275-.275.7-.275t.7.275t.275.7t-.275.7l-6.6 6.6q-.3.3-.7.3t-.7-.3l-2.6-2.6q-.275-.275-.275-.7t.275-.7t.7-.275t.7.275z"/></svg>';

const copyAnnouncer = document.getElementById('copy-announcer');

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    // Icon-/Text-Tausch wird von Screenreadern nicht zuverlässig angesagt –
    // die Bestätigung läuft über diese Live-Region.
    if (copyAnnouncer) {
      copyAnnouncer.textContent = 'Link kopiert';
      setTimeout(() => { copyAnnouncer.textContent = ''; }, 1500);
    }
    // Original label is stored once (dataset): a second click within 1.5s
    // would otherwise capture "Kopiert" and restore that forever.
    const isIcon = btn.classList.contains('copy-icon-btn');
    if (btn.dataset.copyOrig === undefined) btn.dataset.copyOrig = isIcon ? btn.innerHTML : btn.textContent;
    if (btn.dataset.copyOrigTitle === undefined) btn.dataset.copyOrigTitle = btn.title;
    if (isIcon) { btn.innerHTML = COPY_CHECK_SVG; btn.title = 'Kopiert'; btn.classList.add('copied'); } else { btn.textContent = 'Kopiert ✓'; }
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      if (isIcon) { btn.innerHTML = btn.dataset.copyOrig; btn.title = btn.dataset.copyOrigTitle; btn.classList.remove('copied'); } else { btn.textContent = btn.dataset.copyOrig; }
    }, 1500);
  } catch {
    window.prompt('Zum Kopieren: Strg+C drücken', btn.dataset.copy);
  }
});

// Domain-Erreichbarkeits-Check: nur manuell per Klick, nie automatisch beim
// Laden – DNS/Reverse-Proxy einer neuen Domain sind oft noch nicht fertig
// (siehe check-reachability in server.js). Der Button zeigt das Ergebnis als
// Text + Farbe (nicht nur Farbe, WCAG) und bleibt klickbar zum erneuten
// Prüfen; das Ergebnis geht auch in die Live-Region der Kopier-Bestätigung.
document.querySelectorAll('.reach-test-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    btn.classList.remove('ok', 'fail');
    btn.disabled = true;
    btn.textContent = 'Wird geprüft…';
    try {
      const res = await fetch(`/app/domains/${btn.dataset.domainId}/check-reachability`, { method: 'POST' });
      const data = await res.json();
      const text = data.ok ? 'Erreichbar' : 'Nicht erreichbar';
      btn.textContent = text;
      btn.classList.toggle('ok', data.ok);
      btn.classList.toggle('fail', !data.ok);
      btn.title = (data.ok ? 'Zeigt auf diese snar-Instanz.' : (data.reason || 'Nicht erreichbar.')) + ' Erneut klicken zum erneuten Prüfen.';
      if (copyAnnouncer) copyAnnouncer.textContent = `${text}: ${btn.title}`;
    } catch {
      btn.textContent = 'Nicht erreichbar';
      btn.classList.add('fail');
      btn.title = 'Prüfung fehlgeschlagen (Netzwerkfehler im Browser). Erneut klicken zum erneuten Prüfen.';
      if (copyAnnouncer) copyAnnouncer.textContent = btn.title;
    } finally {
      btn.disabled = false;
    }
  });
});

// "← Zurück" breadcrumb: real browser history returns to the actual page of
// origin (e.g. personal/shared vault). Without JS or a same-origin referrer
// the href fallback applies.
//
// The detail page reloads itself for click paging and the custom date range,
// each a history entry of its own, so history.back() alone would step through
// them. Every entry keeps in history.state how many same-page entries lie
// before the page of origin; "Zurück" skips them with history.go(-(depth + 1)).
// Depth is derived from the previous page via sessionStorage keyed by
// path+query (document.referrer never carries the #fragment).
const backLinks = document.querySelectorAll('a[data-back]');
if (backLinks.length) {
  const pathQuery = (u) => u.pathname + u.search;
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem('snarBack:' + k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem('snarBack:' + k, JSON.stringify(v)); } catch { /* storage blocked: fall back to plain history.back() */ } },
  };
  let ref = null;
  try { ref = document.referrer ? new URL(document.referrer) : null; } catch { /* malformed referrer */ }
  const sameOrigin = !!ref && ref.origin === location.origin;

  // Nav highlight: the server derives it from the Referer, which on a reloaded
  // detail page is the page itself – so the first entry records the highlight
  // and later ones restore it.
  const navItems = () => [...document.querySelectorAll('a.navlink, a.bottom-nav-item, a.bottom-nav-create')];
  const activeNavHref = () => {
    const a = navItems().find((x) => x.classList.contains('active') || x.getAttribute('aria-current') === 'page');
    return a ? a.getAttribute('href') : null;
  };

  let entry = history.state && history.state.snarBack;
  if (!entry) {
    const prev = sameOrigin && ref.pathname === location.pathname ? store.get(pathQuery(ref)) : null;
    entry = prev
      ? { depth: prev.depth + 1, hasOrigin: prev.hasOrigin, nav: prev.nav }
      : { depth: 0, hasOrigin: sameOrigin, nav: activeNavHref() };
    try { history.replaceState({ ...(history.state || {}), snarBack: entry }, ''); } catch { /* ignore */ }
  }
  store.set(pathQuery(location), entry);

  if (entry.nav && entry.nav !== activeNavHref()) {
    navItems().forEach((item) => {
      const on = item.getAttribute('href') === entry.nav;
      if (!item.classList.contains('bottom-nav-create')) item.classList.toggle('active', on);
      if (on) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
  }

  backLinks.forEach((a) => {
    a.addEventListener('click', (e) => {
      // Modifier and middle clicks keep their normal new-tab meaning.
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (window.history.length > 1 && entry.hasOrigin) {
        e.preventDefault();
        history.go(-(entry.depth + 1));
      }
    });
  });
}

// Not inline onsubmit: the text would land in a JS string context, which HTML escaping doesn't secure.
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (!window.confirm(form.dataset.confirm)) e.preventDefault();
  });
});

// Custom confirm modal (native <dialog>, layout() in views.js) for
// data-confirm-modal forms. form.submit() (not requestSubmit()) deliberately
// bypasses the 'submit' event, otherwise this listener would catch itself.
const confirmDialog = document.getElementById('confirm-dialog');
if (confirmDialog) {
  const textEl = confirmDialog.querySelector('.confirm-dialog-text');
  let pendingForm = null;

  document.querySelectorAll('form[data-confirm-modal]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      pendingForm = form;
      textEl.textContent = form.dataset.confirmModal;
      confirmDialog.showModal();
    });
  });

  confirmDialog.querySelector('[data-dialog-confirm]').addEventListener('click', () => {
    confirmDialog.close();
    window.snarLeaving = true; // form.submit() skips the 'submit' event (see guardUnsavedChanges)
    pendingForm?.submit();
    pendingForm = null;
  });
  confirmDialog.querySelector('[data-dialog-cancel]').addEventListener('click', () => {
    pendingForm = null;
    confirmDialog.close();
  });
  // A click on the ::backdrop also closes it.
  confirmDialog.addEventListener('click', (e) => {
    if (e.target === confirmDialog) { pendingForm = null; confirmDialog.close(); }
  });
}

// "Weitere (n)" rows open a native <dialog> listing every entry
// (splitBreakdownList() in views.js); Esc, focus trap and focus return come from <dialog>.
document.querySelectorAll('[data-open-dialog]').forEach((btn) => {
  btn.addEventListener('click', () => document.getElementById(btn.dataset.openDialog)?.showModal());
});
document.querySelectorAll('dialog.dist-dialog').forEach((dialog) => {
  dialog.querySelector('[data-close-dialog]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
});

// Delete account: works without JS (the server hands the links to the acting
// admin, see server.js); with JS a modal asks who takes over instead.
// pendingForm.submit() bypasses 'submit', same as the confirm modal above.
const deleteUserDialog = document.getElementById('delete-user-dialog');
if (deleteUserDialog) {
  const textEl = deleteUserDialog.querySelector('.confirm-dialog-text');
  const select = document.getElementById('reassign-to');
  const allUsers = JSON.parse(deleteUserDialog.dataset.users);
  const currentUserId = Number(deleteUserDialog.dataset.currentUser);
  let pendingForm = null;

  document.querySelectorAll('form[data-delete-user]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      pendingForm = form;
      const targetId = Number(form.dataset.deleteUser);
      textEl.textContent = `„${form.dataset.username}“ wird endgültig gelöscht. Wähle, wer die persönlichen Links übernimmt. Kein gedruckter QR-Code läuft dadurch ins Leere. Diese Aktion lässt sich nicht rückgängig machen.`;
      select.replaceChildren(...allUsers
        .filter((u) => u.id !== targetId)
        .map((u) => {
          const opt = document.createElement('option');
          opt.value = String(u.id);
          opt.textContent = u.id === currentUserId ? `${u.username} (du)` : u.username;
          opt.selected = u.id === currentUserId;
          return opt;
        }));
      select.dispatchEvent(new Event('options-changed'));
      deleteUserDialog.showModal();
    });
  });

  deleteUserDialog.querySelector('[data-dialog-confirm]').addEventListener('click', () => {
    deleteUserDialog.close();
    if (pendingForm) {
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'reassign_to';
      hidden.value = select.value;
      pendingForm.appendChild(hidden);
      pendingForm.submit();
    }
    pendingForm = null;
  });
  deleteUserDialog.querySelector('[data-dialog-cancel]').addEventListener('click', () => {
    pendingForm = null;
    deleteUserDialog.close();
  });
  deleteUserDialog.addEventListener('click', (e) => {
    if (e.target === deleteUserDialog) { pendingForm = null; deleteUserDialog.close(); }
  });
}

// Enable delete only once the slug is typed exactly. The button is also disabled in
// the HTML, so without JS (or before this script ran) nothing can be deleted by accident.
document.querySelectorAll('[data-confirm-slug]').forEach((input) => {
  const btn = input.closest('form')?.querySelector('button[type=submit]');
  if (!btn) return;
  btn.disabled = true;
  input.addEventListener('input', () => {
    btn.disabled = input.value !== input.dataset.confirmSlug;
  });
});

// Mobile sidebar: below the breakpoint (style.css) it becomes an off-canvas
// overlay opened via "Mehr" in the bottom nav (admins get a direct "Admin"
// link instead, see bottomNav() in views.js). Nav link clicks need no handler:
// a full page load resets 'open'.
const menuToggle = document.getElementById('bottom-nav-more');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
if (sidebar) {
  // A closed sidebar is only moved off-screen and stays focusable; inert
  // removes it from tab order/AT tree while hidden. Outside the menuToggle
  // branch because admins have no toggle but still need it inert.
  const mobileNavQuery = window.matchMedia('(max-width: 760px)');
  const syncInert = () => { sidebar.inert = mobileNavQuery.matches && !sidebar.classList.contains('open'); };
  mobileNavQuery.addEventListener('change', () => {
    // Resized past the breakpoint with the overlay open: close it, else the
    // page stays scroll-locked behind the now permanent sidebar.
    if (!mobileNavQuery.matches) {
      sidebar.classList.remove('open');
      sidebarBackdrop?.classList.remove('open');
      document.body.classList.remove('sidebar-open-lock');
      menuToggle?.setAttribute('aria-expanded', 'false');
    }
    syncInert();
  });
  syncInert();

  if (menuToggle && sidebarBackdrop) {
    const closeSidebar = ({ restoreFocus = false } = {}) => {
      sidebar.classList.remove('open');
      sidebarBackdrop.classList.remove('open');
      document.body.classList.remove('sidebar-open-lock');
      menuToggle.setAttribute('aria-expanded', 'false');
      syncInert();
      if (restoreFocus) menuToggle.focus();
    };
    menuToggle.addEventListener('click', () => {
      const open = sidebar.classList.toggle('open');
      sidebarBackdrop.classList.toggle('open', open);
      document.body.classList.toggle('sidebar-open-lock', open);
      menuToggle.setAttribute('aria-expanded', String(open));
      syncInert();
      if (open) sidebar.querySelector('.account-trigger, .navlink')?.focus();
    });
    sidebarBackdrop.addEventListener('click', () => closeSidebar({ restoreFocus: true }));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) closeSidebar({ restoreFocus: true });
    });
  }
}

// Profile dropdown.
const accountToggle = document.getElementById('account-menu-toggle');
const accountMenu = document.getElementById('account-menu');
if (accountToggle && accountMenu) {
  const closeAccountMenu = () => {
    accountMenu.classList.remove('open');
    accountToggle.setAttribute('aria-expanded', 'false');
  };
  // No stopPropagation (see the custom dropdown above).
  accountToggle.addEventListener('click', () => {
    const open = accountMenu.classList.toggle('open');
    accountToggle.setAttribute('aria-expanded', String(open));
  });
  closeOnOutside(accountToggle.parentElement, closeAccountMenu);
}

// Link tables (dashboard, vaults, user & domain management): client-side
// search + pagination. linksSearch is optional: the domains list has no search
// box (showSearch:false, see searchTable() in views.js). render() is the only
// place that sets row.style.display, so search and pagination can't clobber
// each other.
const linksSearch = document.getElementById('links-search');
const linkRows = [...document.querySelectorAll('.linktable tbody tr')];
if (linkRows.length) {
  const pageSizeBtns = document.querySelectorAll('.page-size-btn');
  const prevBtn = document.getElementById('links-prev');
  const nextBtn = document.getElementById('links-next');
  const DEFAULT_PAGE_SIZE = Number(document.querySelector('.page-size-btn.active')?.dataset.pageSize) || 20;

  // Initial state from the URL (?q=&page=&size=) so reloads and shared links
  // land on the same view; synced via replaceState() (a history entry per
  // keystroke would make the back button useless).
  const initialParams = new URLSearchParams(location.search);
  let pageSize = Number(initialParams.get('size'));
  if (![10, 20, 50].includes(pageSize)) pageSize = DEFAULT_PAGE_SIZE;
  let page = Math.max(1, parseInt(initialParams.get('page'), 10) || 1);
  const initialQ = initialParams.get('q') || '';
  if (linksSearch && initialQ) linksSearch.value = initialQ;
  pageSizeBtns.forEach((b) => b.classList.toggle('active', Number(b.dataset.pageSize) === pageSize));

  function syncUrl() {
    const params = new URLSearchParams(location.search);
    const q = linksSearch ? linksSearch.value.trim() : '';
    q ? params.set('q', q) : params.delete('q');
    page > 1 ? params.set('page', String(page)) : params.delete('page');
    pageSize !== DEFAULT_PAGE_SIZE ? params.set('size', String(pageSize)) : params.delete('size');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
  }

  function render() {
    const q = linksSearch ? linksSearch.value.trim().toLowerCase() : '';
    const matches = linkRows.filter((row) => (row.dataset.search || '').includes(q));
    const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
    page = Math.min(page, totalPages);
    linkRows.forEach((row) => { row.style.display = 'none'; });
    matches.forEach((row, i) => {
      if (Math.floor(i / pageSize) === page - 1) row.style.display = '';
    });
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= totalPages;
    syncUrl();
  }

  linksSearch?.addEventListener('input', () => { page = 1; render(); });
  pageSizeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      pageSize = Number(btn.dataset.pageSize);
      page = 1;
      pageSizeBtns.forEach((b) => b.classList.toggle('active', b === btn));
      render();
    });
  });
  prevBtn?.addEventListener('click', () => { if (page > 1) { page--; render(); } });
  nextBtn?.addEventListener('click', () => { page++; render(); });

  render();
}

// "Erstellen" button: usable without JS (target URL has `required`); with JS
// disabled until a target URL is entered, reason in the title.
const createBtn = document.getElementById('create-btn');
const targetInput = document.getElementById('target');
if (createBtn && targetInput) {
  const syncCreateState = () => {
    const empty = targetInput.value.trim() === '';
    createBtn.disabled = empty;
    createBtn.title = empty ? 'Bitte zuerst eine Ziel-URL eingeben' : 'Kurzlink erstellen';
  };
  targetInput.addEventListener('input', syncCreateState);
  syncCreateState();
}

// Stats range chips: redraw the chart client-side (all ranges arrive with the
// page, data-ranges). Path math and markup come from public/chart-shared.js,
// which the server also uses for the initial chart (views.js), so both match.
const rangeGroup = document.getElementById('stats-range-group');
if (rangeGroup) {
  const Chart = window.SnarChart;
  const ranges = JSON.parse(rangeGroup.dataset.ranges);
  const fmt = new Intl.NumberFormat('de-DE').format;
  const chartWrap = document.getElementById('stats-chart');
  const areaPath = document.getElementById('chart-area');
  const linePath = document.getElementById('chart-line');
  const partialLinePath = document.getElementById('chart-line-partial');
  const hoverGroup = document.getElementById('chart-hover-group');
  const chartSvg = document.getElementById('chart-svg');
  const gridGroup = document.getElementById('chart-grid');
  const yLabels = document.getElementById('chart-y-labels');
  const xLabels = document.getElementById('chart-x-labels');

  // <details> doesn't close on an outside click; give the custom-range panel
  // the same closeOnOutside() behavior as the other popovers.
  const rangeCustomDetails = rangeGroup.querySelector('.range-custom-details');
  if (rangeCustomDetails) {
    closeOnOutside(rangeCustomDetails, () => { rangeCustomDetails.open = false; });
  }

  function renderRange(key) {
    const r = ranges[key];
    const g = Chart.chartGeometry(r.values, r.partialLast);
    areaPath.setAttribute('d', g.areaPath);
    linePath.setAttribute('d', g.linePath);
    partialLinePath.setAttribute('d', g.partialPath);
    const grid = Chart.gridHtml(g.ticks, fmt);
    gridGroup.innerHTML = grid.lines;
    yLabels.innerHTML = grid.labels;
    const axisW = `${Chart.axisWidthPx(g.ticks.map((t) => fmt(t.value)))}px`;
    chartWrap.style.setProperty('--axis-w', axisW);
    xLabels.style.setProperty('--axis-w', axisW);
    chartSvg.setAttribute('aria-label', Chart.chartSummary(r.label, r.total, r.values, r.pointLabels, fmt));
    xLabels.innerHTML = Chart.xLabelsHtml(r.labels, r.values.length);
    // The tooltip uses event delegation (below), so rebuilding the bands is safe.
    hoverGroup.innerHTML = Chart.hoverBandsHtml(g.points, r.values, r.pointLabels);
  }

  // Custom tooltip instead of native <title>: follows the exact curve point
  // (SVG -> screen via getScreenCTM, correct under preserveAspectRatio="none").
  const tooltip = document.getElementById('chart-tooltip');
  const tooltipTitle = document.getElementById('chart-tooltip-title');
  const tooltipValue = document.getElementById('chart-tooltip-value');
  const hoverDot = document.getElementById('chart-hover-dot');

  function showTooltip(hoverRect) {
    const px = Number(hoverRect.dataset.px), py = Number(hoverRect.dataset.py);
    // The hover dot is an HTML element, not an SVG <circle>: preserveAspectRatio="none"
    // scales x/y differently and would turn a circle into an ellipse.
    const screenPt = new DOMPoint(px, py).matrixTransform(chartSvg.getScreenCTM());
    const wrapRect = chartWrap.getBoundingClientRect();
    const left = screenPt.x - wrapRect.left, top = screenPt.y - wrapRect.top;
    hoverDot.style.left = `${left}px`;
    hoverDot.style.top = `${top}px`;
    hoverDot.classList.add('visible');
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltipTitle.textContent = hoverRect.dataset.label;
    tooltipValue.textContent = hoverRect.dataset.value;
    tooltip.classList.add('visible');
  }
  function hideTooltip() { tooltip.classList.remove('visible'); hoverDot.classList.remove('visible'); }

  // Keyboard access: the chart is focusable, arrow keys walk through the points
  // (same tooltip as on hover) and a live region announces the value.
  chartWrap.tabIndex = 0;
  chartWrap.setAttribute('role', 'group');
  chartWrap.setAttribute('aria-label', 'Klickverlauf: mit Pfeiltasten einzelne Werte durchgehen');
  const chartAnnouncer = document.createElement('span');
  chartAnnouncer.className = 'sr-only';
  chartAnnouncer.setAttribute('aria-live', 'polite');
  chartWrap.appendChild(chartAnnouncer);
  let activePoint = -1;
  function stepPoint(next) {
    const bands = hoverGroup.querySelectorAll('.chart-hover');
    if (!bands.length) return;
    activePoint = Math.max(0, Math.min(bands.length - 1, next));
    const band = bands[activePoint];
    showTooltip(band);
    chartAnnouncer.textContent = `${band.dataset.label}: ${band.dataset.value} ${band.dataset.value === '1' ? 'Klick' : 'Klicks'}`;
  }
  chartWrap.addEventListener('keydown', (e) => {
    const count = hoverGroup.querySelectorAll('.chart-hover').length;
    const last = count - 1;
    if (e.key === 'ArrowRight') stepPoint(activePoint < 0 ? last : activePoint + 1);
    else if (e.key === 'ArrowLeft') stepPoint(activePoint < 0 ? last : activePoint - 1);
    else if (e.key === 'Home') stepPoint(0);
    else if (e.key === 'End') stepPoint(last);
    else if (e.key === 'Escape') { activePoint = -1; hideTooltip(); return; }
    else return;
    e.preventDefault();
  });
  chartWrap.addEventListener('blur', () => { activePoint = -1; hideTooltip(); });

  hoverGroup.addEventListener('mousemove', (e) => {
    const hoverRect = e.target.closest('.chart-hover');
    if (hoverRect) showTooltip(hoverRect); else hideTooltip();
  });
  hoverGroup.addEventListener('mouseleave', hideTooltip);

  rangeGroup.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      // The custom-range trigger (a <summary>, statsChart() in views.js) only
      // has data-range once a range was picked; before that it just opens the
      // <details> and must not touch the chart or the chips.
      if (!btn.dataset.range || !(btn.dataset.range in ranges)) return;
      rangeGroup.querySelectorAll('.range-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
        if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', String(b === btn));
      });
      renderRange(btn.dataset.range);
      activePoint = -1;
      hideTooltip(); // positions still belong to the old range until the mouse moves again
    });
  });
}

// Admin page "Darstellung": live preview of the accent colour on the whole page.
// Nothing is saved until the form is submitted; the save button stays disabled
// while the contrast on white is below the minimum (server checks it again).
const designForm = document.getElementById('design-form');
if (designForm && window.SnarTheme) {
  const Theme = window.SnarTheme;
  const colorInput = document.getElementById('accent');
  const contrastInfo = document.getElementById('accent-contrast');
  const saveBtn = designForm.querySelector('button[type=submit]:not([name=reset])');
  const minContrast = Number(designForm.dataset.minContrast);
  const fmtRatio = (r) => r.toFixed(1).replace('.', ',');
  const updatePreview = () => {
    const color = Theme.normalizeHex(colorInput.value);
    if (!color) return;
    document.documentElement.style.setProperty('--accent', color);
    const ratio = Theme.contrastOnWhite(color);
    const ok = ratio >= minContrast;
    contrastInfo.textContent = `Kontrast auf Weiß: ${fmtRatio(ratio)}:1` + (ok ? '' : ` (zu gering, mindestens ${fmtRatio(minContrast)}:1)`);
    saveBtn.disabled = !ok;
  };
  colorInput.addEventListener('input', updatePreview);
  updatePreview();
}

// Admin page "Darstellung": live name preview in the sidebar and on the page.
const brandNameInput = document.getElementById('brand-name');
if (brandNameInput && window.SnarTheme) {
  const Theme = window.SnarTheme;
  brandNameInput.addEventListener('input', () => {
    const text = Theme.normalizeName(brandNameInput.value) || Theme.DEFAULT_NAME;
    document.querySelectorAll('[data-brand-name]').forEach((el) => { el.textContent = text; });
  });
}
// Focus a validation error on load: the specific invalid field if any, else
// the generic .flash.error banner (login, QR generator, flashRedirect toast).
const invalidField = document.querySelector('input.invalid, textarea.invalid');
if (invalidField) {
  invalidField.focus();
} else {
  const errorFlash = document.querySelector('.flash.error');
  if (errorFlash) {
    errorFlash.setAttribute('tabindex', '-1');
    errorFlash.focus();
  }
}

// Warn before leaving a form with unsaved changes (link edit + password
// change): compares serialized state at load vs. unload; `submitting` avoids
// warning on the form's own submit.
//
// snarLeaving covers leaving on purpose via another POST form (delete, logout …),
// set by the document listener below and by the confirm-modal path
// (form.submit()). GET forms (custom date range) are excluded on purpose:
// they'd drop unsaved edits unintentionally.
window.snarLeaving = false;
document.addEventListener('submit', (e) => {
  if (!e.defaultPrevented && e.target.method === 'post') window.snarLeaving = true;
});
function guardUnsavedChanges(form) {
  if (!form) return;
  const snapshot = () => new URLSearchParams(new FormData(form)).toString();
  const initial = snapshot();
  let submitting = false;
  form.addEventListener('submit', () => { submitting = true; });
  window.addEventListener('beforeunload', (e) => {
    if (submitting || window.snarLeaving || snapshot() === initial) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
guardUnsavedChanges(document.getElementById('edit-form'));
guardUnsavedChanges(document.getElementById('password-form'));

// Update box (admins, views.js): can be dismissed per version; a newer release brings it back.
const updateBox = document.getElementById('update-box');
if (updateBox) {
  const storageKey = 'snar-update-dismissed';
  let dismissed = null;
  try { dismissed = localStorage.getItem(storageKey); } catch { /* storage blocked: box just stays */ }
  if (dismissed === updateBox.dataset.version) updateBox.hidden = true;
  updateBox.querySelector('.update-close').addEventListener('click', () => {
    updateBox.hidden = true;
    try { localStorage.setItem(storageKey, updateBox.dataset.version); } catch { /* ignore */ }
  });
}

// Destructive buttons ship disabled (views.js) and are enabled only now, after the
// confirmation handlers above are attached: without JS, or on a slow connection,
// nothing can be deleted before the confirmation dialog exists.
document.querySelectorAll('[data-needs-js]').forEach((btn) => { btn.disabled = false; });
