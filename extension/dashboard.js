// Synergy side panel: today's VC leads, what's in play, history and settings.
// Follows the prototype in design/dashboard-prototype.html (card 166).
const DEFAULT_API = 'http://localhost:8787';
const view = document.getElementById('view');

// ---------- Storage and API ----------
const store = {
  async get(key) {
    if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(key))[key];
    try { return localStorage.getItem(key); } catch { return null; }
  },
  async set(key, value) {
    if (globalThis.chrome?.storage?.local) return chrome.storage.local.set({ [key]: value });
    try { localStorage.setItem(key, value); } catch { /* storage blocked: the default API is used */ }
  }
};
const apiBase = async () => (await store.get('api')) || DEFAULT_API;
async function call(path, options = {}) {
  const response = await fetch(`${await apiBase()}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? `The server said ${response.status}.`);
  return body;
}

// ---------- Formatting ----------
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (value, currency = 'GBP') => value == null ? null
  : new Intl.NumberFormat('en-GB', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value);
const year = date => (date ? String(date).slice(0, 4) : null);
const todayIso = () => new Date().toISOString().slice(0, 10);
const shortDay = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const daysSince = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
const OUT = { sent: 'Waiting', call: 'Call', rejected: 'Rejected', no_reply: 'No reply', not_for_me: 'Not for me' };
const REASONS = ['Portfolio too young', 'Wrong sector', 'Bad timing', 'Know them already'];
const TICK = '✓';

// ---------- State ----------
const state = { view: 'today', day: null, profile: null, history: null, filter: 'all', open: null, repliesOpen: true, editing: null, error: null, loading: true, saved: false };

const isQuiet = lead => lead.status === 'sent' && lead.sent_at && daysSince(lead.sent_at) >= 7;
const contactOf = lead => {
  const partner = lead.partners?.[0] ?? {};
  return {
    name: lead.contact_name || partner.name || null,
    email: lead.contact_email || partner.email || null,
    title: lead.contact_name ? null : partner.title,
    linkedin: partner.linkedin,
    edited: Boolean(lead.contact_name || lead.contact_email)
  };
};

// Why a company fits an exit now, from the facts we have. Unknowns are left out, not guessed.
function whyNow(company) {
  const parts = [];
  if (company.matched_on?.includes('ebitda') && company.ebitda != null) parts.push(`filed EBITDA of ${money(company.ebitda, company.currency)}${company.ebitda_year ? ` in ${company.ebitda_year}` : ''}`);
  const series = /^Series /i.test(company.last_round_label ?? '') ? company.last_round_label : null;
  if (company.matched_on?.includes('series_a_plus')) parts.push(`${series ? `${series} backed` : 'VC backed to Series A or later'}, no new round since ${year(company.last_round_date) ?? 'at least two years ago'}`);
  else if (company.last_round_date) parts.push(`no new round since ${year(company.last_round_date)}`);
  if (company.employee_growth_1y > 0) parts.push(`headcount up ${Math.round(company.employee_growth_1y)}% on last year`);
  const text = parts.join('; ');
  return text ? text[0].toUpperCase() + text.slice(1) : 'Matches your search';
}

function prompt(lead) {
  const me = state.profile?.who || '[Your name, your firm]';
  const offer = state.profile?.offer || 'I help boards and founders of profitable, VC-backed companies plan their exit: a sale, a secondary or a buy-out.';
  const contact = contactOf(lead);
  const partner = contact.name || `a partner at ${lead.name}`;
  const best = lead.companies?.[0];
  if (isQuiet(lead)) {
    return `I'm ${me}. A week ago I emailed ${partner} at ${lead.name}${best ? ` about ${best.name}` : ''} and haven't heard back.\n${best ? `Fact to use: ${whyNow(best)}.\n` : ''}Write a two-sentence follow-up that adds one new, useful point. No guilt, same ask: a 20-minute call.`;
  }
  const lines = (lead.companies ?? []).slice(0, 3).map(c => `- ${c.name}${c.industries?.[0] ? ` (${typeof c.industries[0] === 'string' ? c.industries[0] : c.industries[0].name ?? ''})` : ''}: revenue ${money(c.revenue, c.currency) ?? 'not public'}, EBITDA ${money(c.ebitda, c.currency) ?? 'not public'}. Why now: ${whyNow(c)}.`);
  return `I'm ${me}. ${offer}

Write a short first email to ${partner}, partner at ${lead.name}.

Their holdings that fit:
${lines.join('\n')}

Why these fit: they're established and growing without new venture money, and the fund will want to return cash to its investors. That makes them better suited to a sale, a secondary or a buy-out than another round.

Check recent news on ${lead.name}${best ? ` and ${best.name}` : ''} first and use one relevant detail. Lead with ${best?.name ?? 'the strongest company'} and say specifically why it fits. Peer to peer, under 120 words, no jargon. One ask: a 20-minute call about which of these might want options in the next two years.`;
}

// ---------- Pieces ----------
const sig = tier => `<span class="sig" data-tier="${tier}" role="img" aria-label="Tier ${tier}"><i></i><i></i><i></i></span>`;
const matchesLine = lead => `${lead.matching_companies} ${lead.matching_companies === 1 ? 'match' : 'matches'} · ${esc(lead.hq_city || lead.hq_country || '')}`;

function companyTable(lead) {
  if (!lead.companies?.length) return '<p class="hint">No portfolio companies match your search any more.</p>';
  const all = state.showAll === lead.uuid;
  const shown = all ? lead.companies : lead.companies.slice(0, 3);
  const more = lead.companies.length - shown.length;
  return `<table class="port"><thead><tr><th scope="col">Matching company</th><th scope="col">EBITDA</th><th scope="col">Last round</th></tr></thead><tbody>
    ${shown.map(c => `<tr>
      <td><b>${esc(c.name)}</b><span>${esc([c.hq_city, money(c.revenue, c.currency) && `rev ${money(c.revenue, c.currency)}${c.revenue_year ? ` (${c.revenue_year})` : ''}`].filter(Boolean).join(' · '))}</span></td>
      <td>${c.ebitda == null ? '<span class="unk">Unknown</span>' : `${esc(money(c.ebitda, c.currency))}<span>${esc(c.ebitda_year ?? '')}</span>`}</td>
      <td>${c.last_round_date ? `${esc(year(c.last_round_date))}<span>${esc(/^Series /i.test(c.last_round_label ?? '') ? c.last_round_label : '')}</span>` : '<span class="unk">Unknown</span>'}</td>
    </tr><tr class="why"><td colspan="3">${esc(whyNow(c))}</td></tr>`).join('')}
  </tbody></table>${more ? `<button class="link" type="button" data-act="show-all" data-id="${lead.uuid}">Show ${more} more</button>` : ''}${shown.some(c => c.ebitda == null) ? '<p class="hint">Unknown means Dealroom doesn\'t have it. Check Companies House.</p>' : ''}`;
}

function contactBox(lead) {
  const c = contactOf(lead);
  if (state.editing === lead.uuid) {
    return `<form class="contact" data-contact="${lead.uuid}">
      <label class="field"><span>Partner's name</span><input name="contact_name" id="cn-${lead.uuid}" value="${esc(c.name ?? '')}" autocomplete="off"></label>
      <label class="field"><span>Email</span><input name="contact_email" id="ce-${lead.uuid}" type="email" value="${esc(c.email ?? '')}" autocomplete="off"></label>
      <div class="toggles"><button class="btn small" type="submit">Save</button><button class="btn ghost small" type="button" data-act="cancel-edit">Cancel</button>
      ${c.edited ? `<button class="link" type="button" data-act="reset-contact" data-id="${lead.uuid}">Use Dealroom's</button>` : ''}</div>
    </form>`;
  }
  const others = (lead.partners ?? []).slice(1, 4).map(p => p.name);
  return `<div class="contact">
    <div class="who"><span><span class="lbl hint">Contact</span><br><b>${esc(c.name ?? 'No partner listed')}</b>${c.title ? `, ${esc(c.title)}` : ''} ${c.edited ? '<span class="edited">Edited by you</span>' : ''}</span>
      <button class="link" type="button" data-act="edit-contact" data-id="${lead.uuid}">Edit</button></div>
    <div class="email">${c.email ? `${esc(c.email)} <button class="link" type="button" data-act="copy-email" data-id="${lead.uuid}">Copy</button>` : '<span class="hint">No email yet. Dealroom rarely has them, so add it with Edit.</span>'}</div>
    ${others.length ? `<span class="hint">Also: ${esc(others.join(', '))}</span>` : ''}
  </div>`;
}

function links(lead) {
  const c = contactOf(lead);
  const q = encodeURIComponent;
  const items = [
    lead.website && [lead.website, 'Website'],
    c.linkedin ? [c.linkedin, `${(c.name || 'Partner').split(' ')[0]} on LinkedIn`] : lead.linkedin && [lead.linkedin, 'LinkedIn'],
    [`https://news.google.com/search?q=${q(`"${lead.name}"`)}`, 'News'],
    lead.dealroom_url && [lead.dealroom_url, 'Dealroom']
  ].filter(Boolean);
  return `<div class="links">${items.map(([href, label]) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`).join('')}</div>`;
}

function detail(lead, inPlay) {
  let actions;
  if (lead.status === 'not_for_me') {
    actions = `<p class="hint">Not for me${lead.dismiss_reason ? ` · ${esc(lead.dismiss_reason)}` : ''}. Why? Optional, it tunes your search.</p>
      <div class="reasons">${REASONS.map(r => `<button type="button" data-act="reason" data-id="${lead.uuid}" data-r="${esc(r)}" aria-pressed="${lead.dismiss_reason === r}">${esc(r)}</button>`).join('')}</div>
      <button class="link" type="button" data-act="unnope" data-id="${lead.uuid}">Undo</button>`;
  } else if (inPlay) {
    actions = `<div class="outcome four" role="group" aria-label="What happened with ${esc(lead.name)}">
      ${['sent', 'call', 'rejected', 'no_reply'].map(k => `<button type="button" data-act="outcome" data-id="${lead.uuid}" data-v="${k}" data-st="${k}" aria-pressed="${lead.status === k}">${OUT[k]}</button>`).join('')}</div>`;
  } else {
    actions = `<button class="link" type="button" data-act="nope" data-id="${lead.uuid}">Not for me</button>`;
  }
  return `<div class="more">
    <div class="chips"><span class="chip">Tier ${lead.tier}</span><span class="chip">${esc(lead.hq_country ?? '')}</span><span class="chip">${lead.matching_companies} matching</span></div>
    ${contactBox(lead)}
    ${links(lead)}
    ${companyTable(lead)}
    <label class="field"><span>Notes</span><textarea rows="2" data-notes="${lead.uuid}" id="notes-${lead.uuid}" placeholder="Who knows them, what they said, when to chase">${esc(lead.notes)}</textarea></label>
    ${inPlay ? actions : ''}
    <div class="prompt"><span class="tag">${isQuiet(lead) ? 'Follow-up prompt' : 'Prompt for Claude'}</span><p id="p-${lead.uuid}">${esc(prompt(lead))}</p>
      <button class="btn small" type="button" data-act="copy" data-id="${lead.uuid}" style="margin-top:10px">Copy prompt</button></div>
    ${inPlay ? '' : actions}
  </div>`;
}

function todayRow(lead) {
  const sent = Boolean(lead.sent_at), nope = lead.status === 'not_for_me', open = state.open === lead.uuid;
  const right = nope ? '<span class="pill" data-st="not_for_me">Not for me</span>'
    : `<button type="button" class="sent" data-act="sent" data-id="${lead.uuid}" aria-pressed="${sent}" aria-label="Sent to ${esc(lead.name)}">${sent ? `Sent ${TICK}` : 'Sent?'}</button>`;
  const tag = lead.carried_from ? `<span class="from">From ${esc(shortDay(lead.carried_from).split(' ')[0])}</span>` : (lead.first_shown === state.day?.date && state.day?.has_history ? '<span class="new">New</span>' : '');
  return `<li class="lead${open ? ' open' : ''}${sent || nope ? ' done' : ''}${nope ? ' crossed' : ''}">
    <div class="rowwrap"><button type="button" class="row" data-act="open" data-id="${lead.uuid}" aria-expanded="${open}">${sig(lead.tier)}
      <span><span class="name"><span class="t">${esc(lead.name)}</span>${tag}</span><span class="meta">${matchesLine(lead)}</span></span></button>${right}</div>
    ${open ? detail(lead, false) : ''}</li>`;
}

function playRow(lead) {
  const open = state.open === lead.uuid, quiet = isQuiet(lead);
  const when = lead.sent_at ? `sent ${shortDay(lead.sent_at.slice(0, 10))}` : `shown ${shortDay(lead.first_shown)}`;
  const crossed = ['rejected', 'no_reply', 'not_for_me'].includes(lead.status);
  return `<li class="lead${open ? ' open' : ''}${crossed ? ' crossed' : ''}">
    <div class="rowwrap"><button type="button" class="row" data-act="open" data-id="${lead.uuid}" aria-expanded="${open}">${sig(lead.tier)}
      <span><span class="name"><span class="t">${esc(lead.name)}</span>${lead.notes ? '<span class="from" title="Has notes">✎</span>' : ''}</span><span class="meta">${esc(contactOf(lead).name ?? '')} · ${when}</span></span></button>
      <span class="pill" data-st="${quiet ? 'quiet' : lead.status}">${quiet ? 'Quiet 7d' : OUT[lead.status]}</span></div>
    ${open ? detail(lead, true) : ''}</li>`;
}

// ---------- Views ----------
function renderToday() {
  const day = state.day;
  const n = day?.leads_per_day ?? state.profile?.leads_per_day ?? 10;
  document.getElementById('title-text').textContent = `Your ${n}`;
  document.getElementById('date').textContent = shortDay(day?.date ?? todayIso());
  if (!day && !state.error) return `<p class="hint">Finding today's VCs…</p>${'<div class="skel"></div>'.repeat(5)}`;
  if (!day) return `<div class="alert err"><b>Can't reach Synergy.</b> ${esc(state.error)}</div><button class="btn small" type="button" data-act="retry">Try again</button>`;
  const leads = day.leads, handled = leads.filter(l => l.sent_at || l.dismissed_at).length;
  const sentCount = leads.filter(l => l.sent_at).length;
  const allDone = leads.length > 0 && handled === leads.length;
  const { current, best } = day.streak;
  let h = '';
  if (state.error) h += `<div class="alert err"><b>Couldn't save that.</b> ${esc(state.error)}</div>`;
  if (current || best) h += `<div class="streak"><span class="dots">${Array.from({ length: 10 }, (_, i) => `<i class="${i < Math.min(current, 10) ? 'on' : ''}"></i>`).join('')}</span><span>${current ? `<b>${current}-day streak</b>` : 'No streak yet'}${best >= current && best ? ` · best ${best}` : ''}</span></div>`;
  if (allDone) h += `<div class="welldone"><b>That's your ${leads.length}.</b><span>${current >= 10 ? `${current} days in a row. That's ${current * n} VCs. Nobody else is doing this.` : current > 1 ? `${current} days in a row${current >= best ? ', your best yet' : ''}. Same again tomorrow.` : 'Day one of a streak. Same again tomorrow.'}</span></div>`;
  h += day.in_play.filter(l => l.outcome === 'call' && l.outcome_at?.slice(0, 10) === day.date).map(l => `<div class="alert call"><b>Call requested</b> · ${esc(contactOf(l).name ?? '')}, ${esc(l.name)}</div>`).join('');
  const waiting = day.in_play.filter(l => l.status === 'sent');
  if (waiting.length) {
    const quiet = waiting.filter(isQuiet).length;
    h += `<button type="button" class="ask" data-act="replies" aria-expanded="${state.repliesOpen}"><b>Any replies?</b><span class="hint">${waiting.length} waiting${quiet ? ` · <span class="unk">${quiet} quiet a week</span>` : ''} ${state.repliesOpen ? '▴' : '▾'}</span></button>`;
    if (state.repliesOpen) h += `<ul class="replies">${waiting.map(l => `<li><span class="nm">${esc(contactOf(l).name ?? l.name)} · ${esc(l.name)}<span${isQuiet(l) ? ' class="unk"' : ''}>${isQuiet(l) ? `${daysSince(l.sent_at)} days` : `Sent ${shortDay(l.sent_at.slice(0, 10))}`}</span></span>
      <div class="outcome" role="group" aria-label="Reply from ${esc(l.name)}">${['call', 'rejected', 'no_reply'].map(k => `<button type="button" data-act="outcome" data-id="${l.uuid}" data-v="${k}" data-st="${k}" aria-pressed="false">${OUT[k]}</button>`).join('')}</div></li>`).join('')}</ul>`;
  }
  h += `<div class="sublbl"><span>Today</span><span>${handled ? `${sentCount} sent · ${leads.length - handled} to go` : ''}</span></div>`;
  if (leads.length) h += `<ul class="leads">${leads.map(todayRow).join('')}</ul>`;
  if (day.pool_empty) h += `<div class="empty"><p>${leads.length ? `Only ${leads.length} VCs match your search today.` : "That's every VC that matches your search."} Widen it to see more tomorrow.</p><button class="btn ghost small" type="button" data-go="settings">Change search</button></div>`;
  const play = [...day.in_play].sort((a, b) => ({ call: 0, sent: 1, rejected: 2, no_reply: 3 }[a.status] - { call: 0, sent: 1, rejected: 2, no_reply: 3 }[b.status]));
  if (play.length) h += `<div class="sublbl"><span>In play</span><span>${play.length}</span></div><ul class="leads">${play.map(playRow).join('')}</ul>`;
  return h;
}

const FILTERS = [['all', 'All'], ['waiting', 'Waiting'], ['call', 'Calls'], ['closed', 'Closed'], ['not_for_me', 'Not for me']];
function renderHistory() {
  document.getElementById('title-text').textContent = 'History';
  const hist = state.history;
  if (!hist) return `${'<div class="skel"></div>'.repeat(4)}`;
  return `<div class="filters" role="group" aria-label="Filter history">${FILTERS.map(([k, label]) => `<button type="button" data-act="filter" data-v="${k}" aria-pressed="${state.filter === k}">${label} ${hist.counts[k] ?? 0}</button>`).join('')}</div>
    ${hist.leads.length ? `<ul class="leads">${hist.leads.map(playRow).join('')}</ul>` : '<div class="empty"><p>Nothing here yet.</p></div>'}`;
}

const COUNTRIES = ['United Kingdom', 'Spain'];
function renderSettings() {
  const p = state.profile ?? { criteria: {} };
  const c = p.criteria ?? {};
  const first = !p.updated_at;
  document.getElementById('title-text').textContent = first ? 'Welcome' : 'Settings';
  const sel = (name, value, options) => `<select name="${name}" id="s-${name}">${options.map(([v, label]) => `<option value="${v}"${String(value) === String(v) ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
  return `<form class="form" id="settings">
    ${first ? '<p class="hint">A few VC firms every morning whose portfolio companies are ready for an exit. Tell us who you are and who you\'re looking for.</p>' : '<p class="hint">Changes apply from tomorrow\'s list.</p>'}
    <div class="group">About you</div>
    <label class="field"><span>Your name and firm</span><input name="who" id="s-who" value="${esc(p.who)}" placeholder="Used to write your emails"></label>
    <label class="field"><span>What you offer</span><textarea name="offer" id="s-offer" rows="2" placeholder="e.g. I help boards of profitable, VC-backed companies plan their exit">${esc(p.offer)}</textarea></label>
    <div class="field"><span>Leads a day</span><div class="seg" role="group" aria-label="Leads a day">${[5, 10].map(v => `<button type="button" data-act="perday" data-v="${v}" aria-pressed="${(state.perDay ?? p.leads_per_day ?? 10) === v}">${v} a day</button>`).join('')}</div></div>
    <div class="group">Who you're looking for</div>
    <div class="field"><span>Countries</span><div class="toggles" role="group" aria-label="Countries">${COUNTRIES.map(k => `<button type="button" data-act="country" data-v="${k}" aria-pressed="${(state.countries ?? c.investor_countries ?? COUNTRIES).includes(k)}">${k}</button>`).join('')}</div></div>
    <div class="two">
      <label class="field"><span>Min EBITDA</span>${sel('ebitda_min_gbp', c.ebitda_min_gbp ?? 'off', [['off', 'Any'], [500000, '£0.5m'], [1000000, '£1m'], [2000000, '£2m'], [5000000, '£5m']])}</label>
      <label class="field"><span>No new round in</span>${sel('no_raise_months', c.no_raise_months ?? 24, [[12, '1 year'], [24, '2 years'], [36, '3 years'], [60, '5 years']])}</label>
      <label class="field"><span>Founded by</span>${sel('launched_by', c.launched_by ?? 2018, [2012, 2014, 2016, 2018, 2020].map(y => [y, y]))}</label>
      <label class="field"><span>Or Series A+</span>${sel('series_a_plus', c.series_a_plus ?? true, [[true, 'Counts'], [false, "Doesn't count"]])}</label>
    </div>
    <details><summary>Advanced</summary><label class="field" style="margin-top:8px"><span>Synergy API</span><input name="api" id="s-api" type="url" value="${esc(state.api)}"></label></details>
    <button class="btn" type="submit">${first ? 'Find my leads' : 'Save'}</button>
    ${state.saved ? '<span class="saved" role="status">Saved.</span>' : ''}
  </form>`;
}

function render() {
  for (const v of ['today', 'history', 'settings']) {
    const b = document.getElementById(`nav-${v}`);
    if (state.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  view.innerHTML = state.view === 'history' ? renderHistory() : state.view === 'settings' ? renderSettings() : renderToday();
}

// ---------- Data ----------
async function loadToday() {
  try {
    const [day, history] = await Promise.all([call('/vcs/today'), call('/vcs/history')]);
    state.day = { ...day, has_history: history.counts.all > day.leads.length };
    state.error = null;
  } catch (error) { state.error = error.message; }
  state.loading = false;
  render();
}
async function loadHistory() {
  try { state.history = await call(`/vcs/history?status=${state.filter}`); state.error = null; } catch (error) { state.error = error.message; }
  render();
}
const allLeads = () => [...(state.day?.leads ?? []), ...(state.day?.in_play ?? []), ...(state.history?.leads ?? [])];
const findLead = uuid => allLeads().find(lead => lead.uuid === uuid);

async function patch(uuid, body) {
  try {
    await call(`/vcs/${uuid}`, { method: 'PATCH', body: JSON.stringify(body) });
    state.error = null;
  } catch (error) { state.error = error.message; }
  await (state.view === 'history' ? Promise.all([loadToday(), loadHistory()]) : loadToday());
}

async function go(next) {
  state.view = next; state.open = null; state.editing = null; state.saved = false;
  render();
  if (next === 'history') await loadHistory();
  if (next === 'today') await loadToday();
}

// ---------- Events ----------
document.querySelector('.nav').addEventListener('click', event => {
  const b = event.target.closest('[data-go]'); if (b) go(b.dataset.go);
});
view.addEventListener('click', async event => {
  const goBtn = event.target.closest('[data-go]');
  if (goBtn) return go(goBtn.dataset.go);
  const b = event.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'open': state.open = state.open === id ? null : id; state.editing = null; return render();
    case 'show-all': state.showAll = state.showAll === id ? null : id; return render();
    case 'replies': state.repliesOpen = !state.repliesOpen; return render();
    case 'retry': state.loading = true; render(); return loadToday();
    case 'sent': return patch(id, { sent: !findLead(id)?.sent_at });
    case 'nope': return patch(id, { not_for_me: true });
    case 'unnope': return patch(id, { not_for_me: false });
    case 'reason': return patch(id, { reason: findLead(id)?.dismiss_reason === b.dataset.r ? '' : b.dataset.r });
    case 'outcome': return patch(id, { outcome: b.dataset.v === 'sent' ? null : b.dataset.v });
    case 'edit-contact': state.editing = id; render(); return document.getElementById(`cn-${id}`)?.focus();
    case 'cancel-edit': state.editing = null; return render();
    case 'reset-contact': state.editing = null; return patch(id, { contact_name: null, contact_email: null });
    case 'filter': state.filter = b.dataset.v; state.open = null; return loadHistory();
    case 'perday': state.perDay = Number(b.dataset.v); return render();
    case 'country': {
      const now = state.countries ?? state.profile?.criteria?.investor_countries ?? COUNTRIES;
      const next = now.includes(b.dataset.v) ? now.filter(c => c !== b.dataset.v) : [...now, b.dataset.v];
      state.countries = next.length ? next : now;
      return render();
    }
    case 'copy': case 'copy-email': {
      const lead = findLead(id);
      const text = b.dataset.act === 'copy' ? prompt(lead) : contactOf(lead).email;
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
      catch { b.textContent = 'Select and copy'; }
      return setTimeout(() => { b.textContent = b.dataset.act === 'copy' ? 'Copy prompt' : 'Copy'; }, 1400);
    }
  }
});

let notesTimer;
view.addEventListener('input', event => {
  const id = event.target.dataset.notes; if (!id) return;
  clearTimeout(notesTimer);
  const value = event.target.value;
  notesTimer = setTimeout(async () => {
    try { await call(`/vcs/${id}`, { method: 'PATCH', body: JSON.stringify({ notes: value }) }); const lead = findLead(id); if (lead) lead.notes = value; }
    catch (error) { state.error = error.message; render(); }
  }, 600);
});

view.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  if (form.dataset.contact) {
    state.editing = null;
    return patch(form.dataset.contact, { contact_name: form.elements.contact_name.value, contact_email: form.elements.contact_email.value });
  }
  if (form.id === 'settings') {
    const f = form.elements;
    const countries = state.countries ?? state.profile?.criteria?.investor_countries ?? COUNTRIES;
    const criteria = {
      ...state.profile?.criteria,
      investor_countries: countries,
      company_countries: countries,
      ebitda_min_gbp: f.ebitda_min_gbp.value === 'off' ? null : Number(f.ebitda_min_gbp.value),
      no_raise_months: Number(f.no_raise_months.value),
      launched_by: Number(f.launched_by.value),
      series_a_plus: f.series_a_plus.value === 'true'
    };
    const api = f.api.value.trim().replace(/\/+$/, '');
    if (api) { await store.set('api', api); state.api = api; }
    try {
      state.profile = await call('/profile', { method: 'PUT', body: JSON.stringify({
        who: f.who.value, offer: f.offer.value, looking_for: state.profile?.looking_for ?? '',
        criteria, leads_per_day: state.perDay ?? state.profile?.leads_per_day ?? 10 }) });
      state.saved = true; state.error = null;
      return go('today');
    } catch (error) { state.error = error.message; return render(); }
  }
});

// ---------- Start ----------
(async () => {
  state.api = await apiBase();
  render();
  try { state.profile = await call('/profile'); } catch (error) { state.error = error.message; }
  if (state.profile && !state.profile.updated_at) { state.view = 'settings'; state.loading = false; return render(); }
  await loadToday();
})();
