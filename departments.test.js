'use strict';
// Tests for: self-registration, custom roles, per-role dashboards, HR / Sales / Inventory modules.
process.env.DB_PATH = ':memory:';
process.env.TRUST_PROXY = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

let ipCounter = 10;
function client() {
  let cookie = '';
  const ip = `198.51.100.${ipCounter++}`; // each "person" gets their own address so rate limits don't interfere
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledgerly', 'X-Forwarded-For': ip, ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b || {}), del: (u) => call('DELETE', u) };
}

const anon = client(); const admin = client(); const owner = client(); const hr = client(); const sales = client();
const manager = client(); const stock = client(); const outsider = client(); const accountant = client();
let orgId; let roles = {};
const widgetIds = (r) => r.data.widgets.map((w) => w.id);

test('self-registration is blocked until the platform admin exists, then works for anyone', async () => {
  const body = { name: 'Ngozi', email: 'ngozi@shop.test', password: 'longenough1', business_name: 'Ngozi Stores', type: 'restaurant' };
  assert.equal((await anon.post('/api/register-business', body)).status, 400, 'first-run: no admin yet');
  assert.equal((await admin.post('/api/signup', { name: 'Admin', email: 'admin@ledgerly.test', password: 'longenough1' })).status, 200);

  const info = (await anon.get('/api/public/info')).data;
  assert.ok(info.templates.length >= 5 && info.trial_days > 0 && info.price_month > 0);

  assert.equal((await anon.post('/api/register-business', { ...body, type: 'nonsense' })).status, 400);
  assert.equal((await anon.post('/api/register-business', { ...body, business_name: '' })).status, 400);
  assert.equal((await anon.post('/api/register-business', { ...body, password: 'short' })).status, 400);
  const r = await owner.post('/api/register-business', { ...body, email: 'ngozi@shop.test' });
  assert.equal(r.status, 200);
  orgId = r.data.org_id;
  const me = (await owner.get('/api/me')).data;
  assert.equal(me.user.is_admin, false, 'registering a business does not make you platform admin');
  assert.equal(me.orgs[0].role, 'owner');
  assert.equal((await client().post('/api/register-business', { ...body })).status, 400, 'duplicate email');
});

test('every new business starts with the department roles', async () => {
  const r = await owner.get(`/api/orgs/${orgId}/roles`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.roles.map((x) => x.name), ['Manager', 'Accounts Officer', 'HR Officer', 'Sales Officer', 'Inventory Officer']);
  for (const x of r.data.roles) roles[x.name] = x;
  assert.equal(roles.Manager.all_dashboards, true);
  assert.equal(roles['HR Officer'].all_dashboards, false);
  assert.equal(r.data.can_edit, false, 'owners can see roles but only the admin edits them');
});

test('owner assigns department roles; invited people get them when they sign up', async () => {
  const add = (email, name) => owner.post(`/api/orgs/${orgId}/members`, { email, role: `c${roles[name].id}` });
  assert.equal((await add('hr@shop.test', 'HR Officer')).data.status, 'invited');
  assert.equal((await add('sales@shop.test', 'Sales Officer')).data.status, 'invited');
  assert.equal((await add('manager@shop.test', 'Manager')).data.status, 'invited');
  assert.equal((await add('stock@shop.test', 'Inventory Officer')).data.status, 'invited');
  assert.equal((await owner.post(`/api/orgs/${orgId}/members`, { email: 'acc@shop.test', role: 'accountant' })).data.status, 'invited');
  assert.equal((await owner.post(`/api/orgs/${orgId}/members`, { email: 'x@shop.test', role: 'c99999' })).status, 400, 'unknown role');
  for (const [c, email, name] of [[hr, 'hr@shop.test', 'HR'], [sales, 'sales@shop.test', 'Sales'], [manager, 'manager@shop.test', 'Mgr'], [stock, 'stock@shop.test', 'Stock'], [accountant, 'acc@shop.test', 'Acc']]) {
    assert.equal((await c.post('/api/signup', { name, email, password: 'longenough1' })).status, 200);
  }
  const team = (await owner.get(`/api/orgs/${orgId}/members`)).data;
  assert.equal(team.members.find((m) => m.email === 'hr@shop.test').role_name, 'HR Officer');
});

test('an HR officer sees only the HR dashboard and cannot reach the books or other departments', async () => {
  const setup = (await hr.get(`/api/orgs/${orgId}/setup`)).data;
  assert.equal(setup.role_name, 'HR Officer');
  assert.equal(setup.access.hr, 'edit');
  assert.equal(setup.access.accounts, 'none');
  assert.deepEqual(setup.accounts, [], 'no chart of accounts for people without accounting access');

  const home = await hr.get(`/api/orgs/${orgId}/home`);
  assert.equal(home.data.tabs, null, 'no tabs for a normal role');
  assert.ok(widgetIds(home).length > 0 && widgetIds(home).every((i) => i.startsWith('hr.')));
  const peek = await hr.get(`/api/orgs/${orgId}/home?tab=sales`);
  assert.ok(widgetIds(peek).every((i) => i.startsWith('hr.')), 'asking for another tab changes nothing');

  for (const url of ['transactions', 'transactions.csv', 'reports/dashboard', 'reports/profit-loss?from=2026-01-01&to=2026-12-31', 'reports/trial-balance', 'sales/orders', 'inventory/items']) {
    assert.equal((await hr.get(`/api/orgs/${orgId}/${url}`)).status, 403, `HR must not read ${url}`);
  }
  assert.equal((await hr.post(`/api/orgs/${orgId}/transactions`, { kind: 'income', date: '2026-10-01', amount: '5' })).status, 403);
  assert.equal((await hr.get(`/api/orgs/${orgId}/members`)).status, 403, 'HR cannot see the team list');
  assert.equal((await hr.get(`/api/orgs/${orgId}/roles`)).status, 403);
});

test('HR records: staff, leave requests and approvals feed the HR dashboard', async () => {
  const e = await hr.post(`/api/orgs/${orgId}/hr/employees`, { name: 'Chidi Okafor', job_title: 'Cashier', department: 'Front of house', salary: '85,000', start_date: new Date().toISOString().slice(0, 10), email: 'chidi@shop.test' });
  assert.equal(e.status, 200);
  assert.equal((await hr.post(`/api/orgs/${orgId}/hr/employees`, { name: '' })).status, 400);
  assert.equal((await hr.post(`/api/orgs/${orgId}/hr/employees`, { name: 'Bad', salary: 'abc' })).status, 400);
  await hr.post(`/api/orgs/${orgId}/hr/employees`, { name: 'Bisi Ade', job_title: 'Cook', department: 'Kitchen', salary: '120000' });
  const list = (await hr.get(`/api/orgs/${orgId}/hr/employees`)).data.employees;
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.name === 'Chidi Okafor').salary, 8500000, 'salary stored in kobo');

  const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
  assert.equal((await hr.post(`/api/orgs/${orgId}/hr/leave`, { employee_id: e.data.id, type: 'Annual', from_date: today, to_date: '2000-01-01' })).status, 400, 'end before start');
  const l = await hr.post(`/api/orgs/${orgId}/hr/leave`, { employee_id: e.data.id, type: 'Annual', from_date: today, to_date: today, reason: 'Family event' });
  assert.equal(l.status, 200);

  const kpis = async () => Object.fromEntries((await hr.get(`/api/orgs/${orgId}/home`)).data.widgets.filter((w) => w.kind === 'kpi').map((w) => [w.id, w.data.value]));
  let k = await kpis();
  assert.equal(k['hr.headcount'], 2);
  assert.equal(k['hr.pending_leave'], 1);
  assert.equal(k['hr.on_leave'], 0, 'pending leave does not count as on leave');
  assert.equal(k['hr.payroll'], 20500000);
  assert.equal((await hr.put(`/api/orgs/${orgId}/hr/leave/${l.data.id}`, { status: 'approved' })).status, 200);
  k = await kpis();
  assert.equal(k['hr.pending_leave'], 0);
  assert.equal(k['hr.on_leave'], 1);
});

test('sales officer: logs orders, sees only the sales dashboard', async () => {
  assert.equal((await sales.get(`/api/orgs/${orgId}/hr/employees`)).status, 403, 'sales cannot read staff records');
  const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
  assert.equal((await sales.post(`/api/orgs/${orgId}/sales/orders`, { date: today, customer: 'Mama Tunde', description: '20 plates of jollof', amount: '40,000', status: 'confirmed' })).status, 200);
  assert.equal((await sales.post(`/api/orgs/${orgId}/sales/orders`, { date: today, customer: 'Mama Tunde', amount: '10000', status: 'paid' })).status, 200);
  assert.equal((await sales.post(`/api/orgs/${orgId}/sales/orders`, { date: today, customer: '', amount: '10' })).status, 400);
  assert.equal((await sales.post(`/api/orgs/${orgId}/sales/orders`, { date: today, customer: 'X', amount: '0' })).status, 400);
  assert.equal((await sales.post(`/api/orgs/${orgId}/sales/orders`, { date: today, customer: 'X', amount: '5', status: 'weird' })).status, 400);
  const home = await sales.get(`/api/orgs/${orgId}/home`);
  assert.ok(widgetIds(home).every((i) => i.startsWith('sales.')));
  const by = Object.fromEntries(home.data.widgets.map((w) => [w.id, w.data]));
  assert.equal(by['sales.month'].value, 5000000);
  assert.equal(by['sales.unpaid'].value, 4000000);
  assert.equal(by['sales.top_customers'].rows[0].title, 'Mama Tunde');
  assert.equal((await sales.get(`/api/orgs/${orgId}/reports/dashboard`)).status, 403);
});

test('inventory: stock cannot go negative, counts can be corrected, low stock shows up', async () => {
  const it = await stock.post(`/api/orgs/${orgId}/inventory/items`, { name: 'Rice (50kg bag)', unit: 'bags', opening_qty: '10', reorder: '4', unit_cost: '65000' });
  assert.equal(it.status, 200);
  const id = it.data.id;
  assert.equal((await stock.post(`/api/orgs/${orgId}/inventory/items/${id}/movements`, { kind: 'out', qty: '11' })).status, 400, 'cannot go below zero');
  assert.equal((await stock.post(`/api/orgs/${orgId}/inventory/items/${id}/movements`, { kind: 'out', qty: '0' })).status, 400);
  assert.equal((await stock.post(`/api/orgs/${orgId}/inventory/items/${id}/movements`, { kind: 'out', qty: '7.5' })).data.qty, 2.5);
  assert.equal((await stock.post(`/api/orgs/${orgId}/inventory/items/${id}/movements`, { kind: 'adjust', qty: '3' })).status, 400, 'a correction needs a reason');
  assert.equal((await stock.post(`/api/orgs/${orgId}/inventory/items/${id}/movements`, { kind: 'adjust', qty: '3', note: 'stock take' })).data.qty, 3);
  const items = (await stock.get(`/api/orgs/${orgId}/inventory/items`)).data.items;
  assert.equal(items[0].low, true);
  assert.equal(items[0].value, 19500000, '3 bags x ₦65,000 = ₦195,000 (in kobo)');
  const hist = (await stock.get(`/api/orgs/${orgId}/inventory/items/${id}/movements`)).data.movements;
  assert.deepEqual(hist.map((m) => m.change).reverse(), [10, -7.5, 0.5]);
  const home = await stock.get(`/api/orgs/${orgId}/home`);
  assert.ok(widgetIds(home).every((i) => i.startsWith('inventory.')));
  assert.equal(home.data.widgets.find((w) => w.id === 'inventory.low_count').data.value, 1);
  assert.equal((await stock.get(`/api/orgs/${orgId}/sales/orders`)).status, 403);
});

test('the manager opens every dashboard; tabs follow their access', async () => {
  const home = (await manager.get(`/api/orgs/${orgId}/home`)).data;
  assert.deepEqual(home.tabs.map((t) => t.key), ['overview', 'accounts', 'hr', 'sales', 'inventory']);
  assert.equal(home.tab, 'overview');
  for (const t of ['accounts', 'hr', 'sales', 'inventory']) {
    const r = await manager.get(`/api/orgs/${orgId}/home?tab=${t}`);
    assert.equal(r.status, 200);
    assert.ok(r.data.widgets.length > 0 && r.data.widgets.every((w) => w.module === t));
  }
  assert.equal((await manager.get(`/api/orgs/${orgId}/reports/dashboard`)).status, 200, 'manager can view the books');
  assert.equal((await manager.post(`/api/orgs/${orgId}/transactions`, { kind: 'income', date: '2026-10-01', amount: '5' })).status, 403, 'but cannot record transactions');
  assert.equal((await manager.put(`/api/orgs/${orgId}/hr/leave/1`, { status: 'rejected' })).status, 200, 'manager approves leave');
  assert.equal((await manager.get(`/api/orgs/${orgId}/members`)).status, 403, 'manager is not the owner');

  const ownerHome = (await owner.get(`/api/orgs/${orgId}/home`)).data;
  assert.equal(ownerHome.tabs.length, 5);
});

test('the classic accountant still works and sees only the accounts dashboard', async () => {
  const home = (await accountant.get(`/api/orgs/${orgId}/home`)).data;
  assert.equal(home.role_name, 'Accountant');
  assert.equal(home.tabs, null);
  assert.ok(home.widgets.every((w) => w.module === 'accounts'));
  assert.equal((await accountant.get(`/api/orgs/${orgId}/hr/employees`)).status, 403);
  assert.equal((await accountant.get(`/api/orgs/${orgId}/reports/dashboard`)).status, 200);
});

test('only the platform admin edits roles; edits take effect for people already in the role', async () => {
  const hrRole = roles['HR Officer'];
  const edited = { name: 'HR Officer', description: 'HR plus a look at the books', all_dashboards: false,
    perms: { accounts: 'view', hr: 'edit', sales: 'none', inventory: 'none' }, widgets: ['hr.headcount', 'accounts.cash'] };
  assert.equal((await owner.put(`/api/orgs/${orgId}/roles/${hrRole.id}`, edited)).status, 403, 'owner cannot edit');
  assert.equal((await owner.post(`/api/orgs/${orgId}/roles`, edited)).status, 403);
  assert.equal((await admin.put(`/api/orgs/${orgId}/roles/${hrRole.id}`, { ...edited, perms: { accounts: 'none', hr: 'none', sales: 'none', inventory: 'none' } })).status, 400, 'needs some access');
  assert.equal((await admin.put(`/api/orgs/${orgId}/roles/${hrRole.id}`, { ...edited, widgets: [] })).status, 400, 'needs a widget');
  assert.equal((await admin.put(`/api/orgs/${orgId}/roles/${hrRole.id}`, { ...edited, name: 'Manager' })).status, 400, 'duplicate name');
  assert.equal((await admin.put(`/api/orgs/${orgId}/roles/${hrRole.id}`, edited)).status, 200);

  const home = await hr.get(`/api/orgs/${orgId}/home`);
  assert.deepEqual(widgetIds(home), ['accounts.cash', 'hr.headcount'], 'dashboard follows the edited widget list');
  assert.equal((await hr.get(`/api/orgs/${orgId}/reports/dashboard`)).status, 200, 'now has view access to the books');
  assert.equal((await hr.post(`/api/orgs/${orgId}/transactions`, { kind: 'income', date: '2026-10-01', amount: '5' })).status, 403, 'view only, so no recording');
});

test('admin can add a brand-new role and give it a dashboard; roles in use cannot be deleted', async () => {
  const c = await admin.post(`/api/orgs/${orgId}/roles`, { name: 'Procurement', description: 'Buys stock', all_dashboards: false,
    perms: { accounts: 'none', hr: 'none', sales: 'none', inventory: 'edit' }, widgets: ['inventory.low_list', 'inventory.value', 'sales.month'] });
  assert.equal(c.status, 200);
  const list = (await admin.get(`/api/orgs/${orgId}/roles`)).data.roles;
  const proc = list.find((r) => r.name === 'Procurement');
  assert.deepEqual(proc.widgets, ['inventory.value', 'inventory.low_list'], 'widgets from departments the role cannot access are dropped');
  assert.equal((await owner.post(`/api/orgs/${orgId}/members`, { email: 'hr@shop.test', role: `c${proc.id}` })).data.status, 'added');
  assert.equal((await admin.del(`/api/orgs/${orgId}/roles/${proc.id}`)).status, 400, 'someone is using it');
  assert.equal((await owner.post(`/api/orgs/${orgId}/members`, { email: 'hr@shop.test', role: `c${roles['HR Officer'].id}` })).data.status, 'added');
  assert.equal((await admin.del(`/api/orgs/${orgId}/roles/${proc.id}`)).status, 200);
});

test('role templates: admin edits them and new businesses get the change', async () => {
  assert.equal((await owner.get('/api/admin/role-templates')).status, 403);
  const t = (await admin.get('/api/admin/role-templates')).data.templates;
  assert.equal(t.length, 5);
  const created = await admin.post('/api/admin/role-templates', { name: 'Marketing', description: 'Runs promotions', all_dashboards: false,
    perms: { accounts: 'none', hr: 'none', sales: 'view', inventory: 'none' }, widgets: ['sales.month', 'sales.chart'] });
  assert.equal(created.status, 200);
  const o2 = (await admin.post('/api/orgs', { name: 'Second Biz', type: 'blank' })).data.id;
  assert.ok((await admin.get(`/api/orgs/${o2}/roles`)).data.roles.some((r) => r.name === 'Marketing'));
  // an existing business can pull in templates it is missing
  assert.equal((await admin.post(`/api/orgs/${orgId}/roles/from-templates`)).data.added, 1);
});

test('businesses are isolated from each other', async () => {
  await outsider.post('/api/register-business', { name: 'Other', email: 'other@else.test', password: 'longenough1', business_name: 'Other Ltd', type: 'blank' });
  for (const url of ['hr/employees', 'sales/orders', 'inventory/items', 'home', 'roles']) {
    assert.equal((await outsider.get(`/api/orgs/${orgId}/${url}`)).status, 404, `${url} must not leak across businesses`);
  }
  assert.equal((await outsider.post(`/api/orgs/${orgId}/hr/employees`, { name: 'Sneaky' })).status, 404);
});
