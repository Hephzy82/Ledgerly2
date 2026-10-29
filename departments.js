'use strict';
/* =====================================================================
   Departments: custom roles, per-role dashboards, and the HR, Sales and
   Inventory modules. Installed from server.js (same pattern as payments.js).

   How access works
   - memberships.role stays one of owner/accountant/viewer. For a custom role
     it is the *accounting* access level derived from the role (edit -> accountant,
     otherwise viewer), so every existing accounting route keeps working.
   - memberships.role_id points at a custom role. The role says, per department,
     none / view / edit, which dashboard widgets to show, and whether the person
     may open every department's dashboard (the Manager).
   - guard() blocks accounting URLs for roles that have no accounting access.
   ===================================================================== */

const MODULES = { accounts: 'Accounts', hr: 'HR', sales: 'Sales', inventory: 'Inventory' };
const MODULE_KEYS = Object.keys(MODULES);
const LEVELS = ['none', 'view', 'edit'];

// [id, module, label, kind]
const WIDGET_LIST = [
  ['accounts.cash', 'accounts', 'Money on hand', 'kpi'],
  ['accounts.income_month', 'accounts', 'Income this month', 'kpi'],
  ['accounts.expense_month', 'accounts', 'Expenses this month', 'kpi'],
  ['accounts.profit_month', 'accounts', 'Profit this month', 'kpi'],
  ['accounts.receivable', 'accounts', 'Owed to the business', 'kpi'],
  ['accounts.payable', 'accounts', 'Owed by the business', 'kpi'],
  ['accounts.chart', 'accounts', 'Income and expenses, last 6 months', 'chart'],
  ['accounts.top_expenses', 'accounts', 'Biggest expenses this month', 'list'],
  ['accounts.top_income', 'accounts', 'Top income this month', 'list'],
  ['accounts.recent', 'accounts', 'Recent transactions', 'list'],
  ['hr.headcount', 'hr', 'Staff on the payroll', 'kpi'],
  ['hr.on_leave', 'hr', 'On leave today', 'kpi'],
  ['hr.pending_leave', 'hr', 'Leave awaiting approval', 'kpi'],
  ['hr.payroll', 'hr', 'Monthly salary bill', 'kpi'],
  ['hr.by_department', 'hr', 'Staff by department', 'list'],
  ['hr.new_hires', 'hr', 'Joined in the last 90 days', 'list'],
  ['hr.pending_list', 'hr', 'Leave requests to review', 'list'],
  ['sales.month', 'sales', 'Sales this month', 'kpi'],
  ['sales.open_orders', 'sales', 'Open orders', 'kpi'],
  ['sales.unpaid', 'sales', 'Awaiting payment', 'kpi'],
  ['sales.chart', 'sales', 'Sales, last 6 months', 'bars'],
  ['sales.top_customers', 'sales', 'Top customers this year', 'list'],
  ['sales.recent', 'sales', 'Recent orders', 'list'],
  ['inventory.items', 'inventory', 'Items tracked', 'kpi'],
  ['inventory.value', 'inventory', 'Stock value', 'kpi'],
  ['inventory.low_count', 'inventory', 'Items to reorder', 'kpi'],
  ['inventory.low_list', 'inventory', 'Running low', 'list'],
  ['inventory.recent', 'inventory', 'Recent stock movements', 'list'],
];
const WIDGETS = WIDGET_LIST.map(([id, module, label, kind]) => ({ id, module, label, kind }));
const WIDGET_BY_ID = Object.fromEntries(WIDGETS.map((w) => [w.id, w]));
const ALL_IDS = WIDGETS.map((w) => w.id);
const idsOf = (m) => WIDGETS.filter((w) => w.module === m).map((w) => w.id);
const OVERVIEW = ['accounts.cash', 'accounts.profit_month', 'hr.headcount', 'hr.pending_leave', 'sales.month', 'sales.open_orders',
  'inventory.value', 'inventory.low_count', 'hr.pending_list', 'inventory.low_list'];

const perms = (o) => ({ accounts: 'none', hr: 'none', sales: 'none', inventory: 'none', ...o });
const DEFAULT_TEMPLATES = [
  {
    name: 'Manager', all_dashboards: true,
    description: 'Opens every department’s dashboard. Approves leave and looks after sales and stock.',
    perms: perms({ accounts: 'view', hr: 'edit', sales: 'edit', inventory: 'edit' }), widgets: OVERVIEW,
  },
  {
    name: 'Accounts Officer', all_dashboards: false,
    description: 'Records and reviews the books. Sees only the accounts dashboard.',
    perms: perms({ accounts: 'edit' }), widgets: idsOf('accounts'),
  },
  {
    name: 'HR Officer', all_dashboards: false,
    description: 'Keeps staff records and handles leave requests. Sees only the HR dashboard.',
    perms: perms({ hr: 'edit' }), widgets: idsOf('hr'),
  },
  {
    name: 'Sales Officer', all_dashboards: false,
    description: 'Logs orders and follows up on payments. Sees only the sales dashboard.',
    perms: perms({ sales: 'edit' }), widgets: idsOf('sales'),
  },
  {
    name: 'Inventory Officer', all_dashboards: false,
    description: 'Counts stock and records what comes in and goes out. Sees only the inventory dashboard.',
    perms: perms({ inventory: 'edit' }), widgets: idsOf('inventory'),
  },
];

const LEAVE_TYPES = ['Annual', 'Sick', 'Casual', 'Maternity', 'Paternity', 'Unpaid', 'Other'];
const SALE_STATUSES = ['quote', 'confirmed', 'paid', 'cancelled'];
const todayWAT = () => new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);

module.exports = function install(d) {
  const { db, route, ORG, HttpError, bad, requireRole, requireAdmin, inTransaction, cleanText, parseAmount, validEmail, isDate, addColumn, pay, accountingDashboard } = d;

  /* ---------------- schema ---------------- */
  db.exec(`
  CREATE TABLE IF NOT EXISTS role_templates (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    all_dashboards INTEGER NOT NULL DEFAULT 0, perms TEXT NOT NULL, widgets TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', all_dashboards INTEGER NOT NULL DEFAULT 0,
    perms TEXT NOT NULL, widgets TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name ON roles(org_id, lower(name));
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL, job_title TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', salary INTEGER NOT NULL DEFAULT 0,
    start_date TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_emp_org ON employees(org_id);
  CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    decided_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_leave_org ON leave_requests(org_id, status);
  CREATE TABLE IF NOT EXISTS sales_orders (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    date TEXT NOT NULL, customer TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL CHECK (amount > 0),
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('quote','confirmed','paid','cancelled')),
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sales_org ON sales_orders(org_id, date);
  CREATE TABLE IF NOT EXISTS inventory_items (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL, sku TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'pcs',
    qty_milli INTEGER NOT NULL DEFAULT 0 CHECK (qty_milli >= 0),
    reorder_milli INTEGER NOT NULL DEFAULT 0, unit_cost INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_inv_org ON inventory_items(org_id);
  CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    date TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('in','out','adjust')),
    change_milli INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mov_item ON stock_movements(item_id);
  `);
  addColumn('memberships', 'role_id', 'INTEGER');
  addColumn('invites', 'role_id', 'INTEGER');
  addColumn('organizations', 'roles_seeded', 'INTEGER NOT NULL DEFAULT 0');

  /* ---------------- roles ---------------- */
  const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
  const baseFor = (p) => (p.accounts === 'edit' ? 'accountant' : 'viewer');
  const present = (r) => ({
    id: r.id, name: r.name, description: r.description, all_dashboards: !!r.all_dashboards,
    perms: perms(parseJson(r.perms, {})), widgets: parseJson(r.widgets, []),
  });

  function normaliseRole(b) {
    const name = cleanText(b.name, 40, 'Role name', { required: true });
    if (name.length < 2) throw bad('Role name is too short.');
    if (['owner', 'accountant', 'viewer'].includes(name.toLowerCase())) throw bad('That name belongs to a built-in role. Please choose another.');
    const description = cleanText(b.description, 160, 'Description');
    const all = !!b.all_dashboards;
    const p = {};
    for (const m of MODULE_KEYS) {
      const lvl = String((b.perms && b.perms[m]) || 'none');
      if (!LEVELS.includes(lvl)) throw bad('Access must be none, view or edit.');
      p[m] = all && lvl === 'none' ? 'view' : lvl;
    }
    if (MODULE_KEYS.every((m) => p[m] === 'none')) throw bad('Give this role access to at least one department.');
    const chosen = new Set(Array.isArray(b.widgets) ? b.widgets.map(String) : []);
    const widgets = ALL_IDS.filter((id) => chosen.has(id) && p[WIDGET_BY_ID[id].module] !== 'none');
    if (!widgets.length) throw bad('Choose at least one dashboard widget from a department this role can access.');
    return { name, description, all, perms: p, widgets };
  }

  function seedTemplates() {
    if (db.prepare('SELECT COUNT(*) AS n FROM role_templates').get().n) return;
    const ins = db.prepare('INSERT INTO role_templates (name, description, all_dashboards, perms, widgets, sort) VALUES (?, ?, ?, ?, ?, ?)');
    DEFAULT_TEMPLATES.forEach((t, i) => ins.run(t.name, t.description, t.all_dashboards ? 1 : 0, JSON.stringify(t.perms), JSON.stringify(t.widgets), i));
  }
  seedTemplates();

  // Copies template roles into an organisation, skipping names it already has.
  // Does not open its own transaction: callers wrap it when they need one.
  function seedOrgRoles(orgId) {
    const ins = db.prepare('INSERT OR IGNORE INTO roles (org_id, name, description, all_dashboards, perms, widgets, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let added = 0;
    for (const t of db.prepare('SELECT * FROM role_templates ORDER BY sort, id').all()) {
      added += ins.run(orgId, t.name, t.description, t.all_dashboards, t.perms, t.widgets, t.sort).changes;
    }
    db.prepare('UPDATE organizations SET roles_seeded = 1 WHERE id = ?').run(orgId);
    return added;
  }
  // Organisations created before roles existed get the starter roles once.
  for (const o of db.prepare('SELECT id FROM organizations WHERE roles_seeded = 0').all()) inTransaction(() => seedOrgRoles(o.id));

  // Resolves what the "role" field of the members API means: a built-in name or "c<id>".
  function resolveRoleChoice(orgId, choice) {
    const s = String(choice || '');
    if (['owner', 'accountant', 'viewer'].includes(s)) return { role: s, roleId: null };
    const m = /^c(\d+)$/.exec(s);
    if (!m) throw bad('Choose a role.');
    const r = db.prepare('SELECT * FROM roles WHERE id = ? AND org_id = ?').get(Number(m[1]), orgId);
    if (!r) throw bad('That role no longer exists.');
    return { role: baseFor(perms(parseJson(r.perms, {}))), roleId: r.id };
  }

  /* ---------------- access ---------------- */
  const full = (name) => ({ name, base: 'owner', perms: perms(Object.fromEntries(MODULE_KEYS.map((m) => [m, 'edit']))), allDash: true, widgets: OVERVIEW });

  function accessFor(user, orgId) {
    if (user.is_admin) return full('Platform admin');
    const m = db.prepare('SELECT role, role_id FROM memberships WHERE user_id = ? AND org_id = ?').get(user.id, orgId);
    if (!m) return null;
    if (m.role === 'owner') return full('Owner');
    const classic = (name, level) => ({ name, base: m.role, perms: perms({ accounts: level }), allDash: false, widgets: idsOf('accounts') });
    if (m.role_id) {
      const r = db.prepare('SELECT * FROM roles WHERE id = ? AND org_id = ?').get(m.role_id, orgId);
      if (r) return { name: r.name, base: m.role, perms: perms(parseJson(r.perms, {})), allDash: !!r.all_dashboards, widgets: parseJson(r.widgets, []) };
    }
    return m.role === 'accountant' ? classic('Accountant', 'edit') : classic('Viewer', 'view');
  }

  const ACCOUNTING_PATH = /^\/api\/orgs\/\d+\/(transactions(\.csv)?(\/\d+)?|reports\/[a-z-]+|accounts\/\d+\/ledger)$/;
  // Called for every API request: stops people whose role has no accounting access.
  function guard(ctx, pathname) {
    if (!ctx.user || !ctx.orgId || !ACCOUNTING_PATH.test(pathname)) return;
    const acc = accessFor(ctx.user, ctx.orgId);
    if (acc && acc.perms.accounts === 'none') throw new HttpError(403, 'Your role does not include the accounts.');
  }

  function need(ctx, module, level) {
    requireRole(ctx, 'viewer');
    const acc = accessFor(ctx.user, ctx.orgId);
    if (!acc || LEVELS.indexOf(acc.perms[module]) < LEVELS.indexOf(level)) {
      throw new HttpError(403, `Your role does not allow ${level === 'edit' ? 'changes to' : 'access to'} ${MODULES[module]}.`);
    }
    if (level === 'edit') pay.assertActive(ctx.org);
    ctx.acc = acc;
    return acc;
  }

  // What the front end needs to build the menu and choose a dashboard.
  function describeAccess(user, orgId) {
    const acc = accessFor(user, orgId);
    return { role_name: acc.name, access: acc.perms, all_dashboards: acc.allDash };
  }

  /* ---------------- role routes ---------------- */
  route('GET', '/api/role-options', (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Please log in.');
    return { modules: MODULES, levels: LEVELS, widgets: WIDGETS };
  });

  route('GET', '/api/admin/role-templates', (ctx) => {
    requireAdmin(ctx);
    return { templates: db.prepare('SELECT * FROM role_templates ORDER BY sort, id').all().map(present) };
  });
  route('POST', '/api/admin/role-templates', (ctx) => {
    requireAdmin(ctx);
    const r = normaliseRole(ctx.body);
    if (db.prepare('SELECT 1 FROM role_templates WHERE lower(name) = lower(?)').get(r.name)) throw bad('A template with that name already exists.');
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM role_templates').get().n;
    const id = db.prepare('INSERT INTO role_templates (name, description, all_dashboards, perms, widgets, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.name, r.description, r.all ? 1 : 0, JSON.stringify(r.perms), JSON.stringify(r.widgets), sort).lastInsertRowid;
    return { id: Number(id) };
  });
  route('PUT', '/api/admin/role-templates/(\\d+)', (ctx) => {
    requireAdmin(ctx);
    const id = Number(ctx.params[1]);
    if (!db.prepare('SELECT 1 FROM role_templates WHERE id = ?').get(id)) throw new HttpError(404, 'Template not found.');
    const r = normaliseRole(ctx.body);
    if (db.prepare('SELECT 1 FROM role_templates WHERE lower(name) = lower(?) AND id <> ?').get(r.name, id)) throw bad('A template with that name already exists.');
    db.prepare('UPDATE role_templates SET name = ?, description = ?, all_dashboards = ?, perms = ?, widgets = ? WHERE id = ?')
      .run(r.name, r.description, r.all ? 1 : 0, JSON.stringify(r.perms), JSON.stringify(r.widgets), id);
    return { ok: true };
  });
  route('DELETE', '/api/admin/role-templates/(\\d+)', (ctx) => {
    requireAdmin(ctx);
    db.prepare('DELETE FROM role_templates WHERE id = ?').run(Number(ctx.params[1]));
    return { ok: true };
  });

  route('GET', `${ORG}/roles`, (ctx) => {
    requireRole(ctx, 'owner');
    const roles = db.prepare('SELECT * FROM roles WHERE org_id = ? ORDER BY sort, id').all(ctx.orgId).map((r) => ({
      ...present(r), people: db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role_id = ?').get(ctx.orgId, r.id).n,
    }));
    return { roles, can_edit: !!ctx.user.is_admin };
  });
  const adminOnly = (ctx) => { requireRole(ctx, 'viewer'); requireAdmin(ctx); };
  route('POST', `${ORG}/roles`, (ctx) => {
    adminOnly(ctx);
    const r = normaliseRole(ctx.body);
    if (db.prepare('SELECT 1 FROM roles WHERE org_id = ? AND lower(name) = lower(?)').get(ctx.orgId, r.name)) throw bad('This business already has a role with that name.');
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM roles WHERE org_id = ?').get(ctx.orgId).n;
    const id = db.prepare('INSERT INTO roles (org_id, name, description, all_dashboards, perms, widgets, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.orgId, r.name, r.description, r.all ? 1 : 0, JSON.stringify(r.perms), JSON.stringify(r.widgets), sort).lastInsertRowid;
    return { id: Number(id) };
  });
  route('POST', `${ORG}/roles/from-templates`, (ctx) => {
    adminOnly(ctx);
    return { added: inTransaction(() => seedOrgRoles(ctx.orgId)) };
  });
  route('PUT', `${ORG}/roles/(\\d+)`, (ctx) => {
    adminOnly(ctx);
    const id = Number(ctx.params[2]);
    if (!db.prepare('SELECT 1 FROM roles WHERE id = ? AND org_id = ?').get(id, ctx.orgId)) throw new HttpError(404, 'Role not found.');
    const r = normaliseRole(ctx.body);
    if (db.prepare('SELECT 1 FROM roles WHERE org_id = ? AND lower(name) = lower(?) AND id <> ?').get(ctx.orgId, r.name, id)) throw bad('This business already has a role with that name.');
    inTransaction(() => {
      db.prepare('UPDATE roles SET name = ?, description = ?, all_dashboards = ?, perms = ?, widgets = ? WHERE id = ? AND org_id = ?')
        .run(r.name, r.description, r.all ? 1 : 0, JSON.stringify(r.perms), JSON.stringify(r.widgets), id, ctx.orgId);
      // Keep the accounting access level of everyone in this role in step.
      db.prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND role_id = ?').run(baseFor(r.perms), ctx.orgId, id);
    });
    return { ok: true };
  });
  route('DELETE', `${ORG}/roles/(\\d+)`, (ctx) => {
    adminOnly(ctx);
    const id = Number(ctx.params[2]);
    const n = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role_id = ?').get(ctx.orgId, id).n;
    if (n) throw bad(`${n} ${n === 1 ? 'person has' : 'people have'} this role. Move them to another role first.`);
    db.prepare('DELETE FROM invites WHERE org_id = ? AND role_id = ?').run(ctx.orgId, id);
    db.prepare('DELETE FROM roles WHERE id = ? AND org_id = ?').run(id, ctx.orgId);
    return { ok: true };
  });

  /* ---------------- dashboards ---------------- */
  const lastMonths = (today, n) => {
    const [y, m] = today.slice(0, 7).split('-').map(Number);
    return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1)).toISOString().slice(0, 7));
  };
  const kpi = (value, format, sub) => ({ value, format, sub: sub || '' });
  const list = (rows, empty) => ({ rows, empty });

  function accountsWidgets(orgId, want, today) {
    const out = {};
    const dash = accountingDashboard(orgId, today);
    const map = {
      'accounts.cash': () => kpi(dash.cash, 'money', 'Cash and bank accounts'),
      'accounts.income_month': () => kpi(dash.month_income, 'money'),
      'accounts.expense_month': () => kpi(dash.month_expense, 'money'),
      'accounts.profit_month': () => ({ ...kpi(dash.month_profit, 'money', dash.month_profit < 0 ? 'Spending more than earning' : 'Income minus expenses'), tone: dash.month_profit < 0 ? 'neg' : '' }),
      'accounts.receivable': () => kpi(dash.receivable, 'money'),
      'accounts.payable': () => kpi(dash.payable, 'money'),
      'accounts.chart': () => ({ series: dash.series }),
      'accounts.top_expenses': () => list(dash.top_expenses.map((a) => ({ title: a.name, value: a.balance, format: 'money' })), 'No expenses this month.'),
      'accounts.top_income': () => list(dash.top_income.map((a) => ({ title: a.name, value: a.balance, format: 'money' })), 'No income this month.'),
      'accounts.recent': () => list(db.prepare('SELECT date, kind, description, amount FROM transactions WHERE org_id = ? AND voided = 0 ORDER BY date DESC, id DESC LIMIT 6').all(orgId)
        .map((t) => ({ title: t.description || (t.kind === 'income' ? 'Money in' : t.kind === 'expense' ? 'Money out' : 'Moved money'), sub: t.date, value: t.amount, format: 'money', sign: t.kind === 'income' ? 1 : t.kind === 'expense' ? -1 : 0 })), 'Nothing recorded yet.'),
    };
    for (const id of want) if (map[id]) out[id] = map[id]();
    return out;
  }

  function hrWidgets(orgId, want, today) {
    const out = {};
    const one = (sql, ...a) => db.prepare(sql).get(orgId, ...a);
    const map = {
      'hr.headcount': () => kpi(one("SELECT COUNT(*) AS n FROM employees WHERE org_id = ? AND status = 'active'").n, 'count'),
      'hr.on_leave': () => kpi(one("SELECT COUNT(DISTINCT employee_id) AS n FROM leave_requests WHERE org_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?", today, today).n, 'count'),
      'hr.pending_leave': () => kpi(one("SELECT COUNT(*) AS n FROM leave_requests WHERE org_id = ? AND status = 'pending'").n, 'count'),
      'hr.payroll': () => kpi(one("SELECT COALESCE(SUM(salary), 0) AS n FROM employees WHERE org_id = ? AND status = 'active'").n, 'money', 'Active staff only'),
      'hr.by_department': () => list(db.prepare("SELECT CASE WHEN department = '' THEN 'No department' ELSE department END AS title, COUNT(*) AS value FROM employees WHERE org_id = ? AND status = 'active' GROUP BY 1 ORDER BY value DESC LIMIT 8")
        .all(orgId).map((r) => ({ ...r, format: 'count' })), 'No staff added yet.'),
      'hr.new_hires': () => list(db.prepare("SELECT name, job_title, start_date FROM employees WHERE org_id = ? AND status = 'active' AND start_date >= date(?, '-90 days') ORDER BY start_date DESC LIMIT 6")
        .all(orgId, today).map((e) => ({ title: e.name, sub: e.job_title, value: e.start_date, format: 'date' })), 'Nobody has joined recently.'),
      'hr.pending_list': () => list(db.prepare(`SELECT l.type, l.from_date, l.to_date, e.name FROM leave_requests l JOIN employees e ON e.id = l.employee_id
                                               WHERE l.org_id = ? AND l.status = 'pending' ORDER BY l.from_date LIMIT 6`)
        .all(orgId).map((l) => ({ title: l.name, sub: `${l.type} leave`, value: l.from_date, format: 'date' })), 'No leave requests waiting.'),
    };
    for (const id of want) if (map[id]) out[id] = map[id]();
    return out;
  }

  function salesWidgets(orgId, want, today) {
    const out = {};
    const ym = today.slice(0, 7);
    const sum = (sql, ...a) => db.prepare(sql).get(orgId, ...a).n;
    const map = {
      'sales.month': () => kpi(sum("SELECT COALESCE(SUM(amount), 0) AS n FROM sales_orders WHERE org_id = ? AND status IN ('confirmed','paid') AND substr(date, 1, 7) = ?", ym), 'money', 'Confirmed and paid orders'),
      'sales.open_orders': () => kpi(sum("SELECT COUNT(*) AS n FROM sales_orders WHERE org_id = ? AND status IN ('quote','confirmed')"), 'count', 'Quotes and unpaid orders'),
      'sales.unpaid': () => kpi(sum("SELECT COALESCE(SUM(amount), 0) AS n FROM sales_orders WHERE org_id = ? AND status = 'confirmed'"), 'money', 'Confirmed but not yet paid'),
      'sales.chart': () => {
        const months = lastMonths(today, 6);
        const rows = db.prepare("SELECT substr(date, 1, 7) AS m, SUM(amount) AS v FROM sales_orders WHERE org_id = ? AND status IN ('confirmed','paid') AND date >= ? GROUP BY m").all(orgId, `${months[0]}-01`);
        const by = Object.fromEntries(rows.map((r) => [r.m, r.v]));
        return { series: months.map((m) => ({ month: m, value: by[m] || 0 })), format: 'money' };
      },
      'sales.top_customers': () => list(db.prepare("SELECT customer AS title, SUM(amount) AS value FROM sales_orders WHERE org_id = ? AND status IN ('confirmed','paid') AND substr(date, 1, 4) = ? GROUP BY lower(customer) ORDER BY value DESC LIMIT 5")
        .all(orgId, today.slice(0, 4)).map((r) => ({ ...r, format: 'money' })), 'No sales recorded this year.'),
      'sales.recent': () => list(db.prepare('SELECT date, customer, description, amount, status FROM sales_orders WHERE org_id = ? ORDER BY date DESC, id DESC LIMIT 6').all(orgId)
        .map((s) => ({ title: s.customer, sub: `${s.description || 'Order'} · ${s.status}`, value: s.amount, format: 'money' })), 'No orders yet.'),
    };
    for (const id of want) if (map[id]) out[id] = map[id]();
    return out;
  }

  const qtyText = (milli) => (milli / 1000).toLocaleString('en-NG', { maximumFractionDigits: 3 });
  function inventoryWidgets(orgId, want) {
    const out = {};
    const items = () => db.prepare('SELECT * FROM inventory_items WHERE org_id = ? AND active = 1').all(orgId);
    const low = () => items().filter((i) => i.reorder_milli > 0 && i.qty_milli <= i.reorder_milli);
    const map = {
      'inventory.items': () => kpi(items().length, 'count'),
      'inventory.value': () => kpi(items().reduce((s, i) => s + Math.round(i.qty_milli * i.unit_cost / 1000), 0), 'money', 'Quantity times unit cost'),
      'inventory.low_count': () => kpi(low().length, 'count', 'At or below their reorder level'),
      'inventory.low_list': () => list(low().sort((a, b) => a.qty_milli - b.qty_milli).slice(0, 6)
        .map((i) => ({ title: i.name, sub: `Reorder at ${qtyText(i.reorder_milli)} ${i.unit}`, value: `${qtyText(i.qty_milli)} ${i.unit}`, format: 'text' })), 'Nothing is running low.'),
      'inventory.recent': () => list(db.prepare(`SELECT m.date, m.kind, m.change_milli, i.name, i.unit FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
                                                WHERE m.org_id = ? ORDER BY m.date DESC, m.id DESC LIMIT 6`).all(orgId)
        .map((m) => ({ title: m.name, sub: m.date, value: `${m.change_milli > 0 ? '+' : ''}${qtyText(m.change_milli)} ${m.unit}`, format: 'text' })), 'No stock movements yet.'),
    };
    for (const id of want) if (map[id]) out[id] = map[id]();
    return out;
  }

  route('GET', `${ORG}/home`, (ctx) => {
    requireRole(ctx, 'viewer');
    const acc = accessFor(ctx.user, ctx.orgId);
    const today = todayWAT();
    const visible = (id) => acc.perms[WIDGET_BY_ID[id].module] !== 'none';
    let tabs = null;
    let tab = 'mine';
    let ids;
    if (acc.allDash) {
      tabs = [{ key: 'overview', label: 'Overview' }, ...MODULE_KEYS.filter((m) => acc.perms[m] !== 'none').map((m) => ({ key: m, label: MODULES[m] }))];
      tab = tabs.some((t) => t.key === ctx.query.tab) ? ctx.query.tab : 'overview';
      ids = tab === 'overview' ? ALL_IDS.filter((id) => acc.widgets.includes(id) && visible(id)) : idsOf(tab);
    } else {
      ids = ALL_IDS.filter((id) => acc.widgets.includes(id) && visible(id));
    }
    const want = new Set(ids);
    const data = {
      ...accountsWidgets(ctx.orgId, [...want].filter((i) => i.startsWith('accounts.')), today),
      ...hrWidgets(ctx.orgId, [...want].filter((i) => i.startsWith('hr.')), today),
      ...salesWidgets(ctx.orgId, [...want].filter((i) => i.startsWith('sales.')), today),
      ...inventoryWidgets(ctx.orgId, [...want].filter((i) => i.startsWith('inventory.'))),
    };
    return { role_name: acc.name, tabs, tab, widgets: ids.map((id) => ({ ...WIDGET_BY_ID[id], data: data[id] })) };
  });

  /* ---------------- HR ---------------- */
  const empOut = (e) => ({ id: e.id, name: e.name, job_title: e.job_title, department: e.department, phone: e.phone, email: e.email, salary: e.salary, start_date: e.start_date, status: e.status });
  function employeeBody(b) {
    const name = cleanText(b.name, 80, 'Name', { required: true });
    const email = cleanText(b.email, 120, 'Email').toLowerCase();
    if (email && !validEmail(email)) throw bad('That email address is not valid.');
    const start = String(b.start_date || '');
    if (start && !isDate(start)) throw bad('Enter the start date as a real date.');
    const salaryRaw = String(b.salary ?? '').trim();
    let salary = 0;
    if (salaryRaw) { salary = parseAmount(salaryRaw); if (!salary) throw bad('Enter the monthly salary as an amount in Naira, or leave it blank.'); }
    const status = b.status === 'inactive' ? 'inactive' : 'active';
    return { name, job_title: cleanText(b.job_title, 80, 'Job title'), department: cleanText(b.department, 60, 'Department'), phone: cleanText(b.phone, 30, 'Phone'), email, salary, start_date: start || null, status };
  }
  route('GET', `${ORG}/hr/employees`, (ctx) => {
    need(ctx, 'hr', 'view');
    return { employees: db.prepare('SELECT * FROM employees WHERE org_id = ? ORDER BY status, name COLLATE NOCASE LIMIT 1000').all(ctx.orgId).map(empOut) };
  });
  route('POST', `${ORG}/hr/employees`, (ctx) => {
    need(ctx, 'hr', 'edit');
    const e = employeeBody(ctx.body);
    const id = db.prepare('INSERT INTO employees (org_id, name, job_title, department, phone, email, salary, start_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.orgId, e.name, e.job_title, e.department, e.phone, e.email, e.salary, e.start_date, e.status).lastInsertRowid;
    return { id: Number(id) };
  });
  route('PUT', `${ORG}/hr/employees/(\\d+)`, (ctx) => {
    need(ctx, 'hr', 'edit');
    const id = Number(ctx.params[2]);
    if (!db.prepare('SELECT 1 FROM employees WHERE id = ? AND org_id = ?').get(id, ctx.orgId)) throw new HttpError(404, 'Staff member not found.');
    const e = employeeBody(ctx.body);
    db.prepare('UPDATE employees SET name = ?, job_title = ?, department = ?, phone = ?, email = ?, salary = ?, start_date = ?, status = ? WHERE id = ? AND org_id = ?')
      .run(e.name, e.job_title, e.department, e.phone, e.email, e.salary, e.start_date, e.status, id, ctx.orgId);
    return { ok: true };
  });
  route('GET', `${ORG}/hr/leave`, (ctx) => {
    need(ctx, 'hr', 'view');
    const rows = db.prepare(`SELECT l.id, l.employee_id, e.name, l.type, l.from_date, l.to_date, l.reason, l.status, l.created_at
                             FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.org_id = ?
                             ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.from_date DESC LIMIT 300`).all(ctx.orgId);
    return { leave: rows, types: LEAVE_TYPES };
  });
  route('POST', `${ORG}/hr/leave`, (ctx) => {
    need(ctx, 'hr', 'edit');
    const b = ctx.body;
    const emp = db.prepare("SELECT id FROM employees WHERE id = ? AND org_id = ? AND status = 'active'").get(Number(b.employee_id), ctx.orgId);
    if (!emp) throw bad('Choose which staff member the leave is for.');
    const type = String(b.type || '');
    if (!LEAVE_TYPES.includes(type)) throw bad('Choose a leave type.');
    if (!isDate(b.from_date) || !isDate(b.to_date)) throw bad('Enter the first and last day of leave.');
    if (b.from_date > b.to_date) throw bad('The last day of leave is before the first day.');
    const id = db.prepare('INSERT INTO leave_requests (org_id, employee_id, type, from_date, to_date, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ctx.orgId, emp.id, type, b.from_date, b.to_date, cleanText(b.reason, 300, 'Reason')).lastInsertRowid;
    return { id: Number(id) };
  });
  route('PUT', `${ORG}/hr/leave/(\\d+)`, (ctx) => {
    need(ctx, 'hr', 'edit');
    const status = String(ctx.body.status || '');
    if (!['approved', 'rejected', 'pending'].includes(status)) throw bad('Choose approve or reject.');
    const r = db.prepare('UPDATE leave_requests SET status = ?, decided_by = ? WHERE id = ? AND org_id = ?').run(status, ctx.user.id, Number(ctx.params[2]), ctx.orgId);
    if (!r.changes) throw new HttpError(404, 'Leave request not found.');
    return { ok: true };
  });

  /* ---------------- Sales ---------------- */
  route('GET', `${ORG}/sales/orders`, (ctx) => {
    need(ctx, 'sales', 'view');
    const status = SALE_STATUSES.includes(ctx.query.status) ? ctx.query.status : null;
    const q = String(ctx.query.q || '').trim().toLowerCase();
    const rows = db.prepare(`SELECT s.id, s.date, s.customer, s.description, s.amount, s.status, u.name AS created_by FROM sales_orders s
                             LEFT JOIN users u ON u.id = s.created_by WHERE s.org_id = ? ${status ? 'AND s.status = ?' : ''}
                             ORDER BY s.date DESC, s.id DESC LIMIT 500`).all(...(status ? [ctx.orgId, status] : [ctx.orgId]));
    return { orders: q ? rows.filter((r) => `${r.customer} ${r.description}`.toLowerCase().includes(q)) : rows, statuses: SALE_STATUSES };
  });
  function orderBody(b) {
    if (!isDate(b.date)) throw bad('Enter the order date.');
    const amount = parseAmount(b.amount);
    if (!amount) throw bad('Enter the order amount in Naira.');
    const status = String(b.status || 'confirmed');
    if (!SALE_STATUSES.includes(status)) throw bad('Choose an order status.');
    return { date: b.date, customer: cleanText(b.customer, 100, 'Customer name', { required: true }), description: cleanText(b.description, 200, 'Description'), amount, status };
  }
  route('POST', `${ORG}/sales/orders`, (ctx) => {
    need(ctx, 'sales', 'edit');
    const o = orderBody(ctx.body);
    const id = db.prepare('INSERT INTO sales_orders (org_id, date, customer, description, amount, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.orgId, o.date, o.customer, o.description, o.amount, o.status, ctx.user.id).lastInsertRowid;
    return { id: Number(id) };
  });
  route('PUT', `${ORG}/sales/orders/(\\d+)`, (ctx) => {
    need(ctx, 'sales', 'edit');
    const o = orderBody(ctx.body);
    const r = db.prepare('UPDATE sales_orders SET date = ?, customer = ?, description = ?, amount = ?, status = ? WHERE id = ? AND org_id = ?')
      .run(o.date, o.customer, o.description, o.amount, o.status, Number(ctx.params[2]), ctx.orgId);
    if (!r.changes) throw new HttpError(404, 'Order not found.');
    return { ok: true };
  });

  /* ---------------- Inventory ---------------- */
  // "12.5" -> 12500 (thousandths). Returns null when not a non-negative number with up to 3 decimals.
  function parseQty(v, { allowZero = true } = {}) {
    const s = String(v ?? '').replace(/[,\s]/g, '');
    if (!/^\d{1,9}(\.\d{1,3})?$/.test(s)) return null;
    const [w, f = ''] = s.split('.');
    const n = Number(w) * 1000 + Number((f + '000').slice(0, 3));
    return n === 0 && !allowZero ? null : n;
  }
  const itemOut = (i) => ({ id: i.id, name: i.name, sku: i.sku, unit: i.unit, qty: i.qty_milli / 1000, reorder: i.reorder_milli / 1000, unit_cost: i.unit_cost, active: !!i.active,
    value: Math.round(i.qty_milli * i.unit_cost / 1000), low: i.reorder_milli > 0 && i.qty_milli <= i.reorder_milli });
  function itemBody(b) {
    const reorder = parseQty(b.reorder ?? '0');
    if (reorder === null) throw bad('Enter the reorder level as a number.');
    const costRaw = String(b.unit_cost ?? '').trim();
    let cost = 0;
    if (costRaw) { cost = parseAmount(costRaw); if (!cost) throw bad('Enter the cost per unit in Naira, or leave it blank.'); }
    return { name: cleanText(b.name, 80, 'Item name', { required: true }), sku: cleanText(b.sku, 40, 'Code'), unit: cleanText(b.unit, 20, 'Unit') || 'pcs', reorder, cost };
  }
  route('GET', `${ORG}/inventory/items`, (ctx) => {
    need(ctx, 'inventory', 'view');
    return { items: db.prepare('SELECT * FROM inventory_items WHERE org_id = ? ORDER BY active DESC, name COLLATE NOCASE').all(ctx.orgId).map(itemOut) };
  });
  route('POST', `${ORG}/inventory/items`, (ctx) => {
    need(ctx, 'inventory', 'edit');
    const it = itemBody(ctx.body);
    const opening = ctx.body.opening_qty === undefined || ctx.body.opening_qty === '' ? 0 : parseQty(ctx.body.opening_qty);
    if (opening === null) throw bad('Enter the opening quantity as a number.');
    const id = inTransaction(() => {
      const newId = Number(db.prepare('INSERT INTO inventory_items (org_id, name, sku, unit, qty_milli, reorder_milli, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.orgId, it.name, it.sku, it.unit, opening, it.reorder, it.cost).lastInsertRowid);
      if (opening > 0) db.prepare("INSERT INTO stock_movements (org_id, item_id, date, kind, change_milli, note, created_by) VALUES (?, ?, ?, 'in', ?, 'Opening stock', ?)")
        .run(ctx.orgId, newId, todayWAT(), opening, ctx.user.id);
      return newId;
    });
    return { id };
  });
  route('PUT', `${ORG}/inventory/items/(\\d+)`, (ctx) => {
    need(ctx, 'inventory', 'edit');
    const it = itemBody(ctx.body);
    const active = ctx.body.active === undefined ? 1 : (ctx.body.active ? 1 : 0);
    const r = db.prepare('UPDATE inventory_items SET name = ?, sku = ?, unit = ?, reorder_milli = ?, unit_cost = ?, active = ? WHERE id = ? AND org_id = ?')
      .run(it.name, it.sku, it.unit, it.reorder, it.cost, active, Number(ctx.params[2]), ctx.orgId);
    if (!r.changes) throw new HttpError(404, 'Item not found.');
    return { ok: true };
  });
  route('GET', `${ORG}/inventory/items/(\\d+)/movements`, (ctx) => {
    need(ctx, 'inventory', 'view');
    const id = Number(ctx.params[2]);
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND org_id = ?').get(id, ctx.orgId);
    if (!item) throw new HttpError(404, 'Item not found.');
    const rows = db.prepare(`SELECT m.id, m.date, m.kind, m.change_milli, m.note, u.name AS by FROM stock_movements m LEFT JOIN users u ON u.id = m.created_by
                             WHERE m.item_id = ? AND m.org_id = ? ORDER BY m.date DESC, m.id DESC LIMIT 100`).all(id, ctx.orgId);
    return { item: itemOut(item), movements: rows.map((m) => ({ id: m.id, date: m.date, kind: m.kind, change: m.change_milli / 1000, note: m.note, by: m.by })) };
  });
  route('POST', `${ORG}/inventory/items/(\\d+)/movements`, (ctx) => {
    need(ctx, 'inventory', 'edit');
    const id = Number(ctx.params[2]);
    const b = ctx.body;
    const kind = String(b.kind || '');
    if (!['in', 'out', 'adjust'].includes(kind)) throw bad('Choose stock in, stock out or a correction.');
    const date = b.date ? String(b.date) : todayWAT();
    if (!isDate(date)) throw bad('Enter the date.');
    const note = cleanText(b.note, 200, 'Note');
    let change;
    if (kind === 'adjust') {
      // Correction: the person types the quantity actually counted on the shelf.
      const counted = parseQty(b.qty);
      if (counted === null) throw bad('Enter the quantity you counted.');
      if (!note) throw bad('Say why you are correcting the count (for example “stock take”).');
      change = { counted };
    } else {
      const q = parseQty(b.qty, { allowZero: false });
      if (q === null) throw bad('Enter a quantity greater than zero.');
      change = { delta: kind === 'in' ? q : -q };
    }
    const result = inTransaction(() => {
      const item = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND org_id = ?').get(id, ctx.orgId);
      if (!item) throw new HttpError(404, 'Item not found.');
      const delta = change.counted !== undefined ? change.counted - item.qty_milli : change.delta;
      const next = item.qty_milli + delta;
      if (next < 0) throw bad(`Only ${qtyText(item.qty_milli)} ${item.unit} in stock. You cannot take out more than that.`);
      if (delta === 0) throw bad('The count already matches what the system shows.');
      db.prepare('UPDATE inventory_items SET qty_milli = ? WHERE id = ?').run(next, id);
      db.prepare('INSERT INTO stock_movements (org_id, item_id, date, kind, change_milli, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.orgId, id, date, kind, delta, note, ctx.user.id);
      return next;
    });
    return { qty: result / 1000 };
  });

  return { accessFor, describeAccess, guard, seedOrgRoles, resolveRoleChoice, baseFor, WIDGETS, MODULES };
};
