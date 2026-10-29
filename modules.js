'use strict';

/* =====================================================================
   Department front end: dashboards built from widgets, HR / Sales /
   Inventory pages, and the roles editor. Loaded after landing.js and before
   app.js; registers into window.LX, which app.js consults.
   ===================================================================== */
window.LX = window.LX || { actions: {}, forms: {}, changes: {}, pages: {}, inputs: {} };
LX.inputs = LX.inputs || {};

const MOD_LABEL = { accounts: 'Accounts', hr: 'HR', sales: 'Sales', inventory: 'Inventory' };
const ACCESS_LABEL = { none: 'No access', view: 'View only', edit: 'View and edit' };
const accessOf = (m) => (state.setup && state.setup.access ? state.setup.access[m] : 'none');
const canEditMod = (m) => accessOf(m) === 'edit' && state.setup.billing.status !== 'expired';
const qtyFmt = (n) => Number(n).toLocaleString('en-NG', { maximumFractionDigits: 3 });
const lockedNote = () => (state.setup.billing.status === 'expired' ? html`<div class="banner bad">The free trial has ended, so changes are paused. You can still view everything.</div>` : '');

function fmtValue(v, format) {
  if (format === 'money') return fmt(v);
  if (format === 'count') return Number(v).toLocaleString('en-NG');
  if (format === 'date') return niceDate(v);
  return String(v ?? '');
}

/* ---------- dashboards ---------- */
function singleBars(series) {
  const W = 640; const H = 230; const L = 52; const B = 28; const T = 12; const R = 8;
  const top = niceMax(Math.max(1, ...series.map((s) => s.value)));
  const ph = H - B - T; const pw = W - L - R; const gw = pw / series.length; const bw = Math.min(40, gw / 2);
  const y = (v) => T + ph - (Math.max(v, 0) / top) * ph;
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales for the last six months">
    ${[0, .25, .5, .75, 1].map((f) => html`<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(f * top)}" y2="${y(f * top)}"/><text x="${L - 8}" y="${y(f * top) + 4}" text-anchor="end">${compact(f * top)}</text>`)}
    ${series.map((s, i) => { const cx = L + gw * i + gw / 2; return html`
      <rect class="bar-income" x="${cx - bw / 2}" y="${y(s.value)}" width="${bw}" height="${Math.max(0, H - B - y(s.value))}" rx="3"><title>${monthLabel(s.month)}: ${fmt(s.value)}</title></rect>
      <text x="${cx}" y="${H - 8}" text-anchor="middle">${monthLabel(s.month)}</text>`; })}
  </svg>`;
}

function widgetBars(rows, cls) {
  const max = Math.max(1, ...rows.map((r) => Number(r.value)));
  return html`<div class="bar-list ${cls}">${rows.map((r) => html`
    <div class="bl-row"><div class="bl-top"><span>${r.title}</span><strong class="num">${fmtValue(r.value, r.format)}</strong></div>
    <svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="6" rx="3"/><rect class="fill" width="${Math.max(2, (Number(r.value) / max) * 100)}" height="6" rx="3"/></svg></div>`)}</div>`;
}

const BAR_WIDGETS = { 'accounts.top_expenses': 'exp', 'accounts.top_income': 'inc', 'hr.by_department': 'inc', 'sales.top_customers': 'inc' };

function widgetCard(w) {
  const d = w.data;
  if (w.kind === 'kpi') {
    return html`<div class="kpi ${w.id === 'accounts.cash' ? 'hero' : ''}"><div class="k-label">${w.label}</div>
      <div class="k-value ${d.tone === 'neg' ? 'neg' : ''}">${fmtValue(d.value, d.format)}</div>${d.sub ? html`<div class="k-sub">${d.sub}</div>` : ''}</div>`;
  }
  let inner;
  if (w.kind === 'chart') {
    inner = html`<div class="card-title"><h2>${w.label}</h2><div class="legend"><span><i class="li"></i>Income</span><span><i class="le"></i>Expenses</span></div></div>${barChart(d.series)}`;
  } else if (w.kind === 'bars') {
    inner = html`<div class="card-title"><h2>${w.label}</h2></div>${singleBars(d.series)}`;
  } else if (!d.rows.length) {
    inner = html`<h2 class="mb-s">${w.label}</h2><p class="muted small">${d.empty}</p>`;
  } else if (BAR_WIDGETS[w.id]) {
    inner = html`<h2 class="mb-s">${w.label}</h2>${widgetBars(d.rows, BAR_WIDGETS[w.id])}`;
  } else {
    inner = html`<h2 class="mb-s">${w.label}</h2><ul class="wlist">${d.rows.map((r) => html`<li><div><strong>${r.title}</strong>${r.sub ? html`<div class="small muted">${r.sub}</div>` : ''}</div>
      <span class="num ${r.sign > 0 ? 'pos' : r.sign < 0 ? 'neg' : ''}">${r.sign > 0 ? '+' : r.sign < 0 ? '−' : ''}${fmtValue(r.value, r.format)}</span></li>`)}</ul>`;
  }
  return html`<div class="card wcard ${w.kind === 'chart' || w.kind === 'bars' ? 'wide' : ''}">${inner}</div>`;
}

LX.actions['home-tab'] = (el) => { state.homeTab = el.dataset.tab; render(); };

LX.pages.dashboard = async function dashboardPage(id) {
  const d = await GET(`/api/orgs/${id}/home${qs({ tab: state.homeTab })}`);
  state.homeTab = d.tab === 'mine' ? undefined : d.tab;
  const kpis = d.widgets.filter((w) => w.kind === 'kpi');
  const rest = d.widgets.filter((w) => w.kind !== 'kpi');
  const mods = [...new Set(d.widgets.map((w) => w.module))];
  const links = ['hr', 'sales', 'inventory'].filter((m) => mods.includes(m) && accessOf(m) !== 'none')
    .map((m) => html`<a class="btn" href="#/org/${id}/${m}">${{ hr: 'Open staff records', sales: 'Open sales orders', inventory: 'Open stock list' }[m]}</a>`);
  const monthName = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return {
    title: 'Dashboard', sub: `${state.setup.org.name}, ${monthName}`,
    actions: html`${mods.includes('accounts') ? recordButtons() : ''}${links}`,
    body: html`
      ${d.tabs ? html`<div class="tabs no-print" role="tablist" aria-label="Dashboards">${d.tabs.map((t) => html`<button role="tab" data-action="home-tab" data-tab="${t.key}" ${t.key === d.tab ? raw('aria-current="page" aria-selected="true"') : raw('aria-selected="false"')}>${t.label}</button>`)}</div>` : ''}
      ${!d.widgets.length ? html`<div class="card empty"><strong>Nothing to show yet</strong>Your role doesn’t have any dashboard widgets. Ask the business owner or the Ledgerly team to set them up.</div>` : ''}
      ${kpis.length ? html`<div class="grid kpis">${kpis.map(widgetCard)}</div>` : ''}
      ${rest.length ? html`<div class="grid wgrid">${rest.map(widgetCard)}</div>` : ''}`,
  };
};

/* ---------- small shared pieces ---------- */
const field = (label, input, hint) => html`<div class="field"><label>${label}</label>${input}${hint ? html`<div class="hint">${hint}</div>` : ''}</div>`;
const statusBadge = (s) => html`<span class="badge ${{ pending: 'amber', approved: 'ok', rejected: 'red', quote: 'grey', confirmed: 'amber', paid: 'ok', cancelled: 'red', active: 'ok', inactive: 'grey' }[s] || ''}">${s}</span>`;
const subTabs = (id, active, items) => html`<div class="tabs no-print">${items.map(([k, label, path]) => html`<a href="#/org/${id}/${path}" ${k === active ? raw('aria-current="page"') : ''}>${label}</a>`)}</div>`;
const noAccessMsg = (what) => html`<div class="card empty"><strong>You can view this but not change it</strong>${what}</div>`;
async function reload(id) { await refreshSetup(); render(); }

/* =====================================================================
   HR
   ===================================================================== */
const HR_TABS = (id) => [['staff', 'Staff', 'hr'], ['leave', 'Leave', 'hr/leave']];

LX.pages.hr = async function hrPage(id, rest) {
  const tab = rest[0] === 'leave' ? 'leave' : 'staff';
  const edit = canEditMod('hr');
  if (tab === 'staff') {
    const { employees } = await GET(`/api/orgs/${id}/hr/employees`);
    state.employees = employees;
    const active = employees.filter((e) => e.status === 'active');
    return {
      title: 'Staff', sub: `${active.length} on the payroll · ${fmt(active.reduce((s, e) => s + e.salary, 0))} a month`,
      actions: edit ? html`<button class="btn btn-primary" data-action="new-employee">+ Add staff member</button>` : '',
      body: html`${lockedNote()}${subTabs(id, 'staff', HR_TABS(id))}
      <div class="card">${employees.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Department</th><th>Contact</th><th>Joined</th><th class="num">Salary / month</th><th></th></tr></thead><tbody>
        ${employees.map((e) => html`<tr class="${e.status === 'active' ? '' : 'dim'}">
          <td><strong>${e.name}</strong> ${e.status === 'active' ? '' : statusBadge('inactive')}<div class="small muted">${e.job_title}</div></td>
          <td>${e.department || html`<span class="muted">None</span>`}</td>
          <td class="small">${e.phone}<div class="muted">${e.email}</div></td>
          <td class="small nowrap">${e.start_date ? niceDate(e.start_date) : ''}</td>
          <td class="num">${e.salary ? fmt(e.salary) : html`<span class="muted">Not set</span>`}</td>
          <td class="num">${edit ? html`<button class="btn-sm" data-action="edit-employee" data-id="${e.id}">Edit</button>` : ''}</td></tr>`)}
        </tbody></table></div>`
        : html`<div class="empty"><strong>No staff added yet</strong>${edit ? 'Add your first staff member to start keeping HR records.' : 'Nobody has been added.'}</div>`}</div>
      <p class="muted small mt">To stop paying someone without losing their record, open them and set the status to Inactive.</p>`,
    };
  }
  const [{ leave, types }, { employees }] = await Promise.all([GET(`/api/orgs/${id}/hr/leave`), GET(`/api/orgs/${id}/hr/employees`)]);
  state.employees = employees; state.leaveTypes = types;
  return {
    title: 'Leave', sub: 'Requests and approvals',
    actions: edit ? html`<button class="btn btn-primary" data-action="new-leave">+ Record leave</button>` : '',
    body: html`${lockedNote()}${subTabs(id, 'leave', HR_TABS(id))}
    <div class="card">${leave.length ? html`<div class="table-wrap"><table>
      <thead><tr><th>Staff</th><th>Type</th><th>Dates</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
      ${leave.map((l) => html`<tr>
        <td><strong>${l.name}</strong></td><td>${l.type}</td>
        <td class="small nowrap">${niceDate(l.from_date)}${l.to_date !== l.from_date ? ' to ' + niceDate(l.to_date) : ''}</td>
        <td class="small muted">${l.reason}</td><td>${statusBadge(l.status)}</td>
        <td class="num nowrap">${edit ? (l.status === 'pending'
          ? html`<button class="btn-sm" data-action="leave-decide" data-id="${l.id}" data-status="approved">Approve</button> <button class="btn-sm btn-danger" data-action="leave-decide" data-id="${l.id}" data-status="rejected">Reject</button>`
          : html`<button class="btn-sm" data-action="leave-decide" data-id="${l.id}" data-status="pending">Reopen</button>`) : ''}</td></tr>`)}
      </tbody></table></div>`
      : html`<div class="empty"><strong>No leave recorded</strong>${edit ? 'Use “Record leave” when someone asks for time off.' : 'Nothing has been requested.'}</div>`}</div>`,
  };
};

function openEmployeeModal(e) {
  const editing = !!e;
  openModal(html`${modalHead(editing ? 'Edit staff member' : 'Add a staff member')}
    <form data-form="employee" data-id="${e ? e.id : ''}" novalidate>${errorBox()}
      <div class="row">
        ${field('Full name', html`<input name="name" maxlength="80" value="${e ? e.name : ''}" required>`)}
        ${field('Job title', html`<input name="job_title" maxlength="80" value="${e ? e.job_title : ''}" placeholder="e.g. Cashier">`)}
      </div>
      <div class="row">
        ${field('Department', html`<input name="department" maxlength="60" value="${e ? e.department : ''}" placeholder="e.g. Kitchen">`)}
        ${field('Start date', html`<input name="start_date" type="date" value="${e && e.start_date ? e.start_date : ''}">`)}
      </div>
      <div class="row">
        ${field('Phone', html`<input name="phone" maxlength="30" value="${e ? e.phone : ''}" inputmode="tel">`)}
        ${field('Email', html`<input name="email" type="email" maxlength="120" value="${e ? e.email : ''}">`)}
      </div>
      <div class="row">
        ${field(`Monthly salary (${sym()})`, html`<input name="salary" inputmode="decimal" value="${e && e.salary ? (e.salary / 100).toFixed(2) : ''}" placeholder="Optional">`)}
        ${editing ? field('Status', html`<select name="status"><option value="active" ${e.status === 'active' ? raw('selected') : ''}>Active</option><option value="inactive" ${e.status === 'inactive' ? raw('selected') : ''}>Inactive (left or suspended)</option></select>`) : ''}
      </div>
      <div class="modal-foot"><button type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Add staff member'}</button></div>
    </form>`, { wide: true });
}
function openLeaveModal() {
  const active = state.employees.filter((e) => e.status === 'active');
  if (!active.length) { toast('Add a staff member first.', true); return; }
  openModal(html`${modalHead('Record leave')}
    <form data-form="leave" novalidate>${errorBox()}
      ${field('Staff member', html`<select name="employee_id" required>${active.map((e) => html`<option value="${e.id}">${e.name}</option>`)}</select>`)}
      ${field('Type of leave', html`<select name="type">${state.leaveTypes.map((t) => html`<option>${t}</option>`)}</select>`)}
      <div class="row">
        ${field('First day', html`<input name="from_date" type="date" value="${todayStr()}" required>`)}
        ${field('Last day', html`<input name="to_date" type="date" value="${todayStr()}" required>`)}
      </div>
      ${field('Reason (optional)', html`<input name="reason" maxlength="300">`)}
      <div class="modal-foot"><button type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">Save request</button></div>
    </form>`);
}
Object.assign(LX.actions, {
  'new-employee': () => openEmployeeModal(null),
  'edit-employee': (el) => openEmployeeModal(state.employees.find((e) => e.id === Number(el.dataset.id))),
  'new-leave': () => openLeaveModal(),
  'leave-decide': async (el) => {
    try { await PUT(`/api/orgs/${state.setupOrgId}/hr/leave/${el.dataset.id}`, { status: el.dataset.status }); toast(el.dataset.status === 'approved' ? 'Approved' : el.dataset.status === 'rejected' ? 'Rejected' : 'Reopened'); render(); } catch (e) { toast(e.message, true); }
  },
});
LX.forms.employee = async (form) => {
  const d = Object.fromEntries(new FormData(form));
  const url = `/api/orgs/${state.setupOrgId}/hr/employees`;
  if (form.dataset.id) await PUT(`${url}/${form.dataset.id}`, d); else await POST(url, d);
  closeModal(); toast('Saved'); render();
};
LX.forms.leave = async (form) => {
  await POST(`/api/orgs/${state.setupOrgId}/hr/leave`, Object.fromEntries(new FormData(form)));
  closeModal(); toast('Leave recorded. It now waits for approval.'); render();
};

/* =====================================================================
   Sales
   ===================================================================== */
const ORDER_LABEL = { quote: 'Quote (not confirmed)', confirmed: 'Confirmed (awaiting payment)', paid: 'Paid', cancelled: 'Cancelled' };

LX.pages.sales = async function salesPage(id) {
  const edit = canEditMod('sales');
  const f = state.sales = state.sales || { status: '', q: '' };
  return {
    title: 'Sales orders', sub: 'Every order, from quote to paid',
    actions: edit ? html`<button class="btn btn-primary" data-action="new-order">+ New order</button>` : '',
    body: html`${lockedNote()}
    <div class="card">
      <div class="filters">
        <div class="field"><label for="so-status">Status</label><select id="so-status" data-change="sales-filter">
          <option value="">All</option>${Object.entries(ORDER_LABEL).map(([v, l]) => html`<option value="${v}" ${f.status === v ? raw('selected') : ''}>${l}</option>`)}</select></div>
        <div class="field"><label for="so-q">Search</label><input id="so-q" type="search" placeholder="Customer or description" value="${f.q}" data-input="sales-search"></div>
      </div>
      <div id="sales-results"><p class="muted">Loading…</p></div>
    </div>`,
    after: loadSalesResults,
  };
};
async function loadSalesResults() {
  const box = $('#sales-results'); if (!box) return;
  const edit = canEditMod('sales');
  try {
    const r = await GET(`/api/orgs/${state.setupOrgId}/sales/orders${qs({ status: state.sales.status, q: state.sales.q })}`);
    state.orders = r.orders;
    const live = r.orders.filter((o) => o.status === 'confirmed' || o.status === 'paid');
    box.innerHTML = (r.orders.length ? html`
      <p class="muted small">${r.orders.length} order${r.orders.length === 1 ? '' : 's'} shown · confirmed and paid total ${fmt(live.reduce((s, o) => s + o.amount, 0))}</p>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Customer</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${r.orders.map((o) => html`<tr class="${o.status === 'cancelled' ? 'voided' : ''}"><td class="small nowrap">${niceDate(o.date)}</td>
        <td><strong>${o.customer}</strong><div class="small muted">${o.description}</div></td><td>${statusBadge(o.status)}</td>
        <td class="num"><strong>${fmt(o.amount)}</strong></td>
        <td class="num nowrap">${edit ? html`${o.status === 'confirmed' ? html`<button class="btn-sm" data-action="order-paid" data-id="${o.id}">Mark paid</button> ` : ''}<button class="btn-sm" data-action="edit-order" data-id="${o.id}">Edit</button>` : ''}</td></tr>`)}
      </tbody></table></div>`
      : html`<div class="empty"><strong>No orders found</strong>${edit ? 'Add an order with “New order”, or change the filters.' : 'Try changing the filters.'}</div>`).s;
  } catch (err) { box.innerHTML = html`<div class="error">${err.message}</div>`.s; }
}
LX.changes['sales-filter'] = (el) => { state.sales.status = el.value; loadSalesResults(); };
let salesTimer;
LX.inputs['sales-search'] = (el) => { clearTimeout(salesTimer); salesTimer = setTimeout(() => { state.sales.q = el.value.trim(); loadSalesResults(); }, 300); };

function openOrderModal(o) {
  const editing = !!o;
  openModal(html`${modalHead(editing ? 'Edit order' : 'New order')}
    <form data-form="order" data-id="${o ? o.id : ''}" novalidate>${errorBox()}
      <div class="row">
        ${field('Date', html`<input name="date" type="date" value="${o ? o.date : todayStr()}" required>`)}
        ${field(`Amount (${sym()})`, html`<input name="amount" inputmode="decimal" value="${o ? (o.amount / 100).toFixed(2) : ''}" placeholder="0.00" required>`)}
      </div>
      ${field('Customer', html`<input name="customer" maxlength="100" value="${o ? o.customer : ''}" required>`)}
      ${field('What was ordered (optional)', html`<input name="description" maxlength="200" value="${o ? o.description : ''}" placeholder="e.g. 40 plates, naming ceremony">`)}
      ${field('Status', html`<select name="status">${Object.entries(ORDER_LABEL).map(([v, l]) => html`<option value="${v}" ${(o ? o.status : 'confirmed') === v ? raw('selected') : ''}>${l}</option>`)}</select>`,
        'Sales orders are your sales log. To put money in the books, also record it under Transactions.')}
      <div class="modal-foot"><button type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Add order'}</button></div>
    </form>`);
}
Object.assign(LX.actions, {
  'new-order': () => openOrderModal(null),
  'edit-order': (el) => openOrderModal(state.orders.find((o) => o.id === Number(el.dataset.id))),
  'order-paid': async (el) => {
    const o = state.orders.find((x) => x.id === Number(el.dataset.id));
    try { await PUT(`/api/orgs/${state.setupOrgId}/sales/orders/${o.id}`, { date: o.date, customer: o.customer, description: o.description, amount: (o.amount / 100).toFixed(2), status: 'paid' }); toast('Marked as paid'); loadSalesResults(); } catch (e) { toast(e.message, true); }
  },
});
LX.forms.order = async (form) => {
  const d = Object.fromEntries(new FormData(form));
  const url = `/api/orgs/${state.setupOrgId}/sales/orders`;
  if (form.dataset.id) await PUT(`${url}/${form.dataset.id}`, d); else await POST(url, d);
  closeModal(); toast('Saved'); loadSalesResults();
};

/* =====================================================================
   Inventory
   ===================================================================== */
LX.pages.inventory = async function inventoryPage(id) {
  const edit = canEditMod('inventory');
  const { items } = await GET(`/api/orgs/${id}/inventory/items`);
  state.items = items;
  const live = items.filter((i) => i.active);
  return {
    title: 'Stock', sub: `${live.length} item${live.length === 1 ? '' : 's'} · worth ${fmt(live.reduce((s, i) => s + i.value, 0))}`,
    actions: edit ? html`<button class="btn btn-primary" data-action="new-item">+ Add item</button>` : '',
    body: html`${lockedNote()}
    <div class="card">${items.length ? html`<div class="table-wrap"><table>
      <thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Reorder at</th><th class="num">Cost each</th><th class="num">Value</th><th></th></tr></thead><tbody>
      ${items.map((i) => html`<tr class="${i.active ? '' : 'dim'}">
        <td><strong>${i.name}</strong> ${i.low && i.active ? html`<span class="badge red">Running low</span>` : ''}${i.active ? '' : html` <span class="badge grey">Not stocked</span>`}${i.sku ? html`<div class="small muted">${i.sku}</div>` : ''}</td>
        <td class="num"><strong>${qtyFmt(i.qty)}</strong> <span class="muted small">${i.unit}</span></td>
        <td class="num">${i.reorder ? qtyFmt(i.reorder) : html`<span class="muted">Not set</span>`}</td>
        <td class="num">${i.unit_cost ? fmt(i.unit_cost) : html`<span class="muted">Not set</span>`}</td>
        <td class="num">${fmt(i.value)}</td>
        <td class="num nowrap">${edit && i.active ? html`<button class="btn-sm" data-action="move-item" data-kind="in" data-id="${i.id}">Stock in</button> <button class="btn-sm" data-action="move-item" data-kind="out" data-id="${i.id}">Stock out</button> <button class="btn-sm" data-action="move-item" data-kind="adjust" data-id="${i.id}">Count</button> ` : ''}<button class="btn-sm" data-action="item-history" data-id="${i.id}">History</button>${edit ? html` <button class="btn-sm" data-action="edit-item" data-id="${i.id}">Edit</button>` : ''}</td></tr>`)}
      </tbody></table></div>`
      : html`<div class="empty"><strong>No stock items yet</strong>${edit ? 'Add the things you keep in stock, such as feed, ingredients or books.' : 'Nothing has been added.'}</div>`}</div>
    <p class="muted small mt">Stock can’t go below zero. Use “Count” after a stock take to correct what the system shows.</p>`,
  };
};
function openItemModal(it) {
  const editing = !!it;
  openModal(html`${modalHead(editing ? 'Edit item' : 'Add a stock item')}
    <form data-form="item" data-id="${it ? it.id : ''}" novalidate>${errorBox()}
      ${field('Item name', html`<input name="name" maxlength="80" value="${it ? it.name : ''}" placeholder="e.g. Layer feed (50kg bag)" required>`)}
      <div class="row">
        ${field('Unit', html`<input name="unit" maxlength="20" value="${it ? it.unit : ''}" placeholder="bags, kg, crates…">`)}
        ${field('Code (optional)', html`<input name="sku" maxlength="40" value="${it ? it.sku : ''}">`)}
      </div>
      <div class="row">
        ${editing ? '' : field('Quantity you have now', html`<input name="opening_qty" inputmode="decimal" placeholder="0">`)}
        ${field('Reorder when it drops to', html`<input name="reorder" inputmode="decimal" value="${it && it.reorder ? it.reorder : ''}" placeholder="Optional">`, 'You’ll see a warning at or below this number.')}
        ${field(`Cost each (${sym()})`, html`<input name="unit_cost" inputmode="decimal" value="${it && it.unit_cost ? (it.unit_cost / 100).toFixed(2) : ''}" placeholder="Optional">`)}
      </div>
      ${editing ? html`<div class="field"><label class="check"><input type="checkbox" name="active" ${it.active ? raw('checked') : ''}> Still stocked</label><div class="hint">Untick if you no longer keep this. The history stays.</div></div>` : ''}
      <div class="modal-foot"><button type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Add item'}</button></div>
    </form>`, { wide: true });
}
const MOVE_INFO = {
  in: { title: 'Stock in', qty: 'Quantity received', note: 'Note (optional)', ph: 'e.g. delivery from supplier', btn: 'Add to stock' },
  out: { title: 'Stock out', qty: 'Quantity taken out', note: 'Note (optional)', ph: 'e.g. used in kitchen', btn: 'Remove from stock' },
  adjust: { title: 'Count stock', qty: 'Quantity you counted', note: 'Why are you correcting it?', ph: 'e.g. stock take', btn: 'Save count' },
};
function openMovementModal(item, kind) {
  const m = MOVE_INFO[kind];
  openModal(html`${modalHead(`${m.title}: ${item.name}`)}
    <form data-form="movement" data-id="${item.id}" data-kind="${kind}" novalidate>${errorBox()}
      <p class="muted small">Now in stock: <strong>${qtyFmt(item.qty)} ${item.unit}</strong></p>
      <div class="row">
        ${field(`${m.qty} (${item.unit})`, html`<input name="qty" inputmode="decimal" required>`)}
        ${field('Date', html`<input name="date" type="date" value="${todayStr()}" required>`)}
      </div>
      ${field(m.note, html`<input name="note" maxlength="200" placeholder="${m.ph}" ${kind === 'adjust' ? raw('required') : ''}>`)}
      <div class="modal-foot"><button type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">${m.btn}</button></div>
    </form>`);
  const q = $('input[name=qty]'); if (q) q.focus();
}
Object.assign(LX.actions, {
  'new-item': () => openItemModal(null),
  'edit-item': (el) => openItemModal(state.items.find((i) => i.id === Number(el.dataset.id))),
  'move-item': (el) => openMovementModal(state.items.find((i) => i.id === Number(el.dataset.id)), el.dataset.kind),
  'item-history': async (el) => {
    try {
      const { item, movements } = await GET(`/api/orgs/${state.setupOrgId}/inventory/items/${el.dataset.id}/movements`);
      openModal(html`${modalHead(`History: ${item.name}`)}
        <p class="muted small">Now in stock: <strong>${qtyFmt(item.qty)} ${item.unit}</strong></p>
        ${movements.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>What happened</th><th class="num">Change</th></tr></thead><tbody>
          ${movements.map((m) => html`<tr><td class="small nowrap">${niceDate(m.date)}</td><td>${{ in: 'Stock in', out: 'Stock out', adjust: 'Count correction' }[m.kind]}${m.note ? html`<div class="small muted">${m.note}${m.by ? ' · ' + m.by : ''}</div>` : ''}</td>
            <td class="num ${m.change > 0 ? 'pos' : 'neg'}">${m.change > 0 ? '+' : '−'}${qtyFmt(Math.abs(m.change))}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted">No movements yet.</p>`}
        <div class="modal-foot"><button type="button" data-action="close">Close</button></div>`, { wide: true });
    } catch (e) { toast(e.message, true); }
  },
});
LX.forms.item = async (form) => {
  const d = Object.fromEntries(new FormData(form));
  const url = `/api/orgs/${state.setupOrgId}/inventory/items`;
  if (form.dataset.id) await PUT(`${url}/${form.dataset.id}`, { ...d, active: form.elements.active.checked }); else await POST(url, d);
  closeModal(); toast('Saved'); render();
};
LX.forms.movement = async (form) => {
  const d = Object.fromEntries(new FormData(form));
  const r = await POST(`/api/orgs/${state.setupOrgId}/inventory/items/${form.dataset.id}/movements`, { ...d, kind: form.dataset.kind });
  closeModal(); toast(`Saved. ${qtyFmt(r.qty)} now in stock.`); render();
};

/* =====================================================================
   Roles and dashboards
   ===================================================================== */
const MODULE_KEYS = ['accounts', 'hr', 'sales', 'inventory'];
async function loadRoleOptions() {
  if (!LX.opts) LX.opts = await GET('/api/role-options');
  return LX.opts;
}
const accessChips = (r) => MODULE_KEYS.filter((m) => r.perms[m] !== 'none').map((m) => html`<span class="badge ${r.perms[m] === 'edit' ? '' : 'grey'}">${MOD_LABEL[m]}: ${r.perms[m] === 'edit' ? 'edit' : 'view'}</span> `);

function roleTable(roles, { canEdit, showPeople }) {
  if (!roles.length) return html`<div class="empty"><strong>No roles yet</strong>${canEdit ? 'Add a role to get started.' : ''}</div>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Role</th><th>Can open</th><th>Dashboard</th>${showPeople ? html`<th class="num">People</th>` : ''}<th></th></tr></thead><tbody>
    ${roles.map((r) => html`<tr>
      <td><strong>${r.name}</strong>${r.all_dashboards ? html` <span class="badge amber">Sees every dashboard</span>` : ''}<div class="small muted">${r.description}</div></td>
      <td>${accessChips(r)}</td>
      <td class="small">${r.widgets.length} widget${r.widgets.length === 1 ? '' : 's'}</td>
      ${showPeople ? html`<td class="num">${r.people}</td>` : ''}
      <td class="num nowrap">${canEdit ? html`<button class="btn-sm" data-action="edit-role" data-id="${r.id}">Edit</button> <button class="btn-sm btn-danger" data-action="delete-role" data-id="${r.id}" data-name="${r.name}">Delete</button>` : ''}</td></tr>`)}
    </tbody></table></div>`;
}

LX.pages.roles = async function rolesPage(id) {
  const { roles, can_edit: canEdit } = await GET(`/api/orgs/${id}/roles`);
  state.roleList = roles; state.roleBase = `/api/orgs/${id}/roles`;
  return {
    title: 'Roles & dashboards', sub: 'What each role can open, and what it sees when it logs in',
    actions: canEdit ? html`<button data-action="role-from-templates">Add missing starter roles</button><button class="btn btn-primary" data-action="new-role">+ New role</button>` : '',
    body: html`
    <div class="card">${roleTable(roles, { canEdit, showPeople: true })}</div>
    <div class="card"><h2 class="mb-s">Built-in roles</h2>
      <p class="small"><strong>Owner</strong> has full access to everything and sees every dashboard. <strong>Accountant</strong> records and voids transactions and sees the accounts dashboard. <strong>Viewer</strong> can read the books but not change them.</p></div>
    <p class="muted small mt">${canEdit ? 'Changes apply straight away to everyone in that role.' : 'You choose who gets which role on the Team page. Need a role that isn’t listed, or a different dashboard? Ask the Ledgerly team and it will be set up for your business.'}</p>`,
  };
};

LX.pages.adminRoles = async function adminRolesPage() {
  const { templates } = await GET('/api/admin/role-templates');
  state.roleList = templates.map((t) => ({ ...t, people: 0 })); state.roleBase = '/api/admin/role-templates';
  app.innerHTML = html`
  <div class="main narrow">
    <div class="page-head"><div>
      <div class="logo mb"><span class="logo-mark">L</span> Ledgerly</div>
      <h1>Role templates</h1>
      <div class="sub">Every new business starts with these roles. Changing a template does not change businesses that already exist: open that business and use its Roles page.</div></div>
      <div class="actions"><a class="btn" href="#/">← All clients</a><button class="btn btn-primary" data-action="new-role">+ New template</button></div></div>
    <div class="card">${roleTable(templates, { canEdit: true, showPeople: false })}</div>
  </div>`.s;
};

async function openRoleModal(role) {
  const opts = await loadRoleOptions();
  const editing = !!role;
  const r = role || { name: '', description: '', all_dashboards: false, perms: { accounts: 'none', hr: 'none', sales: 'none', inventory: 'none' }, widgets: [] };
  openModal(html`${modalHead(editing ? `Edit ${r.name}` : 'New role')}
    <form data-form="role" data-id="${editing ? r.id : ''}" novalidate>${errorBox()}
      <div class="row">
        ${field('Role name', html`<input name="name" maxlength="40" value="${r.name}" placeholder="e.g. Procurement" required>`)}
        ${field('Short description', html`<input name="description" maxlength="160" value="${r.description}" placeholder="What this person does">`)}
      </div>
      <h3 class="mb-s">What can this role open?</h3>
      <div class="role-perms">${MODULE_KEYS.map((m) => html`<div class="field"><label for="rp-${m}">${MOD_LABEL[m]}</label>
        <select id="rp-${m}" name="perm_${m}" data-change="role-perm">${['none', 'view', 'edit'].map((l) => html`<option value="${l}" ${r.perms[m] === l ? raw('selected') : ''}>${ACCESS_LABEL[l]}</option>`)}</select></div>`)}</div>
      <div class="field"><label class="check"><input type="checkbox" name="all_dashboards" data-change="role-all" ${r.all_dashboards ? raw('checked') : ''}> Can open every department’s dashboard (like a manager)</label>
        <div class="hint">Everyone else only sees their own dashboard.</div></div>
      <h3 class="mb-s">What does their dashboard show?</h3>
      <div class="widget-pick">${MODULE_KEYS.map((m) => html`<fieldset data-module="${m}"><legend>${MOD_LABEL[m]}</legend>
        ${opts.widgets.filter((w) => w.module === m).map((w) => html`<label class="check"><input type="checkbox" name="w" value="${w.id}" ${r.widgets.includes(w.id) ? raw('checked') : ''} ${r.perms[m] === 'none' ? raw('disabled') : ''}> ${w.label}</label>`)}</fieldset>`)}</div>
      <div class="modal-foot"><button type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Create role'}</button></div>
    </form>`, { wide: true });
}
Object.assign(LX.actions, {
  'new-role': () => openRoleModal(null).catch((e) => toast(e.message, true)),
  'edit-role': (el) => openRoleModal(state.roleList.find((r) => r.id === Number(el.dataset.id))).catch((e) => toast(e.message, true)),
  'delete-role': async (el) => {
    if (!confirm(`Delete the role “${el.dataset.name}”?`)) return;
    try { await DEL(`${state.roleBase}/${el.dataset.id}`); toast('Deleted'); render(); } catch (e) { toast(e.message, true); }
  },
  'role-from-templates': async () => {
    try { const r = await POST(`${state.roleBase}/from-templates`); toast(r.added ? `${r.added} starter role${r.added === 1 ? '' : 's'} added` : 'Nothing missing: every starter role is already here.'); render(); } catch (e) { toast(e.message, true); }
  },
});
LX.changes['role-perm'] = (el) => {
  const m = el.name.replace('perm_', '');
  const none = el.value === 'none';
  document.querySelectorAll(`.widget-pick fieldset[data-module="${m}"] input`).forEach((i) => { i.disabled = none; if (none) i.checked = false; });
};
LX.changes['role-all'] = (el) => {
  if (!el.checked) return;
  MODULE_KEYS.forEach((m) => { const s = $(`select[name=perm_${m}]`); if (s && s.value === 'none') { s.value = 'view'; LX.changes['role-perm'](s); } });
};
LX.forms.role = async (form) => {
  const d = Object.fromEntries(new FormData(form));
  const body = {
    name: d.name, description: d.description, all_dashboards: form.elements.all_dashboards.checked,
    perms: Object.fromEntries(MODULE_KEYS.map((m) => [m, d[`perm_${m}`]])),
    widgets: [...form.querySelectorAll('input[name=w]:checked:not(:disabled)')].map((i) => i.value),
  };
  if (form.dataset.id) await PUT(`${state.roleBase}/${form.dataset.id}`, body); else await POST(state.roleBase, body);
  closeModal(); toast('Saved'); render();
};
