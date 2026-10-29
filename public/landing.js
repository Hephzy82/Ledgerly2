'use strict';

/* =====================================================================
   Public pages: landing page and business registration.
   Loaded before app.js. Shares helpers (html, GET, POST ...) with it; they
   are only used when a page renders, after app.js has finished loading.
   Extra event handlers register in window.LX, which app.js consults.
   ===================================================================== */
window.LX = window.LX || { actions: {}, forms: {}, changes: {}, pages: {} };

const LANDING = { info: null };
const naira0 = (kobo) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format((kobo || 0) / 100);

/* ---------- the live role demo (the one memorable thing on the page) ---------- */
const DEMO_BUSINESS = 'Mama Tunde’s Kitchen';
const DEMO_ROLES = [
  {
    key: 'manager', label: 'Manager', sees: 'Every department, in tabs',
    note: 'Opens all four dashboards and approves leave. The Overview pulls one headline from each.',
    kpis: [['Money on hand', '₦1,842,500'], ['Profit this month', '₦412,300'], ['Staff', '14'], ['Awaiting leave approval', '2']],
    listTitle: 'Needs a decision',
    rows: [['Leave: Chidi Okafor', '3 days from Monday'], ['Low stock: Rice (50kg)', '3 bags left'], ['Unpaid order: Mrs Bello', '₦85,000']],
  },
  {
    key: 'accounts', label: 'Accounts', sees: 'Accounts only',
    note: 'Records money in and out, runs the profit and loss and balance sheet. Never sees staff salaries.',
    kpis: [['Money on hand', '₦1,842,500'], ['Income this month', '₦1,260,000'], ['Expenses this month', '₦847,700'], ['Owed to you', '₦215,000']],
    listTitle: 'Biggest expenses',
    rows: [['Food supplies', '₦392,000'], ['Wages', '₦280,000'], ['Gas and power', '₦96,500']],
  },
  {
    key: 'hr', label: 'HR', sees: 'HR only',
    note: 'Keeps the staff list and handles leave. Cannot open the books, sales or stock.',
    kpis: [['Staff on the payroll', '14'], ['On leave today', '1'], ['Leave awaiting approval', '2'], ['Monthly salary bill', '₦1,120,000']],
    listTitle: 'Leave requests to review',
    rows: [['Chidi Okafor', 'Annual · from 2 Nov'], ['Bisi Adeyemi', 'Sick · from 29 Oct']],
  },
  {
    key: 'sales', label: 'Sales', sees: 'Sales only',
    note: 'Logs orders and chases unpaid ones. Cannot see profit, wages or stock costs.',
    kpis: [['Sales this month', '₦1,260,000'], ['Open orders', '9'], ['Awaiting payment', '₦340,000'], ['Top customer', 'Mrs Bello']],
    listTitle: 'Recent orders',
    rows: [['Mrs Bello · 40 plates, naming ceremony', '₦85,000'], ['Mama Tunde · weekly lunch order', '₦48,000'], ['St Luke’s school canteen', '₦120,000']],
  },
  {
    key: 'inventory', label: 'Inventory', sees: 'Inventory only',
    note: 'Counts stock in and out and sees what is running low. Cannot see sales or staff.',
    kpis: [['Items tracked', '38'], ['Stock value', '₦624,000'], ['Items to reorder', '4'], ['Moved today', '11']],
    listTitle: 'Running low',
    rows: [['Rice (50kg bag)', '3 bags left'], ['Vegetable oil (25L)', '2 drums left'], ['Cooking gas refill', '1 cylinder left']],
  },
];

function demoPanel(key) {
  const r = DEMO_ROLES.find((x) => x.key === key) || DEMO_ROLES[0];
  return html`
    <div class="demo-who"><strong>${r.label}</strong><span>${r.sees}</span></div>
    <div class="demo-kpis">${r.kpis.map(([l, v]) => html`<div class="demo-kpi"><span>${l}</span><strong>${v}</strong></div>`)}</div>
    <div class="demo-list"><h3>${r.listTitle}</h3>
      <ul>${r.rows.map(([a, b]) => html`<li><span>${a}</span><span>${b}</span></li>`)}</ul></div>
    <p class="demo-note">${r.note}</p>`;
}

const DEMO_TOUCHED = { done: false };
LX.actions['demo-role'] = (el) => {
  const key = el.dataset.role;
  document.querySelectorAll('[data-action="demo-role"]').forEach((b) => b.setAttribute('aria-selected', String(b === el)));
  const panel = $('#demo-panel');
  if (panel) {
    panel.innerHTML = demoPanel(key).s;
    panel.setAttribute('aria-labelledby', el.id);
    panel.classList.remove('swap'); void panel.offsetWidth; panel.classList.add('swap'); // answers the click: a short fade
  }
  DEMO_TOUCHED.done = true;
};
LX.actions['scroll-to'] = (el) => {
  const t = document.getElementById(el.dataset.target);
  if (t) t.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
};

/* ---------- landing page ---------- */
const logoLink = () => html`<a class="lp-logo" href="#/" aria-label="Ledgerly home"><span class="logo-mark">L</span> Ledgerly</a>`;

function featureRow(title, lead, points) {
  return html`<div class="lp-feature"><div><h3>${title}</h3><p>${lead}</p></div>
    <ul>${points.map((p) => html`<li>${p}</li>`)}</ul></div>`;
}

async function viewLanding() {
  if (!LANDING.info) {
    try { LANDING.info = await GET('/api/public/info'); } catch { LANDING.info = { templates: [], trial_days: 30, price_month: 500000 }; }
  }
  const info = LANDING.info;
  const price = naira0(info.price_month);
  document.title = 'Ledgerly: accounts, staff, sales and stock for your business';

  app.innerHTML = html`
  <div class="lp">
    <header class="lp-nav">
      ${logoLink()}
      <nav class="lp-links" aria-label="Page sections">
        <button class="lp-link" data-action="scroll-to" data-target="who">Who it’s for</button>
        <button class="lp-link" data-action="scroll-to" data-target="features">What you get</button>
        <button class="lp-link" data-action="scroll-to" data-target="pricing">Pricing</button>
        <button class="lp-link" data-action="scroll-to" data-target="faq">Questions</button>
      </nav>
      <div class="lp-nav-cta"><a class="lp-login" href="#/login">Log in</a><a class="btn btn-primary" href="#/register">Register your business</a></div>
    </header>

    <main>
      <section class="lp-hero">
        <div class="lp-hero-copy">
          <h1>Accounts, staff, sales and stock, with a dashboard for each person.</h1>
          <p class="lp-lead">Ledgerly keeps proper double-entry books for your farm, school, restaurant or shop, then gives your accounts, HR, sales and stock people a screen of their own. The manager sees everything.</p>
          <div class="lp-cta">
            <a class="btn btn-primary btn-lg" href="#/register">Register your business</a>
            <a class="btn btn-lg" href="#/login">Log in</a>
          </div>
          <p class="lp-fine">Free for ${info.trial_days} days. You don’t need a card to start.</p>
        </div>

        <div class="lp-demo" aria-label="Example dashboards for each role">
          <div class="demo-head"><strong>${DEMO_BUSINESS}</strong><span>Pick a role to see what that person sees</span></div>
          <div class="demo-tabs" role="tablist" aria-label="Role">
            ${DEMO_ROLES.map((r, i) => html`<button role="tab" id="demo-tab-${r.key}" data-action="demo-role" data-role="${r.key}" aria-selected="${i === 0}" aria-controls="demo-panel">${r.label}</button>`)}
          </div>
          <div class="demo-panel swap" id="demo-panel" role="tabpanel" aria-labelledby="demo-tab-manager">${demoPanel('manager')}</div>
        </div>
      </section>

      <section class="lp-section" id="who">
        <div class="lp-wrap">
          <h2>Set up for the business you actually run</h2>
          <p class="lp-sub">Choose your type when you register and Ledgerly fills in the accounts and the questions that business needs. Change any of it later.</p>
          <ul class="lp-types">
            ${info.templates.map((t) => html`<li><strong>${t.label}</strong><span>${t.description}</span></li>`)}
          </ul>
        </div>
      </section>

      <section class="lp-section lp-tint" id="features">
        <div class="lp-wrap">
          <h2>One place for the records each team keeps</h2>
          ${featureRow('The books', 'Real double-entry accounting behind plain screens. Say money in or money out and Ledgerly does the debits and credits.', [
            'Profit and loss, balance sheet and trial balance in Naira',
            'Nothing is deleted: mistakes are voided, so there is always a trail',
            'Extra fields per business, such as flock or class, on every entry',
            'Download any list to open in Excel',
          ])}
          ${featureRow('The departments', 'HR, sales and stock keep their records here too, not in separate notebooks and spreadsheets.', [
            'HR: staff list, salaries, and leave requests with approval',
            'Sales: orders from quote to paid, and who owes you',
            'Inventory: stock in and out, and a warning before you run out',
            'Stock can never go below zero by mistake',
          ])}
          ${featureRow('Who sees what', 'Give people a role and they land on a dashboard built for it. They don’t see the rest.', [
            'Starter roles: Manager, Accounts, HR, Sales and Inventory',
            'Everyone sees their own dashboard only. The manager sees them all',
            'Your data is kept apart from every other business on Ledgerly',
            'Schools can take fees online, and each payment lands in the books',
          ])}
        </div>
      </section>

      <section class="lp-section lp-dark" id="roles">
        <div class="lp-wrap lp-split">
          <div>
            <h2>The cashier doesn’t need to see the payroll</h2>
            <p>In most small businesses everyone shares one login or one notebook, so everyone sees everything. Here, the person who counts stock sees stock. The person who handles leave sees leave. The owner and manager see the lot.</p>
            <p>Need a role we haven’t listed, such as Procurement or Front Desk? Ask the Ledgerly team and it is added to your business with the dashboard you choose.</p>
          </div>
          <ol class="lp-steps">
            <li><strong>Register your business</strong><span>Pick the type, and the starter books and roles are ready.</span></li>
            <li><strong>Add your people</strong><span>Enter their email and choose a role. If they haven’t signed up yet, access starts when they do.</span></li>
            <li><strong>Everyone logs in to their own screen</strong><span>Each person lands on the dashboard for their role.</span></li>
          </ol>
        </div>
      </section>

      <section class="lp-section" id="pricing">
        <div class="lp-wrap lp-pricing">
          <div>
            <h2>One price for the whole business</h2>
            <p class="lp-sub">Not per person and not per module. Everything on this page is included.</p>
          </div>
          <div class="lp-price">
            <div class="lp-price-amt"><strong>${price}</strong> a month</div>
            <ul>
              <li>Free for the first ${info.trial_days} days</li>
              <li>Add as many people as you like</li>
              <li>Pay by card, bank transfer or USSD through Paystack</li>
              <li>If you stop paying, you can still view and download all your records</li>
            </ul>
            <a class="btn btn-primary btn-lg" href="#/register">Start your free ${info.trial_days} days</a>
          </div>
        </div>
      </section>

      <section class="lp-section lp-tint" id="faq">
        <div class="lp-wrap lp-faq">
          <h2>Questions people ask first</h2>
          <details><summary>Do I need to know accounting?</summary><p>No. You record money in and money out in plain words. Ledgerly keeps the double-entry books underneath, so your accountant gets reports they recognise.</p></details>
          <details><summary>Who can see my numbers?</summary><p>Only the people you add, and each person only sees what their role allows. Your records are kept separate from every other business on Ledgerly.</p></details>
          <details><summary>Can I add my accountant or my staff?</summary><p>Yes. Add them by email from the Team page and choose a role. If they don’t have an account yet, they get access when they sign up with that email.</p></details>
          <details><summary>What happens when the free trial ends?</summary><p>You can still log in, view everything and download your records. Adding new entries pauses until you pay.</p></details>
          <details><summary>Can parents pay school fees through it?</summary><p>Yes. A school can switch on a payment page. Parents pay with Paystack and each payment is recorded in the school’s books with the student’s name.</p></details>
          <details><summary>I already have a login someone gave me</summary><p>Then you don’t need to register. <a href="#/login">Log in</a> with your email and you will land on your own dashboard.</p></details>
        </div>
      </section>
    </main>

    <footer class="lp-foot">
      <div class="lp-wrap lp-foot-in">
        ${logoLink()}
        <div><a href="#/register">Register your business</a> <a href="#/login">Log in</a></div>
      </div>
    </footer>
  </div>`.s;
  window.scrollTo(0, 0);
}

/* ---------- business registration ---------- */
async function viewRegister() {
  const loggedIn = !!(state.me && state.me.user);
  let info = LANDING.info;
  if (!info) { try { info = LANDING.info = await GET('/api/public/info'); } catch { info = { templates: [], trial_days: 30, currencies: ['NGN'] }; } }
  document.title = 'Register your business · Ledgerly';
  app.innerHTML = html`
  <div class="auth">
    <section class="auth-brand">
      <a class="logo" href="#/"><span class="logo-mark">L</span> Ledgerly</a>
      <div>
        <h1>Set up your business in a few minutes.</h1>
        <p class="lead">You start with the books for your kind of business and the starter roles: Manager, Accounts, HR, Sales and Inventory.</p>
        <ul>
          <li>Free for ${info.trial_days} days, no card needed</li>
          <li>Add your team and give each person a role</li>
          <li>Everyone lands on their own dashboard</li>
        </ul>
      </div>
      <p class="small fine">Your records are kept separate from every other business.</p>
    </section>
    <section class="auth-panel">
      <div class="auth-card wide">
        <h2>${loggedIn ? 'Register another business' : 'Register your business'}</h2>
        <form data-form="register" novalidate>
          ${errorBox()}
          ${loggedIn ? html`<p class="muted small">Signed in as ${state.me.user.name}. The new business is added to your account and you become its owner.</p>` : html`
          <div class="row">
            <div class="field"><label for="rg-name">Your name</label><input id="rg-name" name="name" autocomplete="name" required></div>
            <div class="field"><label for="rg-email">Email</label><input id="rg-email" name="email" type="email" autocomplete="email" required></div>
          </div>
          <div class="field"><label for="rg-pass">Password</label><input id="rg-pass" name="password" type="password" autocomplete="new-password" required><div class="hint">At least 8 characters.</div></div>`}
          <div class="field"><label for="rg-biz">Business name</label><input id="rg-biz" name="business_name" placeholder="e.g. Adebayo Poultry Farm" required></div>
          <div class="field"><label>What kind of business is it?</label>
            <div class="type-grid">${info.templates.map((t, i) => html`
              <label class="type-opt"><input type="radio" name="type" value="${t.key}" ${i === 0 ? raw('checked') : ''}>
                <span class="box"><strong>${t.label}</strong><span>${t.description}</span></span></label>`)}</div>
            <div class="hint">This only sets the starting accounts and fields. You can change everything afterwards.</div></div>
          <input type="hidden" name="currency" value="NGN">
          <button class="btn btn-primary btn-block" type="submit">Create my business</button>
        </form>
        <p class="small muted mt">${loggedIn ? html`<a href="#/">Back to your businesses</a>` : html`Already registered? <a href="#/login">Log in</a>`}</p>
      </div>
    </section>
  </div>`.s;
}

LX.forms.register = async (form) => {
  const d = Object.fromEntries(new FormData(form));
  const r = await POST('/api/register-business', d);
  state.me = null; state.setup = null; state.setupOrgId = null;
  toast('Your business is ready. Add your team and choose their roles.');
  location.hash = `#/org/${r.org_id}/team`;
  await render();
};

/* Called by app.js when nobody is logged in. */
async function viewPublic(hash) {
  if (state.firstRun && (hash === '/' || hash === '/register')) { location.hash = '#/signup'; return; }
  if (hash === '/register') return viewRegister();
  if (hash === '/' || hash === '') return viewLanding();
  document.title = 'Ledgerly';
  return viewAuth();
}
