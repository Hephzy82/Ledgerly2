'use strict';

/*
 * BILLING + SCHOOL PAYMENT PORTAL (Paystack)
 * ------------------------------------------
 * 1. Subscriptions: every organisation gets a free trial (TRIAL_DAYS, default 30).
 *    After that it becomes READ-ONLY (they can still view and export) until the
 *    owner pays. Payments go to YOUR Paystack account.
 * 2. School portal: a public page /pay/<slug> where parents pay fees online.
 *    The money is split straight to the school's own bank account through a
 *    Paystack "subaccount", and each payment is recorded in the school's books
 *    automatically.
 *
 * Environment variables:
 *   PAYSTACK_SECRET_KEY  your Paystack secret key (sk_live_... / sk_test_...)
 *   PLAN_PRICE_NGN       monthly price in Naira (default 5000)
 *   TRIAL_DAYS           free trial length (default 30)
 *   APP_URL              your public address, e.g. https://yourapp.onrender.com
 */

const crypto = require('node:crypto');
const { sendEmail, appUrl } = require('./mail');

const PAYSTACK_BASE = 'https://api.paystack.co';
const TRIAL_DAYS = Math.max(1, Math.floor(Number(process.env.TRIAL_DAYS)) || 30);
const DEFAULT_PRICE = Math.round((Number(process.env.PLAN_PRICE_NGN) || 5000) * 100); // kobo per month
const MONTH_CHOICES = [1, 3, 6, 12];
const MIN_PAYMENT = 10000;            // ₦100
const MAX_PAYMENT = 1000000000;       // ₦10,000,000
const RESERVED_SLUGS = new Set(['admin', 'api', 'pay', 'login', 'signup', 'static', 'public', 'billing', 'app', 'www', 'verify']);
const TERMS = ['First Term', 'Second Term', 'Third Term'];

const secretKey = () => process.env.PAYSTACK_SECRET_KEY || '';

/* ---------- dates (Nigeria is UTC+1 all year, no daylight saving) ---------- */
const todayWAT = () => new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  if (d.getUTCDate() !== day) d.setUTCDate(0); // 31 Jan + 1 month -> 28/29 Feb
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

module.exports = function install(d) {
  const { db, route, ORG, HttpError, bad, requireRole, requireAdmin, inTransaction, cleanText, parseAmount,
    validEmail, loadCustomFields, throttle, securityHeaders } = d;

  /* ================================================================== */
  /* Paystack API                                                        */
  /* ================================================================== */

  async function paystack(method, path, body) {
    if (!secretKey()) throw new HttpError(503, 'Online payments are not set up yet. Please contact the platform admin.');
    let res;
    try {
      res = await fetch(PAYSTACK_BASE + path, {
        method,
        headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(502, 'Could not reach the payment provider. Please try again in a moment.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false) {
      console.error('Paystack error', res.status, data.message);
      throw new HttpError(502, 'The payment provider could not process that request. Please try again.');
    }
    return data.data;
  }

  const newReference = () => `LDG-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`.toUpperCase();

  /* ================================================================== */
  /* Subscription status                                                 */
  /* ================================================================== */

  function priceFor(org) { return org.plan_price != null ? org.plan_price : DEFAULT_PRICE; }

  function billingInfo(org) {
    const today = todayWAT();
    if (org.exempt) return { status: 'exempt', until: null, days_left: null };
    if (org.paid_until && org.paid_until >= today) {
      return { status: 'active', until: org.paid_until, days_left: daysBetween(today, org.paid_until) };
    }
    if (org.trial_ends_at && org.trial_ends_at >= today) {
      return { status: 'trial', until: org.trial_ends_at, days_left: daysBetween(today, org.trial_ends_at) };
    }
    return { status: 'expired', until: org.paid_until || org.trial_ends_at || null, days_left: 0 };
  }

  // Called before anything is written to the books.
  function assertActive(org) {
    if (billingInfo(org).status === 'expired') {
      throw new HttpError(402, 'The free trial or subscription for this organisation has ended, so new entries are paused. You can still view and export everything. The owner can renew under Billing.');
    }
  }

  function trialEndFromNow() { return addDays(todayWAT(), TRIAL_DAYS); }

  /* ================================================================== */
  /* Recording a verified payment                                        */
  /* ================================================================== */

  function recordSchoolPayment(p, org) {
    const online = db.prepare('SELECT id FROM accounts WHERE id = ? AND org_id = ?').get(org.portal_account_id, org.id);
    const income = db.prepare("SELECT id FROM accounts WHERE id = ? AND org_id = ? AND type = 'income'").get(p.account_id, org.id);
    if (!online || !income) {
      console.error(`Payment ${p.reference}: accounts missing for org ${org.id}; payment kept but not booked.`);
      return null;
    }
    const keys = new Set(loadCustomFields(org.id, true).map((f) => f.key));
    const fields = loadCustomFields(org.id, true);
    const custom = {};
    if (keys.has('student_id_name') && p.student) custom.student_id_name = p.student;
    if (keys.has('class') && p.student_class) custom.class = p.student_class;
    const termField = fields.find((f) => f.key === 'term');
    if (termField && p.term && termField.options.includes(p.term)) custom.term = p.term;

    const desc = `Online payment: ${p.student || 'student'}${p.item_label ? ` (${p.item_label})` : ''}`.slice(0, 200);
    const txId = Number(db.prepare(`INSERT INTO transactions (org_id, date, kind, description, reference, amount, custom, created_by)
      VALUES (?, ?, 'income', ?, ?, ?, ?, NULL)`).run(org.id, todayWAT(), desc, p.reference, p.amount, JSON.stringify(custom)).lastInsertRowid);
    const ins = db.prepare('INSERT INTO entries (tx_id, account_id, debit, credit) VALUES (?, ?, ?, ?)');
    ins.run(txId, online.id, p.amount, 0);
    ins.run(txId, income.id, 0, p.amount);
    return txId;
  }

  // Safe to call many times for the same reference (webhook + browser return both call it).
  async function fulfill(reference) {
    const p = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
    if (!p) throw new HttpError(404, 'Payment not found.');
    if (p.status === 'success') return p;
    if (p.kind === 'manual') return p;

    const v = await paystack('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (v.status !== 'success') {
      if (v.status === 'failed') db.prepare("UPDATE payments SET status = 'failed' WHERE reference = ? AND status = 'pending'").run(reference);
      return db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
    }
    if (Number(v.amount) !== p.amount || String(v.currency || 'NGN') !== 'NGN') {
      console.error(`Payment ${reference}: amount/currency mismatch (expected ${p.amount}, got ${v.amount} ${v.currency})`);
      db.prepare("UPDATE payments SET status = 'mismatch' WHERE reference = ? AND status = 'pending'").run(reference);
      return db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
    }

    let receiptFor = null;
    inTransaction(() => {
      const claimed = db.prepare("UPDATE payments SET status = 'success', paid_at = datetime('now') WHERE reference = ? AND status = 'pending'").run(reference);
      if (!claimed.changes) return; // someone else already processed it
      const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(p.org_id);
      if (!org) return;
      if (p.kind === 'subscription') {
        const base = org.paid_until && org.paid_until > todayWAT() ? org.paid_until : todayWAT();
        db.prepare('UPDATE organizations SET paid_until = ? WHERE id = ?').run(addMonths(base, p.months), org.id);
      } else if (p.kind === 'school') {
        const txId = recordSchoolPayment(p, org);
        if (txId) db.prepare('UPDATE payments SET tx_id = ? WHERE reference = ?').run(txId, reference);
        receiptFor = org;
      }
    });

    if (receiptFor && p.email) {
      const naira = (p.amount / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      sendEmail({
        to: p.email,
        subject: `Payment received - ${receiptFor.name}`,
        text: `Thank you. ${receiptFor.name} has received your payment.\n\nStudent: ${p.student}\nFor: ${p.item_label || 'School fees'}\nAmount: NGN ${naira}\nReference: ${p.reference}\n\nKeep this reference as your receipt.`,
      }).catch(() => {});
    }
    return db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  }

  /* ================================================================== */
  /* Billing routes (inside an organisation)                             */
  /* ================================================================== */

  route('GET', `${ORG}/billing`, (ctx) => {
    requireRole(ctx, 'viewer');
    const org = ctx.org;
    const info = billingInfo(org);
    const showPayments = ctx.role === 'owner';
    return {
      ...info,
      trial_ends_at: org.trial_ends_at, paid_until: org.paid_until, exempt: !!org.exempt,
      price_month: priceFor(org), custom_price: org.plan_price != null, default_price: DEFAULT_PRICE,
      months: MONTH_CHOICES, payments_enabled: !!secretKey(), trial_days: TRIAL_DAYS,
      is_admin: !!ctx.user.is_admin,
      payments: showPayments
        ? db.prepare(`SELECT reference, kind, status, amount, months, created_at, paid_at FROM payments
                      WHERE org_id = ? AND kind IN ('subscription','manual') ORDER BY id DESC LIMIT 12`).all(org.id)
        : [],
    };
  });

  route('POST', `${ORG}/billing/checkout`, async (ctx) => {
    requireRole(ctx, 'owner');
    if (ctx.org.exempt) throw bad('This organisation does not need a subscription.');
    const months = Number(ctx.body.months);
    if (!MONTH_CHOICES.includes(months)) throw bad('Choose how many months to pay for.');
    throttle(`checkout:${ctx.user.id}`, 20);
    const amount = priceFor(ctx.org) * months;
    if (amount < MIN_PAYMENT) throw bad('The price for this organisation is not set up correctly. Please contact support.');
    const reference = newReference();
    const init = await paystack('POST', '/transaction/initialize', {
      email: ctx.user.email, amount, currency: 'NGN', reference,
      callback_url: `${appUrl()}/billing-return`,
      metadata: { kind: 'subscription', org_id: ctx.org.id, months },
    });
    db.prepare(`INSERT INTO payments (reference, org_id, kind, status, amount, email, months)
                VALUES (?, ?, 'subscription', 'pending', ?, ?, ?)`).run(reference, ctx.org.id, amount, ctx.user.email, months);
    return { url: init.authorization_url };
  });

  // Platform admin only: bank-transfer customers, discounts, free accounts.
  route('POST', `${ORG}/billing/admin`, (ctx) => {
    requireRole(ctx, 'viewer');
    requireAdmin(ctx);
    const b = ctx.body;
    inTransaction(() => {
      if (b.exempt !== undefined) db.prepare('UPDATE organizations SET exempt = ? WHERE id = ?').run(b.exempt ? 1 : 0, ctx.org.id);
      if (b.plan_price !== undefined) {
        if (b.plan_price === '' || b.plan_price === null) db.prepare('UPDATE organizations SET plan_price = NULL WHERE id = ?').run(ctx.org.id);
        else {
          const kobo = parseAmount(b.plan_price);
          if (!kobo) throw bad('Enter a valid monthly price in Naira.');
          db.prepare('UPDATE organizations SET plan_price = ? WHERE id = ?').run(kobo, ctx.org.id);
        }
      }
      if (b.add_days !== undefined && b.add_days !== '') {
        const n = Number(b.add_days);
        if (!Number.isInteger(n) || n < 1 || n > 3650) throw bad('Days must be a whole number between 1 and 3650.');
        const fresh = db.prepare('SELECT paid_until FROM organizations WHERE id = ?').get(ctx.org.id);
        const base = fresh.paid_until && fresh.paid_until > todayWAT() ? fresh.paid_until : todayWAT();
        db.prepare('UPDATE organizations SET paid_until = ? WHERE id = ?').run(addDays(base, n), ctx.org.id);
        db.prepare(`INSERT INTO payments (reference, org_id, kind, status, amount, email, months, meta, paid_at)
                    VALUES (?, ?, 'manual', 'success', 0, ?, 0, ?, datetime('now'))`)
          .run(`MANUAL-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, ctx.org.id, ctx.user.email, JSON.stringify({ added_days: n }));
      }
    });
    return { ok: true };
  });

  /* ================================================================== */
  /* School portal: owner/admin settings                                 */
  /* ================================================================== */

  function ensureOnlineAccount(org) {
    const existing = org.portal_account_id && db.prepare('SELECT id FROM accounts WHERE id = ? AND org_id = ?').get(org.portal_account_id, org.id);
    if (existing) return existing.id;
    let code = 1030;
    while (db.prepare('SELECT 1 FROM accounts WHERE org_id = ? AND code = ?').get(org.id, String(code))) code += 1;
    const id = Number(db.prepare(`INSERT INTO accounts (org_id, code, name, type, tag) VALUES (?, ?, 'Online Payments (Paystack)', 'asset', 'cash')`)
      .run(org.id, String(code)).lastInsertRowid);
    db.prepare('UPDATE organizations SET portal_account_id = ? WHERE id = ?').run(id, org.id);
    return id;
  }

  const parseItems = (org) => { try { return JSON.parse(org.portal_items || '[]'); } catch { return []; } };

  route('GET', `${ORG}/portal`, (ctx) => {
    requireRole(ctx, 'owner');
    const org = ctx.org;
    return {
      enabled: !!org.portal_enabled, slug: org.portal_slug || '', note: org.portal_note || '',
      subaccount: org.portal_subaccount || '', items: parseItems(org),
      base_url: appUrl(), payments_enabled: !!secretKey(), is_admin: !!ctx.user.is_admin,
      income_accounts: db.prepare("SELECT id, code, name FROM accounts WHERE org_id = ? AND type = 'income' AND active = 1 ORDER BY code").all(org.id),
      terms: TERMS,
      payments: db.prepare(`SELECT reference, status, amount, student, student_class, term, item_label, email, created_at, paid_at
                            FROM payments WHERE org_id = ? AND kind = 'school' ORDER BY id DESC LIMIT 60`).all(org.id),
    };
  });

  route('PUT', `${ORG}/portal`, (ctx) => {
    requireRole(ctx, 'owner');
    const org = ctx.org;
    const b = ctx.body;

    const slug = String(b.slug || '').trim().toLowerCase();
    if (slug) {
      if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) throw bad('The web address can use only lowercase letters, numbers and hyphens (3-40 characters).');
      if (RESERVED_SLUGS.has(slug)) throw bad('That web address is reserved. Please choose another.');
      const clash = db.prepare('SELECT id FROM organizations WHERE portal_slug = ? AND id <> ?').get(slug, org.id);
      if (clash) throw bad('That web address is already taken. Please choose another.');
    }

    const rawItems = Array.isArray(b.items) ? b.items : [];
    if (rawItems.length > 30) throw bad('You can have at most 30 fee items.');
    const items = rawItems.map((it) => {
      const label = cleanText(it.label, 60, 'Fee name', { required: true });
      const acct = db.prepare("SELECT id FROM accounts WHERE id = ? AND org_id = ? AND type = 'income' AND active = 1").get(Number(it.account_id), org.id);
      if (!acct) throw bad(`Choose an income account for "${label}".`);
      let amount = null;
      if (it.amount !== undefined && it.amount !== null && String(it.amount).trim() !== '') {
        amount = parseAmount(it.amount);
        if (!amount || amount < MIN_PAYMENT || amount > MAX_PAYMENT) throw bad(`The fixed amount for "${label}" must be between ₦100 and ₦10,000,000, or left blank.`);
      }
      const id = /^[a-f0-9]{8}$/.test(String(it.id || '')) ? it.id : crypto.randomBytes(4).toString('hex');
      return { id, label, account_id: acct.id, amount };
    });

    const enabled = !!b.enabled;
    if (enabled && !slug) throw bad('Choose a web address before turning the portal on.');
    if (enabled && !items.length) throw bad('Add at least one fee item before turning the portal on.');
    const note = cleanText(b.note, 500, 'Message to parents');

    let subaccount = org.portal_subaccount;
    if (ctx.user.is_admin && b.subaccount !== undefined) {
      const s = String(b.subaccount || '').trim();
      if (s && !/^ACCT_[A-Za-z0-9]{6,40}$/.test(s)) throw bad('A Paystack subaccount code looks like ACCT_xxxxxxxxxx.');
      subaccount = s || null;
    }

    inTransaction(() => {
      db.prepare(`UPDATE organizations SET portal_enabled = ?, portal_slug = ?, portal_items = ?, portal_note = ?, portal_subaccount = ? WHERE id = ?`)
        .run(enabled ? 1 : 0, slug || null, JSON.stringify(items), note, subaccount, org.id);
      ensureOnlineAccount({ ...org, portal_slug: slug });
    });
    return { ok: true };
  });

  /* ================================================================== */
  /* School portal: public (no login)                                    */
  /* ================================================================== */

  function portalOrg(slug) {
    const org = db.prepare('SELECT * FROM organizations WHERE portal_slug = ? AND portal_enabled = 1').get(slug);
    if (!org) throw new HttpError(404, 'This payment page does not exist.');
    if (!org.portal_subaccount || !secretKey()) throw new HttpError(503, 'Online payment is not available for this school yet. Please contact the school office.');
    if (billingInfo(org).status === 'expired') throw new HttpError(503, 'Online payment is temporarily unavailable. Please contact the school office.');
    return org;
  }

  route('GET', '/api/portal/([a-z0-9-]+)', (ctx) => {
    const org = portalOrg(ctx.params[1]);
    return {
      school: org.name, currency: org.currency, note: org.portal_note || '', terms: TERMS,
      items: parseItems(org).map((i) => ({ id: i.id, label: i.label, amount: i.amount })),
    };
  });

  route('POST', '/api/portal/([a-z0-9-]+)/pay', async (ctx) => {
    throttle(`portalpay:${ctx.ip}`, 30);
    const org = portalOrg(ctx.params[1]);
    const b = ctx.body;
    const item = parseItems(org).find((i) => i.id === b.item_id);
    if (!item) throw bad('Please choose what you are paying for.');
    let amount = item.amount;
    if (!amount) {
      amount = parseAmount(b.amount);
      if (!amount) throw bad('Enter the amount you want to pay.');
    }
    if (amount < MIN_PAYMENT) throw bad('The smallest payment is ₦100.');
    if (amount > MAX_PAYMENT) throw bad('That amount is too large for an online payment. Please pay at the school office.');
    const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email)) throw bad('Enter a valid email address so we can send your receipt.');
    const student = cleanText(b.student_name, 80, "Student's name", { required: true });
    const studentClass = cleanText(b.student_class, 40, 'Class');
    const payer = cleanText(b.payer_name, 80, 'Your name');
    const term = TERMS.includes(b.term) ? b.term : '';

    const reference = newReference();
    const init = await paystack('POST', '/transaction/initialize', {
      email, amount, currency: 'NGN', reference,
      callback_url: `${appUrl()}/pay/${org.portal_slug}`,
      subaccount: org.portal_subaccount,
      bearer: 'subaccount', // the school, not the platform, pays Paystack's fee
      metadata: { kind: 'school', org_id: org.id, student, item: item.label },
    });
    db.prepare(`INSERT INTO payments (reference, org_id, kind, status, amount, email, payer_name, student, student_class, term, item_label, account_id)
                VALUES (?, ?, 'school', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reference, org.id, amount, email, payer, student, studentClass, term, item.label, item.account_id);
    return { url: init.authorization_url };
  });

  // The browser asks this after Paystack sends the payer back.
  route('GET', '/api/payments/verify', async (ctx) => {
    throttle(`verify:${ctx.ip}`, 60);
    const reference = String(ctx.query.reference || '').slice(0, 80);
    if (!/^[A-Z0-9-]+$/.test(reference)) throw bad('Invalid payment reference.');
    const p = await fulfill(reference);
    const org = db.prepare('SELECT name, id FROM organizations WHERE id = ?').get(p.org_id);
    return { status: p.status, kind: p.kind, school: org ? org.name : '', item_label: p.item_label, student: p.student, amount: p.amount, reference: p.reference, paid_at: p.paid_at };
  });

  /* ================================================================== */
  /* Raw HTTP hooks: Paystack webhook + return page                      */
  /* ================================================================== */

  function readRaw(req, limit = 200000) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handleSpecial(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/paystack/webhook') {
      try {
        const raw = await readRaw(req);
        const sig = String(req.headers['x-paystack-signature'] || '');
        const expected = crypto.createHmac('sha512', secretKey() || 'x').update(raw).digest('hex');
        const a = Buffer.from(sig); const e = Buffer.from(expected);
        if (!secretKey() || a.length !== e.length || !crypto.timingSafeEqual(a, e)) { res.writeHead(401); res.end(); return true; }
        const event = JSON.parse(raw.toString('utf8'));
        if (event.event === 'charge.success' && event.data && typeof event.data.reference === 'string') {
          try { await fulfill(event.data.reference); } catch (err) {
            if (!(err instanceof HttpError && err.status === 404)) { res.writeHead(500); res.end(); return true; } // let Paystack retry
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end(); }
      return true;
    }

    // Paystack sends a paying business owner back here.
    if (req.method === 'GET' && url.pathname === '/billing-return') {
      securityHeaders(res);
      const reference = String(url.searchParams.get('reference') || '').slice(0, 80);
      let orgId = '';
      try {
        if (/^[A-Z0-9-]+$/.test(reference)) {
          const p = await fulfill(reference);
          if (p.kind === 'subscription') orgId = p.org_id;
        }
      } catch (err) { console.error('billing-return:', err.message); }
      res.writeHead(302, { Location: orgId ? `/#/org/${orgId}/billing` : '/' });
      res.end();
      return true;
    }
    return false;
  }

  return { billingInfo, assertActive, trialEndFromNow, handleSpecial, fulfill, DEFAULT_PRICE };
};
