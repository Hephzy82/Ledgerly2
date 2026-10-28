# Ledgerly

An accounting platform where **every client gets books shaped around their own business**: a poultry farm, a school, a sole proprietor, or anything you set up. You (the platform admin) onboard clients and customise their accounts and fields; each client's data is kept completely separate.

Amounts are in **Naira (₦)** by default and stored in kobo (whole numbers) so totals never drift.

---

## Run it on your computer

You need **Node.js 22.13 or newer** (https://nodejs.org). There is nothing else to install.

```bash
cd ledgerly
npm start
```

Then open **http://localhost:3000**.

1. Click **Create an account**. The **first** account created becomes the **platform admin** (you).
2. Click **Onboard new client**, choose **Poultry Farm**, type the farm's name, and (optionally) the owner's email.
3. Open the client and click **+ Money in** or **+ Money out** to start recording.

Your data lives in `data/ledgerly.db`. **Back this file up regularly**: copying it is a full backup.

To check everything works: `npm test`

---

## How it works (the 2-minute version)

- **Organisation** = one client business. Everything below belongs to exactly one organisation.
- **Chart of accounts** = the list of places money can come from or go to (e.g. *Egg Sales*, *Feed*, *Bank Account*). A client starts from a **template** and can then rename, add or switch off any account.
- **Custom fields** = extra questions on each transaction (e.g. *Flock / Batch*, *Class*, *Term*). Different for every client.
- **Transactions** come in three kinds:
  - **Money in**: sales and other income (into cash, bank, or "customers owing us" for credit sales)
  - **Money out**: expenses (from cash/bank, or "suppliers we owe" if bought on credit)
  - **Move money**: bank deposits, loans, owner putting in or taking out money, customers paying what they owed, paying suppliers
- Behind the scenes every transaction is a proper **double-entry** record, so the **Profit & Loss**, **Balance Sheet** and **Trial Balance** are always consistent.
- Mistakes are **voided**, never deleted, so there is always an audit trail.

### Roles

| Role | Can do |
|---|---|
| **Platform admin** (you) | Onboard clients, open and configure any client |
| **Owner** (client) | Everything inside their organisation: accounts, fields, team |
| **Accountant** | Record and void transactions, view reports |
| **Viewer** | View only |

Add people from **Team**. If they haven't signed up yet, their access switches on automatically when they register with that email.

---

## Adding a new type of business

Open `templates.js`. Copy any block (for example `school`), give it a new key (such as `church`), then change the account list and the fields. Restart the server and the new type appears when onboarding a client. Existing clients are not affected.

You don't need a template for one-off needs: after onboarding, any client's accounts and fields can be changed from the **Chart of accounts** and **Custom fields** pages.

---

## What's new in this version

- **Restaurant / Food Business** template (food and drink sales, gas, packaging, wastage, POS charges; fields for table/order no., meal period, payment method, branch).
- **Password reset**: "Forgot password?" emails a one-hour link. If email isn't set up, the platform admin can create a link by hand from the home page and send it on WhatsApp. Resetting logs the user out of every other device.
- **Subscriptions**: every new client gets a free trial (default 30 days, set `TRIAL_DAYS`). When it ends the account becomes **read-only**: they can still view reports and download CSV, but can't add entries until the owner pays on the **Billing** page (Paystack). The admin can add free days, set a custom price, or mark an account free.
- **School payment portal**: each school gets a public page at `/pay/<their-address>` where parents choose a fee, enter the student's name, class and term, and pay with Paystack. The money is split straight to the school's bank account, and each payment is recorded in their books automatically, tagged with the student. Parents get an emailed receipt.
- **Rate-limit fix**: set `TRUST_PROXY=1` on hosts like Render so visitors are counted individually, not all as one person.

**Paystack has only been tested against a simulated Paystack here.** Please run everything in Paystack **test mode** first (see `DEPLOY.md`).

## Settings (environment variables)

| Name | What it does | Default |
|---|---|---|
| `PORT` | Port to listen on | 3000 |
| `DB_PATH` | Where the database file lives | `data/ledgerly.db` |
| `NODE_ENV` | Set `production` online (HTTPS-only cookies) | |
| `ADMIN_EMAIL` | Only this email can be platform admin | first signup |
| `TRUST_PROXY` | Number of proxies in front of the app (1 on most hosts) | 0 |
| `APP_URL` | Your public address, used in emails and Paystack links | `http://localhost:PORT` |
| `PAYSTACK_SECRET_KEY` | Turns on subscriptions and the school portal | off |
| `PLAN_PRICE_NGN` | Monthly price in Naira | 5000 |
| `TRIAL_DAYS` | Free trial length | 30 |
| `RESEND_API_KEY`, `MAIL_FROM` | Send real emails (resets, receipts) | off |

## Putting it online

Follow **DEPLOY.md**: GitHub, Render, Paystack and email, step by step, with a checklist before real clients use it.

### What's built in for safety
- Passwords are hashed with scrypt; login, signup, reset and payment attempts are rate-limited per visitor.
- Every request checks the person's role for that specific organisation, and one client can never read or write another's data.
- Paystack webhooks are verified by signature, every payment is re-checked with Paystack and for the exact amount, and a payment can only be applied once.
- The school's payout account can only be set by the platform admin, and is never shown publicly.
- Reset links are single-use, expire in one hour, and are built from your `APP_URL`, never from the visitor's request.
- All text shown on screen is escaped, the app sends a strict Content-Security-Policy, and changes can't be forged from other websites.
- CSV exports neutralise spreadsheet-formula tricks.

### Not built yet (good next steps)
- Email verification and two-factor login
- Invoices & receipts (PDF), customer/supplier records
- Bank statement import and reconciliation
- Closing a period (locking past months)
- Inventory/flock tracking, payroll, per-student fee balances
- Multi-currency conversion, per-client logo and branding
- Refunds and Paystack payout reconciliation inside the app

---

## Files

| File | What it is |
|---|---|
| `server.js` | The server: database, logins, permissions, accounting rules, reports, password reset |
| `payments.js` | Subscriptions, Paystack, and the school payment portal |
| `mail.js` | Email sending and the public web address |
| `templates.js` | The starting accounts and fields for each business type |
| `public/` | The website: `index.html`, `app.js`, `style.css`, and the public parent page `pay.html` + `pay.js` |
| `test/` | Automated checks (`npm test`) |
| `DEPLOY.md` | GitHub → Render → Paystack guide |
| `data/` | Created on first run; holds your database |
