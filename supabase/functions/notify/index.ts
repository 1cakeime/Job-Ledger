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
    return json({ sent: await reminders(url) });
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
    const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#10142B">
      <img src="https://getblueboard.com/icons/logo-seal.png" width="56" height="56" alt="Blue Board" style="display:block;margin-bottom:16px">
      <h2 style="margin:0 0 8px;font-size:20px">${esc(title)}</h2><p style="font-size:16px;line-height:1.5;margin:0 0 20px">${esc(body)}</p>
      <a href="${link}" style="display:inline-block;background:#2D5BFF;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px">Open Blue Board</a>
      <p style="font-size:12px;color:#6b7280;margin-top:24px">You get these emails because you don't have the Blue Board iPhone app signed in. Install it to get phone notifications instead.</p></div>`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Blue Board <no-reply@getblueboard.com>', to, subject: title.slice(0, 120), html, text: `${title}\n\n${body}\n\n${link}` }),
    });
    if (!r.ok) console.error('Resend', r.status, await r.text().catch(() => ''));
  }
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
