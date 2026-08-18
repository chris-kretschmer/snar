// The only client-side JS: custom dropdown & datepicker, copy buttons,
// delete confirmation, search/pagination, nav accordion, profile menu,
// stats chart time ranges. Everything else is rendered server-side.

// Close a popover on a click outside the wrapper, or on Escape.
// composedPath() instead of contains(): survives DOM rebuilds inside the
// wrapper (e.g. the datepicker's freshly rebuilt day grid).
function closeOnOutside(wrapper, close) {
  document.addEventListener('click', (e) => { if (!e.composedPath().includes(wrapper)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// Shared wrapper scaffold for the custom dropdown and custom datetime: the
// real form element gets moved into a wrapper <div> and taken out of tab
// order, the trigger button takes over both.
function wrapControl(el, wrapperClass) {
  const wrapper = document.createElement('div');
  wrapper.className = wrapperClass;
  el.insertAdjacentElement('beforebegin', wrapper);
  wrapper.appendChild(el);
  el.tabIndex = -1;
  return wrapper;
}

// <label for="…"> should focus the visible trigger, not the now-hidden
// original (buttons are "labelable").
function reassignLabel(sourceEl, trigger) {
  if (!sourceEl.id) return;
  trigger.id = sourceEl.id + '-trigger';
  document.querySelector(`label[for="${sourceEl.id}"]`)?.setAttribute('for', trigger.id);
}

// Custom dropdown menu in the app's own style instead of the native
// <option> list, which can't be styled consistently across browsers. The
// real <select> stays invisible in the DOM as the source of truth (form
// value, no-JS fallback – display:none selects still get submitted).
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
  const syncLabel = () => { label.textContent = select.options[select.selectedIndex]?.textContent || ''; };
  trigger.appendChild(label);
  trigger.insertAdjacentHTML('beforeend', CHEVRON_SVG);
  wrapper.appendChild(trigger);

  const menu = document.createElement('div');
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');
  wrapper.appendChild(menu);

  // Rebuilds the label + menu entries from the current options state –
  // needed for selects whose options only get set via JS after the initial
  // render (e.g. "Links übertragen an" in the delete-account modal), which
  // would otherwise stay empty forever: the real <select> is made
  // invisible/inert above, only this menu, built here, is ever visible.
  function buildMenu() {
    syncLabel();
    menu.innerHTML = '';
    [...select.options].forEach((opt, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'custom-select-option' + (i === select.selectedIndex ? ' active' : '');
      item.textContent = opt.textContent;
      item.addEventListener('click', () => {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        menu.querySelectorAll('.custom-select-option').forEach((el) => el.classList.remove('active'));
        item.classList.add('active');
        closeMenu();
      });
      menu.appendChild(item);
    });
  }
  buildMenu();
  select.addEventListener('options-changed', buildMenu);

  // Opens downward or upward, whichever has more room, and caps its own
  // height to the actually available space (with its own scroll, see
  // .custom-select-menu in style.css). Needed for selects with a variable
  // option count only known at runtime (e.g. "Links übertragen an" in the
  // delete-account modal): a fixed direction isn't enough there – with few
  // options, "down" overflows a small modal, with many options "up"
  // overflows just as much. Measured against the viewport (not the
  // dialog), because a <dialog> in the top layer doesn't bring the
  // overflowing menu area into its own scroll.
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
  // No stopPropagation: the click should keep bubbling up to document so
  // other open popovers (datepicker, profile menu) can close. This
  // element's own outside-click listener recognizes the trigger via
  // wrapper.contains().
  trigger.addEventListener('click', () => {
    if (!menu.classList.contains('open')) positionMenu();
    const open = menu.classList.toggle('open');
    trigger.setAttribute('aria-expanded', String(open));
  });
  closeOnOutside(wrapper, closeMenu);
});

// Custom date/time picker (same principle as the custom dropdown above):
// the real <input type="datetime-local"> stays invisible in the DOM as the
// source of truth; native picker popups can't be styled consistently in
// the app's design across browsers.
const DT_MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const DT_WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DT_CALENDAR_SVG = '<svg class="dt-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 22q-.825 0-1.412-.587T3 20V6q0-.825.588-1.412T5 4h1V2h2v2h8V2h2v2h1q.825 0 1.413.588T21 6v14q0 .825-.587 1.413T19 22zm0-2h14V10H5zM5 8h14V6H5zm0 0V6zm7 6q-.425 0-.712-.288T11 13t.288-.712T12 12t.713.288T13 13t-.288.713T12 14m-4.712-.288Q7 13.426 7 13t.288-.712T8 12t.713.288T9 13t-.288.713T8 14t-.712-.288M16 14q-.425 0-.712-.288T15 13t.288-.712T16 12t.713.288T17 13t-.288.713T16 14m-4 4q-.425 0-.712-.288T11 17t.288-.712T12 16t.713.288T13 17t-.288.713T12 18m-4.712-.288Q7 17.426 7 17t.288-.712T8 16t.713.288T9 17t-.288.713T8 18t-.712-.288M16 18q-.425 0-.712-.288T15 17t.288-.712T16 16t.713.288T17 17t-.288.713T16 18"/></svg>';
// same thin line-chevrons as the pagination arrows (views.js)
const DT_PREV_SVG = '<svg class="navicon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14.5 5 9 12 14.5 19"/></svg>';
const DT_NEXT_SVG = '<svg class="navicon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9.5 5 15 12 9.5 19"/></svg>';
const dtPad = (n) => String(n).padStart(2, '0');

document.querySelectorAll('input[type="datetime-local"]').forEach((input) => {
  const wrapper = wrapControl(input, 'custom-datetime');

  // Timezone correction: the browser's UTC offset (minutes) is sent along
  // as a hidden field, so the server converts the input to UTC exactly.
  // Without JS, the field is missing and the server falls back to its own
  // timezone as an approximation.
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
        <input type="number" class="dt-hour" min="0" max="23">
        <span class="dt-time-sep">:</span>
        <input type="number" class="dt-minute" min="0" max="59">
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
    // The server sends the stored UTC value along as data-utc – derive the
    // display in the browser's timezone from that (the value itself is
    // just the no-JS fallback in server local time).
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
    // Only measurable after showing it: if the panel overflows the
    // viewport on the right (narrow field near the right edge), align it right.
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

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    if (btn.classList.contains('copy-icon-btn')) {
      const oldHtml = btn.innerHTML;
      const oldTitle = btn.title;
      btn.innerHTML = COPY_CHECK_SVG;
      btn.title = 'Kopiert';
      setTimeout(() => { btn.innerHTML = oldHtml; btn.title = oldTitle; }, 1500);
    } else {
      const old = btn.textContent;
      btn.textContent = 'Kopiert ✓';
      setTimeout(() => { btn.textContent = old; }, 1500);
    }
  } catch {
    window.prompt('Zum Kopieren: Strg+C drücken', btn.dataset.copy);
  }
});

// "← Zurück" breadcrumb: uses real browser history to return to the actual
// page of origin (e.g. personal/shared vault), instead of always landing
// on one fixed page. Without JS, or without a matching referrer (page
// opened directly via URL, linked from outside), the href fallback applies.
document.querySelectorAll('a[data-back]').forEach((a) => {
  a.addEventListener('click', (e) => {
    if (window.history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) {
      e.preventDefault();
      history.back();
    }
  });
});

// Confirmation dialog before submitting (instead of inline onsubmit: there,
// the text would land in a JS string context, which HTML escaping doesn't secure).
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (!window.confirm(form.dataset.confirm)) e.preventDefault();
  });
});

// Custom confirmation modal (native <dialog>, see layout() in views.js)
// instead of window.confirm() – for forms with data-confirm-modal instead
// of data-confirm, when the text needs more explanation than a browser
// popup allows. form.submit() (not requestSubmit()) on confirm
// deliberately bypasses the 'submit' event, otherwise this same listener
// would catch itself again.
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
    pendingForm?.submit();
    pendingForm = null;
  });
  confirmDialog.querySelector('[data-dialog-cancel]').addEventListener('click', () => {
    pendingForm = null;
    confirmDialog.close();
  });
  // A click on the ::backdrop (outside the dialog content) also closes it.
  confirmDialog.addEventListener('click', (e) => {
    if (e.target === confirmDialog) { pendingForm = null; confirmDialog.close(); }
  });
}

// Delete account (user management): the form stays fully usable without JS
// (the server then transfers the links automatically to the admin
// performing the action, see the fallback in server.js) – with JS, a modal
// additionally asks who should take over the personal links instead.
// pendingForm.submit() (not requestSubmit()) on confirm deliberately
// bypasses the 'submit' event, same principle as the confirmation modal above.
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
      textEl.textContent = `„${form.dataset.username}" wird endgültig gelöscht. Wähle, wer die persönlichen Links übernimmt — kein gedruckter QR-Code läuft dadurch ins Leere. Diese Aktion lässt sich nicht rückgängig machen.`;
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

// Only enable the delete button once the slug has been typed exactly.
// The button is deliberately NOT disabled in the HTML, so deleting still
// works without JavaScript (then only the form's confirm() dialog applies).
document.querySelectorAll('[data-confirm-slug]').forEach((input) => {
  const btn = input.closest('form')?.querySelector('button[type=submit]');
  if (!btn) return;
  btn.disabled = true;
  input.addEventListener('input', () => {
    btn.disabled = input.value !== input.dataset.confirmSlug;
  });
});

// Nav accordion (e.g. "Admin-Einstellungen"): expand/collapse on click.
document.querySelectorAll('.nav-accordion > .accordion-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const group = btn.parentElement;
    const open = group.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });
});

// Profile dropdown: open/close via the trigger, close on a click outside
// it or on a menu item.
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

// Link tables (dashboard, personal & org vault, user & domain management):
// search + page size/prev-next, both client-side, no server request.
// Pagination also works without a visible search box (e.g. the domains
// list with showSearch:false, see searchTable() in views.js) – linksSearch
// is therefore optional, not a prerequisite for the whole block. A single
// shared render() function is the only place that sets row.style.display,
// so search and pagination can't clobber each other.
const linksSearch = document.getElementById('links-search');
const linkRows = [...document.querySelectorAll('.linktable tbody tr')];
if (linkRows.length) {
  const pageSizeBtns = document.querySelectorAll('.page-size-btn');
  const prevBtn = document.getElementById('links-prev');
  const nextBtn = document.getElementById('links-next');
  let pageSize = Number(document.querySelector('.page-size-btn.active')?.dataset.pageSize) || 20;
  let page = 1;

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

// "Erstellen" button: stays fully usable without JS (target-URL already
// has `required`), but is additionally disabled via JS until a target URL
// has been entered, with a hint text next to it.
const createBtn = document.getElementById('create-btn');
const createHint = document.getElementById('create-hint');
const targetInput = document.getElementById('target');
if (createBtn && targetInput) {
  const syncCreateState = () => {
    const empty = targetInput.value.trim() === '';
    createBtn.disabled = empty;
    createBtn.title = empty ? 'Bitte zuerst eine Ziel-URL eingeben' : 'Kurzlink erstellen';
    // display:none by default via CSS – without JS the hint never appears at all
    if (createHint) createHint.style.display = empty ? 'inline' : 'none';
  };
  targetInput.addEventListener('input', syncCreateState);
  syncCreateState();
}

// Stats time-range chips (detail page): redraws the clicks chart on
// switching, without a server request – the values for all four ranges
// already arrive on the first page load (data-ranges). The path math
// matches chartGeometry() in views.js 1:1 (used there for the no-JS render).
const rangeGroup = document.getElementById('stats-range-group');
if (rangeGroup) {
  const ranges = JSON.parse(rangeGroup.dataset.ranges);
  const CHART_W = 800, CHART_TOP = 15, CHART_BASE = 185;
  const areaPath = document.getElementById('chart-area');
  const linePath = document.getElementById('chart-line');
  const hoverGroup = document.getElementById('chart-hover-group');
  const labelMax = document.getElementById('chart-label-max');
  const labelMid = document.getElementById('chart-label-mid');
  const xLabels = document.getElementById('chart-x-labels');
  const totalRange = document.getElementById('stat-total-range');
  const rangeLabel = document.getElementById('stat-range-label');

  function renderRange(key) {
    const r = ranges[key];
    // max = the real highest value for the label (can be 0), denom = pure
    // division safeguard – see chartGeometry() in views.js.
    const max = Math.max(...r.values, 0);
    const denom = max || 1;
    const n = r.values.length;
    const points = r.values.map((v, i) => ({
      x: n > 1 ? (i / (n - 1)) * CHART_W : CHART_W / 2,
      y: CHART_BASE - (v / denom) * (CHART_BASE - CHART_TOP),
    }));
    const line = 'M' + points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L');
    areaPath.setAttribute('d', `${line} L${CHART_W},${CHART_BASE} L0,${CHART_BASE} Z`);
    linePath.setAttribute('d', line);
    labelMax.textContent = max;
    labelMid.textContent = Math.floor(max / 2); // see chartGeometry() in views.js
    // Positioned at the real index instead of evenly spread – see xLabelsHtml() in views.js.
    xLabels.innerHTML = r.labels.map(({ i, text }) => {
      const pct = n > 1 ? (i / (n - 1)) * 100 : 50;
      return `<span style="left:${pct.toFixed(2)}%">${text}</span>`;
    }).join('');
    totalRange.textContent = r.total;
    rangeLabel.textContent = r.label;

    // Rebuild the hover areas – see chartHoverBands() in views.js. The
    // actual tooltip display runs via event delegation (below), so it
    // reads the data attributes independently of when/how often this gets
    // rebuilt.
    const spacing = n > 1 ? CHART_W / (n - 1) : CHART_W;
    hoverGroup.innerHTML = points.map((p, i) => {
      const left = Math.max(0, p.x - spacing / 2);
      const right = Math.min(CHART_W, p.x + spacing / 2);
      const label = r.pointLabels?.[i] ?? '';
      return `<rect class="chart-hover" x="${left.toFixed(1)}" y="0" width="${(right - left).toFixed(1)}" height="190" fill="transparent" data-label="${label}" data-value="${r.values[i]}" data-px="${p.x.toFixed(1)}" data-py="${p.y.toFixed(1)}"/>`;
    }).join('');
  }

  // Custom tooltip instead of the native <title>: follows the exact point
  // position on the curve (SVG coordinate -> screen via getScreenCTM, so
  // it's still correct with preserveAspectRatio="none"/responsive scaling).
  const chartSvg = document.getElementById('chart-svg');
  const chartWrap = document.getElementById('stats-chart');
  const tooltip = document.getElementById('chart-tooltip');
  const tooltipTitle = document.getElementById('chart-tooltip-title');
  const tooltipValue = document.getElementById('chart-tooltip-value');
  const hoverDot = document.getElementById('chart-hover-dot');

  function showTooltip(hoverRect) {
    const px = Number(hoverRect.dataset.px), py = Number(hoverRect.dataset.py);
    // SVG point -> screen coordinate (not drawn as an SVG <circle>:
    // preserveAspectRatio="none" scales x/y by different amounts, which
    // would turn a circle into an ellipse. A regular HTML element avoids that.
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

  hoverGroup.addEventListener('mousemove', (e) => {
    const hoverRect = e.target.closest('.chart-hover');
    if (hoverRect) showTooltip(hoverRect); else hideTooltip();
  });
  hoverGroup.addEventListener('mouseleave', hideTooltip);

  rangeGroup.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      rangeGroup.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderRange(btn.dataset.range);
      hideTooltip(); // positions still belong to the old range until the mouse moves again
    });
  });
}
