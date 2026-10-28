'use strict';

/* =====================================================================
   LEDGERLY front-end (no frameworks, no build step)
   Safety rule: everything dynamic goes through html`...` which escapes
   values automatically. Only wrap in raw() when the text is trusted.
   ===================================================================== */

/* ---------- tiny templating helpers ---------- */
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toStr(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(toStr).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
}
function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += toStr(vals[i]); });
  return new Raw(out);
}
const $ = (sel, root = document) => root.querySelector(sel);

/* ---------- state ---------- */
const state = { me: null, firstRun: false, setup: null, setupOrgId: null, tx: { offset: 0, voided: false }, report: {} };
const app = $('#app');

/* ---------- API ---------- */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledgerly' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.me && state.me.user) { state.me = null; state.setup = null; state.setupOrgId = null; render(); }
    throw new Error(data.error || 'Something went wrong. Please try again.');
  }
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b || {});
const PUT = (u, b) => api('PUT', u, b || {});
const DEL = (u) => api('DELETE', u);
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v !== null && v !== undefined && v !== false) p.set(k, v === true ? '1' : v);
  const s = p.toString();
  return s ? '?' + s : '';
};

/* ---------- formatting ---------- */
const currency = () => (state.setup ? state.setup.org.currency : 'NGN');
const moneyFmt = (cur) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: cur });
function fmt(kobo, cur = currency()) { return moneyFmt(cur).format((kobo || 0) / 100); }
function sym(cur = currency()) { return moneyFmt(cur).formatToParts(0).find((p) => p.type === 'currency')?.value || cur; }
function compact(kobo) {
  return sym() + new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format((kobo || 0) / 100);
}
const pad = (n) => String(n).padStart(2, '0');
const localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => localISO(new Date());
const monthStart = () => { const d = new Date(); return localISO(new Date(d.getFullYear(), d.getMonth(), 1)); };
const yearStart = () => `${new Date().getFullYear()}-01-01`;
function niceDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short' });
}

const TYPE_LABELS = { asset: 'Assets', liability: 'Liabilities', equity: 'Owner’s Equity', income: 'Income', expense: 'Expenses' };
const TYPE_HELP = {
  asset: 'What the business owns or is owed',
  liability: 'What the business owes',
  equity: 'Money the owner put in or took out',
  income: 'Where money comes from',
  expense: 'Where money goes',
};
const TAG_LABELS = { cash: 'Cash / bank', receivable: 'Money owed to us', payable: 'Money we owe' };
const ROLE_LABELS = { owner: 'Owner (full access)', accountant: 'Accountant (record & void)', viewer: 'Viewer (read only)' };

/* ---------- UI helpers ---------- */
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isError ? 5000 : 2600);
}

function openModal(content, { wide = false } = {}) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = html`<div class="overlay" data-action="overlay"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${content}</div></div>`.s;
  const first = root.querySelector('input:not([type=hidden]):not([type=radio]), select, textarea');
  if (first) first.focus();
}
function closeModal() { $('#modal-root').innerHTML = ''; }
const modalHead = (title) => html`<div class="modal-head"><h2>${title}</h2><button class="close" type="button" data-action="close" aria-label="Close">×</button></div>`;
const errorBox = () => html`<div class="error" id="form-error" hidden></div>`;
function showFormError(msg) { const b = $('#form-error'); if (b) { b.textContent = msg; b.hidden = false; b.scrollIntoView({ block: 'nearest' }); } else toast(msg, true); }
function busy(form, on) { form.querySelectorAll('button[type=submit]').forEach((b) => { b.disabled = on; }); }

function isOwner() { return state.setup && state.setup.role === 'owner'; }
function canWrite() {
  return state.setup && (state.setup.role === 'owner' || state.setup.role === 'accountant') && state.setup.billing.status !== 'expired';
}
const activeAccounts = (types) => state.setup.accounts.filter((a) => a.active && (!types || types.includes(a.type)));
const accountName = (id) => state.setup.accounts.find((a) => a.id === id);

function optionList(accounts, selected) {
  return accounts.map((a) => html`<option value="${a.id}" ${String(a.id) === String(selected) ? raw('selected') : ''}>${a.code} · ${a.name}</option>`);
}

/* =====================================================================
   Routing
   ===================================================================== */
async function loadMe() {
  const data = await GET('/api/me');
  state.me = data;
  state.firstRun = !!data.first_run;
}
async function loadSetup(id) {
  const next = await GET(`/api/orgs/${id}/setup`);
  if (state.setupOrgId !== id) { state.tx = { offset: 0, voided: false }; state.report = {}; }
  state.setup = next;
  state.setupOrgId = id;
}
async function refreshSetup() { if (state.setupOrgId) await loadSetup(state.setupOrgId); }

async function render() {
  const hash = location.hash.replace(/^#/, '') || '/';
  try {
    if (!state.me) await loadMe();
    const resetMatch = hash.match(/^\/reset\/([A-Za-z0-9_-]+)$/);
    if (resetMatch) return viewReset(resetMatch[1]);
    if (!state.me.user) return viewAuth();
    const m = hash.match(/^\/org\/(\d+)(?:\/(.*))?$/);
    if (m) {
      const id = Number(m[1]);
      if (state.setupOrgId !== id) await loadSetup(id);
      return await viewOrg(id, m[2] || 'dashboard');
    }
    state.setup = null; state.setupOrgId = null;
    return await viewHome();
  } catch (err) {
    if (/not found/i.test(err.message)) { toast(err.message, true); state.setup = null; state.setupOrgId = null; location.hash = '#/'; return; }
    app.innerHTML = html`<div class="main"><div class="card"><h2>We couldn’t load that page</h2><p class="muted">${err.message}</p><p><a class="btn" href="#/">Back to start</a></p></div></div>`.s;
  }
}
window.addEventListener('hashchange', () => { closeModal(); render(); });

/* =====================================================================
   Auth
   ===================================================================== */
function authLayout(inner) {
  app.innerHTML = html`
  <div class="auth">
    <section class="auth-brand">
      <div class="logo"><span class="logo-mark">L</span> Ledgerly</div>
      <div><h1>Accounts that fit every kind of business.</h1></div>
      <p class="small fine">Your clients\u2019 data stays separated by organisation.</p>
    </section>
    <section class="auth-panel"><div class="auth-card">${inner}</div></section>
  </div>`.s;
}
function viewForgot() {
  authLayout(html`<h2>Forgot your password?</h2>
    <p class="muted">Enter your email and we\u2019ll send you a link to choose a new one.</p>
    <form data-form="forgot" novalidate>${errorBox()}
      <div class="field"><label for="fp-email">Email</label><input id="fp-email" name="email" type="email" autocomplete="email" required></div>
      <button class="btn btn-primary btn-block" type="submit">Send reset link</button></form>
    <p class="small muted mt"><a href="#/login">Back to log in</a></p>
    <p class="small muted">No email arriving? Ask your platform admin to send you a reset link.</p>`);
}
function viewReset(token) {
  authLayout(html`<h2>Choose a new password</h2>
    <form data-form="reset" data-token="${token}" novalidate>${errorBox()}
      <div class="field"><label for="rp-pass">New password</label><input id="rp-pass" name="password" type="password" autocomplete="new-password" required>
        <div class="hint">At least 8 characters. You\u2019ll be logged out on all other devices.</div></div>
      <button class="btn btn-primary btn-block" type="submit">Save new password</button></form>
    <p class="small muted mt"><a href="#/login">Back to log in</a></p>`);
}

function viewAuth() {
  if (location.hash === '#/forgot') return viewForgot();
  const signup = location.hash === '#/signup';
  app.innerHTML = html`
  <div class="auth">
    <section class="auth-brand">
      <div class="logo"><span class="logo-mark">L</span> Ledgerly</div>
      <div>
        <h1>Accounts that fit every kind of business.</h1>
        <p class="lead">One platform. Each client gets books shaped around how they actually work: a poultry farm, a school, a market trader.</p>
        <ul>
          <li>Real double-entry books behind simple screens</li>
          <li>Custom accounts and fields for every client</li>
          <li>Profit &amp; loss, balance sheet and trial balance in Naira</li>
        </ul>
      </div>
      <p class="small fine">Your clients’ data stays separated by organisation.</p>
    </section>
    <section class="auth-panel">
      <div class="auth-card">
        <h2>${signup ? 'Create your account' : 'Welcome back'}</h2>
        ${state.firstRun && signup ? html`<p class="small notice">You’re the first person here, so this account becomes the <strong>platform admin</strong> and can onboard clients.</p>` : ''}
        <form data-form="${signup ? 'signup' : 'login'}" novalidate>
          ${errorBox()}
          ${signup ? html`<div class="field"><label for="name">Your name</label><input id="name" name="name" autocomplete="name" required></div>` : ''}
          <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
            ${signup ? html`<div class="hint">At least 8 characters.</div>` : ''}</div>
          <button class="btn btn-primary btn-block" type="submit">${signup ? 'Create account' : 'Log in'}</button>
        </form>
        <p class="small muted mt">${signup
          ? html`Already have an account? <a href="#/login">Log in</a>`
          : html`New here? <a href="#/signup">Create an account</a> · <a href="#/forgot">Forgot password?</a>`}</p>
      </div>
    </section>
  </div>`.s;
}

/* =====================================================================
   Home: client list
   ===================================================================== */
async function viewHome() {
  const { user, orgs } = state.me;
  let adminOrgs = null;
  if (user.is_admin) adminOrgs = (await GET('/api/admin/orgs')).orgs;
  if (!user.is_admin && orgs.length === 1) { location.hash = `#/org/${orgs[0].id}/dashboard`; return; }

  const list = user.is_admin ? adminOrgs : orgs;
  app.innerHTML = html`
  <div class="main narrow">
    <div class="page-head">
      <div>
        <div class="logo mb"><span class="logo-mark">L</span> Ledgerly</div>
        <h1>${user.is_admin ? 'Your clients' : 'Your organisations'}</h1>
        <div class="sub">${user.is_admin ? 'Onboard a business, then tailor its accounts and fields.' : `Signed in as ${user.name}.`}</div>
      </div>
      <div class="actions">
        ${user.is_admin ? html`<button class="btn btn-primary" data-action="new-client">+ Onboard new client</button>` : ''}
        <button data-action="logout">Log out</button>
      </div>
    </div>
    ${list.length ? html`
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Business</th><th>Type</th>${user.is_admin ? html`<th class="num">People</th><th class="num">Entries</th><th>Plan</th>` : html`<th>Your role</th>`}<th></th></tr></thead>
      <tbody>${list.map((o) => html`<tr>
        <td><a href="#/org/${o.id}/dashboard"><strong>${o.name}</strong></a></td>
        <td>${o.type_label}</td>
        ${user.is_admin ? html`<td class="num">${o.members}</td><td class="num">${o.transactions}</td><td>${planBadge(o.plan)}</td>` : html`<td><span class="badge">${o.role}</span></td>`}
        <td class="num"><a class="btn btn-sm" href="#/org/${o.id}/dashboard">Open</a></td></tr>`)}</tbody>
    </table></div></div>`
    : html`<div class="card empty"><strong>${user.is_admin ? 'No clients yet' : 'You haven’t been added to any organisation yet'}</strong>
      ${user.is_admin ? 'Click “Onboard new client” to set up your first business, for example the poultry farm.' : 'Ask the business owner to add your email address. Your access will appear here automatically.'}</div>`}
    ${user.is_admin ? html`<div class="card">
      <h2 class="mb-s">Help someone who can\u2019t log in</h2>
      <p class="muted small">If a client forgot their password and reset emails aren\u2019t set up, make them a one-hour link and send it on WhatsApp.</p>
      <form data-form="reset-link" class="row" novalidate>
        <div class="field"><label for="rl-email">Their email</label><input id="rl-email" name="email" type="email" required></div>
        <div class="field"><label>&nbsp;</label><button class="btn" type="submit">Create reset link</button></div>
      </form>
      <div id="reset-link-out"></div>
    </div>` : ''}
  </div>`.s;
}

async function openNewClient() {
  const { templates, currencies } = await GET('/api/templates');
  openModal(html`
    ${modalHead('Onboard a new client')}
    <form data-form="new-client" novalidate>
      ${errorBox()}
      <div class="field"><label for="nc-name">Business name</label><input id="nc-name" name="name" placeholder="e.g. Adebayo Poultry Farm" required></div>
      <div class="field"><label>What kind of business is it?</label>
        <div class="type-grid">${templates.map((t, i) => html`
          <label class="type-opt"><input type="radio" name="type" value="${t.key}" ${i === 0 ? raw('checked') : ''}>
            <span class="box"><strong>${t.label}</strong><span>${t.description}</span></span></label>`)}</div>
        <div class="hint">This only sets the starting accounts and fields. You can change everything afterwards.</div></div>
      <div class="row">
        <div class="field"><label for="nc-cur">Currency</label><select id="nc-cur" name="currency">${currencies.map((c) => html`<option ${c === 'NGN' ? raw('selected') : ''}>${c}</option>`)}</select></div>
        <div class="field"><label for="nc-owner">Owner’s email <span class="muted">(optional)</span></label><input id="nc-owner" name="owner_email" type="email" placeholder="owner@example.com">
          <div class="hint">They get owner access when they sign up or log in with this email.</div></div>
      </div>
      <div class="modal-foot"><button type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">Create client</button></div>
    </form>`, { wide: true });
}

/* =====================================================================
   Organisation shell
   ===================================================================== */
function shell(id, active, { title, sub, actions = '', body }) {
  const s = state.setup;
  const link = (path, label) => html`<a href="#/org/${id}/${path}" ${active === path || active.startsWith(path + '/') ? raw('aria-current="page"') : ''}>${label}</a>`;
  const multi = state.me.user.is_admin || state.me.orgs.length > 1;
  return html`
  <div class="shell">
    <aside class="side">
      <div class="logo"><span class="logo-mark">L</span> Ledgerly</div>
      <div class="org-card"><strong>${s.org.name}</strong><span>${s.org.type_label} · ${s.role}</span></div>
      <nav class="nav" aria-label="Main">
        ${link('dashboard', 'Dashboard')}
        ${link('transactions', 'Transactions')}
        <div class="label">Reports</div>
        ${link('reports/profit-loss', 'Profit & Loss')}
        ${link('reports/balance-sheet', 'Balance Sheet')}
        ${link('reports/trial-balance', 'Trial Balance')}
        ${isOwner() ? html`<div class="label">Set up</div>
          ${link('accounts', 'Chart of accounts')}
          ${link('fields', 'Custom fields')}
          ${link('team', 'Team')}
          ${s.org.type === 'school' ? link('online', 'Online payments') : ''}
          ${link('billing', 'Billing')}
          ${link('settings', 'Settings')}` : html`${link('accounts', 'Accounts')}`}
      </nav>
      <div class="side-foot">
        <span>${state.me.user.name}</span>
        ${multi ? html`<a class="btn" href="#/">${state.me.user.is_admin ? 'All clients' : 'Switch organisation'}</a>` : ''}
        <button data-action="logout">Log out</button>
      </div>
    </aside>
    <main class="main">
      ${billingBanner(id)}
      <div class="page-head">
        <div><h1>${title}</h1>${sub ? html`<div class="sub">${sub}</div>` : ''}</div>
        <div class="actions">${actions}</div>
      </div>
      ${body}
    </main>
  </div>`;
}

const recordButtons = () => canWrite() ? html`
  <button class="btn btn-primary" data-action="record" data-kind="income">+ Money in</button>
  <button class="btn btn-primary" data-action="record" data-kind="expense">+ Money out</button>
  <button data-action="record" data-kind="transfer">Move money</button>` : '';

async function viewOrg(id, sub) {
  const [page, ...rest] = sub.split('/');
  const view = {
    dashboard: pageDashboard, transactions: pageTransactions, accounts: pageAccounts, fields: pageFields,
    team: pageTeam, settings: pageSettings, reports: pageReports, ledger: pageLedger,
    billing: pageBilling, online: pageOnline,
  }[page];
  if (!view) { location.hash = `#/org/${id}/dashboard`; return; }
  if (['fields', 'team', 'settings', 'billing', 'online'].includes(page) && !isOwner()) { location.hash = `#/org/${id}/dashboard`; return; }
  const out = await view(id, rest, sub);
  app.innerHTML = shell(id, sub, out).s;
  if (out.after) out.after();
}

/* =====================================================================
   Dashboard
   ===================================================================== */
function barChart(series) {
  const W = 640; const H = 230; const L = 52; const B = 28; const T = 12; const R = 8;
  const max = Math.max(1, ...series.flatMap((s) => [s.income, s.expense]));
  const top = niceMax(max);
  const ph = H - B - T; const pw = W - L - R;
  const gw = pw / series.length; const bw = Math.min(26, gw / 3);
  const y = (v) => T + ph - (Math.max(v, 0) / top) * ph;
  const ticks = [0, .25, .5, .75, 1].map((f) => f * top);
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Income and expenses for the last six months">
    ${ticks.map((v) => html`<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`)}
    ${series.map((s, i) => {
      const cx = L + gw * i + gw / 2;
      return html`
      <rect class="bar-income" x="${cx - bw - 2}" y="${y(s.income)}" width="${bw}" height="${Math.max(0, H - B - y(s.income))}" rx="3"><title>${monthLabel(s.month)} income: ${fmt(s.income)}</title></rect>
      <rect class="bar-expense" x="${cx + 2}" y="${y(s.expense)}" width="${bw}" height="${Math.max(0, H - B - y(s.expense))}" rx="3"><title>${monthLabel(s.month)} expenses: ${fmt(s.expense)}</title></rect>
      <text x="${cx}" y="${H - 8}" text-anchor="middle">${monthLabel(s.month)}</text>`;
    })}
  </svg>`;
}
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function barList(items, cls) {
  const max = Math.max(1, ...items.map((i) => i.balance));
  return html`<div class="bar-list ${cls}">${items.map((i) => html`
    <div class="bl-row"><div class="bl-top"><span>${i.name}</span><strong class="num">${fmt(i.balance)}</strong></div>
    <svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="6" rx="3"/><rect class="fill" width="${Math.max(2, (i.balance / max) * 100)}" height="6" rx="3"/></svg></div>`)}</div>`;
}

async function pageDashboard(id) {
  const [d, recent] = await Promise.all([
    GET(`/api/orgs/${id}/reports/dashboard${qs({ today: todayStr() })}`),
    GET(`/api/orgs/${id}/transactions${qs({ limit: 8 })}`),
  ]);
  const monthName = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const noData = !recent.total;
  return {
    title: 'Dashboard', sub: `${state.setup.org.name} · ${monthName}`, actions: recordButtons(),
    body: html`
    <div class="grid kpis">
      <div class="kpi hero"><div class="k-label">Money on hand</div><div class="k-value">${fmt(d.cash)}</div><div class="k-sub">Cash &amp; bank accounts</div></div>
      <div class="kpi"><div class="k-label">Income this month</div><div class="k-value">${fmt(d.month_income)}</div></div>
      <div class="kpi"><div class="k-label">Expenses this month</div><div class="k-value">${fmt(d.month_expense)}</div></div>
      <div class="kpi"><div class="k-label">Profit this month</div><div class="k-value ${d.month_profit < 0 ? 'neg' : ''}">${fmt(d.month_profit)}</div><div class="k-sub">${d.month_profit < 0 ? 'Spending more than earning' : 'Income minus expenses'}</div></div>
      <div class="kpi"><div class="k-label">Owed to you</div><div class="k-value">${fmt(d.receivable)}</div></div>
      <div class="kpi"><div class="k-label">You owe</div><div class="k-value">${fmt(d.payable)}</div></div>
    </div>
    ${noData ? html`<div class="card empty"><strong>Your books are empty</strong>${canWrite() ? 'Record your first sale or expense using the green buttons above.' : 'Nothing has been recorded yet.'}</div>` : html`
    <div class="grid two-col">
      <div class="card"><div class="card-title"><h2>Last 6 months</h2><div class="legend"><span><i class="li"></i>Income</span><span><i class="le"></i>Expenses</span></div></div>${barChart(d.series)}</div>
      <div class="grid">
        <div class="card"><h2 class="mb-s">Biggest expenses this month</h2>${d.top_expenses.length ? barList(d.top_expenses, 'exp') : html`<p class="muted small">No expenses this month.</p>`}</div>
        <div class="card"><h2 class="mb-s">Top income this month</h2>${d.top_income.length ? barList(d.top_income, 'inc') : html`<p class="muted small">No income this month.</p>`}</div>
      </div>
    </div>
    <div class="card"><div class="card-title"><h2>Recent activity</h2><a href="#/org/${id}/transactions">See all</a></div>${txTable(recent.transactions, { compact: true })}</div>`}`,
  };
}

/* =====================================================================
   Transactions
   ===================================================================== */
function txSummary(t) {
  const dr = t.lines.filter((l) => l.debit > 0);
  const cr = t.lines.filter((l) => l.credit > 0);
  const names = (ls) => ls.map((l) => l.name).join(', ');
  if (t.kind === 'income') return { main: names(cr), flow: `into ${names(dr)}` };
  if (t.kind === 'expense') return { main: names(dr), flow: `from ${names(cr)}` };
  return { main: 'Moved money', flow: `${names(cr)} → ${names(dr)}` };
}
function customChips(t) {
  const labels = Object.fromEntries(state.setup.fields.map((f) => [f.key, f.label]));
  const entries = Object.entries(t.custom || {}).filter(([, v]) => v !== '');
  if (!entries.length) return '';
  return html`<div class="chips">${entries.map(([k, v]) => html`<span class="chip">${labels[k] || k}: ${v}</span>`)}</div>`;
}
function txTable(list, { compact: isCompact = false } = {}) {
  if (!list.length) return html`<div class="empty"><strong>No transactions found</strong>Try changing the filters.</div>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>What</th>${isCompact ? '' : html`<th>Details</th>`}<th class="num">Amount</th>${isCompact || !canWrite() ? '' : html`<th></th>`}</tr></thead>
    <tbody>${list.map((t) => {
      const s = txSummary(t);
      const sign = t.kind === 'income' ? '+' : t.kind === 'expense' ? '−' : '';
      return html`<tr class="${t.voided ? 'voided' : ''}">
        <td class="small nowrap">${niceDate(t.date)}</td>
        <td><strong>${t.description || s.main}</strong><div class="small muted">${t.description ? s.main + ' · ' : ''}${s.flow}${t.reference ? ' · Ref ' + t.reference : ''}</div>${customChips(t)}</td>
        ${isCompact ? '' : html`<td class="small muted">${t.created_by ? 'by ' + t.created_by : ''}${t.voided ? html` <span class="badge red">Voided</span>` : ''}</td>`}
        <td class="num ${t.kind === 'income' ? 'pos' : t.kind === 'expense' ? 'neg' : ''}"><strong>${sign}${fmt(t.amount)}</strong></td>
        ${isCompact || !canWrite() ? '' : html`<td class="num">${t.voided ? '' : html`<button class="btn-sm btn-danger" data-action="void" data-id="${t.id}">Void</button>`}</td>`}
      </tr>`;
    })}</tbody></table></div>`;
}

const PAGE = 25;
async function pageTransactions(id) {
  const f = state.tx;
  const accounts = state.setup.accounts;
  return {
    title: 'Transactions', sub: 'Every sale, expense and transfer. Nothing is ever deleted: mistakes are voided so there’s a trail.', actions: recordButtons(),
    body: html`
    <div class="card">
      <div class="filters">
        <div class="field"><label for="f-from">From</label><input id="f-from" type="date" value="${f.from || ''}" data-change="txfilter" data-key="from"></div>
        <div class="field"><label for="f-to">To</label><input id="f-to" type="date" value="${f.to || ''}" data-change="txfilter" data-key="to"></div>
        <div class="field"><label for="f-kind">Type</label><select id="f-kind" data-change="txfilter" data-key="kind">
          <option value="">All</option>${[['income', 'Money in'], ['expense', 'Money out'], ['transfer', 'Moved money']].map(([v, l]) => html`<option value="${v}" ${f.kind === v ? raw('selected') : ''}>${l}</option>`)}</select></div>
        <div class="field"><label for="f-acct">Account</label><select id="f-acct" data-change="txfilter" data-key="account_id"><option value="">All</option>${optionList(accounts, f.account_id)}</select></div>
        <div class="field"><label for="f-q">Search</label><input id="f-q" type="search" placeholder="Description, ref, details…" value="${f.q || ''}" data-input="txsearch"></div>
        <div class="field"><label class="check"><input type="checkbox" data-change="txfilter" data-key="voided" ${f.voided ? raw('checked') : ''}> Show voided</label></div>
      </div>
      <div class="card-title no-print"><span class="muted small" id="tx-count"></span><a class="btn btn-sm" id="tx-csv" href="#">Download CSV (opens in Excel)</a></div>
      <div id="tx-results"><p class="muted">Loading…</p></div>
    </div>`,
    after: loadTxResults,
  };
}
function txQuery() {
  const f = state.tx;
  return { from: f.from, to: f.to, kind: f.kind, account_id: f.account_id, q: f.q, voided: f.voided };
}
async function loadTxResults() {
  const box = $('#tx-results');
  if (!box) return;
  const id = state.setupOrgId;
  try {
    const r = await GET(`/api/orgs/${id}/transactions${qs({ ...txQuery(), limit: PAGE, offset: state.tx.offset })}`);
    const off = state.tx.offset;
    box.innerHTML = html`${txTable(r.transactions)}
      ${r.total > PAGE ? html`<div class="pager"><button data-action="txpage" data-dir="-1" ${off === 0 ? raw('disabled') : ''}>← Newer</button>
        <span class="muted small">${off + 1}–${Math.min(off + PAGE, r.total)} of ${r.total}</span>
        <button data-action="txpage" data-dir="1" ${off + PAGE >= r.total ? raw('disabled') : ''}>Older →</button></div>` : ''}`.s;
    const c = $('#tx-count'); if (c) c.textContent = `${r.total} transaction${r.total === 1 ? '' : 's'}`;
    const csv = $('#tx-csv'); if (csv) csv.href = `/api/orgs/${id}/transactions.csv${qs(txQuery())}`;
  } catch (err) { box.innerHTML = html`<div class="error">${err.message}</div>`.s; }
}

/* ---------- record a transaction ---------- */
const KIND_INFO = {
  income: { title: 'Money in', cat: 'What was it for?', money: 'Where did the money go?', hint: 'Sales, fees received, grants…' },
  expense: { title: 'Money out', cat: 'What was it for?', money: 'Where did the money come from?', hint: 'Feed, wages, rent, repairs… Choose “Suppliers We Owe” if you haven’t paid yet.' },
  transfer: { title: 'Move money', cat: '', money: '', hint: 'Bank deposits, loans, owner putting in or taking out money, customers paying what they owed, paying suppliers.' },
};
function customFieldInputs(values = {}) {
  return state.setup.fields.map((f) => {
    const id = `cf-${f.key}`;
    let input;
    if (f.type === 'select') input = html`<select id="${id}" name="cf_${f.key}"><option value="">—</option>${f.options.map((o) => html`<option ${values[f.key] === o ? raw('selected') : ''}>${o}</option>`)}</select>`;
    else input = html`<input id="${id}" name="cf_${f.key}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" ${f.type === 'number' ? raw('step="any"') : ''} value="${values[f.key] || ''}" ${f.required ? raw('required') : ''}>`;
    return html`<div class="field"><label for="${id}">${f.label}${f.required ? ' *' : ''}</label>${input}</div>`;
  });
}
function recordForm(kind, keep = {}) {
  const info = KIND_INFO[kind];
  const cashFirst = (list) => [...list.filter((a) => a.tag === 'cash'), ...list.filter((a) => a.tag !== 'cash')];
  let selects;
  if (kind === 'income') {
    selects = html`
      <div class="field"><label for="r-cat">${info.cat}</label><select id="r-cat" name="account_id" required>${optionList(activeAccounts(['income']), keep.account_id)}</select></div>
      <div class="field"><label for="r-money">${info.money}</label><select id="r-money" name="money_account_id" required>${optionList(cashFirst(activeAccounts(['asset'])), keep.money_account_id)}</select>
        <div class="hint">Pick “Customers Owing Us” for a sale on credit.</div></div>`;
  } else if (kind === 'expense') {
    const assets = activeAccounts(['asset']);
    selects = html`
      <div class="field"><label for="r-cat">${info.cat}</label><select id="r-cat" name="account_id" required>
        <optgroup label="Expenses">${optionList(activeAccounts(['expense']), keep.account_id)}</optgroup>
        <optgroup label="Buying stock or equipment">${optionList(assets.filter((a) => !a.tag), keep.account_id)}</optgroup></select></div>
      <div class="field"><label for="r-money">${info.money}</label><select id="r-money" name="money_account_id" required>
        <optgroup label="Paid now from">${optionList(cashFirst(assets.filter((a) => a.tag === 'cash')), keep.money_account_id)}</optgroup>
        <optgroup label="Bought on credit">${optionList(activeAccounts(['liability']), keep.money_account_id)}</optgroup></select></div>`;
  } else {
    const opts = (sel) => ['asset', 'liability', 'equity'].map((t) => html`<optgroup label="${TYPE_LABELS[t]}">${optionList(activeAccounts([t]), sel)}</optgroup>`);
    selects = html`
      <div class="row">
        <div class="field"><label for="r-from">Money comes from</label><select id="r-from" name="from_account_id" required>${opts(keep.from_account_id)}</select></div>
        <div class="field"><label for="r-to">Money goes to</label><select id="r-to" name="to_account_id" required>${opts(keep.to_account_id)}</select></div>
      </div>`;
  }
  return html`
    <form data-form="record" data-kind="${kind}" novalidate>
      ${errorBox()}
      <div class="kind-tabs" role="group" aria-label="Transaction type">
        ${['income', 'expense', 'transfer'].map((k) => html`<button type="button" data-action="record-kind" data-kind="${k}" aria-pressed="${k === kind}">${KIND_INFO[k].title}</button>`)}
      </div>
      <p class="muted small">${info.hint}</p>
      <div class="row">
        <div class="field"><label for="r-date">Date</label><input id="r-date" name="date" type="date" value="${keep.date || todayStr()}" required></div>
        <div class="field"><label for="r-amt">Amount (${sym()})</label><input id="r-amt" name="amount" inputmode="decimal" placeholder="0.00" autocomplete="off" required></div>
      </div>
      ${selects}
      <div class="field"><label for="r-desc">Description <span class="muted">(optional)</span></label><input id="r-desc" name="description" maxlength="200" placeholder="e.g. 40 crates of eggs to Mama Tunde"></div>
      <div class="field"><label for="r-ref">Receipt / reference no. <span class="muted">(optional)</span></label><input id="r-ref" name="reference" maxlength="60"></div>
      ${customFieldInputs(keep.custom)}
      <div class="modal-foot">
        <button type="button" data-action="close">Cancel</button>
        <button type="submit" data-again="1">Save &amp; add another</button>
        <button class="btn btn-primary" type="submit">Save</button>
      </div>
    </form>`;
}
function openRecord(kind) {
  if (!canWrite()) return;
  openModal(html`${modalHead('Record a transaction')}${recordForm(kind)}`);
  const amt = $('#r-amt'); if (amt) amt.focus();
}

/* =====================================================================
   Reports
   ===================================================================== */
function reportTabs(id, active) {
  return html`<div class="tabs no-print">${[['profit-loss', 'Profit & Loss'], ['balance-sheet', 'Balance Sheet'], ['trial-balance', 'Trial Balance']]
    .map(([k, l]) => html`<a href="#/org/${id}/reports/${k}" ${k === active ? raw('aria-current="page"') : ''}>${l}</a>`)}</div>`;
}
function repRows(items, id) {
  if (!items.length) return html`<tr><td colspan="2" class="muted small">Nothing recorded.</td></tr>`;
  return items.map((a) => html`<tr><td><a href="#/org/${id}/ledger/${a.id}">${a.code} · ${a.name}</a></td><td class="num">${fmt(a.balance)}</td></tr>`);
}
async function pageReports(id, rest) {
  const which = rest[0] || 'profit-loss';
  const r = state.report;
  if (!r.from) { r.from = yearStart(); r.to = todayStr(); }
  if (!r.as_at) r.as_at = todayStr();
  const printBtn = html`<button data-action="print">Print / Save as PDF</button>`;
  const org = state.setup.org.name;

  if (which === 'profit-loss') {
    const d = await GET(`/api/orgs/${id}/reports/profit-loss${qs({ from: r.from, to: r.to })}`);
    return {
      title: 'Profit & Loss', sub: 'Did the business make money in this period?', actions: printBtn,
      body: html`${reportTabs(id, which)}
      <div class="card report">
        <form class="filters no-print" data-form="range">
          <div class="field"><label for="p-from">From</label><input id="p-from" type="date" name="from" value="${r.from}" required></div>
          <div class="field"><label for="p-to">To</label><input id="p-to" type="date" name="to" value="${r.to}" required></div>
          <div class="field"><button class="btn btn-primary" type="submit">Update</button></div>
          <div class="field"><button type="button" data-action="preset" data-preset="month">This month</button></div>
          <div class="field"><button type="button" data-action="preset" data-preset="year">This year</button></div>
        </form>
        <div class="report-head"><h2>${org}</h2><div>Profit &amp; Loss</div><div class="muted small">${niceDate(d.from)} to ${niceDate(d.to)}</div></div>
        <table>
          <tr class="group"><td colspan="2">Income</td></tr>${repRows(d.income, id)}
          <tr class="total"><td>Total income</td><td class="num">${fmt(d.total_income)}</td></tr>
          <tr class="group"><td colspan="2">Expenses</td></tr>${repRows(d.expenses, id)}
          <tr class="total"><td>Total expenses</td><td class="num">${fmt(d.total_expenses)}</td></tr>
          <tr class="total"><td>${d.net_profit >= 0 ? 'Net profit' : 'Net loss'}</td><td class="num ${d.net_profit >= 0 ? 'pos' : 'neg'}">${fmt(d.net_profit)}</td></tr>
        </table>
      </div>`,
    };
  }

  const asAtForm = html`<form class="filters no-print" data-form="asat">
    <div class="field"><label for="a-date">As at</label><input id="a-date" type="date" name="as_at" value="${r.as_at}" required></div>
    <div class="field"><button class="btn btn-primary" type="submit">Update</button></div></form>`;

  if (which === 'balance-sheet') {
    const d = await GET(`/api/orgs/${id}/reports/balance-sheet${qs({ as_at: r.as_at })}`);
    return {
      title: 'Balance Sheet', sub: 'What the business owns, owes, and is worth.', actions: printBtn,
      body: html`${reportTabs(id, which)}
      <div class="card report">${asAtForm}
        <div class="report-head"><h2>${org}</h2><div>Balance Sheet</div><div class="muted small">As at ${niceDate(d.as_at)}</div></div>
        <table>
          <tr class="group"><td colspan="2">Assets (what we own)</td></tr>${repRows(d.assets, id)}
          <tr class="total"><td>Total assets</td><td class="num">${fmt(d.total_assets)}</td></tr>
          <tr class="group"><td colspan="2">Liabilities (what we owe)</td></tr>${repRows(d.liabilities, id)}
          <tr class="total"><td>Total liabilities</td><td class="num">${fmt(d.total_liabilities)}</td></tr>
          <tr class="group"><td colspan="2">Owner’s equity</td></tr>${repRows(d.equity, id)}
          <tr><td>Profit kept in the business (all time to date)</td><td class="num">${fmt(d.retained_earnings)}</td></tr>
          <tr class="total"><td>Total equity</td><td class="num">${fmt(d.total_equity)}</td></tr>
        </table>
        <p class="mt ${d.balanced ? 'balance-ok' : 'balance-bad'}">${d.balanced ? '✓ Balanced: assets equal liabilities plus equity.' : '⚠ These do not balance. Please contact support.'}</p>
      </div>`,
    };
  }

  const d = await GET(`/api/orgs/${id}/reports/trial-balance${qs({ as_at: r.as_at })}`);
  return {
    title: 'Trial Balance', sub: 'A check that every debit has a matching credit.', actions: printBtn,
    body: html`${reportTabs(id, 'trial-balance')}
    <div class="card report">${asAtForm}
      <div class="report-head"><h2>${org}</h2><div>Trial Balance</div><div class="muted small">As at ${niceDate(d.as_at)}</div></div>
      <table><thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
        ${d.rows.length ? d.rows.map((a) => html`<tr><td><a href="#/org/${id}/ledger/${a.id}">${a.code} · ${a.name}</a></td><td class="num">${a.debit ? fmt(a.debit) : ''}</td><td class="num">${a.credit ? fmt(a.credit) : ''}</td></tr>`)
          : html`<tr><td colspan="3" class="muted small">Nothing recorded yet.</td></tr>`}
        <tr class="total"><td>Totals</td><td class="num">${fmt(d.total_debit)}</td><td class="num">${fmt(d.total_credit)}</td></tr></tbody></table>
      <p class="mt ${d.balanced ? 'balance-ok' : 'balance-bad'}">${d.balanced ? '✓ Debits equal credits.' : '⚠ Debits and credits differ.'}</p>
    </div>`,
  };
}

/* ---------- account ledger ---------- */
async function pageLedger(id, rest) {
  const aid = Number(rest[0]);
  const d = await GET(`/api/orgs/${id}/accounts/${aid}/ledger`);
  return {
    title: `${d.account.code} · ${d.account.name}`, sub: `${TYPE_LABELS[d.account.type]} account · every entry, with a running balance`,
    actions: html`<a class="btn" href="#/org/${id}/accounts">← Accounts</a>`,
    body: html`<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead><tbody>
      ${d.opening ? html`<tr><td colspan="4" class="muted">Opening balance</td><td class="num">${fmt(d.opening)}</td></tr>` : ''}
      ${d.rows.length ? d.rows.map((r) => html`<tr><td class="small">${niceDate(r.date)}</td><td>${r.description || r.kind}${r.reference ? html` <span class="muted small">· Ref ${r.reference}</span>` : ''}</td>
        <td class="num">${r.debit ? fmt(r.debit) : ''}</td><td class="num">${r.credit ? fmt(r.credit) : ''}</td><td class="num">${fmt(r.balance)}</td></tr>`)
        : html`<tr><td colspan="5" class="muted">No entries yet.</td></tr>`}
      <tr class="total"><td colspan="4">Closing balance</td><td class="num">${fmt(d.closing)}</td></tr></tbody></table></div></div>`,
  };
}

/* =====================================================================
   Chart of accounts
   ===================================================================== */
async function pageAccounts(id) {
  const accts = state.setup.accounts;
  const owner = isOwner();
  return {
    title: 'Chart of accounts', sub: owner ? 'The list of places money can come from or go to. Rename, add or switch off anything to suit this business.' : 'The list of accounts used by this business.',
    actions: owner ? html`<button class="btn btn-primary" data-action="new-account">+ Add account</button>` : '',
    body: html`${['asset', 'liability', 'equity', 'income', 'expense'].map((t) => {
      const list = accts.filter((a) => a.type === t);
      return html`<div class="card"><div class="card-title"><div><h2>${TYPE_LABELS[t]}</h2><div class="muted small">${TYPE_HELP[t]}</div></div></div>
        ${list.length ? html`<div class="table-wrap"><table><tbody>${list.map((a) => html`<tr class="${a.active ? '' : 'dim'}">
          <td class="muted w-code">${a.code}</td>
          <td><a href="#/org/${id}/ledger/${a.id}">${a.name}</a> ${a.tag ? html`<span class="badge amber">${TAG_LABELS[a.tag]}</span>` : ''} ${a.active ? '' : html`<span class="badge grey">Switched off</span>`}</td>
          <td class="num">${owner ? html`<button class="btn-sm" data-action="edit-account" data-id="${a.id}">Edit</button>` : ''}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted small">No accounts of this type.</p>`}</div>`;
    })}`,
  };
}
function tagOptions(type, current) {
  const tags = type === 'asset' ? ['cash', 'receivable'] : type === 'liability' ? ['payable'] : [];
  if (!tags.length) return '';
  return html`<div class="field"><label for="ac-tag">Special role <span class="muted">(optional)</span></label><select id="ac-tag" name="tag">
    <option value="">None</option>${tags.map((t) => html`<option value="${t}" ${current === t ? raw('selected') : ''}>${TAG_LABELS[t]}</option>`)}</select>
    <div class="hint">Used on the dashboard: cash/bank adds up to “Money on hand”.</div></div>`;
}
function nextCode(type) {
  const base = { asset: 1000, liability: 2000, equity: 3000, income: 4000, expense: 5000 }[type];
  const used = state.setup.accounts.filter((a) => a.type === type).map((a) => parseInt(a.code, 10)).filter((n) => Number.isFinite(n));
  let n = used.length ? Math.max(...used) + 10 : base;
  const all = new Set(state.setup.accounts.map((a) => a.code));
  while (all.has(String(n))) n += 1;
  return String(n);
}
function openAccountModal(acct) {
  const editing = !!acct;
  const type = acct ? acct.type : 'income';
  openModal(html`${modalHead(editing ? 'Edit account' : 'Add an account')}
    <form data-form="account" data-id="${acct ? acct.id : ''}" novalidate>
      ${errorBox()}
      ${editing ? html`<p class="muted small">${TYPE_LABELS[acct.type]} account. The type can’t be changed once created, so past reports stay correct.</p>`
        : html`<div class="field"><label for="ac-type">Type</label><select id="ac-type" name="type" data-change="acct-type">
          ${Object.keys(TYPE_LABELS).map((t) => html`<option value="${t}" ${t === type ? raw('selected') : ''}>${TYPE_LABELS[t]} — ${TYPE_HELP[t]}</option>`)}</select></div>`}
      <div class="row">
        <div class="field"><label for="ac-code">Code</label><input id="ac-code" name="code" maxlength="12" value="${acct ? acct.code : nextCode(type)}" required></div>
        <div class="field"><label for="ac-name">Name</label><input id="ac-name" name="name" maxlength="80" value="${acct ? acct.name : ''}" placeholder="e.g. Egg Crate Sales" required></div>
      </div>
      <div id="ac-tag-wrap">${tagOptions(type, acct ? acct.tag : '')}</div>
      ${editing ? html`<div class="field"><label class="check"><input type="checkbox" name="active" ${acct.active ? raw('checked') : ''}> Active (available when recording transactions)</label>
        <div class="hint">Switching off hides it from new entries but keeps all past records.</div></div>` : ''}
      <div class="modal-foot"><button type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Add account'}</button></div>
    </form>`);
}

/* =====================================================================
   Custom fields
   ===================================================================== */
async function pageFields(id) {
  const { fields } = await GET(`/api/orgs/${id}/fields`);
  state.allFields = fields;
  const FT = { text: 'Text', number: 'Number', select: 'Drop-down list', date: 'Date' };
  return {
    title: 'Custom fields', sub: 'Extra questions asked on every transaction for this client (e.g. Flock / Batch for a farm, Class for a school).',
    actions: html`<button class="btn btn-primary" data-action="new-field">+ Add field</button>`,
    body: html`<div class="card">${fields.length ? html`<div class="table-wrap"><table>
      <thead><tr><th>Label</th><th>Type</th><th>Choices</th><th>Required</th><th></th></tr></thead><tbody>
      ${fields.map((f) => html`<tr class="${f.active ? '' : 'dim'}"><td><strong>${f.label}</strong> ${f.active ? '' : html`<span class="badge grey">Hidden</span>`}</td><td>${FT[f.type]}</td>
        <td class="small muted">${f.type === 'select' ? f.options.join(', ') : '—'}</td><td>${f.required ? 'Yes' : 'No'}</td>
        <td class="num"><button class="btn-sm" data-action="edit-field" data-id="${f.id}">Edit</button>
          <button class="btn-sm" data-action="toggle-field" data-id="${f.id}" data-active="${f.active ? 0 : 1}">${f.active ? 'Hide' : 'Show'}</button></td></tr>`)}
      </tbody></table></div>`
      : html`<div class="empty"><strong>No custom fields yet</strong>Add fields to capture whatever this business needs to track.</div>`}</div>
      <p class="muted small mt">Hiding a field removes it from the entry form but keeps the data already saved.</p>`,
  };
}
function openFieldModal(f) {
  const editing = !!f;
  openModal(html`${modalHead(editing ? 'Edit field' : 'Add a custom field')}
    <form data-form="field" data-id="${f ? f.id : ''}" novalidate>
      ${errorBox()}
      <div class="field"><label for="cf-label">Label</label><input id="cf-label" name="label" maxlength="60" value="${f ? f.label : ''}" placeholder="e.g. Flock / Batch" required></div>
      <div class="field"><label for="cf-type">Answer type</label>
        <select id="cf-type" name="type" data-change="field-type" ${editing ? raw('disabled') : ''}>
          ${[['text', 'Text'], ['number', 'Number'], ['select', 'Drop-down list'], ['date', 'Date']].map(([v, l]) => html`<option value="${v}" ${f && f.type === v ? raw('selected') : ''}>${l}</option>`)}</select>
        ${editing ? html`<div class="hint">The type can’t be changed after creation.</div>` : ''}</div>
      <div class="field" id="cf-opts" ${f && f.type === 'select' ? '' : raw('hidden')}><label for="cf-options">Choices (separate with commas)</label>
        <textarea id="cf-options" name="options" placeholder="Crates, Birds, Bags">${f ? f.options.join(', ') : ''}</textarea></div>
      <div class="field"><label class="check"><input type="checkbox" name="required" ${f && f.required ? raw('checked') : ''}> Required on every transaction</label></div>
      <div class="modal-foot"><button type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Add field'}</button></div>
    </form>`);
}

/* =====================================================================
   Team & settings
   ===================================================================== */
async function pageTeam(id) {
  const { members, invites } = await GET(`/api/orgs/${id}/members`);
  return {
    title: 'Team', sub: 'Who can see and change this client’s books.',
    actions: html`<button class="btn btn-primary" data-action="new-member">+ Add person</button>`,
    body: html`<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
      ${members.map((m) => html`<tr><td>${m.name}</td><td>${m.email}</td>
        <td><select data-change="member-role" data-email="${m.email}" aria-label="Role for ${m.name}">${Object.entries(ROLE_LABELS).map(([v, l]) => html`<option value="${v}" ${m.role === v ? raw('selected') : ''}>${l}</option>`)}</select></td>
        <td class="num"><button class="btn-sm btn-danger" data-action="remove-member" data-id="${m.id}" data-name="${m.name}">Remove</button></td></tr>`)}
      ${invites.map((i) => html`<tr><td class="muted">Not signed up yet</td><td>${i.email}</td><td><span class="badge amber">Invited · ${i.role}</span></td>
        <td class="num"><button class="btn-sm" data-action="cancel-invite" data-email="${i.email}">Cancel</button></td></tr>`)}
      ${!members.length && !invites.length ? html`<tr><td colspan="4" class="muted">Nobody has been added yet.</td></tr>` : ''}
      </tbody></table></div></div>
      <p class="muted small mt">If you add an email that hasn’t signed up yet, access is granted automatically when they create their account with that email.</p>`,
  };
}
async function pageSettings(id) {
  const { currencies } = await GET('/api/templates');
  const o = state.setup.org;
  return {
    title: 'Settings', sub: o.type_label,
    body: html`<div class="card max-520"><form data-form="settings" novalidate>${errorBox()}
      <div class="field"><label for="s-name">Business name</label><input id="s-name" name="name" maxlength="100" value="${o.name}" required></div>
      <div class="field"><label for="s-cur">Currency</label><select id="s-cur" name="currency">${currencies.map((c) => html`<option ${c === o.currency ? raw('selected') : ''}>${c}</option>`)}</select>
        <div class="hint">Changing currency only changes the symbol shown. It does not convert existing amounts.</div></div>
      <button class="btn btn-primary" type="submit">Save</button></form></div>`,
  };
}

/* =====================================================================
   Billing (subscription)
   ===================================================================== */
function planBadge(plan) {
  if (!plan) return '';
  if (plan.status === 'exempt') return html`<span class="badge grey">Free</span>`;
  if (plan.status === 'active') return html`<span class="badge ok">Paid · ${plan.days_left}d left</span>`;
  if (plan.status === 'trial') return html`<span class="badge amber">Trial · ${plan.days_left}d left</span>`;
  return html`<span class="badge red">Expired</span>`;
}
function billingBanner(id) {
  const b = state.setup && state.setup.billing;
  if (!b || b.status === 'active' || b.status === 'exempt') return '';
  const renew = isOwner() ? html` <a href="#/org/${id}/billing">Renew now</a>` : ' Please ask the owner to renew.';
  if (b.status === 'expired') {
    return html`<div class="banner bad" role="alert">The free trial has ended, so new entries are paused. You can still view and download everything.${renew}</div>`;
  }
  if (b.days_left <= 7) {
    return html`<div class="banner" role="status">Your free trial ends in ${b.days_left} day${b.days_left === 1 ? '' : 's'}.${renew}</div>`;
  }
  return '';
}
async function pageBilling(id) {
  const b = await GET(`/api/orgs/${id}/billing`);
  const m = (n) => `${n} month${n === 1 ? '' : 's'}`;
  const statusText = {
    trial: html`Free trial: <strong>${b.days_left} day${b.days_left === 1 ? '' : 's'} left</strong> (ends ${niceDate(b.until)})`,
    active: html`Subscription active until <strong>${niceDate(b.until)}</strong> (${b.days_left} day${b.days_left === 1 ? '' : 's'} left)`,
    expired: html`<strong class="neg">Ended${b.until ? ' on ' + niceDate(b.until) : ''}.</strong> You can view and download your records, but new entries are paused.`,
    exempt: html`This organisation has free access.`,
  }[b.status];
  return {
    title: 'Billing', sub: 'Your Ledgerly subscription',
    body: html`
    <div class="card">
      <h2 class="mb-s">Plan status</h2>
      <p>${statusText}</p>
      <p class="muted small">Price: <strong>${fmt(b.price_month, 'NGN')}</strong> per month. Paying early adds time to the end of your current period.</p>
    </div>
    ${b.exempt ? '' : html`<div class="card">
      <h2>Pay for more time</h2>
      ${b.payments_enabled ? html`
      <div class="plan-grid">${b.months.map((n) => html`<button class="plan-opt" data-action="checkout" data-months="${n}"><strong>${m(n)}</strong><span>${fmt(b.price_month * n, 'NGN')}</span></button>`)}</div>
      <p class="muted small mt">You’ll be taken to Paystack to pay by card, bank transfer or USSD, then brought back here.</p>`
      : html`<p class="muted">Online payment isn’t switched on yet. Please contact the platform admin to pay by bank transfer.</p>`}
    </div>`}
    ${b.is_admin ? html`<div class="card">
      <h2 class="mb-s">Platform admin controls</h2>
      <form data-form="billing-admin" class="row" novalidate>
        ${errorBox()}
        <div class="field"><label for="ba-days">Add free days</label><input id="ba-days" name="add_days" type="number" min="1" max="3650" placeholder="e.g. 30"><div class="hint">For clients who paid by bank transfer.</div></div>
        <div class="field"><label for="ba-price">Monthly price (₦)</label><input id="ba-price" name="plan_price" inputmode="decimal" value="${b.custom_price ? (b.price_month / 100).toFixed(2) : ''}" placeholder="Default ${(b.default_price / 100).toLocaleString()}"><div class="hint">Leave blank for the standard price.</div></div>
        <div class="field"><label class="check"><input type="checkbox" name="exempt" ${b.exempt ? raw('checked') : ''}> Free account (never expires)</label></div>
        <div class="field"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Save</button></div>
      </form>
    </div>` : ''}
    ${b.payments.length ? html`<div class="card"><h2 class="mb-s">Payment history</h2><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>For</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
      ${b.payments.map((p) => html`<tr><td class="small">${niceDate((p.paid_at || p.created_at || '').slice(0, 10))}</td>
        <td>${p.kind === 'manual' ? 'Time added by admin' : m(p.months)}</td>
        <td><span class="badge ${p.status === 'success' ? 'ok' : p.status === 'pending' ? 'amber' : 'red'}">${p.status}</span></td>
        <td class="num">${p.kind === 'manual' ? '—' : fmt(p.amount, 'NGN')}</td></tr>`)}
      </tbody></table></div></div>` : ''}`,
  };
}

/* =====================================================================
   School online payments (portal settings)
   ===================================================================== */
function itemRow(it, accounts) {
  return html`<div class="item-row">
    <div class="field"><label>Fee name</label><input name="item_label" maxlength="60" value="${it.label || ''}" placeholder="e.g. Tuition"></div>
    <div class="field"><label>Goes to income account</label><select name="item_account">${accounts.map((a) => html`<option value="${a.id}" ${a.id === it.account_id ? raw('selected') : ''}>${a.code} · ${a.name}</option>`)}</select></div>
    <div class="field"><label>Fixed amount (₦)</label><input name="item_amount" inputmode="decimal" value="${it.amount ? (it.amount / 100).toFixed(2) : ''}" placeholder="Parent types it"></div>
    <div class="field"><button type="button" class="btn-sm btn-danger" data-action="remove-item">Remove</button></div>
    <input type="hidden" name="item_id" value="${it.id || ''}">
  </div>`;
}
async function pageOnline(id) {
  const d = await GET(`/api/orgs/${id}/portal`);
  state.portalAccounts = d.income_accounts;
  const link = d.slug ? `${d.base_url}/pay/${d.slug}` : '';
  const ready = d.enabled && d.subaccount && d.payments_enabled;
  return {
    title: 'Online payments', sub: 'Let parents pay fees online. Each payment lands in your books automatically, tagged with the student.',
    body: html`
    ${!d.payments_enabled ? html`<div class="banner">Online payments are not switched on for the platform yet (no Paystack key). Contact the platform admin.</div>` : ''}
    ${d.enabled && !d.subaccount ? html`<div class="banner">Almost there: the platform admin still needs to link your school’s bank account before parents can pay.</div>` : ''}
    ${ready ? html`<div class="card"><h2 class="mb-s">Your payment page is live</h2>
      <div class="copy-box"><code id="portal-link">${link}</code><button type="button" class="btn-sm" data-action="copy-link" data-link="${link}">Copy</button></div>
      <p class="muted small mt">Share this link with parents (WhatsApp, newsletters, fee notices).</p></div>` : ''}
    <div class="card">
      <form data-form="portal" novalidate>
        ${errorBox()}
        <div class="field"><label class="check"><input type="checkbox" name="enabled" ${d.enabled ? raw('checked') : ''}> Turn the online payment page on</label></div>
        <div class="field"><label for="po-slug">Web address</label>
          <input id="po-slug" name="slug" maxlength="40" value="${d.slug}" placeholder="e.g. greenhills">
          <div class="hint">Parents will visit ${d.base_url}/pay/<strong>this-name</strong>. Lowercase letters, numbers and hyphens.</div></div>
        <div class="field"><label for="po-note">Message to parents <span class="muted">(optional)</span></label><textarea id="po-note" name="note" maxlength="500" placeholder="e.g. Please use your child’s full name. Receipts are sent by email.">${d.note}</textarea></div>
        ${d.is_admin ? html`<div class="field"><label for="po-sub">Paystack subaccount code <span class="muted">(platform admin only)</span></label>
          <input id="po-sub" name="subaccount" value="${d.subaccount}" placeholder="ACCT_xxxxxxxxxx">
          <div class="hint">Create the school’s subaccount in your Paystack dashboard (Settings → Subaccounts) with the school’s bank details, then paste its code here. This decides where the money is paid out.</div></div>` : ''}
        <h3 class="mb-s">What can parents pay for?</h3>
        <div id="items">${d.items.map((it) => itemRow(it, d.income_accounts))}</div>
        <p><button type="button" data-action="add-item">+ Add a fee item</button></p>
        <p class="muted small">Leave the fixed amount blank to let parents type an amount (for part-payments). Fill it in for set fees such as an exam fee.</p>
        <button class="btn btn-primary" type="submit">Save</button>
      </form>
    </div>
    <div class="card"><h2 class="mb-s">Payments received online</h2>
      ${d.payments.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Student</th><th>For</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
        ${d.payments.map((p) => html`<tr><td class="small nowrap">${niceDate((p.paid_at || p.created_at || '').slice(0, 10))}</td>
          <td><strong>${p.student}</strong><div class="small muted">${[p.student_class, p.term].filter(Boolean).join(' · ')}</div></td>
          <td>${p.item_label}</td>
          <td><span class="badge ${p.status === 'success' ? 'ok' : p.status === 'pending' ? 'amber' : 'red'}">${p.status === 'pending' ? 'not completed' : p.status}</span></td>
          <td class="num">${fmt(p.amount)}</td></tr>`)}</tbody></table></div>
        <p class="muted small mt">Paid amounts appear in the books under “Online Payments (Paystack)”. When Paystack pays out to your bank, record it under <strong>Move money</strong> from that account to your bank account.</p>`
        : html`<p class="muted">Nothing yet. Once parents start paying, you’ll see every payment here.</p>`}
    </div>`,
  };
}

/* =====================================================================
   Events (delegated, because the CSP forbids inline handlers)
   ===================================================================== */
const actions = {
  close: closeModal,
  overlay: (el, e) => { if (e.target === el) closeModal(); },
  logout: async () => {
    try { await POST('/api/logout'); } catch { /* ignore */ }
    state.me = null; state.setup = null; state.setupOrgId = null; location.hash = '#/login'; render();
  },
  'new-client': () => openNewClient().catch((e) => toast(e.message, true)),
  record: (el) => openRecord(el.dataset.kind),
  'record-kind': (el) => {
    const form = el.closest('form');
    const keep = { date: form.date.value };
    $('.modal').innerHTML = html`${modalHead('Record a transaction')}${recordForm(el.dataset.kind, keep)}`.s;
    $('#r-amt').focus();
  },
  void: async (el) => {
    if (!confirm('Void this transaction? It will be removed from all totals but kept in the history.')) return;
    try { await DEL(`/api/orgs/${state.setupOrgId}/transactions/${el.dataset.id}`); toast('Transaction voided'); render(); } catch (e) { toast(e.message, true); }
  },
  txpage: (el) => { state.tx.offset = Math.max(0, state.tx.offset + Number(el.dataset.dir) * PAGE); loadTxResults(); },
  print: () => window.print(),
  preset: (el) => {
    const r = state.report;
    if (el.dataset.preset === 'month') { r.from = monthStart(); r.to = todayStr(); } else { r.from = yearStart(); r.to = todayStr(); }
    render();
  },
  'new-account': () => openAccountModal(null),
  'edit-account': (el) => openAccountModal(state.setup.accounts.find((a) => a.id === Number(el.dataset.id))),
  'new-field': () => openFieldModal(null),
  'edit-field': (el) => openFieldModal(state.allFields.find((f) => f.id === Number(el.dataset.id))),
  'toggle-field': async (el) => {
    try { await PUT(`/api/orgs/${state.setupOrgId}/fields/${el.dataset.id}`, { active: el.dataset.active === '1' }); await refreshSetup(); render(); } catch (e) { toast(e.message, true); }
  },
  'new-member': () => openModal(html`${modalHead('Add a person')}
    <form data-form="member" novalidate>${errorBox()}
      <div class="field"><label for="m-email">Email</label><input id="m-email" name="email" type="email" required></div>
      <div class="field"><label for="m-role">Role</label><select id="m-role" name="role">${Object.entries(ROLE_LABELS).map(([v, l]) => html`<option value="${v}" ${v === 'accountant' ? raw('selected') : ''}>${l}</option>`)}</select></div>
      <div class="modal-foot"><button type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">Add</button></div></form>`),
  'remove-member': async (el) => {
    if (!confirm(`Remove ${el.dataset.name} from this organisation?`)) return;
    try { await DEL(`/api/orgs/${state.setupOrgId}/members/${el.dataset.id}`); toast('Removed'); render(); } catch (e) { toast(e.message, true); }
  },
  checkout: async (el) => {
    el.disabled = true;
    try { const r = await POST(`/api/orgs/${state.setupOrgId}/billing/checkout`, { months: Number(el.dataset.months) }); location.assign(r.url); }
    catch (e) { toast(e.message, true); el.disabled = false; }
  },
  'add-item': () => {
    $('#items').insertAdjacentHTML('beforeend', itemRow({}, state.portalAccounts).s);
  },
  'remove-item': (el) => { el.closest('.item-row').remove(); },
  'copy-link': async (el) => {
    try { await navigator.clipboard.writeText(el.dataset.link); toast('Link copied'); } catch { toast('Select the link and copy it manually.', true); }
  },
  'cancel-invite': async (el) => {
    try { await DEL(`/api/orgs/${state.setupOrgId}/invites${qs({ email: el.dataset.email })}`); render(); } catch (e) { toast(e.message, true); }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
});

let searchTimer;
document.addEventListener('input', (e) => {
  if (e.target.dataset.input === 'txsearch') {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.tx.q = e.target.value.trim(); state.tx.offset = 0; loadTxResults(); }, 300);
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  const kind = el.dataset.change;
  if (!kind) return;
  if (kind === 'txfilter') {
    state.tx[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
    state.tx.offset = 0; loadTxResults();
  } else if (kind === 'acct-type') {
    const form = el.closest('form');
    form.code.value = nextCode(el.value);
    $('#ac-tag-wrap').innerHTML = tagOptions(el.value, '').s;
  } else if (kind === 'field-type') {
    $('#cf-opts').hidden = el.value !== 'select';
  } else if (kind === 'member-role') {
    try { await POST(`/api/orgs/${state.setupOrgId}/members`, { email: el.dataset.email, role: el.value }); toast('Role updated'); } catch (err) { toast(err.message, true); render(); }
  }
});

const forms = {
  async login(form) {
    const d = Object.fromEntries(new FormData(form));
    await POST('/api/login', d);
    state.me = null; location.hash = '#/'; await render();
  },
  async signup(form) {
    const d = Object.fromEntries(new FormData(form));
    await POST('/api/signup', d);
    state.me = null; location.hash = '#/'; await render();
  },
  async 'new-client'(form) {
    const d = Object.fromEntries(new FormData(form));
    const r = await POST('/api/orgs', d);
    closeModal();
    toast(r.owner_status === 'invited' ? 'Client created. The owner gets access when they sign up.' : 'Client created');
    state.setupOrgId = null; location.hash = `#/org/${r.id}/accounts`;
  },
  async record(form, e) {
    const again = e.submitter && e.submitter.dataset.again === '1';
    const kind = form.dataset.kind;
    const d = Object.fromEntries(new FormData(form));
    const body = { kind, date: d.date, amount: d.amount, description: d.description, reference: d.reference, custom: {} };
    for (const [k, v] of Object.entries(d)) if (k.startsWith('cf_')) body.custom[k.slice(3)] = v;
    if (kind === 'transfer') { body.from_account_id = d.from_account_id; body.to_account_id = d.to_account_id; } else { body.account_id = d.account_id; body.money_account_id = d.money_account_id; }
    await POST(`/api/orgs/${state.setupOrgId}/transactions`, body);
    toast('Saved');
    if (again) {
      const keep = { date: d.date, account_id: d.account_id, money_account_id: d.money_account_id, from_account_id: d.from_account_id, to_account_id: d.to_account_id, custom: body.custom };
      $('.modal').innerHTML = html`${modalHead('Record a transaction')}${recordForm(kind, keep)}`.s;
      $('#r-amt').focus();
      if (/#\/org\/\d+\/(transactions|dashboard)/.test(location.hash)) render();
    } else { closeModal(); render(); }
  },
  async account(form) {
    const d = Object.fromEntries(new FormData(form));
    const id = form.dataset.id;
    if (id) await PUT(`/api/orgs/${state.setupOrgId}/accounts/${id}`, { code: d.code, name: d.name, tag: d.tag || null, active: form.active.checked });
    else await POST(`/api/orgs/${state.setupOrgId}/accounts`, { code: d.code, name: d.name, type: d.type, tag: d.tag || null });
    await refreshSetup(); closeModal(); toast('Saved'); render();
  },
  async field(form) {
    const d = Object.fromEntries(new FormData(form));
    const id = form.dataset.id;
    const body = { label: d.label, type: d.type, options: d.options || '', required: form.required.checked };
    if (id) await PUT(`/api/orgs/${state.setupOrgId}/fields/${id}`, body);
    else await POST(`/api/orgs/${state.setupOrgId}/fields`, body);
    await refreshSetup(); closeModal(); toast('Saved'); render();
  },
  async member(form) {
    const d = Object.fromEntries(new FormData(form));
    const r = await POST(`/api/orgs/${state.setupOrgId}/members`, d);
    closeModal(); toast(r.status === 'added' ? 'Person added' : 'Invitation saved. Access starts when they sign up.'); render();
  },
  async settings(form) {
    const d = Object.fromEntries(new FormData(form));
    await PUT(`/api/orgs/${state.setupOrgId}`, d);
    await refreshSetup(); toast('Saved'); render();
  },
  async range(form) {
    const d = Object.fromEntries(new FormData(form));
    state.report.from = d.from; state.report.to = d.to; render();
  },
  async asat(form) {
    state.report.as_at = new FormData(form).get('as_at'); render();
  },
  async forgot(form) {
    const r = await POST('/api/forgot', Object.fromEntries(new FormData(form)));
    form.innerHTML = html`<div class="notice">${r.message}</div>`.s;
  },
  async reset(form) {
    await POST('/api/reset', { token: form.dataset.token, password: new FormData(form).get('password') });
    state.me = null; location.hash = '#/'; toast('Password changed. You are logged in.'); await render();
  },
  async 'reset-link'(form) {
    const r = await POST('/api/admin/reset-link', Object.fromEntries(new FormData(form)));
    $('#reset-link-out').innerHTML = html`<p class="small mt">Send this to ${r.name}. It works once, for 1 hour:</p>
      <div class="copy-box"><code>${r.link}</code><button type="button" class="btn-sm" data-action="copy-link" data-link="${r.link}">Copy</button></div>`.s;
  },
  async 'billing-admin'(form) {
    const d = Object.fromEntries(new FormData(form));
    await POST(`/api/orgs/${state.setupOrgId}/billing/admin`, { add_days: d.add_days, plan_price: d.plan_price, exempt: !!form.exempt.checked });
    await refreshSetup(); toast('Saved'); render();
  },
  async portal(form) {
    const items = [...form.querySelectorAll('.item-row')].map((row) => ({
      id: row.querySelector('[name=item_id]').value, label: row.querySelector('[name=item_label]').value,
      account_id: row.querySelector('[name=item_account]').value, amount: row.querySelector('[name=item_amount]').value,
    })).filter((i) => i.label.trim());
    const d = Object.fromEntries(new FormData(form));
    const body = { enabled: form.enabled.checked, slug: d.slug, note: d.note, items };
    if (d.subaccount !== undefined) body.subaccount = d.subaccount;
    await PUT(`/api/orgs/${state.setupOrgId}/portal`, body);
    await refreshSetup(); toast('Saved'); render();
  },
};

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const handler = forms[form.dataset.form];
  if (!handler) return;
  busy(form, true);
  try { await handler(form, e); } catch (err) { showFormError(err.message); } finally { busy(form, false); }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

render();
