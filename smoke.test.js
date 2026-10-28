'use strict';
// Run with:  npm test      (uses a throw-away in-memory database)
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

// A tiny "browser" that remembers its login cookie.
function client() {
  let cookie = '';
  const call = async (method, url, body, extraHeaders = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledgerly', ...(cookie ? { cookie } : {}), ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b || {}), del: (u) => call('DELETE', u), call };
}

const admin = client(); const farmer = client(); const vet = client(); const stranger = client(); const anon = client();
let orgId; let acct = {};
const byName = (name) => acct[name];

test('first user becomes platform admin; signup rules are enforced', async () => {
  assert.equal((await anon.get('/api/me')).data.first_run, true);
  assert.equal((await admin.post('/api/signup', { name: 'Platform Admin', email: 'admin@ledgerly.test', password: 'short' })).status, 400);
  assert.equal((await admin.post('/api/signup', { name: 'Platform Admin', email: 'not-an-email', password: 'longenough1' })).status, 400);
  assert.equal((await admin.post('/api/signup', { name: 'Platform Admin', email: 'admin@ledgerly.test', password: 'longenough1' })).status, 200);
  const me = (await admin.get('/api/me')).data;
  assert.equal(me.user.is_admin, true);
  assert.equal((await anon.get('/api/me')).data.first_run, false);
  assert.equal((await anon.post('/api/signup', { name: 'Dup', email: 'ADMIN@ledgerly.test', password: 'longenough1' })).status, 400, 'duplicate email (case-insensitive)');
});

test('wrong password is rejected, right one works', async () => {
  const c = client();
  assert.equal((await c.post('/api/login', { email: 'admin@ledgerly.test', password: 'wrongwrong' })).status, 401);
  assert.equal((await c.post('/api/login', { email: 'admin@ledgerly.test', password: 'longenough1' })).status, 200);
});

test('admin onboards the poultry farm and invites the owner before they sign up', async () => {
  const r = await admin.post('/api/orgs', { name: 'Adebayo Poultry Farm', type: 'poultry_farm', owner_email: 'Farmer@Example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.data.owner_status, 'invited');
  orgId = r.data.id;
  assert.equal((await admin.post('/api/orgs', { name: 'X', type: 'nonsense' })).status, 400);

  assert.equal((await farmer.post('/api/signup', { name: 'Mr Adebayo', email: 'farmer@example.com', password: 'poultry-2026' })).status, 200);
  const me = (await farmer.get('/api/me')).data;
  assert.equal(me.user.is_admin, false);
  assert.equal(me.orgs.length, 1);
  assert.equal(me.orgs[0].role, 'owner');
  assert.equal(me.orgs[0].currency, 'NGN', 'Naira is the default currency');

  assert.equal((await farmer.post('/api/orgs', { name: 'Sneaky', type: 'blank' })).status, 403, 'only the admin can onboard clients');
});

test('poultry template gives eggs/feed accounts and farm fields', async () => {
  const s = (await farmer.get(`/api/orgs/${orgId}/setup`)).data;
  assert.equal(s.org.type_label, 'Poultry Farm');
  for (const a of s.accounts) acct[a.name] = a;
  for (const n of ['Egg Sales', 'Feed', 'Vaccines & Medication', 'Bank Account', 'Cash on Hand', "Owner's Capital", 'Suppliers We Owe (Payable)', 'Customers Owing Us (Receivable)']) {
    assert.ok(byName(n), `missing account ${n}`);
  }
  assert.deepEqual(s.fields.map((f) => f.label), ['Flock / Batch', 'House / Pen', 'Quantity', 'Unit']);
});

const tx = (kind, extra) => farmer.post(`/api/orgs/${orgId}/transactions`, { kind, date: '2026-10-05', ...extra });

test('record a month of farm activity', async () => {
  const bank = byName('Bank Account').id; const cash = byName('Cash on Hand').id;
  const recv = byName('Customers Owing Us (Receivable)').id; const pay = byName('Suppliers We Owe (Payable)').id;

  // Owner puts in capital: ₦500,000 into the bank.
  assert.equal((await tx('transfer', { amount: '500,000', from_account_id: byName("Owner's Capital").id, to_account_id: bank, description: 'Start-up capital' })).status, 200);
  // Buy feed ₦120,000.50 from the bank, with farm details.
  const feed = await tx('expense', { amount: '120000.50', account_id: byName('Feed').id, money_account_id: bank, description: '40 bags layers mash', custom: { flock_batch: 'Batch 7', quantity: '40', unit: 'Bags' } });
  assert.equal(feed.status, 200, JSON.stringify(feed.data));
  // Egg sales ₦85,000 cash.
  assert.equal((await tx('income', { amount: '85000', account_id: byName('Egg Sales').id, money_account_id: cash, description: '100 crates', custom: { house_pen: 'House A' } })).status, 200);
  // Sale on credit ₦40,000.
  assert.equal((await tx('income', { amount: 40000, account_id: byName('Broiler / Live Bird Sales').id, money_account_id: recv, description: 'Birds to caterer' })).status, 200);
  // Vaccines on credit ₦15,000.
  assert.equal((await tx('expense', { amount: '15000', account_id: byName('Vaccines & Medication').id, money_account_id: pay, date: '2026-10-07' })).status, 200);
  // Customer pays what they owed.
  assert.equal((await tx('transfer', { amount: '40000', from_account_id: recv, to_account_id: cash, date: '2026-10-20' })).status, 200);
  // A mistake that gets voided.
  const oops = await tx('expense', { amount: '999999', account_id: byName('Other Expenses').id, money_account_id: cash });
  assert.equal(oops.status, 200);
  assert.equal((await farmer.del(`/api/orgs/${orgId}/transactions/${oops.data.id}`)).status, 200);
  assert.equal((await farmer.del(`/api/orgs/${orgId}/transactions/${oops.data.id}`)).status, 404, 'cannot void twice');
});

test('reports add up exactly (money kept in kobo, no rounding drift)', async () => {
  const pl = (await farmer.get(`/api/orgs/${orgId}/reports/profit-loss?from=2026-10-01&to=2026-10-31`)).data;
  assert.equal(pl.total_income, 12500000);       // 85,000 + 40,000
  assert.equal(pl.total_expenses, 13500050);     // 120,000.50 + 15,000
  assert.equal(pl.net_profit, -1000050);         // a small loss: -10,000.50

  const tb = (await farmer.get(`/api/orgs/${orgId}/reports/trial-balance?as_at=2026-10-31`)).data;
  assert.equal(tb.balanced, true);
  assert.equal(tb.total_debit, tb.total_credit);

  const bs = (await farmer.get(`/api/orgs/${orgId}/reports/balance-sheet?as_at=2026-10-31`)).data;
  assert.equal(bs.balanced, true);
  assert.equal(bs.retained_earnings, -1000050);
  // bank 379,999.50 + cash 125,000 (85,000 + 40,000 collected) = 504,999.50
  assert.equal(bs.total_assets, 50499950);
  assert.equal(bs.total_liabilities, 1500000);   // owe suppliers 15,000
  assert.equal(bs.total_equity, 50000000 - 1000050);

  const dash = (await farmer.get(`/api/orgs/${orgId}/reports/dashboard?today=2026-10-27`)).data;
  assert.equal(dash.cash, 50499950);
  assert.equal(dash.receivable, 0);
  assert.equal(dash.payable, 1500000);
  assert.equal(dash.month_profit, -1000050);
  assert.equal(dash.series.length, 6);
  assert.equal(dash.series[5].month, '2026-10');
  assert.equal(dash.top_expenses[0].name, 'Feed');

  const ledger = (await farmer.get(`/api/orgs/${orgId}/accounts/${byName('Bank Account').id}/ledger`)).data;
  assert.equal(ledger.closing, 37999950);
});

test('transactions list: filters, search on farm details, voided hidden by default', async () => {
  const all = (await farmer.get(`/api/orgs/${orgId}/transactions`)).data;
  assert.equal(all.total, 6);
  assert.equal((await farmer.get(`/api/orgs/${orgId}/transactions?voided=1`)).data.total, 7);
  assert.equal((await farmer.get(`/api/orgs/${orgId}/transactions?q=Batch%207`)).data.total, 1, 'search covers custom fields');
  assert.equal((await farmer.get(`/api/orgs/${orgId}/transactions?kind=income`)).data.total, 2);
  assert.equal((await farmer.get(`/api/orgs/${orgId}/transactions?account_id=${byName('Egg Sales').id}`)).data.total, 1);
  assert.equal((await farmer.get(`/api/orgs/${orgId}/transactions?from=bad`)).status, 400);
  const withFields = all.transactions.find((t) => t.description === '40 bags layers mash');
  assert.equal(withFields.custom.flock_batch, 'Batch 7');
});

test('input validation protects the books', async () => {
  const bank = byName('Bank Account').id; const feed = byName('Feed').id; const eggs = byName('Egg Sales').id;
  for (const amount of ['abc', '-5', '0', '1.234', '', '1e9', '99999999999999']) {
    assert.equal((await tx('expense', { amount, account_id: feed, money_account_id: bank })).status, 400, `amount ${amount}`);
  }
  assert.equal((await farmer.post(`/api/orgs/${orgId}/transactions`, { kind: 'expense', date: '2026-02-30', amount: '5', account_id: feed, money_account_id: bank })).status, 400, 'impossible date');
  assert.equal((await tx('expense', { amount: '5', account_id: eggs, money_account_id: bank })).status, 400, 'expense into an income account');
  assert.equal((await tx('income', { amount: '5', account_id: feed, money_account_id: bank })).status, 400, 'income into an expense account');
  assert.equal((await tx('transfer', { amount: '5', from_account_id: bank, to_account_id: bank })).status, 400, 'same account');
  assert.equal((await tx('transfer', { amount: '5', from_account_id: bank, to_account_id: feed })).status, 400, 'transfer into an expense');
  assert.equal((await tx('expense', { amount: '5', account_id: feed, money_account_id: bank, custom: { unit: 'Elephants' } })).status, 400, 'drop-down value must be a listed choice');
  assert.equal((await tx('expense', { amount: '5', account_id: feed, money_account_id: bank, custom: { quantity: 'lots' } })).status, 400, 'number field');
  assert.equal((await tx('weird', { amount: '5' })).status, 400);
});

test('owner customises accounts and fields for this client', async () => {
  // Add a brand-new income account and use it.
  const add = await farmer.post(`/api/orgs/${orgId}/accounts`, { code: '4050', name: 'Crate Return Deposits', type: 'income' });
  assert.equal(add.status, 200);
  assert.equal((await farmer.post(`/api/orgs/${orgId}/accounts`, { code: '4050', name: 'Dup', type: 'income' })).status, 400, 'duplicate code');
  assert.equal((await farmer.post(`/api/orgs/${orgId}/accounts`, { code: '9', name: 'Bad tag', type: 'income', tag: 'cash' })).status, 400, 'cash tag only on assets');
  assert.equal((await tx('income', { amount: '2500', account_id: add.data.id, money_account_id: byName('Cash on Hand').id })).status, 200);

  // Switch an account off: no new entries, history kept.
  assert.equal((await farmer.put(`/api/orgs/${orgId}/accounts/${byName('Poultry Manure Sales').id}`, { active: false })).status, 200);
  const blocked = await tx('income', { amount: '10', account_id: byName('Poultry Manure Sales').id, money_account_id: byName('Cash on Hand').id });
  assert.equal(blocked.status, 400);

  // A new required drop-down field.
  const f = await farmer.post(`/api/orgs/${orgId}/fields`, { label: 'Mortality Cause', type: 'select', options: 'Disease, Heat, Predator', required: true });
  assert.equal(f.status, 200);
  const miss = await tx('expense', { amount: '10', account_id: byName('Bird Mortality Loss').id, money_account_id: byName('Cash on Hand').id });
  assert.equal(miss.status, 400);
  assert.match(miss.data.error, /Mortality Cause/);
  const ok = await tx('expense', { amount: '10', account_id: byName('Bird Mortality Loss').id, money_account_id: byName('Cash on Hand').id, custom: { mortality_cause: 'Heat' } });
  assert.equal(ok.status, 200);
  // Hide it again so later tests are unaffected.
  assert.equal((await farmer.put(`/api/orgs/${orgId}/fields/${f.data.id}`, { active: false })).status, 200);
  assert.equal((await tx('expense', { amount: '10', account_id: byName('Bird Mortality Loss').id, money_account_id: byName('Cash on Hand').id })).status, 200);
});

test('roles: accountant can record but not configure; viewer is read-only', async () => {
  assert.equal((await farmer.post(`/api/orgs/${orgId}/members`, { email: 'vet@example.com', role: 'viewer' })).data.status, 'invited');
  assert.equal((await vet.post('/api/signup', { name: 'Dr Vet', email: 'vet@example.com', password: 'vet-password-1' })).status, 200);
  const cash = byName('Cash on Hand').id; const feed = byName('Feed').id;
  assert.equal((await vet.get(`/api/orgs/${orgId}/reports/profit-loss?from=2026-10-01&to=2026-10-31`)).status, 200, 'viewer can read');
  assert.equal((await vet.post(`/api/orgs/${orgId}/transactions`, { kind: 'expense', date: '2026-10-05', amount: '5', account_id: feed, money_account_id: cash })).status, 403, 'viewer cannot record');
  assert.equal((await vet.post(`/api/orgs/${orgId}/accounts`, { code: '7', name: 'x', type: 'asset' })).status, 403);
  assert.equal((await vet.get(`/api/orgs/${orgId}/members`)).status, 403);

  assert.equal((await farmer.post(`/api/orgs/${orgId}/members`, { email: 'vet@example.com', role: 'accountant' })).data.status, 'added');
  assert.equal((await vet.post(`/api/orgs/${orgId}/transactions`, { kind: 'expense', date: '2026-10-05', amount: '5', account_id: feed, money_account_id: cash })).status, 200, 'accountant can record');
  assert.equal((await vet.post(`/api/orgs/${orgId}/accounts`, { code: '7', name: 'x', type: 'asset' })).status, 403, 'accountant cannot change the chart of accounts');
  assert.equal((await vet.post(`/api/orgs/${orgId}/fields`, { label: 'x', type: 'text' })).status, 403);
});

test('tenant isolation: strangers cannot see or touch another client’s books', async () => {
  await stranger.post('/api/signup', { name: 'Other Biz', email: 'other@example.com', password: 'other-password-1' });
  for (const [m, u] of [['get', `/api/orgs/${orgId}/setup`], ['get', `/api/orgs/${orgId}/transactions`], ['get', `/api/orgs/${orgId}/reports/dashboard`], ['get', `/api/orgs/${orgId}/transactions.csv`]]) {
    assert.equal((await stranger[m](u)).status, 404, u);
  }
  assert.equal((await stranger.post(`/api/orgs/${orgId}/transactions`, { kind: 'income' })).status, 404);
  assert.equal((await anon.get(`/api/orgs/${orgId}/setup`)).status, 401);
  assert.equal((await stranger.get('/api/admin/orgs')).status, 403);
  assert.equal((await stranger.get('/api/me')).data.orgs.length, 0);

  // Another client created by admin: accounts of one org cannot be used in another org's transaction.
  const other = (await admin.post('/api/orgs', { name: 'Green Hills School', type: 'school', owner_email: 'other@example.com' })).data.id;
  const schoolSetup = (await stranger.get(`/api/orgs/${other}/setup`)).data;
  assert.equal(schoolSetup.role, 'owner');
  const cross = await stranger.post(`/api/orgs/${other}/transactions`, { kind: 'income', date: '2026-10-05', amount: '5', account_id: byName('Egg Sales').id, money_account_id: byName('Cash on Hand').id });
  assert.equal(cross.status, 400, 'cannot reference another organisation’s account');
  assert.deepEqual(schoolSetup.fields.map((f) => f.label), ['Student ID / Name', 'Class', 'Term', 'Session (e.g. 2026/2027)']);
  assert.ok(schoolSetup.accounts.some((a) => a.name === 'Tuition Fees'));
});

test('CSRF protection and CSV safety', async () => {
  const res = await farmer.call('POST', `/api/orgs/${orgId}/transactions`, { kind: 'income' }, { 'X-Requested-With': '' });
  assert.equal(res.status, 403, 'requests without the app header are blocked');

  await tx('income', { amount: '1', account_id: byName('Egg Sales').id, money_account_id: byName('Cash on Hand').id, description: '=HYPERLINK("http://evil","click")' });
  const csv = await farmer.get(`/api/orgs/${orgId}/transactions.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /Flock \/ Batch/);
  assert.ok(!/,=HYPERLINK/.test(csv.data), 'formula must be neutralised');
  assert.match(csv.data, /'=HYPERLINK/);
  assert.match(csv.data, /120000\.50/);
});

test('static files are served with security headers; path traversal is blocked', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.notEqual((await fetch(base + '/..%2fserver.js')).status, 200);
  assert.notEqual((await fetch(base + '/%2e%2e/%2e%2e/etc/passwd')).status, 200);
});
