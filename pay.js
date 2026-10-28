'use strict';

/* Public school fee payment page (no login). Opened at /pay/<school-address>. */

const root = document.getElementById('pay-root');
const slug = (location.pathname.match(/^\/pay\/([a-z0-9-]+)/) || [])[1] || '';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (kobo) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format((kobo || 0) / 100);

let school = null;

async function getJson(url, opts) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledgerly' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function shell(inner) {
  root.innerHTML = `<div class="pay-card">
    <div class="logo"><span class="logo-mark">L</span> ${esc(school ? school.school : 'Online payment')}</div>
    ${inner}
    <p class="small muted pay-foot">Payments are processed securely by Paystack. We never see or store your card details.</p>
  </div>`;
}

function showForm(message = '') {
  const items = school.items;
  shell(`
    <h1>Pay school fees</h1>
    ${school.note ? `<p class="muted">${esc(school.note)}</p>` : ''}
    <form id="pay-form" novalidate>
      <div class="error" id="pay-error" ${message ? '' : 'hidden'}>${esc(message)}</div>
      <div class="field"><label for="p-item">What are you paying for?</label>
        <select id="p-item" name="item_id">${items.map((i) => `<option value="${esc(i.id)}">${esc(i.label)}${i.amount ? ` — ${esc(naira(i.amount))}` : ''}</option>`).join('')}</select></div>
      <div class="field" id="amount-field"><label for="p-amount">Amount (₦)</label><input id="p-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00"></div>
      <div class="field"><label for="p-student">Student's full name</label><input id="p-student" name="student_name" maxlength="80" required></div>
      <div class="row">
        <div class="field"><label for="p-class">Class</label><input id="p-class" name="student_class" maxlength="40" placeholder="e.g. JSS 2"></div>
        <div class="field"><label for="p-term">Term</label><select id="p-term" name="term"><option value="">—</option>${school.terms.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="p-payer">Your name <span class="muted">(optional)</span></label><input id="p-payer" name="payer_name" maxlength="80"></div>
      <div class="field"><label for="p-email">Your email</label><input id="p-email" name="email" type="email" autocomplete="email" required>
        <div class="hint">Your receipt is sent here.</div></div>
      <button class="btn btn-primary btn-block" type="submit" id="pay-btn">Continue to payment</button>
    </form>`);
  const item = document.getElementById('p-item');
  const amountField = document.getElementById('amount-field');
  const sync = () => {
    const chosen = items.find((i) => i.id === item.value);
    amountField.hidden = !!(chosen && chosen.amount);
  };
  item.addEventListener('change', sync);
  sync();

  document.getElementById('pay-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('pay-btn');
    const err = document.getElementById('pay-error');
    err.hidden = true; btn.disabled = true; btn.textContent = 'Please wait…';
    try {
      const body = Object.fromEntries(new FormData(e.target));
      const r = await getJson(`/api/portal/${slug}/pay`, { method: 'POST', body: JSON.stringify(body) });
      location.assign(r.url);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Continue to payment';
    }
  });
}

function showResult(r) {
  if (r.status === 'success') {
    shell(`<div class="pay-done"><div class="tick" aria-hidden="true">✓</div><h1>Payment received</h1>
      <p>Thank you. ${esc(r.school)} has received your payment.</p>
      <table class="receipt"><tbody>
        <tr><th>Student</th><td>${esc(r.student)}</td></tr>
        <tr><th>For</th><td>${esc(r.item_label)}</td></tr>
        <tr><th>Amount</th><td><strong>${esc(naira(r.amount))}</strong></td></tr>
        <tr><th>Reference</th><td>${esc(r.reference)}</td></tr>
      </tbody></table>
      <p class="muted small">Please keep this reference as your receipt. A copy is also sent to your email.</p>
      <p><a class="btn" href="/pay/${esc(slug)}">Make another payment</a></p></div>`);
  } else if (r.status === 'pending') {
    shell(`<h1>Waiting for confirmation</h1><p>We have not received confirmation of your payment yet. This can take a minute.</p>
      <p><button class="btn btn-primary" id="recheck">Check again</button></p>
      <p class="muted small">Reference: ${esc(r.reference)}. If your bank has already debited you, do not pay again. Check back shortly or contact the school office with this reference.</p>`);
    document.getElementById('recheck').addEventListener('click', () => verify(r.reference));
  } else {
    shell(`<h1>Payment not completed</h1><p>Your payment did not go through, and the school has not received any money.</p>
      <p><a class="btn btn-primary" href="/pay/${esc(slug)}">Try again</a></p>
      <p class="muted small">Reference: ${esc(r.reference)}. If you were debited, contact the school office with this reference.</p>`);
  }
}

async function verify(reference) {
  try {
    shell('<p class="boot">Confirming your payment…</p>');
    showResult(await getJson(`/api/payments/verify?reference=${encodeURIComponent(reference)}`));
  } catch (ex) {
    shell(`<h1>We could not confirm that payment</h1><p>${esc(ex.message)}</p><p><a class="btn" href="/pay/${esc(slug)}">Back</a></p>`);
  }
}

(async () => {
  try {
    school = await getJson(`/api/portal/${slug}`);
  } catch (ex) {
    school = null;
    shell(`<h1>Payment page unavailable</h1><p>${esc(ex.message)}</p>`);
    return;
  }
  const ref = new URLSearchParams(location.search).get('reference');
  if (ref) verify(ref); else showForm();
})();
