'use strict';

/*
 * LEDGERLY - multi-organisation accounting platform
 * Zero dependencies: needs only Node.js 22.13+ (uses built-in SQLite).
 * Run:  node --disable-warning=ExperimentalWarning server.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { TEMPLATES } = require('./templates');
const { appUrl, sendEmail, emailConfigured } = require('./mail');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'ledgerly.db');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const SECURE_COOKIE = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;
const CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR', 'GHS', 'KES', 'ZAR', 'XOF'];

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','accountant','viewer')),
  PRIMARY KEY (user_id, org_id)
);
CREATE TABLE IF NOT EXISTS invites (
  email TEXT NOT NULL,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','accountant','viewer')),
  PRIMARY KEY (email, org_id)
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  tag TEXT CHECK (tag IN ('cash','receivable','payable')),
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, code)
);
CREATE TABLE IF NOT EXISTS custom_fields (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','number','select','date')),
  options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, key)
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense','transfer')),
  description TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL CHECK (amount > 0),   -- stored in kobo (1 Naira = 100 kobo)
  custom TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided INTEGER NOT NULL DEFAULT 0,
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0)
);
CREATE INDEX IF NOT EXISTS idx_tx_org_date ON transactions(org_id, date);
CREATE INDEX IF NOT EXISTS idx_entries_tx ON entries(tx_id);
CREATE INDEX IF NOT EXISTS idx_entries_acct ON entries(account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(org_id);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('subscription','school','manual')),
  status TEXT NOT NULL DEFAULT 'pending',
  amount INTEGER NOT NULL DEFAULT 0,         -- kobo
  email TEXT,
  payer_name TEXT,
  student TEXT,
  student_class TEXT,
  term TEXT,
  item_label TEXT,
  account_id INTEGER,
  months INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  tx_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_org ON payments(org_id, kind);
`);

// Adds a column to an existing database only if it is missing (safe to run on every start).
function addColumn(table, column, ddl) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumn('organizations', 'trial_ends_at', 'TEXT');
addColumn('organizations', 'paid_until', 'TEXT');
addColumn('organizations', 'plan_price', 'INTEGER');
addColumn('organizations', 'exempt', 'INTEGER NOT NULL DEFAULT 0');
addColumn('organizations', 'portal_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('organizations', 'portal_slug', 'TEXT');
addColumn('organizations', 'portal_subaccount', 'TEXT');
addColumn('organizations', 'portal_account_id', 'INTEGER');
addColumn('organizations', 'portal_items', "TEXT NOT NULL DEFAULT '[]'");
addColumn('organizations', 'portal_note', "TEXT NOT NULL DEFAULT ''");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_org_slug ON organizations(portal_slug) WHERE portal_slug IS NOT NULL');
// Organisations that existed before billing was added get a fresh trial.
db.prepare(`UPDATE organizations SET trial_ends_at = date('now', '+' || ? || ' days') WHERE trial_ends_at IS NULL`)
  .run(Math.max(1, Math.floor(Number(process.env.TRIAL_DAYS)) || 30));

if (ADMIN_EMAIL) db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(ADMIN_EMAIL);

function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const ROLE_RANK = { viewer: 1, accountant: 2, owner: 3 };

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// "1,250.50" -> 125050 (kobo). Returns null when invalid or not positive.
function parseAmount(v) {
  const s = String(v ?? '').replace(/[,\s₦]/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const kobo = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return kobo > 0 ? kobo : null;
}

function cleanText(v, max, label, { required = false } = {}) {
  const s = String(v ?? '').trim();
  if (required && !s) throw bad(`${label} is required.`);
  if (s.length > max) throw bad(`${label} is too long (max ${max} characters).`);
  return s;
}

function validEmail(e) {
  return typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function checkPassword(password, hash, salt) {
  const candidate = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'));
  const real = Buffer.from(hash);
  return candidate.length === real.length && crypto.timingSafeEqual(candidate, real);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function slugKey(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
}

/* Naive login throttle (per IP + email). Fine for a single server. */
const attempts = new Map();
const THROTTLE_WINDOW = 15 * 60 * 1000;
function throttle(key, max = 10) {
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < THROTTLE_WINDOW);
  if (rec.length >= max) throw new HttpError(429, 'Too many attempts. Please wait 15 minutes and try again.');
  rec.push(now);
  attempts.set(key, rec);
}

/*
 * Who is really calling? Behind a hosting proxy (Render, Railway...) every request
 * arrives from the proxy's own address, so the limiter would treat the WHOLE WORLD
 * as one person. Set TRUST_PROXY to the number of proxies in front of the app
 * (1 on most hosts). We then take that many entries from the RIGHT of
 * X-Forwarded-For, because the left side can be faked by the visitor.
 * Leave it unset when running on your own computer.
 */
const TRUST_PROXY = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY)) || 0);
function clientIp(req) {
  const direct = req.socket.remoteAddress || 'unknown';
  if (!TRUST_PROXY) return direct;
  const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return parts[parts.length - TRUST_PROXY] || direct;
}

/* ------------------------------------------------------------------ */
/* Sessions & permissions                                              */
/* ------------------------------------------------------------------ */

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.email, u.name, u.is_admin FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).get(sha256(token)) || null;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at)
              VALUES (?, ?, datetime('now', ?))`).run(sha256(token), userId, `+${SESSION_DAYS} days`);
  const cookie = [`sid=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (SECURE_COOKIE) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
}

function roleIn(user, orgId) {
  if (user.is_admin) return 'owner';
  const m = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND org_id = ?').get(user.id, orgId);
  return m ? m.role : null;
}

// Throws unless the logged-in user has at least `min` role in the org.
function requireRole(ctx, min) {
  if (!ctx.user) throw new HttpError(401, 'Please log in.');
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(ctx.orgId);
  const role = org ? roleIn(ctx.user, org.id) : null;
  // Same message for "no such org" and "not yours" so ids can't be probed.
  if (!role) throw new HttpError(404, 'Organisation not found.');
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw new HttpError(403, 'You do not have permission to do that.');
  ctx.org = org;
  ctx.role = role;
}

function requireAdmin(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Please log in.');
  if (!ctx.user.is_admin) throw new HttpError(403, 'Only the platform admin can do that.');
}

/* ------------------------------------------------------------------ */
/* Organisation setup from templates                                   */
/* ------------------------------------------------------------------ */

function createOrganization({ name, type, currency }) {
  const tpl = TEMPLATES[type];
  if (!tpl) throw bad('Unknown business type.');
  return inTransaction(() => {
    const orgId = db.prepare('INSERT INTO organizations (name, type, currency, trial_ends_at) VALUES (?, ?, ?, ?)')
      .run(name, type, currency, pay.trialEndFromNow()).lastInsertRowid;
    const addAcct = db.prepare('INSERT INTO accounts (org_id, code, name, type, tag) VALUES (?, ?, ?, ?, ?)');
    for (const [code, aname, atype, tag] of tpl.accounts) addAcct.run(orgId, code, aname, atype, tag);
    const addField = db.prepare(`INSERT INTO custom_fields (org_id, key, label, type, options, required, sort)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const used = new Set();
    tpl.fields.forEach((f, i) => {
      let key = slugKey(f.label);
      while (used.has(key)) key += '_2';
      used.add(key);
      addField.run(orgId, key, f.label, f.type, JSON.stringify(f.options || []), f.required ? 1 : 0, i);
    });
    dept.seedOrgRoles(orgId);
    return Number(orgId);
  });
}

// `choice` is 'owner' | 'accountant' | 'viewer' or 'c<id>' for a custom department role.
function addMemberOrInvite(orgId, email, choice) {
  const { role, roleId } = dept.resolveRoleChoice(orgId, choice);
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (user) {
    db.prepare(`INSERT INTO memberships (user_id, org_id, role, role_id) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, org_id) DO UPDATE SET role = excluded.role, role_id = excluded.role_id`).run(user.id, orgId, role, roleId);
    return 'added';
  }
  db.prepare(`INSERT INTO invites (email, org_id, role, role_id) VALUES (?, ?, ?, ?)
              ON CONFLICT(email, org_id) DO UPDATE SET role = excluded.role, role_id = excluded.role_id`).run(email, orgId, role, roleId);
  return 'invited';
}

/* ------------------------------------------------------------------ */
/* Accounting queries                                                  */
/* ------------------------------------------------------------------ */

// Sum of debits and credits per account for non-voided transactions in a date range.
function balances(orgId, from = '0000-01-01', to = '9999-12-31') {
  return db.prepare(`
    SELECT a.id, a.code, a.name, a.type, a.tag, a.active,
           COALESCE(SUM(x.debit), 0) AS debit, COALESCE(SUM(x.credit), 0) AS credit
    FROM accounts a
    LEFT JOIN (
      SELECT e.account_id, e.debit, e.credit
      FROM entries e JOIN transactions t ON t.id = e.tx_id
      WHERE t.org_id = ? AND t.voided = 0 AND t.date >= ? AND t.date <= ?
    ) x ON x.account_id = a.id
    WHERE a.org_id = ?
    GROUP BY a.id ORDER BY a.code`).all(orgId, from, to, orgId)
    .map((r) => ({
      ...r,
      // "Natural" balance: assets & expenses grow with debits, the rest with credits.
      balance: (r.type === 'asset' || r.type === 'expense') ? r.debit - r.credit : r.credit - r.debit,
    }));
}

function getAccount(orgId, accountId) {
  return db.prepare('SELECT * FROM accounts WHERE id = ? AND org_id = ?').get(accountId, orgId);
}

function loadCustomFields(orgId, onlyActive = true) {
  return db.prepare(`SELECT * FROM custom_fields WHERE org_id = ? ${onlyActive ? 'AND active = 1' : ''}
                     ORDER BY sort, id`).all(orgId).map(fieldOut);
}
function fieldOut(f) {
  return { id: f.id, key: f.key, label: f.label, type: f.type, options: JSON.parse(f.options || '[]'),
           required: !!f.required, active: !!f.active, sort: f.sort };
}

function validateCustom(orgId, input) {
  const fields = loadCustomFields(orgId, true);
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const f of fields) {
    let v = src[f.key];
    v = v === undefined || v === null ? '' : String(v).trim();
    if (!v) {
      if (f.required) throw bad(`"${f.label}" is required.`);
      continue;
    }
    if (v.length > 200) throw bad(`"${f.label}" is too long.`);
    if (f.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v.replace(/,/g, ''))) throw bad(`"${f.label}" must be a number.`);
    if (f.type === 'date' && !isDate(v)) throw bad(`"${f.label}" must be a valid date.`);
    if (f.type === 'select' && !f.options.includes(v)) throw bad(`"${f.label}" must be one of the listed choices.`);
    out[f.key] = f.type === 'number' ? v.replace(/,/g, '') : v;
  }
  return out;
}

function shapeTransactions(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const lines = db.prepare(`
    SELECT e.tx_id, e.account_id, e.debit, e.credit, a.code, a.name, a.type
    FROM entries e JOIN accounts a ON a.id = e.account_id
    WHERE e.tx_id IN (${ids.map(() => '?').join(',')}) ORDER BY e.id`).all(...ids);
  const byTx = new Map();
  for (const l of lines) {
    if (!byTx.has(l.tx_id)) byTx.set(l.tx_id, []);
    byTx.get(l.tx_id).push({ account_id: l.account_id, code: l.code, name: l.name, type: l.type, debit: l.debit, credit: l.credit });
  }
  return rows.map((r) => ({
    id: r.id, date: r.date, kind: r.kind, description: r.description, reference: r.reference,
    amount: r.amount, custom: JSON.parse(r.custom || '{}'), voided: !!r.voided,
    created_by: r.created_by_name || null, created_at: r.created_at, lines: byTx.get(r.id) || [],
  }));
}

function txFilter(orgId, q) {
  const where = ['t.org_id = ?'];
  const params = [orgId];
  if (q.from) { if (!isDate(q.from)) throw bad('Invalid "from" date.'); where.push('t.date >= ?'); params.push(q.from); }
  if (q.to) { if (!isDate(q.to)) throw bad('Invalid "to" date.'); where.push('t.date <= ?'); params.push(q.to); }
  if (q.kind) {
    if (!['income', 'expense', 'transfer'].includes(q.kind)) throw bad('Invalid type.');
    where.push('t.kind = ?'); params.push(q.kind);
  }
  if (q.account_id) {
    where.push('EXISTS (SELECT 1 FROM entries e WHERE e.tx_id = t.id AND e.account_id = ?)');
    params.push(Number(q.account_id) || 0);
  }
  if (q.q) {
    const like = `%${String(q.q).slice(0, 100).replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    where.push("(t.description LIKE ? ESCAPE '\\' OR t.reference LIKE ? ESCAPE '\\' OR t.custom LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (q.voided !== '1') where.push('t.voided = 0');
  return { where: where.join(' AND '), params };
}

function csvCell(v, { text = false } = {}) {
  let s = String(v ?? '');
  // Stop spreadsheet apps from running text that begins like a formula.
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const nairaDecimal = (kobo) => (kobo / 100).toFixed(2);

/* ------------------------------------------------------------------ */
/* API routes                                                          */
/* ------------------------------------------------------------------ */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
const ORG = '/api/orgs/(\\d+)';

// Billing, Paystack and the school payment portal live in payments.js
const pay = require('./payments')({
  db, route, ORG, HttpError, bad, requireRole, requireAdmin, inTransaction, cleanText, parseAmount,
  validEmail, loadCustomFields, throttle, securityHeaders, TEMPLATES,
});

// Custom roles, per-role dashboards and the HR / Sales / Inventory modules live in departments.js
const dept = require('./departments')({
  db, route, ORG, HttpError, bad, requireRole, requireAdmin, inTransaction, cleanText, parseAmount, validEmail,
  isDate, addColumn, pay, accountingDashboard,
});

/* ---- auth ---- */

// Validates and creates a user, turning any pending invitations into memberships.
function registerUser(body, ip) {
  const name = cleanText(body.name, 80, 'Name', { required: true });
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!validEmail(email)) throw bad('Please enter a valid email address.');
  if (password.length < 8) throw bad('Password must be at least 8 characters.');
  if (password.length > 200) throw bad('Password is too long.');
  throttle(`signup:${ip}`);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('An account with this email already exists. Try logging in.');

  const { hash, salt } = hashPassword(password);
  const noUsersYet = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  // The platform admin is ADMIN_EMAIL if set, otherwise whoever registers first.
  const isAdmin = ADMIN_EMAIL ? email === ADMIN_EMAIL : noUsersYet;
  return inTransaction(() => {
    const id = db.prepare('INSERT INTO users (email, name, pw_hash, pw_salt, is_admin) VALUES (?, ?, ?, ?, ?)')
      .run(email, name, hash, salt, isAdmin ? 1 : 0).lastInsertRowid;
    for (const inv of db.prepare('SELECT org_id, role, role_id FROM invites WHERE email = ?').all(email)) {
      db.prepare('INSERT OR IGNORE INTO memberships (user_id, org_id, role, role_id) VALUES (?, ?, ?, ?)').run(id, inv.org_id, inv.role, inv.role_id);
    }
    db.prepare('DELETE FROM invites WHERE email = ?').run(email);
    return Number(id);
  });
}

route('POST', '/api/signup', (ctx) => {
  startSession(ctx.res, registerUser(ctx.body, ctx.ip));
  return { ok: true };
});

// Public facts for the landing page.
route('GET', '/api/public/info', () => ({
  templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, description: t.description })),
  currencies: CURRENCIES, trial_days: pay.TRIAL_DAYS, price_month: pay.DEFAULT_PRICE,
}));

// A business owner registers their own company (new account + business, or just a business when logged in).
route('POST', '/api/register-business', (ctx) => {
  const b = ctx.body;
  const businessName = cleanText(b.business_name, 100, 'Business name', { required: true });
  const type = String(b.type || '');
  if (!TEMPLATES[type]) throw bad('Choose the kind of business you run.');
  const currency = String(b.currency || 'NGN');
  if (!CURRENCIES.includes(currency)) throw bad('Unsupported currency.');
  throttle(`regbiz:${ctx.ip}`, 10);
  let userId = ctx.user ? ctx.user.id : null;
  if (!userId) {
    const none = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    if (none && !ADMIN_EMAIL) throw bad('This platform has not been set up yet. The first account created becomes the platform admin, so please use “Create an account” instead.');
    userId = registerUser(b, ctx.ip);
    startSession(ctx.res, userId);
  } else if (!ctx.user.is_admin && db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND role = 'owner'").get(userId).n >= 5) {
    throw bad('You already own five businesses. Please contact support to add more.');
  }
  const orgId = createOrganization({ name: businessName, type, currency });
  db.prepare("INSERT INTO memberships (user_id, org_id, role, role_id) VALUES (?, ?, 'owner', NULL)").run(userId, orgId);
  return { ok: true, org_id: orgId };
});

route('POST', '/api/login', (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  const password = String(ctx.body.password || '');
  throttle(`login:${ctx.ip}:${email}`);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Do the same work whether or not the user exists, so timing doesn't leak.
  const ok = u ? checkPassword(password, u.pw_hash, u.pw_salt) : (hashPassword(password), false);
  if (!ok) throw new HttpError(401, 'Incorrect email or password.');
  startSession(ctx.res, u.id);
  return { ok: true };
});

/* ---- password reset ---- */

function makeResetToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))").run(sha256(token), userId);
  return token;
}

route('POST', '/api/forgot', (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  throttle(`forgot:${ctx.ip}`, 10);
  if (validEmail(email)) {
    throttle(`forgot-email:${email}`, 5);
    const u = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
    if (u) {
      const link = `${appUrl()}/#/reset/${makeResetToken(u.id)}`;
      sendEmail({
        to: email, subject: 'Reset your Ledgerly password',
        text: `Hello ${u.name},\n\nSomeone asked to reset the password for this email address. If it was you, open this link within 1 hour:\n\n${link}\n\nIf it was not you, ignore this message and your password stays the same.`,
      }).catch(() => {});
    }
  }
  // Same answer whether or not the email exists, so this can't be used to find who has an account.
  return { ok: true, message: 'If that email has an account, a reset link is on its way. It works for 1 hour.' };
});

route('POST', '/api/reset', (ctx) => {
  throttle(`reset:${ctx.ip}`, 20);
  const token = String(ctx.body.token || '');
  const password = String(ctx.body.password || '');
  if (password.length < 8) throw bad('Password must be at least 8 characters.');
  if (password.length > 200) throw bad('Password is too long.');
  const row = db.prepare("SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > datetime('now')").get(sha256(token));
  if (!row) throw bad('This reset link has expired or was already used. Please ask for a new one.');
  const { hash, salt } = hashPassword(password);
  inTransaction(() => {
    db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').run(hash, salt, row.user_id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id); // log out every other device
  });
  startSession(ctx.res, row.user_id);
  return { ok: true };
});

// For when email isn't set up: the platform admin makes a link and sends it on WhatsApp.
route('POST', '/api/admin/reset-link', (ctx) => {
  requireAdmin(ctx);
  const email = String(ctx.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  if (!u) throw bad('No account uses that email address.');
  return { link: `${appUrl()}/#/reset/${makeResetToken(u.id)}`, name: u.name, email_configured: emailConfigured() };
});

route('POST', '/api/logout', (ctx) => {
  const token = parseCookies(ctx.req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  ctx.res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  return { ok: true };
});

route('GET', '/api/me', (ctx) => {
  if (!ctx.user) {
    const none = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    return { user: null, first_run: none && !ADMIN_EMAIL };
  }
  const orgs = ctx.user.is_admin
    ? db.prepare(`SELECT id, name, type, currency, 'owner' AS role FROM organizations ORDER BY name`).all()
    : db.prepare(`SELECT o.id, o.name, o.type, o.currency, m.role, r.name AS role_name FROM memberships m
                  JOIN organizations o ON o.id = m.org_id LEFT JOIN roles r ON r.id = m.role_id AND r.org_id = m.org_id
                  WHERE m.user_id = ? ORDER BY o.name`).all(ctx.user.id);
  return {
    user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, is_admin: !!ctx.user.is_admin },
    orgs: orgs.map((o) => ({ ...o, type_label: TEMPLATES[o.type]?.label || o.type })),
  };
});

route('GET', '/api/templates', (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'Please log in.');
  return {
    templates: Object.entries(TEMPLATES).map(([key, t]) => ({
      key, label: t.label, description: t.description, accounts: t.accounts.length, fields: t.fields.length,
    })),
    currencies: CURRENCIES,
  };
});

/* ---- onboarding a client (platform admin) ---- */

route('POST', '/api/orgs', (ctx) => {
  requireAdmin(ctx);
  const name = cleanText(ctx.body.name, 100, 'Business name', { required: true });
  const type = String(ctx.body.type || '');
  const currency = String(ctx.body.currency || 'NGN');
  if (!CURRENCIES.includes(currency)) throw bad('Unsupported currency.');
  const ownerEmail = String(ctx.body.owner_email || '').trim().toLowerCase();
  if (ownerEmail && !validEmail(ownerEmail)) throw bad('Owner email is not valid.');
  const id = createOrganization({ name, type, currency });
  let ownerStatus = null;
  if (ownerEmail) ownerStatus = addMemberOrInvite(id, ownerEmail, 'owner');
  return { id, owner_status: ownerStatus };
});

route('GET', '/api/admin/orgs', (ctx) => {
  requireAdmin(ctx);
  const orgs = db.prepare(`
    SELECT o.id, o.name, o.type, o.currency, o.created_at,
      (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS members,
      (SELECT COUNT(*) FROM transactions t WHERE t.org_id = o.id AND t.voided = 0) AS transactions
    FROM organizations o ORDER BY o.created_at DESC`).all();
  const raw = db.prepare('SELECT id, trial_ends_at, paid_until, exempt FROM organizations').all();
  const byId = Object.fromEntries(raw.map((r) => [r.id, r]));
  return { orgs: orgs.map((o) => ({ ...o, type_label: TEMPLATES[o.type]?.label || o.type, plan: pay.billingInfo(byId[o.id]) })) };
});

/* ---- organisation setup bundle ---- */

route('GET', `${ORG}/setup`, (ctx) => {
  requireRole(ctx, 'viewer');
  const access = dept.describeAccess(ctx.user, ctx.orgId);
  // People whose role has no accounting access never receive the chart of accounts.
  const accounts = access.access.accounts === 'none' ? []
    : db.prepare('SELECT id, code, name, type, tag, active FROM accounts WHERE org_id = ? ORDER BY code').all(ctx.orgId).map((a) => ({ ...a, active: !!a.active }));
  return {
    ...access,
    org: { id: ctx.org.id, name: ctx.org.name, type: ctx.org.type, type_label: TEMPLATES[ctx.org.type]?.label || ctx.org.type, currency: ctx.org.currency },
    role: ctx.role, accounts, fields: loadCustomFields(ctx.orgId, true), billing: pay.billingInfo(ctx.org),
  };
});

route('PUT', `${ORG}`, (ctx) => {
  requireRole(ctx, 'owner');
  const name = cleanText(ctx.body.name, 100, 'Business name', { required: true });
  const currency = String(ctx.body.currency || ctx.org.currency);
  if (!CURRENCIES.includes(currency)) throw bad('Unsupported currency.');
  db.prepare('UPDATE organizations SET name = ?, currency = ? WHERE id = ?').run(name, currency, ctx.orgId);
  return { ok: true };
});

/* ---- chart of accounts ---- */

route('POST', `${ORG}/accounts`, (ctx) => {
  requireRole(ctx, 'owner');
  const code = cleanText(ctx.body.code, 12, 'Account code', { required: true });
  const name = cleanText(ctx.body.name, 80, 'Account name', { required: true });
  const type = String(ctx.body.type || '');
  if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(type)) throw bad('Choose an account type.');
  const tag = ctx.body.tag || null;
  if (tag && !['cash', 'receivable', 'payable'].includes(tag)) throw bad('Invalid tag.');
  if (tag === 'cash' && type !== 'asset') throw bad('Only asset accounts can be marked as cash/bank.');
  if (tag === 'receivable' && type !== 'asset') throw bad('Only asset accounts can be marked as receivable.');
  if (tag === 'payable' && type !== 'liability') throw bad('Only liability accounts can be marked as payable.');
  if (db.prepare('SELECT 1 FROM accounts WHERE org_id = ? AND code = ?').get(ctx.orgId, code)) throw bad(`Account code ${code} is already used.`);
  const id = db.prepare('INSERT INTO accounts (org_id, code, name, type, tag) VALUES (?, ?, ?, ?, ?)').run(ctx.orgId, code, name, type, tag).lastInsertRowid;
  return { id: Number(id) };
});

route('PUT', `${ORG}/accounts/(\\d+)`, (ctx) => {
  requireRole(ctx, 'owner');
  const acct = getAccount(ctx.orgId, Number(ctx.params[2]));
  if (!acct) throw new HttpError(404, 'Account not found.');
  const code = cleanText(ctx.body.code ?? acct.code, 12, 'Account code', { required: true });
  const name = cleanText(ctx.body.name ?? acct.name, 80, 'Account name', { required: true });
  const active = ctx.body.active === undefined ? acct.active : (ctx.body.active ? 1 : 0);
  const tag = ctx.body.tag === undefined ? acct.tag : (ctx.body.tag || null);
  if (tag && !['cash', 'receivable', 'payable'].includes(tag)) throw bad('Invalid tag.');
  if (tag === 'cash' && acct.type !== 'asset') throw bad('Only asset accounts can be marked as cash/bank.');
  if (tag === 'receivable' && acct.type !== 'asset') throw bad('Only asset accounts can be marked as receivable.');
  if (tag === 'payable' && acct.type !== 'liability') throw bad('Only liability accounts can be marked as payable.');
  const clash = db.prepare('SELECT id FROM accounts WHERE org_id = ? AND code = ? AND id <> ?').get(ctx.orgId, code, acct.id);
  if (clash) throw bad(`Account code ${code} is already used.`);
  db.prepare('UPDATE accounts SET code = ?, name = ?, active = ?, tag = ? WHERE id = ?').run(code, name, active, tag, acct.id);
  return { ok: true };
});

/* ---- custom fields ---- */

route('GET', `${ORG}/fields`, (ctx) => {
  requireRole(ctx, 'viewer');
  return { fields: loadCustomFields(ctx.orgId, false) };
});

function readFieldBody(body) {
  const label = cleanText(body.label, 60, 'Field label', { required: true });
  const type = String(body.type || 'text');
  if (!['text', 'number', 'select', 'date'].includes(type)) throw bad('Invalid field type.');
  let options = [];
  if (type === 'select') {
    const raw = Array.isArray(body.options) ? body.options : String(body.options || '').split(',');
    options = [...new Set(raw.map((o) => String(o).trim()).filter(Boolean))].slice(0, 50);
    if (options.some((o) => o.length > 60)) throw bad('Each choice must be under 60 characters.');
    if (!options.length) throw bad('Add at least one choice for a drop-down field.');
  }
  return { label, type, options, required: body.required ? 1 : 0 };
}

route('POST', `${ORG}/fields`, (ctx) => {
  requireRole(ctx, 'owner');
  const f = readFieldBody(ctx.body);
  let key = slugKey(f.label);
  const base = key;
  for (let n = 2; db.prepare('SELECT 1 FROM custom_fields WHERE org_id = ? AND key = ?').get(ctx.orgId, key); n++) key = `${base}_${n}`;
  const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM custom_fields WHERE org_id = ?').get(ctx.orgId).s;
  const id = db.prepare(`INSERT INTO custom_fields (org_id, key, label, type, options, required, sort)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ctx.orgId, key, f.label, f.type, JSON.stringify(f.options), f.required, sort).lastInsertRowid;
  return { id: Number(id) };
});

route('PUT', `${ORG}/fields/(\\d+)`, (ctx) => {
  requireRole(ctx, 'owner');
  const existing = db.prepare('SELECT * FROM custom_fields WHERE id = ? AND org_id = ?').get(Number(ctx.params[2]), ctx.orgId);
  if (!existing) throw new HttpError(404, 'Field not found.');
  if (ctx.body.active !== undefined && ctx.body.label === undefined) {
    db.prepare('UPDATE custom_fields SET active = ? WHERE id = ?').run(ctx.body.active ? 1 : 0, existing.id);
    return { ok: true };
  }
  // The data type is fixed after creation so old entries stay valid.
  const f = readFieldBody({ ...ctx.body, type: existing.type });
  db.prepare('UPDATE custom_fields SET label = ?, options = ?, required = ? WHERE id = ?')
    .run(f.label, JSON.stringify(f.options), f.required, existing.id);
  return { ok: true };
});

/* ---- team ---- */

route('GET', `${ORG}/members`, (ctx) => {
  requireRole(ctx, 'owner');
  const choice = (r) => (r.role_id ? `c${r.role_id}` : r.role);
  const members = db.prepare(`SELECT u.id, u.name, u.email, m.role, m.role_id, r.name AS role_name FROM memberships m
                              JOIN users u ON u.id = m.user_id LEFT JOIN roles r ON r.id = m.role_id AND r.org_id = m.org_id
                              WHERE m.org_id = ? ORDER BY u.name`).all(ctx.orgId).map((m) => ({ ...m, choice: choice(m) }));
  const invites = db.prepare(`SELECT i.email, i.role, i.role_id, r.name AS role_name FROM invites i LEFT JOIN roles r ON r.id = i.role_id AND r.org_id = i.org_id
                              WHERE i.org_id = ? ORDER BY i.email`).all(ctx.orgId).map((i) => ({ ...i, choice: choice(i) }));
  return { members, invites };
});

route('POST', `${ORG}/members`, (ctx) => {
  requireRole(ctx, 'owner');
  const email = String(ctx.body.email || '').trim().toLowerCase();
  const role = String(ctx.body.role || '');
  if (!validEmail(email)) throw bad('Please enter a valid email address.');
  if (!role) throw bad('Choose a role.');
  return { status: addMemberOrInvite(ctx.orgId, email, role) };
});

route('DELETE', `${ORG}/members/(\\d+)`, (ctx) => {
  requireRole(ctx, 'owner');
  const uid = Number(ctx.params[2]);
  const target = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND org_id = ?').get(uid, ctx.orgId);
  if (!target) throw new HttpError(404, 'Member not found.');
  if (target.role === 'owner' && db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'").get(ctx.orgId).n <= 1 && !ctx.user.is_admin) {
    throw bad('An organisation needs at least one owner.');
  }
  db.prepare('DELETE FROM memberships WHERE user_id = ? AND org_id = ?').run(uid, ctx.orgId);
  return { ok: true };
});

route('DELETE', `${ORG}/invites`, (ctx) => {
  requireRole(ctx, 'owner');
  db.prepare('DELETE FROM invites WHERE org_id = ? AND email = ?').run(ctx.orgId, String(ctx.query.email || '').toLowerCase());
  return { ok: true };
});

/* ---- transactions ---- */

route('POST', `${ORG}/transactions`, (ctx) => {
  requireRole(ctx, 'accountant');
  pay.assertActive(ctx.org);
  const b = ctx.body;
  const kind = String(b.kind || '');
  if (!['income', 'expense', 'transfer'].includes(kind)) throw bad('Choose a transaction type.');
  if (!isDate(b.date)) throw bad('Please enter a valid date.');
  const amount = parseAmount(b.amount);
  if (!amount) throw bad('Enter an amount greater than zero (up to 2 decimal places).');
  const description = cleanText(b.description, 200, 'Description');
  const reference = cleanText(b.reference, 60, 'Reference');
  const custom = validateCustom(ctx.orgId, b.custom);

  const need = (id, label) => {
    const a = getAccount(ctx.orgId, Number(id));
    if (!a) throw bad(`Choose a valid ${label}.`);
    if (!a.active) throw bad(`"${a.name}" is switched off. Pick another ${label} or switch it back on.`);
    return a;
  };

  let debitAcct; let creditAcct;
  if (kind === 'income') {
    const cat = need(b.account_id, 'income category');
    const money = need(b.money_account_id, 'account the money went into');
    if (cat.type !== 'income') throw bad('The category must be an income account.');
    if (money.type !== 'asset') throw bad('Money must go into an asset account (cash, bank, or customers owing).');
    debitAcct = money; creditAcct = cat;
  } else if (kind === 'expense') {
    const cat = need(b.account_id, 'expense category');
    const money = need(b.money_account_id, 'account the money came from');
    if (cat.type !== 'expense' && cat.type !== 'asset') throw bad('The category must be an expense account (or an asset such as stock you are buying).');
    if (money.type !== 'asset' && money.type !== 'liability') throw bad('Pay from cash/bank, or from "Suppliers We Owe" if bought on credit.');
    debitAcct = cat; creditAcct = money;
  } else {
    const from = need(b.from_account_id, 'account the money moves from');
    const to = need(b.to_account_id, 'account the money moves to');
    if (from.id === to.id) throw bad('Choose two different accounts.');
    if (['income', 'expense'].includes(from.type) || ['income', 'expense'].includes(to.type)) {
      throw bad('Use Income or Expense for those accounts. Transfers are for cash, bank, loans, capital and similar.');
    }
    debitAcct = to; creditAcct = from;
  }

  const id = inTransaction(() => {
    const txId = db.prepare(`INSERT INTO transactions (org_id, date, kind, description, reference, amount, custom, created_by)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ctx.orgId, b.date, kind, description, reference, amount, JSON.stringify(custom), ctx.user.id).lastInsertRowid;
    const ins = db.prepare('INSERT INTO entries (tx_id, account_id, debit, credit) VALUES (?, ?, ?, ?)');
    ins.run(txId, debitAcct.id, amount, 0);
    ins.run(txId, creditAcct.id, 0, amount);
    return Number(txId);
  });
  return { id };
});

route('GET', `${ORG}/transactions`, (ctx) => {
  requireRole(ctx, 'viewer');
  const { where, params } = txFilter(ctx.orgId, ctx.query);
  const limit = Math.min(Math.max(Number(ctx.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(ctx.query.offset) || 0, 0);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT t.*, u.name AS created_by_name FROM transactions t
                           LEFT JOIN users u ON u.id = t.created_by
                           WHERE ${where} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, transactions: shapeTransactions(rows) };
});

route('DELETE', `${ORG}/transactions/(\\d+)`, (ctx) => {
  requireRole(ctx, 'accountant');
  pay.assertActive(ctx.org);
  // Records are never erased, only voided, so there is always an audit trail.
  const r = db.prepare(`UPDATE transactions SET voided = 1, voided_by = ?, voided_at = datetime('now')
                        WHERE id = ? AND org_id = ? AND voided = 0`).run(ctx.user.id, Number(ctx.params[2]), ctx.orgId);
  if (!r.changes) throw new HttpError(404, 'Transaction not found (or already voided).');
  return { ok: true };
});

route('GET', `${ORG}/transactions\\.csv`, (ctx) => {
  requireRole(ctx, 'viewer');
  const { where, params } = txFilter(ctx.orgId, ctx.query);
  const fields = loadCustomFields(ctx.orgId, true);
  const rows = shapeTransactions(db.prepare(`SELECT t.*, u.name AS created_by_name FROM transactions t
    LEFT JOIN users u ON u.id = t.created_by WHERE ${where} ORDER BY t.date, t.id`).all(...params));
  const header = ['Date', 'Type', 'Description', 'Reference', 'Amount', 'Debit account', 'Credit account', 'Status', ...fields.map((f) => f.label)];
  const out = [header.map((h) => csvCell(h)).join(',')];
  for (const t of rows) {
    const dr = t.lines.filter((l) => l.debit > 0).map((l) => `${l.code} ${l.name}`).join('; ');
    const cr = t.lines.filter((l) => l.credit > 0).map((l) => `${l.code} ${l.name}`).join('; ');
    out.push([
      t.date, t.kind, csvCell(t.description, { text: true }), csvCell(t.reference, { text: true }), nairaDecimal(t.amount),
      csvCell(dr, { text: true }), csvCell(cr, { text: true }), t.voided ? 'VOIDED' : 'ok',
      ...fields.map((f) => csvCell(t.custom[f.key] ?? '', { text: true })),
    ].join(','));
  }
  return { __raw: '﻿' + out.join('\r\n') + '\r\n', type: 'text/csv; charset=utf-8', filename: `transactions-${ctx.org.name.replace(/[^a-z0-9]+/gi, '-')}.csv` };
});

/* ---- reports ---- */

function accountingDashboard(orgId, today) {
  const ym = today.slice(0, 7);
  const monthStart = `${ym}-01`;
  const monthEnd = `${ym}-31`;

  const all = balances(orgId);
  const month = balances(orgId, monthStart, monthEnd);
  const sum = (list, pred) => list.filter(pred).reduce((s, a) => s + a.balance, 0);

  // Last 6 calendar months, oldest first.
  const [y, m] = ym.split('-').map(Number);
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const series = Object.fromEntries(months.map((k) => [k, { month: k, income: 0, expense: 0 }]));
  const rows = db.prepare(`
    SELECT substr(t.date, 1, 7) AS m, a.type, SUM(e.debit) AS d, SUM(e.credit) AS c
    FROM entries e JOIN transactions t ON t.id = e.tx_id JOIN accounts a ON a.id = e.account_id
    WHERE t.org_id = ? AND t.voided = 0 AND a.type IN ('income','expense') AND t.date >= ?
    GROUP BY m, a.type`).all(orgId, `${months[0]}-01`);
  for (const r of rows) {
    if (!series[r.m]) continue;
    if (r.type === 'income') series[r.m].income += r.c - r.d; else series[r.m].expense += r.d - r.c;
  }

  const monthIncome = sum(month, (a) => a.type === 'income');
  const monthExpense = sum(month, (a) => a.type === 'expense');
  return {
    month: ym,
    cash: sum(all, (a) => a.tag === 'cash'),
    receivable: sum(all, (a) => a.tag === 'receivable'),
    payable: sum(all, (a) => a.tag === 'payable'),
    month_income: monthIncome,
    month_expense: monthExpense,
    month_profit: monthIncome - monthExpense,
    series: months.map((k) => series[k]),
    top_income: month.filter((a) => a.type === 'income' && a.balance !== 0).sort((a, b) => b.balance - a.balance).slice(0, 5)
      .map(({ id, code, name, balance }) => ({ id, code, name, balance })),
    top_expenses: month.filter((a) => a.type === 'expense' && a.balance !== 0).sort((a, b) => b.balance - a.balance).slice(0, 5)
      .map(({ id, code, name, balance }) => ({ id, code, name, balance })),
  };
}

route('GET', `${ORG}/reports/dashboard`, (ctx) => {
  requireRole(ctx, 'viewer');
  const today = isDate(ctx.query.today) ? ctx.query.today : new Date().toISOString().slice(0, 10);
  return accountingDashboard(ctx.orgId, today);
});

route('GET', `${ORG}/reports/profit-loss`, (ctx) => {
  requireRole(ctx, 'viewer');
  const { from, to } = ctx.query;
  if (!isDate(from) || !isDate(to)) throw bad('Choose a start and end date.');
  if (from > to) throw bad('The start date is after the end date.');
  const list = balances(ctx.orgId, from, to);
  const pick = (type) => list.filter((a) => a.type === type && (a.balance !== 0 || a.debit || a.credit))
    .map(({ id, code, name, balance }) => ({ id, code, name, balance }));
  const income = pick('income');
  const expenses = pick('expense');
  const totalIncome = income.reduce((s, a) => s + a.balance, 0);
  const totalExpenses = expenses.reduce((s, a) => s + a.balance, 0);
  return { from, to, income, expenses, total_income: totalIncome, total_expenses: totalExpenses, net_profit: totalIncome - totalExpenses };
});

route('GET', `${ORG}/reports/balance-sheet`, (ctx) => {
  requireRole(ctx, 'viewer');
  const asAt = ctx.query.as_at;
  if (!isDate(asAt)) throw bad('Choose a date.');
  const list = balances(ctx.orgId, '0000-01-01', asAt);
  const pick = (type) => list.filter((a) => a.type === type && (a.balance !== 0 || a.debit || a.credit))
    .map(({ id, code, name, balance }) => ({ id, code, name, balance }));
  const assets = pick('asset'); const liabilities = pick('liability'); const equity = pick('equity');
  const earnings = list.filter((a) => a.type === 'income').reduce((s, a) => s + a.balance, 0)
    - list.filter((a) => a.type === 'expense').reduce((s, a) => s + a.balance, 0);
  const totalAssets = assets.reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
  const totalEquity = equity.reduce((s, a) => s + a.balance, 0) + earnings;
  return {
    as_at: asAt, assets, liabilities, equity, retained_earnings: earnings,
    total_assets: totalAssets, total_liabilities: totalLiabilities, total_equity: totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
});

route('GET', `${ORG}/reports/trial-balance`, (ctx) => {
  requireRole(ctx, 'viewer');
  const asAt = ctx.query.as_at;
  if (!isDate(asAt)) throw bad('Choose a date.');
  const rows = balances(ctx.orgId, '0000-01-01', asAt).filter((a) => a.debit || a.credit).map((a) => {
    const net = a.debit - a.credit;
    return { id: a.id, code: a.code, name: a.name, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  });
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { as_at: asAt, rows, total_debit: totalDebit, total_credit: totalCredit, balanced: totalDebit === totalCredit };
});

route('GET', `${ORG}/accounts/(\\d+)/ledger`, (ctx) => {
  requireRole(ctx, 'viewer');
  const acct = getAccount(ctx.orgId, Number(ctx.params[2]));
  if (!acct) throw new HttpError(404, 'Account not found.');
  const from = isDate(ctx.query.from) ? ctx.query.from : '0000-01-01';
  const to = isDate(ctx.query.to) ? ctx.query.to : '9999-12-31';
  const natural = (d, c) => ((acct.type === 'asset' || acct.type === 'expense') ? d - c : c - d);
  const opening = db.prepare(`SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c FROM entries e
    JOIN transactions t ON t.id = e.tx_id WHERE e.account_id = ? AND t.voided = 0 AND t.date < ?`).get(acct.id, from);
  const lines = db.prepare(`SELECT t.id, t.date, t.kind, t.description, t.reference, e.debit, e.credit
    FROM entries e JOIN transactions t ON t.id = e.tx_id
    WHERE e.account_id = ? AND t.voided = 0 AND t.date >= ? AND t.date <= ? ORDER BY t.date, t.id, e.id`).all(acct.id, from, to);
  let running = natural(opening.d, opening.c);
  const openingBalance = running;
  const rows = lines.map((l) => { running += natural(l.debit, l.credit); return { ...l, balance: running }; });
  return { account: { id: acct.id, code: acct.code, name: acct.name, type: acct.type }, opening: openingBalance, rows, closing: running };
});

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('Invalid request body.')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  securityHeaders(res);
  // Custom header + JSON body means other websites cannot forge changes (CSRF).
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'ledgerly') throw new HttpError(403, 'Blocked request.');
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const ctx = {
      req, res, user: getUser(req), params: m, query: Object.fromEntries(url.searchParams),
      body: req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req),
      orgId: m[1] && url.pathname.startsWith('/api/orgs/') ? Number(m[1]) : null,
      ip: clientIp(req),
    };
    if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw bad('Invalid request body.');
    dept.guard(ctx, url.pathname);
    const result = await r.handler(ctx);
    if (result && result.__raw !== undefined) {
      res.writeHead(200, {
        'Content-Type': result.type, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
      });
      return res.end(result.__raw);
    }
    return sendJson(res, 200, result);
  }
  throw new HttpError(404, 'Not found.');
}

function serveStatic(req, res, url) {
  securityHeaders(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (await pay.handleSpecial(req, res, url)) return;
    if (/^\/pay\/[a-z0-9-]+\/?$/.test(url.pathname)) url.pathname = '/pay.html'; // the school payment page
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server.' });
    else res.end();
  }
});

// Clean up expired sessions once an hour.
setInterval(() => {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  db.prepare("DELETE FROM password_resets WHERE expires_at <= datetime('now')").run();
  const cutoff = Date.now() - THROTTLE_WINDOW;
  for (const [k, v] of attempts) if (!v.length || v[v.length - 1] < cutoff) attempts.delete(k);
}, 3600 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Ledgerly running at http://localhost:${PORT}`));
}
module.exports = { server, db, pay, dept };
