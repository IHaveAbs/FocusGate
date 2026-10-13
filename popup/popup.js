/* Focus Gate popup logic: master switch, gated-site list, add/remove. */

'use strict';

const BLACKLIST_KEY = 'focusgate_blacklist';
const ENABLED_KEY = 'focusgate_enabled';

const $ = (id) => document.getElementById(id);

const toggle = $('toggle');
const toggleLabel = $('toggleLabel');
const addForm = $('addForm');
const addInput = $('addInput');
const currentTabBtn = $('currentTab');
const formError = $('formError');
const listEl = $('list');
const emptyEl = $('empty');
const countEl = $('count');

/* --- helpers ------------------------------------------------------------ */

function normalizeSite(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/\.+$/, '');
  const host = s.includes(':') ? s.split(':')[0] : s;
  if (!host || host.includes(' ') || !host.includes('.')) return null;
  const labels = host.split('.');
  if (labels.some((l) => !/^[a-z0-9-]+$/.test(l))) return null;
  if (labels.some((l) => l.startsWith('-') || l.endsWith('-'))) return null;
  return host;
}

async function getList() {
  const res = await chrome.storage.local.get(BLACKLIST_KEY);
  return Array.isArray(res[BLACKLIST_KEY]) ? res[BLACKLIST_KEY] : [];
}

async function setList(list) {
  await chrome.storage.local.set({ [BLACKLIST_KEY]: list });
}

function showError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function clearError() {
  formError.hidden = true;
}

/* --- render ------------------------------------------------------------- */

function render(list) {
  listEl.textContent = '';
  emptyEl.hidden = list.length > 0;
  countEl.textContent = list.length === 1 ? '1 site' : list.length + ' sites';

  for (const site of list) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'list__site';
    name.textContent = site;
    name.title = 'Gate ' + site;
    const rm = document.createElement('button');
    rm.className = 'list__remove';
    rm.type = 'button';
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      const next = await getList();
      await setList(next.filter((s) => s !== site));
      render(await getList());
    });
    li.append(name, rm);
    listEl.appendChild(li);
  }
}

/* --- events ------------------------------------------------------------- */

async function addSite(raw) {
  clearError();
  const site = normalizeSite(raw);
  if (!site) {
    showError("That doesn't look like a site. Try \"example.com\".");
    return false;
  }
  const list = await getList();
  if (list.includes(site)) {
    showError(site + ' is already gated.');
    return false;
  }
  await setList([...list, site]);
  render(await getList());
  return true;
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const added = await addSite(addInput.value);
  if (added) {
    addInput.value = '';
    addInput.focus();
  }
});

currentTabBtn.addEventListener('click', async () => {
  clearError();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
      showError('No web page is open in this tab.');
      return;
    }
    const site = normalizeSite(new URL(tab.url).hostname);
    if (!site) { showError("Could not read that page's address."); return; }
    const added = await addSite(site);
    if (added) { currentTabBtn.textContent = 'Gated ' + site + ' ✓'; }
  } catch (err) {
    showError('Could not read the current tab.');
  }
});

toggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ [ENABLED_KEY]: toggle.checked });
  toggleLabel.textContent = toggle.checked ? 'On' : 'Off';
});

/* --- init --------------------------------------------------------------- */

(async function init() {
  const cfg = await chrome.storage.local.get(ENABLED_KEY);
  toggle.checked = cfg[ENABLED_KEY] !== false;
  toggleLabel.textContent = toggle.checked ? 'On' : 'Off';
  render(await getList());
})();
