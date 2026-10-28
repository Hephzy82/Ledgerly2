# Putting Ledgerly online: GitHub → Render → Paystack

This guide takes you from the folder on your computer to a live website. I can't see GitHub's or Render's screens from here, so button names may differ slightly from what I describe. If something looks different, look for the closest match.

**Order of work:** (1) GitHub, (2) Render, (3) test it with fake money, (4) Paystack live, (5) email.

---

## 1. GitHub (where your code is stored)

GitHub is a safe online home for your code. Your website host (Render) reads from it, and every future change you make goes through it.

1. Go to **github.com** and sign up (free). Verify your email.
2. Click the **+** at the top right → **New repository**.
   - Name: `ledgerly`
   - Choose **Private**. This matters: your code and settings stay hidden from the public.
   - Don't tick "Add a README" (the project already has one).
   - Click **Create repository**.
3. On the empty repository page, click **uploading an existing file**.
4. On your computer, unzip `ledgerly.zip`. Open the `ledgerly` folder, select **everything inside it** (not the folder itself) and drag it into the GitHub page. You should see `server.js`, `payments.js`, `package.json`, the `public` folder and so on listed.
5. Scroll down, write a message like `First version`, and click **Commit changes**.

**Check it worked:** the repository page should show `server.js`, `package.json`, `public/`, `test/` and the rest.

**Never upload:** a `data` folder (your database), any `.env` file, or any key or password. Secret keys go only into Render's settings in step 2. The included `.gitignore` already blocks `data/` and `.env` if you use Git commands later.

### Making changes later
- Open a file on GitHub, click the pencil ✏️, edit, then **Commit changes**. Render redeploys by itself.
- For bigger changes, start a new chat with me, upload the project files, tell me what to change, and I'll give you the updated files. Upload them to GitHub the same way (GitHub asks to replace the old ones).
- Alternative: install **GitHub Desktop** (desktop.github.com), which lets you edit files on your computer and press "Push" to send them. It's easier if you'll change things often.

---

## 2. Render (the computer that runs your website)

1. Go to **render.com** and sign up with your GitHub account.
2. **New → Web Service** → pick your `ledgerly` repository.
3. Settings:
   - **Runtime:** Node
   - **Build command:** leave blank or `npm install`
   - **Start command:** `npm start`
   - **Plan:** Free is fine for testing only (see "Disk" below).
4. Open **Environment** and add these variables:

| Name | Value | Why |
|---|---|---|
| `NODE_VERSION` | `22` | The app needs Node 22.13 or newer |
| `NODE_ENV` | `production` | Makes login cookies HTTPS-only |
| `ADMIN_EMAIL` | your email | Only this email can become platform admin |
| `TRUST_PROXY` | `1` | Fixes the rate limiter behind Render's proxy |
| `APP_URL` | your Render address, e.g. `https://ledgerly-abcd.onrender.com` | Used in reset emails and Paystack return links. Set it after you see your address, then redeploy |
| `PAYSTACK_SECRET_KEY` | `sk_test_...` for now | From Paystack → Settings → API Keys. **Start with the TEST key** |
| `PLAN_PRICE_NGN` | `5000` | Monthly price in Naira |
| `TRIAL_DAYS` | `30` | Free trial length (use `15` for two weeks) |
| `DB_PATH` | `/var/data/ledgerly.db` | **Only after you add the disk** (see below) |

5. Click **Create Web Service**. After a few minutes Render shows your address. Open it and **sign up with the exact email you set in `ADMIN_EMAIL`**. That account becomes the platform admin.

**Check the `TRUST_PROXY` value:** `1` is correct for most hosts. If you later notice that all your visitors seem to be blocked together, or that the limiter never triggers, tell me and I'll adjust it.

### Disk (important)
Without a persistent disk, **the database is erased whenever the app restarts or redeploys**. Until you add one, use only fake data. To add it: in Render, open your service → **Disks** → add a disk mounted at `/var/data`, then set `DB_PATH=/var/data/ledgerly.db` and redeploy. Disks usually need a paid plan. Check the price first. Also, free web services sleep when idle and wake slowly, which is bad for parents trying to pay fees. Plan to use a paid plan before real use.

---

## 3. Test with fake money

With the Paystack **test** key:
1. Log in as admin → **Onboard new client** → create a School → open it → **Billing** → pick 1 month → **Pay**.
2. On Paystack's test page, use one of Paystack's **test cards** (they list them in their documentation) and finish the payment.
3. You return to the Billing page, which should now show the subscription as active.

Test the school portal too:
1. In Paystack (test mode) go to **Settings → Subaccounts** and create one. Copy its code (`ACCT_...`).
2. In Ledgerly, open the school → **Online payments**. Paste the code, set a web address, add fee items, turn it **on**, and save.
3. Open `https://your-app/pay/<address>`, make a test payment, and confirm it appears under the school's Transactions.

Also test: **Log out → Forgot password**. Without email set up, the reset link isn't sent. Use the admin's "Help someone who can't log in" box on the home page to make a link instead.

---

## 4. Going live with Paystack

1. Complete Paystack's **business verification** (they need your business details and documents). Only then do you get live keys.
2. In Paystack → **Settings → API Keys & Webhooks**, set the **Webhook URL** to:
   `https://your-app-address/api/paystack/webhook`
   This lets payments be recorded even if a parent closes their browser right after paying.
3. In Render, replace `PAYSTACK_SECRET_KEY` with your `sk_live_...` key and redeploy.
4. For each school you onboard: create their **Subaccount** in Paystack with the school's own bank account, then paste its code into their Online payments page (admin only). Paystack then pays the school directly, and the school bears Paystack's fee.
5. Make a small real payment yourself first (₦100) and confirm it shows up everywhere.

**Your money vs the school's money:** subscription payments go to *your* Paystack account. Parents' fee payments go to *the school's* bank account via the subaccount. Ledgerly never holds money.

---

## 5. Email for password resets and receipts (optional but recommended)

The app uses **Resend** (resend.com). Sign up, add and verify your domain, create an API key, then in Render add:
- `RESEND_API_KEY` = your key
- `MAIL_FROM` = `Ledgerly <no-reply@yourdomain.com>`

Without these, everything still works, but emails (password reset, parent receipts) aren't sent.

---

## Before real clients use it

- [ ] Persistent disk attached and `DB_PATH` set
- [ ] A way to back up `ledgerly.db` regularly (Render disk snapshots, or download copies)
- [ ] `ADMIN_EMAIL`, `TRUST_PROXY`, `APP_URL` set; HTTPS working
- [ ] Paystack live key and webhook set, and a ₦100 real test done
- [ ] Get advice about Nigeria's data protection law (NDPA) and terms of service for your clients. I am not a lawyer.
- [ ] Ask a developer for a security review before handling many clients' real financial records
