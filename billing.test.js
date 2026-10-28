'use strict';
// Tests for: proxy-aware rate limits, password reset, subscriptions, school portal.
// Paystack and the email service are replaced by fakes, so no real money or email is involved.
process.env.DB_PATH = ':memory:';
process.env.TRUST_PROXY = '1';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_fake';
process.env.APP_URL = 'https://ledgerly.example';
process.env.PLAN_PRICE_NGN = '5000';
process.env.TRIAL_DAYS = '30';
process.env.RESEND_API_KEY = 're_fake';
process.env.MAIL_FROM = 'Ledgerly <no-reply@ledgerly.example>';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { server, db } = require('../server');

/* ---------- fake Paystack + fake email, everything else goes to the real network stack ---------- */
const realFetch = globalThis.fetch;
const paystackCalls = [];
const paystackTx = new Map();   // reference -> { amount, status }
const emails = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
  if (u.startsWith('https://api.paystack.co')) {
    assert.equal(opts.headers.Authorization, 'Bearer sk_test_fake');
    const path = u.replace('https://api.paystack.co', '');
    if (path === '/transaction/initialize') {
      const body = JSON.parse(opts.body);
      paystackCalls.push(body);
      paystackTx.set(body.reference, { amount: body.amount, status: 'pending' });
      return json(200, { status: true, data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, reference: body.reference } });
    }
    if (path.startsWith('/transaction/verify/')) {
      const ref = decodeURIComponent(path.split('/').pop());
      const t = paystackTx.get(ref);
      if (!t) return json(404, { status: false, message: 'not found' });
      return json(200, { status: true, data: { status: t.status, amount: t.paidAmount ?? t.amount, currency: 'NGN', reference: ref } });
    }
    return json(404, { status: false });
  }
  if (u.startsWith('https://api.resend.com')) {
    emails.push(JSON.parse(opts.body));
    return json(200, { id: 'email_1' });
  }
  return realFetch(url, opts);
};
const payOnPaystack = (ref, patch = {}) => Object.assign(paystackTx.get(ref), { status: 'success' }, patch);

let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

function client(ip = '203.0.113.1') {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await realFetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledgerly', 'X-Forwarded-For': `${ip}`, ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { call, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b || {}), del: (u) => call('DELETE', u) };
}

const admin = client('198.51.100.10'); const owner = client('198.51.100.20'); const anon = client('198.51.100.30');
let farmId; let schoolId; let A = {};

/* ================================================================ */
test('rate limit: people behind a proxy are counted separately, but one attacker is still stopped', async () => {
  // 12 different visitors signing up through the same proxy must all succeed (the old bug blocked them after 10).
  for (let i = 0; i < 12; i++) {
    const c = client(`192.0.2.${i + 1}`);
    const r = await c.post('/api/signup', { name: `User ${i}`, email: `user${i}@example.com`, password: 'password-12345' });
    assert.equal(r.status, 200, `visitor ${i}: ${JSON.stringify(r.data)}`);
  }
  // One visitor hammering logins gets blocked on the 11th try...
  const attacker = client('192.0.2.200');
  let last;
  for (let i = 0; i < 11; i++) last = await attacker.post('/api/login', { email: 'user0@example.com', password: `wrong-guess-${i}` });
  assert.equal(last.status, 429);
  // ...while a different visitor can still log in to the same account.
  assert.equal((await client('192.0.2.201').post('/api/login', { email: 'user0@example.com', password: 'password-12345' })).status, 200);
  // A forged X-Forwarded-For on the left cannot dodge the limit (we read from the right).
  const sneaky = client('1.1.1.1, 192.0.2.200');
  assert.equal((await sneaky.post('/api/login', { email: 'user0@example.com', password: 'wrong-again' })).status, 429);
});

/* ================================================================ */
test('platform admin = first user; admin onboards a poultry farm and a restaurant, each with a trial', async () => {
  db.exec('DELETE FROM users'); // start clean so the next signup is the first user
  assert.equal((await admin.post('/api/signup', { name: 'Admin', email: 'admin@ledgerly.test', password: 'admin-password-1' })).status, 200);
  assert.equal((await admin.get('/api/me')).data.user.is_admin, true);

  const farm = await admin.post('/api/orgs', { name: 'Adebayo Poultry Farm', type: 'poultry_farm', owner_email: 'farmer@example.com' });
  assert.equal(farm.status, 200); farmId = farm.data.id;
  const rest = await admin.post('/api/orgs', { name: 'Mama Put Kitchen', type: 'restaurant' });
  assert.equal(rest.status, 200);
  const restSetup = (await admin.get(`/api/orgs/${rest.data.id}/setup`)).data;
  assert.equal(restSetup.org.type_label, 'Restaurant / Food Business');
  assert.ok(restSetup.accounts.some((a) => a.name === 'Cooking Gas / Charcoal'));
  assert.ok(restSetup.accounts.some((a) => a.name === 'Food Sales (Dine-in)'));
  assert.deepEqual(restSetup.fields.map((f) => f.label), ['Table / Order No.', 'Meal Period', 'Payment Method', 'Branch / Outlet']);
  assert.equal(restSetup.billing.status, 'trial');
  assert.equal(restSetup.billing.days_left, 30);

  assert.equal((await owner.post('/api/signup', { name: 'Mr Adebayo', email: 'farmer@example.com', password: 'poultry-2026' })).status, 200);
  const s = (await owner.get(`/api/orgs/${farmId}/setup`)).data;
  for (const a of s.accounts) A[a.name] = a.id;
  assert.equal(s.billing.status, 'trial');
});

/* ================================================================ */
test('password reset: emailed link works once, kills old logins, and never reveals who has an account', async () => {
  const stranger = client('198.51.100.41');
  const unknown = await stranger.post('/api/forgot', { email: 'nobody@example.com' });
  emails.length = 0;
  const known = await stranger.post('/api/forgot', { email: 'FARMER@example.com' });
  assert.equal(unknown.status, 200); assert.equal(known.status, 200);
  assert.deepEqual(unknown.data, known.data, 'identical answer for known and unknown emails');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(emails.length, 1, 'only the real account gets an email');
  assert.deepEqual(emails[0].to, ['farmer@example.com']);
  const token = emails[0].text.match(/\/#\/reset\/([A-Za-z0-9_-]+)/)[1];
  assert.match(emails[0].text, /^Hello Mr Adebayo/);
  assert.ok(emails[0].text.includes('https://ledgerly.example/#/reset/'));

  const oldSession = owner; // still logged in
  assert.equal((await oldSession.get('/api/me')).data.user.name, 'Mr Adebayo');

  assert.equal((await stranger.post('/api/reset', { token, password: 'short' })).status, 400);
  assert.equal((await stranger.post('/api/reset', { token: 'garbage', password: 'brand-new-pass-1' })).status, 400);
  assert.equal((await stranger.post('/api/reset', { token, password: 'brand-new-pass-1' })).status, 200);
  assert.equal((await stranger.post('/api/reset', { token, password: 'another-pass-123' })).status, 400, 'token works once only');

  assert.equal((await oldSession.get('/api/me')).data.user, null, 'old sessions are logged out');
  assert.equal((await client('198.51.100.42').post('/api/login', { email: 'farmer@example.com', password: 'poultry-2026' })).status, 401);
  assert.equal((await owner.post('/api/login', { email: 'farmer@example.com', password: 'brand-new-pass-1' })).status, 200);

  // expired token
  await stranger.post('/api/forgot', { email: 'farmer@example.com' });
  await new Promise((r) => setTimeout(r, 50));
  const t2 = emails.at(-1).text.match(/\/#\/reset\/([A-Za-z0-9_-]+)/)[1];
  db.exec("UPDATE password_resets SET expires_at = datetime('now', '-1 minute')");
  assert.equal((await stranger.post('/api/reset', { token: t2, password: 'brand-new-pass-2' })).status, 400, 'expired');
});

test('admin can generate a reset link by hand (when email is not available); others cannot', async () => {
  const r = await admin.post('/api/admin/reset-link', { email: 'farmer@example.com' });
  assert.equal(r.status, 200);
  assert.match(r.data.link, /^https:\/\/ledgerly\.example\/#\/reset\/[A-Za-z0-9_-]{40,}$/);
  assert.equal((await admin.post('/api/admin/reset-link', { email: 'nobody@example.com' })).status, 400);
  assert.equal((await owner.post('/api/admin/reset-link', { email: 'farmer@example.com' })).status, 403);
});

/* ================================================================ */
test('trial -> expired (read-only) -> pay with Paystack -> active', async () => {
  const bank = A['Bank Account']; const cap = A["Owner's Capital"];
  const rec = () => owner.post(`/api/orgs/${farmId}/transactions`, { kind: 'transfer', date: '2026-10-05', amount: '1000', from_account_id: cap, to_account_id: bank });
  assert.equal((await rec()).status, 200, 'works during trial');

  db.prepare("UPDATE organizations SET trial_ends_at = date('now','-2 days') WHERE id = ?").run(farmId);
  const blocked = await rec();
  assert.equal(blocked.status, 402);
  assert.match(blocked.data.error, /Billing/);
  assert.equal((await owner.get(`/api/orgs/${farmId}/reports/profit-loss?from=2026-01-01&to=2026-12-31`)).status, 200, 'reports still readable');
  assert.equal((await owner.get(`/api/orgs/${farmId}/transactions.csv`)).status, 200, 'export still works');
  assert.equal((await owner.get(`/api/orgs/${farmId}/setup`)).data.billing.status, 'expired');

  const b = (await owner.get(`/api/orgs/${farmId}/billing`)).data;
  assert.equal(b.status, 'expired'); assert.equal(b.price_month, 500000); assert.deepEqual(b.months, [1, 3, 6, 12]);

  assert.equal((await owner.post(`/api/orgs/${farmId}/billing/checkout`, { months: 2 })).status, 400);
  const co = await owner.post(`/api/orgs/${farmId}/billing/checkout`, { months: 3 });
  assert.equal(co.status, 200, JSON.stringify(co.data));
  assert.match(co.data.url, /^https:\/\/checkout\.paystack\.test\//);
  const init = paystackCalls.at(-1);
  assert.equal(init.amount, 1500000, '3 months x ₦5,000, in kobo');
  assert.equal(init.email, 'farmer@example.com');
  assert.equal(init.callback_url, 'https://ledgerly.example/billing-return');
  assert.equal(init.subaccount, undefined, 'subscription money goes to the platform, not a school');
  const ref = init.reference;

  // Paying customer has not completed payment yet -> nothing changes
  const early = await anon.get(`/api/payments/verify?reference=${ref}`);
  assert.equal(early.data.status, 'pending');
  assert.equal((await rec()).status, 402);

  // Webhooks must be signed
  const body = JSON.stringify({ event: 'charge.success', data: { reference: ref } });
  const wh = (sig) => realFetch(`${base}/api/paystack/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig }, body });
  payOnPaystack(ref);
  assert.equal((await wh('deadbeef')).status, 401, 'bad signature rejected');
  assert.equal((await owner.get(`/api/orgs/${farmId}/setup`)).data.billing.status, 'expired', 'fake webhook changed nothing');

  const goodSig = crypto.createHmac('sha512', 'sk_test_fake').update(body).digest('hex');
  assert.equal((await wh(goodSig)).status, 200);
  let info = (await owner.get(`/api/orgs/${farmId}/setup`)).data.billing;
  assert.equal(info.status, 'active');
  assert.ok(info.days_left >= 88 && info.days_left <= 93, `about 3 months left, got ${info.days_left}`);
  const until = info.until;

  // Same payment confirmed again (browser return + retry webhook) must not extend twice
  assert.equal((await wh(goodSig)).status, 200);
  await anon.get(`/api/payments/verify?reference=${ref}`);
  assert.equal((await owner.get(`/api/orgs/${farmId}/setup`)).data.billing.until, until, 'no double credit');
  assert.equal((await rec()).status, 200, 'recording works again');

  // The return page after paying also activates (server redirects to the billing page)
  const co2 = await owner.post(`/api/orgs/${farmId}/billing/checkout`, { months: 1 });
  const ref2 = paystackCalls.at(-1).reference; payOnPaystack(ref2);
  const back = await owner.get(`/billing-return?reference=${ref2}&trxref=${ref2}`);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), `/#/org/${farmId}/billing`);
  assert.ok(co2.status === 200);
  const after = (await owner.get(`/api/orgs/${farmId}/setup`)).data.billing;
  assert.ok(after.until > until, 'renewing early adds to the end of the paid period');

  const hist = (await owner.get(`/api/orgs/${farmId}/billing`)).data.payments;
  assert.equal(hist.filter((p) => p.status === 'success').length, 2);
});

test('underpayment is not accepted as a full payment', async () => {
  const farm2 = (await admin.post('/api/orgs', { name: 'Test Org', type: 'blank', owner_email: 'farmer@example.com' })).data.id;
  db.prepare("UPDATE organizations SET trial_ends_at = date('now','-1 day') WHERE id = ?").run(farm2);
  await owner.post(`/api/orgs/${farm2}/billing/checkout`, { months: 1 });
  const ref = paystackCalls.at(-1).reference;
  payOnPaystack(ref, { paidAmount: 100 }); // paid ₦1 instead of ₦5,000
  const v = await anon.get(`/api/payments/verify?reference=${ref}`);
  assert.equal(v.data.status, 'mismatch');
  assert.equal((await owner.get(`/api/orgs/${farm2}/setup`)).data.billing.status, 'expired');
});

test('platform admin: grant days, set a custom price, mark an account free; owners cannot', async () => {
  const org = (await admin.post('/api/orgs', { name: 'Friend Shop', type: 'sole_proprietor', owner_email: 'friend@example.com' })).data.id;
  db.prepare("UPDATE organizations SET trial_ends_at = date('now','-5 days') WHERE id = ?").run(org);
  assert.equal((await admin.get(`/api/orgs/${org}/setup`)).data.billing.status, 'expired');

  assert.equal((await admin.post(`/api/orgs/${org}/billing/admin`, { add_days: 45 })).status, 200);
  let b = (await admin.get(`/api/orgs/${org}/billing`)).data;
  assert.equal(b.status, 'active'); assert.ok(b.days_left >= 44 && b.days_left <= 46);
  assert.equal((await admin.post(`/api/orgs/${org}/billing/admin`, { add_days: 0.5 })).status, 400);
  assert.equal((await admin.post(`/api/orgs/${org}/billing/admin`, { plan_price: '2,500' })).status, 200);
  assert.equal((await admin.get(`/api/orgs/${org}/billing`)).data.price_month, 250000);
  assert.equal((await admin.post(`/api/orgs/${org}/billing/admin`, { plan_price: '' })).status, 200);
  assert.equal((await admin.get(`/api/orgs/${org}/billing`)).data.price_month, 500000);
  assert.equal((await admin.post(`/api/orgs/${org}/billing/admin`, { exempt: true })).status, 200);
  db.prepare('UPDATE organizations SET paid_until = NULL, trial_ends_at = NULL WHERE id = ?').run(org);
  assert.equal((await admin.get(`/api/orgs/${org}/setup`)).data.billing.status, 'exempt');

  const list = (await admin.get('/api/admin/orgs')).data.orgs;
  assert.ok(list.find((o) => o.id === org).plan.status === 'exempt');
  assert.equal((await owner.post(`/api/orgs/${farmId}/billing/admin`, { add_days: 999 })).status, 403, 'an owner cannot give themselves free time');
});

/* ================================================================ */
test('school portal: setup, public payment page, split to the school, auto-booked', async () => {
  schoolId = (await admin.post('/api/orgs', { name: 'Green Hills Academy', type: 'school', owner_email: 'principal@school.test' })).data.id;
  const principal = client('198.51.100.60');
  await principal.post('/api/signup', { name: 'Principal', email: 'principal@school.test', password: 'principal-pass-1' });
  const S = {}; for (const a of (await principal.get(`/api/orgs/${schoolId}/setup`)).data.accounts) S[a.name] = a.id;

  // Not live yet
  assert.equal((await anon.get('/api/portal/green-hills')).status, 404);

  const cfg = {
    enabled: true, slug: 'green-hills', note: 'Pay school fees securely online.',
    items: [
      { label: 'Tuition', account_id: S['Tuition Fees'], amount: '' },
      { label: 'Exam Fee', account_id: S['Exam, Lesson & Extra-Curricular Fees'], amount: '15,000' },
    ],
  };
  assert.equal((await principal.put(`/api/orgs/${schoolId}/portal`, { ...cfg, slug: 'Bad Slug!' })).status, 400);
  assert.equal((await principal.put(`/api/orgs/${schoolId}/portal`, { ...cfg, slug: 'admin' })).status, 400, 'reserved');
  assert.equal((await principal.put(`/api/orgs/${schoolId}/portal`, { ...cfg, items: [{ label: 'Bad', account_id: S['Cash on Hand'] }] })).status, 400, 'fee items must point at income accounts');
  assert.equal((await principal.put(`/api/orgs/${schoolId}/portal`, { ...cfg, subaccount: 'ACCT_hijack12345' })).status, 200);
  assert.equal((await principal.get(`/api/orgs/${schoolId}/portal`)).data.subaccount, '', 'a school cannot set its own payout account');

  // The page is not payable until the admin links the school's bank (Paystack subaccount)
  assert.equal((await anon.get('/api/portal/green-hills')).status, 503);
  assert.equal((await principal.put(`/api/orgs/${schoolId}/portal`, { ...cfg, subaccount: 'ACCT_nope' })).status, 200);
  assert.equal((await admin.put(`/api/orgs/${schoolId}/portal`, { ...cfg, subaccount: 'bad code' })).status, 400);
  assert.equal((await admin.put(`/api/orgs/${schoolId}/portal`, { ...cfg, subaccount: 'ACCT_school12345' })).status, 200);

  // two schools cannot share one web address
  const other = (await admin.post('/api/orgs', { name: 'Other School', type: 'school' })).data.id;
  assert.equal((await admin.put(`/api/orgs/${other}/portal`, { ...cfg, slug: 'green-hills' })).status, 400);

  const pub = await anon.get('/api/portal/green-hills');
  assert.equal(pub.status, 200);
  assert.equal(pub.data.school, 'Green Hills Academy');
  assert.equal(pub.data.items.length, 2);
  assert.ok(!JSON.stringify(pub.data).includes('ACCT_'), 'payout account is never shown publicly');
  assert.ok(!JSON.stringify(pub.data).includes('account_id'), 'internal accounts are not shown publicly');
  const tuition = pub.data.items.find((i) => i.label === 'Tuition'); const exam = pub.data.items.find((i) => i.label === 'Exam Fee');
  assert.equal(exam.amount, 1500000);

  // validation on the public form
  const pay = (b) => anon.post('/api/portal/green-hills/pay', b);
  const good = { item_id: tuition.id, amount: '85,000', email: 'parent@example.com', student_name: 'Tola Ade', student_class: 'JSS 2', term: 'First Term', payer_name: 'Mrs Ade' };
  assert.equal((await pay({ ...good, email: 'nope' })).status, 400);
  assert.equal((await pay({ ...good, student_name: '' })).status, 400);
  assert.equal((await pay({ ...good, amount: '10' })).status, 400, 'below ₦100');
  assert.equal((await pay({ ...good, item_id: 'zzzzzzzz' })).status, 400);
  const sent = await pay(good);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const init = paystackCalls.at(-1);
  assert.equal(init.amount, 8500000);
  assert.equal(init.subaccount, 'ACCT_school12345', 'money is split to the school');
  assert.equal(init.bearer, 'subaccount', 'the school bears the Paystack fee, not the platform');
  assert.equal(init.callback_url, 'https://ledgerly.example/pay/green-hills');

  // a fixed-price item ignores whatever amount the payer types
  await pay({ ...good, item_id: exam.id, amount: '1' });
  assert.equal(paystackCalls.at(-1).amount, 1500000);
  const examRef = paystackCalls.at(-1).reference;

  const ref = init.reference;
  assert.equal((await anon.get(`/api/payments/verify?reference=${ref}`)).data.status, 'pending');
  const before = (await principal.get(`/api/orgs/${schoolId}/transactions`)).data.total;
  assert.equal(before, 0);

  emails.length = 0;
  payOnPaystack(ref);
  const v = await anon.get(`/api/payments/verify?reference=${ref}`);
  assert.equal(v.data.status, 'success');
  assert.equal(v.data.student, 'Tola Ade'); assert.equal(v.data.school, 'Green Hills Academy');
  assert.ok(!('email' in v.data), 'receipt page does not expose the parent’s email');
  await anon.get(`/api/payments/verify?reference=${ref}`); // second time: must not double-book
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(emails.length, 1, 'receipt emailed once');
  assert.match(emails[0].text, /NGN 85,000\.00/);

  // ...and it landed in the school's books, tagged with the student
  const txs = (await principal.get(`/api/orgs/${schoolId}/transactions`)).data;
  assert.equal(txs.total, 1);
  const t = txs.transactions[0];
  assert.equal(t.kind, 'income'); assert.equal(t.amount, 8500000); assert.equal(t.reference, ref);
  assert.equal(t.custom.student_id_name, 'Tola Ade'); assert.equal(t.custom.class, 'JSS 2'); assert.equal(t.custom.term, 'First Term');
  assert.deepEqual(t.lines.map((l) => [l.name, l.debit, l.credit]),
    [['Online Payments (Paystack)', 8500000, 0], ['Tuition Fees', 0, 8500000]]);
  const bs = (await principal.get(`/api/orgs/${schoolId}/reports/balance-sheet?as_at=2099-12-31`)).data;
  assert.equal(bs.balanced, true);
  const pl = (await principal.get(`/api/orgs/${schoolId}/reports/profit-loss?from=2000-01-01&to=2099-12-31`)).data;
  assert.equal(pl.total_income, 8500000);
  assert.equal((await principal.get(`/api/orgs/${schoolId}/reports/dashboard`)).data.cash, 8500000, 'counts as money on hand');

  // the principal sees the payment list; an unpaid attempt shows as pending
  const list = (await principal.get(`/api/orgs/${schoolId}/portal`)).data.payments;
  assert.equal(list.find((p) => p.reference === ref).status, 'success');
  assert.equal(list.find((p) => p.reference === examRef).status, 'pending');

  // a webhook (no browser return) also books a payment exactly once
  payOnPaystack(examRef);
  const wbody = JSON.stringify({ event: 'charge.success', data: { reference: examRef } });
  const sig = crypto.createHmac('sha512', 'sk_test_fake').update(wbody).digest('hex');
  for (let i = 0; i < 2; i++) await realFetch(`${base}/api/paystack/webhook`, { method: 'POST', headers: { 'x-paystack-signature': sig, 'Content-Type': 'application/json' }, body: wbody });
  assert.equal((await principal.get(`/api/orgs/${schoolId}/transactions`)).data.total, 2);

  // someone else's school cannot see or edit this portal's settings
  assert.equal((await owner.get(`/api/orgs/${schoolId}/portal`)).status, 404);
  assert.equal((await anon.get(`/api/orgs/${schoolId}/portal`)).status, 401);
});

test('school portal switches off when the school stops paying, but money already paid is still booked', async () => {
  db.prepare("UPDATE organizations SET trial_ends_at = date('now','-3 days'), paid_until = NULL WHERE id = ?").run(schoolId);
  assert.equal((await anon.get('/api/portal/green-hills')).status, 503);
  const items = JSON.parse(db.prepare('SELECT portal_items FROM organizations WHERE id = ?').get(schoolId).portal_items);
  // a parent who paid just before the cut-off: webhook must still record it even though recording is paused for staff
  db.prepare(`INSERT INTO payments (reference, org_id, kind, status, amount, email, student, item_label, account_id)
              VALUES ('LDG-LATE-1', ?, 'school', 'pending', 500000, 'p@example.com', 'Late Payer', 'Tuition', ?)`).run(schoolId, items[0].account_id);
  paystackTx.set('LDG-LATE-1', { amount: 500000, status: 'success' });
  const v = await anon.get('/api/payments/verify?reference=LDG-LATE-1');
  assert.equal(v.data.status, 'success');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE org_id = ? AND reference = 'LDG-LATE-1'").get(schoolId).n, 1);
});

test('payments are not available at all if Paystack is not configured', async () => {
  const saved = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = '';
  try {
    assert.equal((await owner.post(`/api/orgs/${farmId}/billing/checkout`, { months: 1 })).status, 503);
    assert.equal((await anon.get('/api/portal/green-hills')).status, 503);
    const wh = await realFetch(`${base}/api/paystack/webhook`, { method: 'POST', headers: { 'x-paystack-signature': 'x', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(wh.status, 401, 'webhooks are refused without a key to check them against');
  } finally { process.env.PAYSTACK_SECRET_KEY = saved; }
});

test('public pay page is served at /pay/<slug>', async () => {
  const r = await realFetch(`${base}/pay/green-hills`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(await r.text(), /pay\.js/);
  assert.equal((await realFetch(`${base}/pay.js`)).status, 200);
});
