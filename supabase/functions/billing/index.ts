// Supabase Edge Function "billing": Blue Board's own subscription plans, paid by the contractor through
// Stripe Checkout. (Not the same as "payments", which lets contractors take card payments from customers.)
//
// Deploy with "Verify JWT" turned OFF (Stripe's webhook isn't signed in). Owner actions check the
// signed-in user in code below.
//
// Secrets (Edge Functions -> Secrets):
//   STRIPE_SECRET_KEY               Blue Board's Stripe secret key (shared with "payments")
//   STRIPE_BILLING_WEBHOOK_SECRET   signing secret of the webhook pointing at this function (whsec_...)
//                                   Events: customer.subscription.created, .updated, .deleted
// Prices are created in Stripe automatically on first use (lookup keys bb_solo_monthly, etc.).
//
// Requests (POST JSON, owner signed in):
//   { action: 'checkout', plan }   returns { url } of a Stripe Checkout page to start a subscription
//   { action: 'change', plan }     switches an existing subscription to another plan (prorated)
//   { action: 'portal' }           returns { url } of Stripe's page to update the card, see invoices or cancel
//   { action: 'sync' }             re-reads the subscription from Stripe and returns the saved row
//   Stripe webhook (has a stripe-signature header): keeps public.subscriptions up to date
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SITE = 'https://getblueboard.com/';
const PLANS: Record<string, { name: string; cents: number }> = {
  solo: { name: 'Blue Board Solo', cents: 2900 },
  crew: { name: 'Blue Board Crew', cents: 5900 },
  company: { name: 'Blue Board Company', cents: 11900 },
};
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function stripe(path: string, params: Record<string, string | number | boolean> = {}, method = 'POST') {
  const headers: Record<string, string> = { Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}` };
  const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const r = await fetch(`https://api.stripe.com/v1/${path}${method === 'GET' && body.toString() ? '?' + body : ''}`, {
    method, headers, body: method === 'POST' ? body : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Stripe error ${r.status}`);
  return data;
}

// The monthly price for a plan, created in Stripe the first time it's needed.
async function priceFor(plan: string) {
  const key = `bb_${plan}_monthly`;
  const found = await stripe('prices', { 'lookup_keys[]': key, active: true, limit: 1 }, 'GET');
  if (found.data?.[0]) return found.data[0].id as string;
  const p = PLANS[plan];
  const price = await stripe('prices', {
    currency: 'usd', unit_amount: p.cents, 'recurring[interval]': 'month', lookup_key: key,
    'product_data[name]': p.name, 'metadata[plan]': plan,
  });
  return price.id as string;
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

const planOf = (sub: any) => {
  const price = sub?.items?.data?.[0]?.price;
  const k = price?.lookup_key?.match(/^bb_(\w+)_monthly$/)?.[1] || price?.metadata?.plan || sub?.metadata?.plan;
  return PLANS[k] ? k : null;
};
const iso = (t?: number) => (t ? new Date(t * 1000).toISOString() : null);

// Save a Stripe subscription onto the company's row.
async function saveSub(sub: any, companyId?: string) {
  const db = admin();
  let id = companyId || sub.metadata?.company_id;
  if (!id) {
    const { data } = await db.from('subscriptions').select('company_id').eq('stripe_customer_id', sub.customer).maybeSingle();
    id = data?.company_id;
  }
  if (!id) return null;
  const row = {
    company_id: id,
    plan: planOf(sub),
    status: sub.status,
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    current_period_end: iso(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end),
    cancel_at_period_end: !!sub.cancel_at_period_end || !!sub.cancel_at,
    updated_at: new Date().toISOString(),
  };
  const { data } = await db.from('subscriptions').upsert(row).select('*').maybeSingle();
  return data;
}

async function verifyStripe(raw: string, header: string) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]).filter((p) => p.length === 2 && p[0] !== 'v1'));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(Deno.env.get('STRIPE_BILLING_WEBHOOK_SECRET') ?? ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

async function webhook(req: Request) {
  const raw = await req.text();
  if (!(await verifyStripe(raw, req.headers.get('stripe-signature') ?? ''))) return json({ error: 'Bad signature' }, 400);
  const ev = JSON.parse(raw);
  if (ev.type?.startsWith('customer.subscription.')) {
    // Re-read so out-of-order events can't save an older state.
    const sub = await stripe(`subscriptions/${ev.data.object.id}`, {}, 'GET').catch(() => ev.data.object);
    await saveSub(sub);
  }
  return json({ received: true });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!Deno.env.get('STRIPE_SECRET_KEY')) return json({ error: 'Billing is not set up yet' }, 503);
  if (req.headers.get('stripe-signature')) return webhook(req);

  const body = await req.json().catch(() => ({}));
  try {
    const owner = await ownerCompany(req);
    if (!owner) return json({ error: 'Sign in as the business owner first' }, 401);
    const db = admin();
    let { data: row } = await db.from('subscriptions').select('*').eq('company_id', owner.company_id).maybeSingle();
    if (!row) {
      ({ data: row } = await db.from('subscriptions').insert({ company_id: owner.company_id }).select('*').maybeSingle());
    }
    const plan = String(body.plan || '');
    const live = row?.stripe_subscription_id && !['canceled', 'incomplete_expired'].includes(row.status);

    async function customer() {
      if (row?.stripe_customer_id) return row.stripe_customer_id as string;
      const { data: co } = await db.from('companies').select('name').eq('id', owner!.company_id).maybeSingle();
      const c = await stripe('customers', { email: owner!.user.email ?? '', name: co?.name || '', 'metadata[company_id]': owner!.company_id });
      await db.from('subscriptions').update({ stripe_customer_id: c.id, updated_at: new Date().toISOString() }).eq('company_id', owner!.company_id);
      return c.id as string;
    }

    if (body.action === 'checkout') {
      if (!PLANS[plan]) return json({ error: 'Pick a plan' }, 400);
      if (live) return json({ error: 'You already have a plan. Switch plans instead.' }, 409);
      const params: Record<string, string | number> = {
        mode: 'subscription',
        customer: await customer(),
        client_reference_id: owner.company_id,
        'line_items[0][price]': await priceFor(plan),
        'line_items[0][quantity]': 1,
        'subscription_data[metadata][company_id]': owner.company_id,
        'subscription_data[metadata][plan]': plan,
        allow_promotion_codes: 'true',
        success_url: `${SITE}#/plan/done`,
        cancel_url: `${SITE}#/plan`,
      };
      // Keep the rest of the free trial: billing starts when it would have ended (Stripe needs 2+ days).
      const trialEnd = row?.trial_ends ? Math.floor(new Date(row.trial_ends).getTime() / 1000) : 0;
      if (trialEnd - Date.now() / 1000 > 2 * 86400 + 600) params['subscription_data[trial_end]'] = trialEnd;
      const s = await stripe('checkout/sessions', params);
      return json({ url: s.url });
    }

    if (body.action === 'change') {
      if (!PLANS[plan]) return json({ error: 'Pick a plan' }, 400);
      if (!live) return json({ error: 'Choose a plan first' }, 409);
      const sub = await stripe(`subscriptions/${row.stripe_subscription_id}`, {}, 'GET');
      const updated = await stripe(`subscriptions/${sub.id}`, {
        'items[0][id]': sub.items.data[0].id,
        'items[0][price]': await priceFor(plan),
        'metadata[plan]': plan,
        proration_behavior: 'create_prorations',
        cancel_at_period_end: 'false',
      });
      return json({ sub: await saveSub(updated, owner.company_id) });
    }

    if (body.action === 'portal') {
      if (!row?.stripe_customer_id) return json({ error: 'Choose a plan first' }, 409);
      const s = await stripe('billing_portal/sessions', { customer: row.stripe_customer_id, return_url: `${SITE}#/plan/done` });
      return json({ url: s.url });
    }

    if (body.action === 'sync') {
      if (!row?.stripe_customer_id) return json({ sub: row });
      const list = await stripe('subscriptions', { customer: row.stripe_customer_id, status: 'all', limit: 1 }, 'GET');
      return json({ sub: list.data?.[0] ? await saveSub(list.data[0], owner.company_id) : row });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
