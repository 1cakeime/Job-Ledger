// Supabase Edge Function "notify": sends Apple push notifications to people in the caller's company.
//   Owner  -> can notify crew members (employee_ids) of their own company.
//   Crew   -> can notify the company owner only.
// Secrets to set in Supabase (Edge Functions -> Secrets):
//   APNS_KEY     the full text of the .p8 key file from Apple (including the BEGIN/END lines)
//   APNS_KEY_ID  the key's 10-character Key ID
//   APNS_TEAM_ID your Apple Developer Team ID
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
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await caller.auth.getUser();
  if (!user) return json({ error: 'Sign in first' }, 401);

  const { company_id, employee_ids, to, title, body, hash } = await req.json().catch(() => ({}));
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

  const { data: tokens } = await admin.from('device_tokens').select('token').in('user_id', targets);
  const payload = { aps: { alert: { title: title.slice(0, 120), body: body.slice(0, 600) }, sound: 'default' }, hash: typeof hash === 'string' ? hash.slice(0, 100) : undefined };
  let sent = 0;
  for (const { token } of tokens ?? []) {
    const r = await sendOne(token, payload);
    if (r === 'ok') sent++;
    if (r === 'gone') await admin.from('device_tokens').delete().eq('token', token);
  }
  return json({ sent });
});
