// Supabase Edge Function "join": creates a crew member's account from an invite code, already
// email-confirmed, so employees can sign up and get straight in. Owners still confirm their email
// through the normal sign-up (the project-wide "Confirm email" setting stays on).
//
// Deploy with "Verify JWT" turned OFF (the employee isn't signed in yet). The invite code is the
// proof: it must exist and be unused, and it's claimed for the new account right away.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Request (POST JSON): { code, email, password }
// Response: { ok: true } then the app signs in with the same email and password and
// accept_invite() finishes joining the crew. Errors: 400 { error } with a message to show.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (error: string) => json({ error }, 400);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST');
  let body: { code?: string; email?: string; password?: string };
  try { body = await req.json(); } catch { return fail('Bad request'); }
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!code) return fail('Missing invite code');
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email.');
  if (password.length < 6) return fail('Use a password of at least 6 characters.');

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: inv, error: invErr } = await db.from('invites').select('code, used_by').eq('code', code).maybeSingle();
  if (invErr) return fail('Something went wrong. Try again.');
  if (!inv) return fail('That invite code was not found. Check it with your boss.');
  if (inv.used_by) return fail('That invite code was already used. Ask your boss for a new one.');

  const { data: created, error: userErr } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (userErr || !created?.user) {
    if (/already|registered|exists/i.test(userErr?.message || '')) {
      return fail('There\'s already an account with that email. Tap Sign in instead.');
    }
    return fail(userErr?.message || 'Couldn\'t create the account. Try again.');
  }
  const uid = created.user.id;

  // Claim the code for this account. If someone else claimed it a moment ago, undo the new account.
  const { data: claimed } = await db.from('invites').update({ used_by: uid, used_at: new Date().toISOString() })
    .eq('code', code).is('used_by', null).select('code');
  if (!claimed?.length) {
    await db.auth.admin.deleteUser(uid);
    return fail('That invite code was already used. Ask your boss for a new one.');
  }
  return json({ ok: true });
});
