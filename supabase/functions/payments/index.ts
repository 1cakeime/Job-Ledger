// Supabase Edge Function "payments": card payments on invoices through Stripe Connect.
// Each company connects its own Stripe account; customers pay that company directly.
//
// Deploy with "Verify JWT" turned OFF (customers paying an invoice aren't signed in, and Stripe's
// webhook isn't either). Owner actions check the signed-in user in code below.
//
// Secrets (Edge Functions -> Secrets):
//   STRIPE_SECRET_KEY      your platform's secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET  signing secret of the Connect webhook pointing at this function (whsec_...)
//                          ("Connected accounts" scope: checkout.session.completed, checkout.session.async_payment_succeeded, account.updated)
// Connected accounts are created with Stripe Accounts v2 (required for new platforms), full Stripe dashboard,
// Stripe collects fees and covers losses, no platform fee.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Requests (POST JSON):
//   { action: 'connect' }            owner: returns { url } to set up or finish their Stripe account
//   { action: 'status' }             owner: refreshes and returns { connected, charges_enabled }
//   { action: 'checkout', token }    anyone with an invoice link (or an approved estimate with a deposit):
//                                    returns { url } of a Stripe Checkout page
//   Stripe webhook (has a stripe-signature header): records payments and account status
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SITE = 'https://getblueboard.com/';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Minimal Stripe REST client (form-encoded), optionally acting on a connected account.
async function stripe(path: string, params: Record<string, string | number> = {}, account?: string, method = 'POST') {
  const headers: Record<string, string> = { Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}` };
  if (account) headers['Stripe-Account'] = account;
  const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const r = await fetch(`https://api.stripe.com/v1/${path}${method === 'GET' && body.toString() ? '?' + body : ''}`, {
    method, headers, body: method === 'POST' ? body : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Stripe error ${r.status}`);
  return data;
}

// Stripe Accounts v2 (JSON). New Connect platforms must create connected accounts this way;
// the v2 account id (acct_...) still works with the v1 calls above (Checkout via Stripe-Account).
const STRIPE_V2_VERSION = '2026-11-18.endive';
async function stripeV2(path: string, body?: unknown, method = 'POST') {
  const r = await fetch(`https://api.stripe.com/v2/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`,
      'Stripe-Version': STRIPE_V2_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `Stripe error ${r.status}`);
  return data;
}
// Card payments are on when the merchant configuration's card_payments capability is active.
async function accountStatus(id: string) {
  const a = await stripeV2(`core/accounts/${id}?include[0]=configuration.merchant&include[1]=requirements`, undefined, 'GET');
  const charges = a?.configuration?.merchant?.capabilities?.card_payments?.status === 'active';
  const due = (a?.requirements?.entries ?? []).some((e: any) => ['currently_due', 'past_due'].includes(e?.minimum_deadline?.status));
  return { charges_enabled: charges, details_submitted: charges || (!!a?.requirements && !due) };
}

async function ownerCompany(req: Request) {
  const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await caller.auth.getUser();
  if (!user) return null;
  const { data } = await admin().from('members').select('company_id').eq('user_id', user.id).eq('role', 'owner').maybeSingle();
  return data ? { user, company_id: data.company_id as string } : null;
}

const cents = (n: number) => Math.round(n * 100);
function balanceOf(doc: any, online: { amount: number; stripe_session: string }[]) {
  const sub = (doc.items || []).reduce((t: number, i: any) => t + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
  const tax = Math.round(sub * (Number(doc.taxRate) || 0)) / 100;
  const refs = new Set((doc.payments || []).map((p: any) => p.ref).filter(Boolean));
  const paid = (doc.payments || []).reduce((t: number, p: any) => t + (Number(p.amount) || 0), 0)
    + online.filter((p) => !refs.has(p.stripe_session)).reduce((t, p) => t + Number(p.amount), 0);
  return Math.round((sub + tax - paid) * 100) / 100;
}

async function verifyStripe(raw: string, header: string) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]).filter((p) => p.length === 2 && p[0] !== 'v1'));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

async function webhook(req: Request) {
  const raw = await req.text();
  if (!(await verifyStripe(raw, req.headers.get('stripe-signature') ?? ''))) return json({ error: 'Bad signature' }, 400);
  const ev = JSON.parse(raw);
  const db = admin();
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
    const s = ev.data.object;
    const token = s.metadata?.token;
    if (token && s.payment_status === 'paid') {
      const { data: doc } = await db.from('shared_docs').select('company_id').eq('token', token).maybeSingle();
      if (doc) await db.from('doc_payments').upsert({ token, company_id: doc.company_id, amount: (s.amount_total || 0) / 100, method: 'Card (online)', stripe_session: s.id, paid_at: new Date((s.created || Date.now() / 1000) * 1000).toISOString() }, { onConflict: 'stripe_session', ignoreDuplicates: true });
    }
  } else if (ev.type === 'account.updated') {
    // Re-read through v2 so the result matches the "status" action.
    const id = ev.account || ev.data?.object?.id;
    if (id) await db.from('company_billing').update({ ...(await accountStatus(id)), updated_at: new Date().toISOString() }).eq('stripe_account_id', id);
  }
  return json({ received: true });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!Deno.env.get('STRIPE_SECRET_KEY')) return json({ error: 'Card payments are not set up yet' }, 503);
  if (req.headers.get('stripe-signature')) return webhook(req);

  const body = await req.json().catch(() => ({}));
  const db = admin();
  try {
    if (body.action === 'checkout') {
      const token = String(body.token || '').replace(/[^a-f0-9]/gi, '');
      const { data: doc } = await db.from('shared_docs').select('token, company_id, kind, data, status').eq('token', token).maybeSingle();
      // Invoices are paid in full; an approved estimate can take its deposit (data.deposit = percent of the total).
      const deposit = doc?.kind === 'estimate' && doc.status === 'approved' && Number(doc.data?.deposit) > 0;
      if (!doc || (doc.kind !== 'invoice' && !deposit)) return json({ error: 'Invoice not found' }, 404);
      const { data: bill } = await db.from('company_billing').select('stripe_account_id, charges_enabled').eq('company_id', doc.company_id).maybeSingle();
      if (!bill?.stripe_account_id || !bill.charges_enabled) return json({ error: 'This business does not take card payments yet' }, 409);
      const { data: online } = await db.from('doc_payments').select('amount, stripe_session').eq('token', token);
      const balance = balanceOf(doc.data, online ?? []);
      const total = balanceOf({ ...doc.data, payments: [] }, []);
      const due = deposit ? Math.round((Math.round(total * Number(doc.data.deposit)) / 100 - (total - balance)) * 100) / 100 : balance;
      if (due < 0.5) return json({ error: deposit ? 'The deposit is already paid' : 'This invoice is already paid' }, 409);
      const name = (deposit ? `Deposit · Estimate ${doc.data.num}` : `Invoice ${doc.data.num}`) + (doc.data.company?.company ? ` · ${doc.data.company.company}` : '');
      const s = await stripe('checkout/sessions', {
        mode: 'payment',
        'line_items[0][quantity]': 1,
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': cents(due),
        'line_items[0][price_data][product_data][name]': name.slice(0, 250),
        'metadata[token]': token,
        'payment_intent_data[metadata][token]': token,
        success_url: `${SITE}doc.html?paid=1#${token}`,
        cancel_url: `${SITE}doc.html#${token}`,
      }, bill.stripe_account_id);
      return json({ url: s.url });
    }

    const owner = await ownerCompany(req);
    if (!owner) return json({ error: 'Sign in as the business owner first' }, 401);
    let { data: bill } = await db.from('company_billing').select('*').eq('company_id', owner.company_id).maybeSingle();

    if (body.action === 'connect') {
      if (!bill?.stripe_account_id) {
        const acct = await stripeV2('core/accounts', {
          contact_email: owner.user.email ?? undefined,
          identity: { country: 'US' },
          dashboard: 'full',
          defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
          configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
          metadata: { company_id: owner.company_id },
        });
        await db.from('company_billing').upsert({ company_id: owner.company_id, stripe_account_id: acct.id, charges_enabled: false, details_submitted: false, updated_at: new Date().toISOString() });
        bill = { stripe_account_id: acct.id };
      }
      const link = await stripeV2('core/account_links', {
        account: bill!.stripe_account_id,
        use_case: { type: 'account_onboarding', account_onboarding: { refresh_url: `${SITE}#/settings`, return_url: `${SITE}#/settings` } },
      });
      return json({ url: link.url });
    }
    if (body.action === 'status') {
      if (!bill?.stripe_account_id) return json({ connected: false, charges_enabled: false });
      const st = await accountStatus(bill.stripe_account_id);
      await db.from('company_billing').update({ ...st, updated_at: new Date().toISOString() }).eq('company_id', owner.company_id);
      return json({ connected: true, ...st });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
