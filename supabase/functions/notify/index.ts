// Supabase Edge Function "notify": sends Apple push notifications to people in the caller's company.
//   Owner  -> can notify crew members (employee_ids) of their own company.
//   Crew   -> can notify the company owner only.
//   Customer page (no sign-in) -> { portal_token, item_id } tells the owner the customer made a pick.
//     Only sends for a pick saved in the last 10 minutes that hasn't been announced yet.
// Deploy with Verify JWT OFF: customers call it with the publishable key, which isn't a JWT.
// The signed-in path checks the user itself with auth.getUser().
// Secrets to set in Supabase (Edge Functions -> Secrets):
//   APNS_KEY     the full text of the .p8 key file from Apple (including the BEGIN/END lines)
//   APNS_KEY_ID  the key's 10-character Key ID
//   APNS_TEAM_ID your Apple Developer Team ID
//   RESEND_API_KEY  (optional) emails the owner when they have no iPhone app to push to, for
//                   requests sent with { email: true } and customer picks
//   CRON_SECRET     (optional) lets the scheduled job call { action: 'reminders' } with an x-cron-key
//                   header: "Still on the clock?" pushes an hour after a shift's scheduled end
//                   (or 10 hours after clock-in when nothing was scheduled). See schema.sql.
//                   The same run emails customers (RESEND_API_KEY): a pick due within 2 days, and an
//                   invoice 1, 7 and 14 days overdue. Once each (customer_reminders), 9am-6pm their time,
//                   unless the contractor turned customer reminders off in Settings.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const TOPIC = 'com.blueboardapp.ios';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let cached: { jwt: string; at: number } | null = null;
async function apnsJwt(): Promise<string> {
  if (cached && Date.now() - cached.at < 40 * 60 * 1000) return cached.jwt; // Apple wants a new token at most every 20–60 min
  const pem = Deno.env.get('APNS_KEY') ?? '';
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: Deno.env.get('APNS_KEY_ID') })));
  const body = b64url(enc.encode(JSON.stringify({ iss: Deno.env.get('APNS_TEAM_ID'), iat: Math.floor(Date.now() / 1000) })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  cached = { jwt: `${head}.${body}.${b64url(sig)}`, at: Date.now() };
  return cached.jwt;
}

// Try the App Store/TestFlight server first, then the sandbox one used by builds installed from Xcode.
async function sendOne(token: string, payload: unknown): Promise<'ok' | 'gone' | 'fail'> {
  const jwt = await apnsJwt();
  for (const host of ['api.push.apple.com', 'api.sandbox.push.apple.com']) {
    const r = await fetch(`https://${host}/3/device/${token}`, {
      method: 'POST',
      headers: { authorization: `bearer ${jwt}`, 'apns-topic': TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10' },
      body: JSON.stringify(payload),
    });
    if (r.ok) return 'ok';
    const reason = (await r.json().catch(() => ({})))?.reason;
    if (reason === 'BadDeviceToken') continue; // token belongs to the other environment
    if (r.status === 410 || reason === 'Unregistered') return 'gone';
    console.error('APNs', host, r.status, reason);
    return 'fail';
  }
  return 'gone';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const input = await req.json().catch(() => ({}));
  const cronKey = Deno.env.get('CRON_SECRET');
  if (input.action === 'reminders') {
    if (!cronKey || req.headers.get('x-cron-key') !== cronKey) return json({ error: 'Not allowed' }, 403);
    const sent = await reminders(url);
    const emailed = await customerReminders(url).catch((e) => { console.error('customer reminders', e); return 0; });
    return json({ sent, emailed });
  }
  if (typeof input.portal_token === 'string') return portalPick(url, input.portal_token, String(input.item_id ?? ''));
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await caller.auth.getUser();
  if (!user) return json({ error: 'Sign in first' }, 401);

  const { company_id, employee_ids, to, title, body, hash, email } = input;
  if (!company_id || typeof title !== 'string' || typeof body !== 'string') return json({ error: 'Missing fields' }, 400);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: members } = await admin.from('members').select('user_id, role, employee_id').eq('company_id', company_id);
  const me = (members ?? []).find((m) => m.user_id === user.id);
  if (!me) return json({ error: 'Not in this company' }, 403);

  let targets: string[] = [];
  if (me.role === 'owner' && Array.isArray(employee_ids)) {
    const want = new Set(employee_ids.map(String));
    targets = (members ?? []).filter((m) => m.role === 'employee' && want.has(m.employee_id)).map((m) => m.user_id);
  } else if (to === 'owner') {
    targets = (members ?? []).filter((m) => m.role === 'owner').map((m) => m.user_id);
  } else {
    return json({ error: 'Not allowed' }, 403);
  }
  targets = targets.filter((id) => id !== user.id);
  if (!targets.length) return json({ sent: 0 });

  const sent = await pushTo(admin, targets, title, body, hash);
  if (to === 'owner' && email === true) await emailIfNoApp(admin, targets, title, body, hash);
  return json({ sent });
});

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// Owners who only use the website get an email instead of a push (those with the app get the push).
// deno-lint-ignore no-explicit-any
async function emailIfNoApp(admin: any, userIds: string[], title: string, body: string, hash?: unknown) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return;
  const { data: tokens } = await admin.from('device_tokens').select('user_id').in('user_id', userIds);
  const hasApp = new Set((tokens ?? []).map((t: { user_id: string }) => t.user_id));
  const link = 'https://getblueboard.com/' + (typeof hash === 'string' && /^#\//.test(hash) ? hash : '');
  for (const id of userIds) {
    if (hasApp.has(id)) continue;
    const { data } = await admin.auth.admin.getUserById(id);
    const to = data?.user?.email;
    if (!to) continue;
    await sendEmail({ to, subject: title, title, body, link, button: 'Open Blue Board',
      foot: "You get these emails because you don't have the Blue Board iPhone app signed in. Install it to get phone notifications instead." });
  }
}

async function sendEmail(o: { to: string; subject: string; title: string; body: string; link: string; button: string; foot: string; fromName?: string; replyTo?: string; logo?: string }): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return false;
  const logo = /^https:\/\//.test(o.logo ?? '') ? o.logo! : 'https://getblueboard.com/icons/logo-seal.png';
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#10142B">
    <img src="${esc(logo)}" width="56" height="56" alt="" style="display:block;margin-bottom:16px;object-fit:contain">
    <h2 style="margin:0 0 8px;font-size:20px">${esc(o.title)}</h2><p style="font-size:16px;line-height:1.5;margin:0 0 20px;white-space:pre-line">${esc(o.body)}</p>
    <a href="${esc(o.link)}" style="display:inline-block;background:#2D5BFF;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px">${esc(o.button)}</a>
    <p style="font-size:12px;color:#6b7280;margin-top:24px">${esc(o.foot)}</p></div>`;
  const name = (o.fromName || 'Blue Board').replace(/[<>"\r\n]/g, '').slice(0, 60);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${name} <no-reply@getblueboard.com>`, to: o.to, subject: o.subject.slice(0, 120), html,
      text: `${o.title}\n\n${o.body}\n\n${o.link}`, ...(o.replyTo && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.replyTo) ? { reply_to: o.replyTo } : {}) }),
  });
  if (!r.ok) console.error('Resend', r.status, await r.text().catch(() => ''));
  return r.ok;
}

const okEmail = (e: unknown) => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const niceDay = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });

// Reminder emails to customers. Each key is claimed in customer_reminders first, so it goes out once.
async function customerReminders(url: string): Promise<number> {
  if (!Deno.env.get('RESEND_API_KEY')) return 0;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  // deno-lint-ignore no-explicit-any
  const settingsOf = new Map<string, any>();
  const settings = async (cid: string) => {
    if (!settingsOf.has(cid)) { const { data } = await admin.from('company_public').select('data').eq('company_id', cid).maybeSingle(); settingsOf.set(cid, data?.data?.settings ?? {}); }
    return settingsOf.get(cid);
  };
  // Today in the company's time zone, or null outside 9am-6pm there (or when reminders are off).
  const dayFor = async (cid: string) => {
    const st = await settings(cid);
    if (st.custRemind === false) return null;
    const tz = st.tz || 'America/New_York';
    try {
      const hour = +new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date());
      if (hour < 9 || hour >= 18) return null;
      return dayIn(new Date().toISOString(), tz);
    } catch (_) { return null; }
  };
  const claim = async (key: string, cid: string) => !(await admin.from('customer_reminders').insert({ key, company_id: cid })).error;
  const days = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
  let sent = 0;

  // Choices due within 2 days on a customer page.
  const { data: portals } = await admin.from('customer_portals').select('token, company_id, data').limit(2000);
  for (const p of portals ?? []) {
    // deno-lint-ignore no-explicit-any
    const d: any = p.data ?? {};
    if (!okEmail(d.email)) continue;
    // deno-lint-ignore no-explicit-any
    const picks = (d.items ?? []).filter((i: any) => i.kind === 'pick' && !i.locked && i.date);
    if (!picks.length) continue;
    const day = await dayFor(p.company_id);
    if (!day) continue;
    const { data: ch } = await admin.from('portal_choices').select('item_id').eq('token', p.token);
    const done = new Set((ch ?? []).map((c: { item_id: string }) => c.item_id));
    const due = [];
    for (const it of picks) {
      const left = days(day, it.date);
      if (done.has(it.id) || left < 0 || left > 2) continue;
      if (await claim(`pick:${p.token}:${it.id}`, p.company_id)) due.push(it);
    }
    if (!due.length) continue;
    const co = d.company ?? {}, who = co.company || 'Your contractor';
    // deno-lint-ignore no-explicit-any
    const list = due.map((i: any) => `• ${i.title}: needed by ${niceDay(i.date)}`).join('\n');
    if (await sendEmail({ to: d.email, fromName: who, replyTo: co.email, logo: co.logo, button: 'Make my choice',
      subject: due.length === 1 ? `Reminder: ${due[0].title} for ${d.jobName || 'your project'}` : `Reminder: ${due.length} choices for ${d.jobName || 'your project'}`,
      title: `${d.client ? d.client + ', w' : 'W'}e need ${due.length === 1 ? 'a choice' : due.length + ' choices'} from you`,
      body: `${list}\n\nPick on your project page so ${who} can keep things on schedule.`,
      link: `https://getblueboard.com/portal.html#${p.token}`, foot: `Sent for ${who} by Blue Board. Reply to this email to reach them.` })) sent++;
  }

  // Unpaid invoices: 1, 7 and 14 days after the due date.
  const { data: docs } = await admin.from('shared_docs').select('token, company_id, data').eq('kind', 'invoice').limit(2000);
  for (const r of docs ?? []) {
    // deno-lint-ignore no-explicit-any
    const d: any = r.data ?? {}, to = d.billTo?.email;
    if (!okEmail(to) || !d.due) continue;
    const day = await dayFor(r.company_id);
    if (!day) continue;
    // Only inside each window, so turning this on doesn't email about invoices that are months old.
    const late = days(d.due, day), stage = late > 20 ? 0 : late >= 14 ? 14 : late >= 7 ? 7 : late >= 1 ? 1 : 0;
    if (!stage) continue;
    // deno-lint-ignore no-explicit-any
    const sub = (d.items ?? []).reduce((t: number, i: any) => t + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
    const total = sub + Math.round(sub * (Number(d.taxRate) || 0)) / 100;
    const { data: online } = await admin.from('doc_payments').select('amount, stripe_session').eq('token', r.token);
    // deno-lint-ignore no-explicit-any
    const refs = new Set((d.payments ?? []).map((x: any) => x.ref).filter(Boolean));
    // deno-lint-ignore no-explicit-any
    const paid = (d.payments ?? []).reduce((t: number, x: any) => t + (Number(x.amount) || 0), 0)
      + (online ?? []).filter((x) => !refs.has(x.stripe_session)).reduce((t, x) => t + Number(x.amount), 0);
    const left = Math.round((total - paid) * 100) / 100;
    if (left < 0.5) continue;
    if (!(await claim(`inv:${r.token}:${stage}`, r.company_id))) continue;
    const co = d.company ?? {}, who = co.company || 'Your contractor';
    if (await sendEmail({ to, fromName: who, replyTo: co.email, logo: co.logo, button: 'View and pay',
      subject: `Reminder: invoice ${d.num} is past due`, title: `Invoice ${d.num}: ${money(left)} is past due`,
      body: `It was due ${niceDay(d.due)}${d.jobName ? ' for ' + d.jobName : ''}. If you've already paid, thank you, and you can ignore this.`,
      link: `https://getblueboard.com/doc.html#${r.token}`, foot: `Sent for ${who} by Blue Board. Reply to this email to reach them.` })) sent++;
  }
  return sent;
}

// The UTC time of a wall-clock date and time ("2026-11-19", "15:30") in a time zone.
function zonedToUtc(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const asZone = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return guess - (asZone - guess);
}
const dayIn = (iso: string, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

// "Still on the clock?": once per clock-in, an hour after the scheduled end (10 hours after clock-in if unscheduled).
async function reminders(url: string): Promise<number> {
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: open } = await admin.from('punches').select('id, company_id, user_id, employee_id, job_id, in_at')
    .is('out_at', null).is('reminded_at', null).lte('in_at', new Date(Date.now() - 30 * 60 * 1000).toISOString()).limit(500);
  if (!open?.length) return 0;
  const ids = [...new Set(open.map((p) => p.company_id))];
  const { data: pubs } = await admin.from('company_public').select('company_id, data').in('company_id', ids);
  // deno-lint-ignore no-explicit-any
  const pub = new Map((pubs ?? []).map((p: any) => [p.company_id, p.data ?? {}]));
  let sent = 0;
  for (const p of open) {
    // deno-lint-ignore no-explicit-any
    const data: any = pub.get(p.company_id) ?? {}, tz = data.settings?.tz;
    let due = new Date(p.in_at).getTime() + 10 * 3600 * 1000;
    if (tz) {
      try {
        const day = dayIn(p.in_at, tz);
        // deno-lint-ignore no-explicit-any
        const mine = (data.shifts ?? []).filter((s: any) => s.empId === p.employee_id && s.date === day && s.status !== 'missed' && s.end);
        // deno-lint-ignore no-explicit-any
        const sh = mine.find((s: any) => s.jobId === p.job_id) ?? mine[0];
        if (sh) {
          let end = zonedToUtc(day, sh.end, tz);
          if (sh.start && sh.end <= sh.start) end += 24 * 3600 * 1000;
          due = end + 3600 * 1000;
        }
      } catch (_) { /* bad time zone: keep the 10-hour rule */ }
    }
    if (Date.now() < due) continue;
    // Claim it first so a slow run can't send twice.
    const { data: claimed } = await admin.from('punches').update({ reminded_at: new Date().toISOString() }).eq('id', p.id).is('reminded_at', null).is('out_at', null).select('id').maybeSingle();
    if (!claimed) continue;
    // deno-lint-ignore no-explicit-any
    const jobName = (data.jobs ?? []).find((j: any) => j.id === p.job_id)?.name || 'the job';
    sent += await pushTo(admin, [p.user_id], 'Still on the clock?',
      `You're still clocked in at ${jobName}. Clock out if you're done, or send a time fix if you forgot.`, '#/schedule');
  }
  return sent;
}

// deno-lint-ignore no-explicit-any
async function pushTo(admin: any, userIds: string[], title: string, body: string, hash?: unknown): Promise<number> {
  const { data: tokens } = await admin.from('device_tokens').select('token').in('user_id', userIds);
  const payload = { aps: { alert: { title: title.slice(0, 120), body: body.slice(0, 600) }, sound: 'default' }, hash: typeof hash === 'string' ? hash.slice(0, 100) : undefined };
  let sent = 0;
  for (const { token } of tokens ?? []) {
    const r = await sendOne(token, payload);
    if (r === 'ok') sent++;
    if (r === 'gone') await admin.from('device_tokens').delete().eq('token', token);
  }
  return sent;
}

// A customer made a pick on their customer page. Claim the row (notified_at) so each pick alerts once.
async function portalPick(url: string, token: string, itemId: string): Promise<Response> {
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: pick } = await admin.from('portal_choices').update({ notified_at: new Date().toISOString() })
    .eq('token', token).eq('item_id', itemId).is('notified_at', null).gte('decided_at', since)
    .select('company_id, label, note, name').maybeSingle();
  if (!pick) return json({ sent: 0 });
  const { data: portal } = await admin.from('customer_portals').select('job_id, data').eq('token', token).maybeSingle();
  // deno-lint-ignore no-explicit-any
  const item = (portal?.data?.items ?? []).find((i: any) => i.id === itemId);
  const { data: owners } = await admin.from('members').select('user_id').eq('company_id', pick.company_id).eq('role', 'owner');
  const who = pick.name || portal?.data?.client || 'Your customer';
  const what = pick.label || pick.note;
  const sent = await pushTo(admin, (owners ?? []).map((o: { user_id: string }) => o.user_id),
    'Customer decision', `${who} picked ${what}${item?.title ? ' for ' + item.title : ''}`, portal ? '#/job/' + portal.job_id : undefined);
  await emailIfNoApp(admin, (owners ?? []).map((o: { user_id: string }) => o.user_id), 'Customer decision',
    `${who} picked ${what}${item?.title ? ' for ' + item.title : ''}`, portal ? '#/job/' + portal.job_id : undefined);
  return json({ sent });
}
