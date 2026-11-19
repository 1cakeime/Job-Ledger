// Estimate and invoice pages in doc.html. scripts/build-doc.mjs pastes this in as plain browser JS.
// Uses: $, app, token, sbc, esc, money2, fmtDateY, docTotals, docDeposit, docHTML, DOC_KIND, renderPhotos.
const isImg = (u) => /^https:\/\/|^data:image\//.test(u || '');
// Same header and contact buttons as the project page (portal.html), so every customer page looks alike.
function headHTML(d, co, title) {
  return `${d.portalToken ? `<a class="back" href="portal.html#${esc(d.portalToken)}">‹ Your whole project</a>` : ''}
  <div class="head">${isImg(co.logo) ? `<img class="logo" src="${esc(co.logo)}" alt="">` : ''}<div>${co.company ? `<div class="co">${esc(co.company)}</div>` : ''}<h1>${esc(d.jobName || title)}</h1>${d.jobAddress ? `<p class="note">${esc(d.jobAddress)}</p>` : ''}</div></div>
  <div class="bar"><h2>${esc(title)}</h2><button class="btn sm" id="print">Print or save PDF</button></div>`;
}
function contactHTML(co) {
  if (!co.phone && !co.email) return '';
  const first = co.name ? co.name.split(' ')[0] : co.company || 'us';
  return `<section class="sec"><h2>Questions?</h2><div class="row">${co.phone ? `<a class="btn" href="tel:${esc(co.phone)}">Call ${esc(first)}</a><a class="btn" href="sms:${esc(co.phone)}">Text</a>` : ''}${co.email ? `<a class="btn" href="mailto:${esc(co.email)}">Email</a>` : ''}</div></section>`;
}
function paidList(d) {
  const ps = (d.payments || []).filter((p) => +p.amount).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return ps.length ? `<ul class="paid">${ps.map((p) => `<li><span>Paid${p.date ? ' ' + fmtDateY(p.date) : ''}${p.method ? ' · ' + esc(p.method) : ''}</span><b>${money2(+p.amount)}</b></li>`).join('')}</ul>` : '';
}

let R = null;
function render(r) {
  if (r.data && r.data.kind === 'photos') return renderPhotos(r);
  R = r;
  const d = r.data, est = d.kind === 'estimate', st = r.status, co = d.company || {};
  const refs = new Set((d.payments || []).map((p) => p.ref).filter(Boolean));
  for (const p of r.online || []) if (!refs.has(p.ref)) (d.payments = d.payments || []).push({ amount: +p.amount, date: p.date, ref: p.ref, method: 'Card' });
  if (r.approved_name && !d.approvedBy) { d.approvedBy = r.approved_name; d.approvedAt = r.approved_at; }
  if (r.approved_sig) d.approvedSig = r.approved_sig;
  const t = docTotals(d), due = Math.max(0, Math.round(t.balance * 100) / 100), justPaid = /[?&]paid=1/.test(location.search);
  const title = DOC_KIND[d.kind] + ' ' + d.num;
  document.title = title + (co.company ? ' · ' + co.company : '');
  let top = '', bottom = '', sticky = '';
  if (est) {
    const dep = docDeposit(d), depDue = Math.max(0, Math.round((dep - t.paid) * 100) / 100);
    if (st === 'approved') {
      top = `<div class="card"><p class="ok">Approved${r.approved_name ? ' by ' + esc(r.approved_name) : ''}${r.approved_at ? ' on ' + fmtDateY(String(r.approved_at).slice(0, 10)) : ''}. Thank you!</p>
        ${dep > 0 ? (depDue < 0.005 ? `<p class="note">Deposit of ${money2(dep)} received.</p>${paidList(d)}`
          : justPaid ? '<p class="ok">Thank you! Your deposit went through. It can take a minute to show here.</p>'
          : r.can_pay ? `<p class="note">Next step: the ${money2(depDue)} deposit to get on the schedule.</p><div class="row" style="margin-top:10px"><button class="btn primary" id="pay" data-label="Pay ${money2(depDue)} deposit by card">Pay ${money2(depDue)} deposit by card</button></div><p class="note err" id="pmsg" hidden></p>`
          : `<p class="note">A deposit of ${money2(depDue)} is due. ${esc(co.company || 'Your contractor')} will tell you how to pay it.</p>`) : ''}</div>`;
    } else if (st === 'declined') {
      top = `<div class="card"><p class="note">You declined this estimate. Contact ${esc(co.company || 'us')} if you change your mind.</p></div>`;
    } else {
      top = `<div class="card"><div class="sum-row"><div><span class="note">Estimate total</span><b class="big">${money2(t.total)}</b></div>${d.valid ? `<div><span class="note">Valid until</span><b>${fmtDateY(d.valid)}</b></div>` : ''}${dep > 0 ? `<div><span class="note">Deposit to start</span><b>${money2(dep)}</b></div>` : ''}</div>
        <p class="note" style="margin-top:8px">Look over the details below, then sign at the bottom to approve.</p></div>`;
      bottom = `<div class="card" id="respond"><h2>Approve this estimate</h2><p class="note">Type your name and sign with your finger or mouse.${dep > 0 && r.can_pay ? ` Then you'll pay the ${money2(dep)} deposit by card.` : ''} ${esc(co.company || 'The contractor')} is told right away.</p>
        <input id="who" placeholder="Your full name" autocomplete="name">
        <div class="sig"><canvas id="sig"></canvas><span class="sig-hint" aria-hidden="true">Sign here</span><button type="button" class="btn sm ghost" id="sig-clear">Clear</button></div>
        <div class="row"><button class="btn primary" id="approve">${dep > 0 && r.can_pay ? 'Approve and pay deposit' : 'Approve estimate'}</button><button class="btn ghost" id="decline">Decline</button></div><p class="note err" id="msg" hidden></p></div>`;
      sticky = `<div class="sticky" id="sticky"><div><span class="note">Total</span><b>${money2(t.total)}</b></div><button class="btn primary" id="to-approve">Review &amp; approve</button></div>`;
    }
  } else {
    top = due < 0.005
      ? `<div class="card"><p class="ok">Paid in full. Thank you!</p>${paidList(d)}</div>`
      : `<div class="card"><span class="note">Amount due</span><b class="big">${money2(due)}</b>${d.due ? `<p class="note">Due ${fmtDateY(d.due)}</p>` : ''}
        ${t.paid ? `${paidList(d)}<p class="note">Total ${money2(t.total)} · paid ${money2(t.paid)} · ${money2(due)} left</p>` : ''}
        ${justPaid ? '<p class="ok">Thank you! Your card payment went through. It can take a minute to show on this page.</p>' : ''}
        ${r.can_pay && !justPaid ? `<div class="row" style="margin-top:12px"><button class="btn primary" id="pay" data-label="Pay ${money2(due)} by card">Pay ${money2(due)} by card</button></div><p class="note err" id="pmsg" hidden></p>` : ''}</div>`;
  }
  app.innerHTML = headHTML(d, co, title) + top + `<div class="doc-wrap" style="margin-top:14px">${docHTML(d, co)}</div>` + bottom + contactHTML(co) + sticky;
  $('#print').onclick = () => window.print();
  if ($('#pay')) $('#pay').onclick = () => payNow($('#pay'), $('#pmsg'));
  if ($('#approve')) wireApprove(est && docDeposit(d) > 0 && r.can_pay);
}

async function payNow(b, m) {
  b.disabled = true; b.textContent = 'Opening secure checkout…';
  const { data, error } = await sbc.functions.invoke('payments', { body: { action: 'checkout', token } });
  if (error || !data?.url) {
    let msg = "Card payment isn't available right now. Please try again later.";
    try { msg = (await error.context.json()).error || msg; } catch (e) {}
    m.hidden = false; m.textContent = msg; b.disabled = false; b.textContent = b.dataset.label || 'Pay by card';
    return;
  }
  location.href = data.url;
}

function wireApprove(thenPay) {
  const c = $('#sig'), hint = $('.sig-hint'), sticky = $('#sticky');
  let signed = false, drawing = false, ctx;
  const size = () => { const w = c.clientWidth, h = c.clientHeight, k = window.devicePixelRatio || 1; c.width = w * k; c.height = h * k; ctx = c.getContext('2d'); ctx.scale(k, k); ctx.lineWidth = 2.4; ctx.lineCap = ctx.lineJoin = 'round'; ctx.strokeStyle = '#10142B'; signed = false; hint.hidden = false; };
  size();
  const pt = (e) => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  c.addEventListener('pointerdown', (e) => { drawing = true; c.setPointerCapture(e.pointerId); const [x, y] = pt(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y + 0.1); ctx.stroke(); signed = true; hint.hidden = true; e.preventDefault(); });
  c.addEventListener('pointermove', (e) => { if (!drawing) return; const [x, y] = pt(e); ctx.lineTo(x, y); ctx.stroke(); e.preventDefault(); });
  c.addEventListener('pointerup', () => { drawing = false; });
  c.addEventListener('pointercancel', () => { drawing = false; });
  $('#sig-clear').onclick = size;
  if (sticky) {
    $('#to-approve').onclick = () => { $('#respond').scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => $('#who').focus({ preventScroll: true }), 400); };
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { sticky.classList.toggle('gone', es.some((x) => x.isIntersecting)); }).observe($('#respond'));
  }
  // A small PNG of the signature (white background removed), saved with the approval.
  const sigData = () => { const w = 600, h = Math.round((w * c.height) / c.width), o = document.createElement('canvas'); o.width = w; o.height = h; o.getContext('2d').drawImage(c, 0, 0, w, h); return o.toDataURL('image/png'); };
  const go = async (ok) => {
    const who = $('#who').value.trim(), m = $('#msg');
    if (ok && who.length < 2) { m.hidden = false; m.textContent = 'Type your name first.'; $('#who').focus(); return; }
    if (ok && !signed) { m.hidden = false; m.textContent = 'Sign in the box first.'; return; }
    document.querySelectorAll('#respond .btn').forEach((b) => (b.disabled = true));
    const args = { p_token: token, p_name: who, p_approve: ok };
    let res = await sbc.rpc('respond_shared_doc', ok ? { ...args, p_sig: sigData() } : args);
    // Before the signature update is in the database, approve without it.
    if (res.error && ok && /p_sig|function|schema cache/i.test(res.error.message || '')) res = await sbc.rpc('respond_shared_doc', args);
    if (res.error) { m.hidden = false; m.textContent = "That didn't go through. Check your connection and try again."; document.querySelectorAll('#respond .btn').forEach((b) => (b.disabled = false)); return; }
    render({ ...R, ...res.data, online: R.online, can_pay: R.can_pay });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (ok && thenPay && $('#pay')) payNow($('#pay'), $('#pmsg'));
  };
  $('#approve').onclick = () => go(true);
  $('#decline').onclick = () => { if (confirm('Decline this estimate?')) go(false); };
}
load();
