const DEFAULT_API = 'http://localhost:8787';
const statusEl = document.getElementById('status');
const listEl = document.getElementById('leads');
const progressEl = document.getElementById('progress');
const form = document.getElementById('profile');
const template = document.getElementById('lead-template');

async function apiBase() {
  const { api } = await chrome.storage.local.get('api');
  return api || DEFAULT_API;
}

async function call(path, options = {}) {
  const response = await fetch(`${await apiBase()}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body;
}

const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD', notation: 'compact' }).format(value);
const percent = value => `${value > 0 ? '+' : ''}${Math.round(value)}%`;

// Every fact is shown, known or not: gaps in the data are part of the lead.
function facts(lead) {
  return [
    ['Founded', lead.launch_year],
    ['Employees', lead.employees],
    ['Headcount, 1 year', lead.employee_growth_1y, percent],
    ['Total funding', lead.funding_total, money],
    ['Revenue', lead.revenue, value => `${money(value)}${lead.revenue_year ? ` (${lead.revenue_year})` : ''}`],
    ['EBITDA', lead.ebitda, value => `${money(value)}${lead.ebitda_year ? ` (${lead.ebitda_year})` : ''}`],
    ['Founders', lead.founders?.length ? lead.founders.map(f => f.name).join(', ') : null]
  ];
}

function renderLead(lead) {
  const node = template.content.firstElementChild.cloneNode(true);
  const link = node.querySelector('.name');
  link.textContent = lead.name;
  link.href = lead.dealroom_url || lead.website || '#';
  node.querySelector('.where').textContent = [lead.hq_city, lead.hq_country].filter(Boolean).join(', ') || 'Location unknown';
  node.querySelector('.tagline').textContent = lead.tagline ?? '';
  const dl = node.querySelector('.facts');
  for (const [label, value, format = String] of facts(lead)) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    if (value === null || value === undefined) { dd.textContent = 'Unknown'; dd.className = 'unknown'; }
    else dd.textContent = format(value);
    div.append(dt, dd);
    dl.append(div);
  }
  for (const button of node.querySelectorAll('[data-reached]')) {
    button.setAttribute('aria-pressed', String(lead.reached_out === (button.dataset.reached === 'true')));
    button.addEventListener('click', async () => {
      const updated = await call(`/leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ reached_out: button.dataset.reached === 'true' }) });
      Object.assign(lead, updated);
      node.replaceWith(renderLead(lead));
      updateProgress();
    });
  }
  node.dataset.reached = String(lead.reached_out);
  return node;
}

let leads = [];
function updateProgress() {
  const done = leads.filter(lead => lead.reached_out !== null).length;
  progressEl.textContent = leads.length ? `${done} of ${leads.length} done today` : '';
}

async function loadLeads() {
  statusEl.textContent = 'Loading…';
  try {
    ({ leads } = await call('/leads/today'));
    listEl.replaceChildren(...leads.map(renderLead));
    statusEl.textContent = leads.length ? '' : 'No leads yet. Fill in "About you", then run a Dealroom sync.';
    updateProgress();
  } catch (error) {
    statusEl.textContent = `Couldn't load leads: ${error.message}`;
  }
}

async function loadProfile() {
  form.elements.api.value = await apiBase();
  try {
    const profile = await call('/profile');
    for (const name of ['who', 'offer', 'looking_for', 'dealroom_filter', 'dealroom_sort']) form.elements[name].value = profile[name] ?? '';
    if (!profile.updated_at) document.getElementById('profile-panel').open = true;
  } catch { /* status line already reports API problems */ }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const { api, ...profile } = data;
  await chrome.storage.local.set({ api: api.replace(/\/+$/, '') });
  await call('/profile', { method: 'PUT', body: JSON.stringify(profile) });
  await loadLeads();
});

loadProfile();
loadLeads();
