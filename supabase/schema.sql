-- Contractor Mainframe: database setup for Supabase.
-- Paste this whole file into Supabase -> SQL Editor -> New query, then click Run.
-- Safe to run again: it only creates what is missing and replaces functions/policies.

-- ============ Tables ============
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null default '',
  created_at timestamptz not null default now()
);

-- Who belongs to which company. role = 'owner' or 'employee'.
-- employee_id links an employee login to the crew member record in the app.
create table if not exists public.members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','employee')),
  employee_id text,
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create unique index if not exists members_one_login_per_employee on public.members(company_id, employee_id) where employee_id is not null;

-- The owner's full app data (jobs, prices, expenses, estimates, payroll). Owner only.
create table if not exists public.company_state (
  company_id uuid primary key references public.companies(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- What employees may see: branding, job names/addresses, crew names, the schedule. No money.
create table if not exists public.company_public (
  company_id uuid primary key references public.companies(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Each employee's own pay rate. The owner sees all; an employee sees only their own.
create table if not exists public.employee_private (
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id text not null,
  rate numeric not null default 0,
  primary key (company_id, employee_id)
);

-- Invite codes the owner gives to employees.
create table if not exists public.invites (
  code text primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id text not null,
  created_at timestamptz not null default now(),
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz
);

-- Clock in / clock out. Times are set by the server, never by the phone.
create table if not exists public.punches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id text not null,
  job_id text not null,
  in_at timestamptz not null default now(),
  in_lat double precision, in_lng double precision, in_acc double precision,
  out_at timestamptz,
  out_lat double precision, out_lng double precision, out_acc double precision,
  note text
);
create index if not exists punches_company_in on public.punches(company_id, in_at desc);
create unique index if not exists punches_one_open_per_user on public.punches(user_id) where out_at is null;

-- ============ Helper checks (used by the security rules) ============
create or replace function public.is_member(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where company_id = cid and user_id = auth.uid());
$$;
create or replace function public.is_owner(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where company_id = cid and user_id = auth.uid() and role = 'owner');
$$;
create or replace function public.my_employee_id(cid uuid) returns text
language sql stable security definer set search_path = public as $$
  select employee_id from members where company_id = cid and user_id = auth.uid() and role = 'employee';
$$;

-- ============ Security rules (row level security) ============
alter table public.companies enable row level security;
alter table public.members enable row level security;
alter table public.company_state enable row level security;
alter table public.company_public enable row level security;
alter table public.employee_private enable row level security;
alter table public.invites enable row level security;
alter table public.punches enable row level security;

drop policy if exists companies_read on public.companies;
create policy companies_read on public.companies for select using (public.is_member(id));
drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies for update using (public.is_owner(id)) with check (public.is_owner(id));
drop policy if exists companies_delete on public.companies;
create policy companies_delete on public.companies for delete using (owner = auth.uid());

drop policy if exists members_read on public.members;
create policy members_read on public.members for select using (user_id = auth.uid() or public.is_owner(company_id));
drop policy if exists members_remove on public.members;
create policy members_remove on public.members for delete using (public.is_owner(company_id) and role = 'employee');

drop policy if exists state_owner on public.company_state;
create policy state_owner on public.company_state for all using (public.is_owner(company_id)) with check (public.is_owner(company_id));

drop policy if exists public_read on public.company_public;
create policy public_read on public.company_public for select using (public.is_member(company_id));
drop policy if exists public_write on public.company_public;
create policy public_write on public.company_public for all using (public.is_owner(company_id)) with check (public.is_owner(company_id));

drop policy if exists pay_read on public.employee_private;
create policy pay_read on public.employee_private for select using (public.is_owner(company_id) or employee_id = public.my_employee_id(company_id));
drop policy if exists pay_write on public.employee_private;
create policy pay_write on public.employee_private for all using (public.is_owner(company_id)) with check (public.is_owner(company_id));

drop policy if exists invites_owner on public.invites;
create policy invites_owner on public.invites for all using (public.is_owner(company_id)) with check (public.is_owner(company_id));

drop policy if exists punches_read on public.punches;
create policy punches_read on public.punches for select using (user_id = auth.uid() or public.is_owner(company_id));
drop policy if exists punches_owner_edit on public.punches;
create policy punches_owner_edit on public.punches for update using (public.is_owner(company_id)) with check (public.is_owner(company_id));
drop policy if exists punches_owner_delete on public.punches;
create policy punches_owner_delete on public.punches for delete using (public.is_owner(company_id));
-- No insert policy: employees clock in/out only through the functions below.

-- ============ Actions ============
create or replace function public.create_company(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id into cid from companies where owner = auth.uid() limit 1;
  if cid is null then
    insert into companies(owner, name) values (auth.uid(), coalesce(p_name, '')) returning id into cid;
    insert into members(company_id, user_id, role) values (cid, auth.uid(), 'owner');
  end if;
  return cid;
end $$;

create or replace function public.accept_invite(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv invites%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into inv from invites where code = upper(trim(p_code)) for update;
  if not found then raise exception 'That invite code was not found'; end if;
  if inv.used_by is not null and inv.used_by <> auth.uid() then raise exception 'That invite code was already used'; end if;
  if exists (select 1 from members where company_id = inv.company_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'You own this company, so you cannot join it as an employee';
  end if;
  delete from members where company_id = inv.company_id and employee_id = inv.employee_id and user_id <> auth.uid();
  insert into members(company_id, user_id, role, employee_id) values (inv.company_id, auth.uid(), 'employee', inv.employee_id)
    on conflict (company_id, user_id) do update set role = 'employee', employee_id = excluded.employee_id;
  update invites set used_by = auth.uid(), used_at = now() where code = inv.code;
  return inv.company_id;
end $$;

create or replace function public.clock_in(p_company uuid, p_job text, p_lat double precision, p_lng double precision, p_acc double precision)
returns public.punches language plpgsql security definer set search_path = public as $$
declare emp text; r punches;
begin
  emp := public.my_employee_id(p_company);
  if emp is null then raise exception 'You are not on this company''s crew'; end if;
  if exists (select 1 from punches where user_id = auth.uid() and out_at is null) then raise exception 'You are already clocked in'; end if;
  insert into punches(company_id, user_id, employee_id, job_id, in_lat, in_lng, in_acc)
    values (p_company, auth.uid(), emp, p_job, p_lat, p_lng, p_acc) returning * into r;
  return r;
end $$;

create or replace function public.clock_out(p_lat double precision, p_lng double precision, p_acc double precision, p_note text)
returns public.punches language plpgsql security definer set search_path = public as $$
declare r punches;
begin
  update punches set out_at = now(), out_lat = p_lat, out_lng = p_lng, out_acc = p_acc, note = nullif(trim(coalesce(p_note, '')), '')
    where user_id = auth.uid() and out_at is null returning * into r;
  if r.id is null then raise exception 'You are not clocked in'; end if;
  return r;
end $$;

revoke all on function public.create_company(text) from public, anon;
revoke all on function public.accept_invite(text) from public, anon;
revoke all on function public.clock_in(uuid, text, double precision, double precision, double precision) from public, anon;
revoke all on function public.clock_out(double precision, double precision, double precision, text) from public, anon;
grant execute on function public.create_company(text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.clock_in(uuid, text, double precision, double precision, double precision) to authenticated;
grant execute on function public.clock_out(double precision, double precision, double precision, text) to authenticated;

-- ============ Photo storage (owner only) ============
insert into storage.buckets (id, name, public) values ('photos', 'photos', false) on conflict (id) do nothing;
drop policy if exists photos_owner_all on storage.objects;
create policy photos_owner_all on storage.objects for all to authenticated
  using (bucket_id = 'photos' and public.is_owner(((storage.foldername(name))[1])::uuid))
  with check (bucket_id = 'photos' and public.is_owner(((storage.foldername(name))[1])::uuid));

-- ============ Delete account (required by the App Store) ============
-- Deletes the signed-in login. Everything tied to it is removed by "on delete cascade":
-- an owner's company (jobs, crew, invites, punches, members) or an employee's membership and punches.
-- The app calls this with p_confirm = false first (a check that changes nothing), removes the
-- owner's photo files from storage, then calls it with p_confirm = true.
create or replace function public.delete_my_account(p_confirm boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if p_confirm then delete from auth.users where id = auth.uid(); end if;
end $$;
revoke all on function public.delete_my_account(boolean) from public, anon;
grant execute on function public.delete_my_account(boolean) to authenticated;

-- ============ Card payments (Stripe Connect) ============
-- Written only by the "payments" Edge Function (service role). Owners can read their own rows.
create table if not exists public.company_billing (
  company_id uuid primary key references public.companies(id) on delete cascade,
  stripe_account_id text unique,
  charges_enabled boolean not null default false,
  details_submitted boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.company_billing enable row level security;
drop policy if exists billing_owner_read on public.company_billing;
create policy billing_owner_read on public.company_billing for select using (public.is_owner(company_id));

create table if not exists public.doc_payments (
  id uuid primary key default gen_random_uuid(),
  token text not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  amount numeric not null,
  method text not null default 'Card (online)',
  stripe_session text unique,
  paid_at timestamptz not null default now()
);
create index if not exists doc_payments_company on public.doc_payments(company_id);
alter table public.doc_payments enable row level security;
drop policy if exists doc_payments_owner_read on public.doc_payments;
create policy doc_payments_owner_read on public.doc_payments for select using (public.is_owner(company_id));

-- ============ Estimates & invoices: customer links ============
-- The owner shares a snapshot of an estimate or invoice. Customers open it with a long random token
-- (no account) through the two functions below; nobody can list or browse this table.
create table if not exists public.shared_docs (
  token text primary key check (length(token) >= 32),
  company_id uuid not null references public.companies(id) on delete cascade,
  doc_id text not null,
  kind text not null check (kind in ('estimate','invoice','photos')),
  data jsonb not null,
  status text not null default 'sent' check (status in ('sent','approved','declined')),
  approved_name text,
  approved_at timestamptz,
  viewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 'photos' = a customer photo link (gallery of signed photo URLs). Added 2026-11-17; this keeps older databases in step.
alter table public.shared_docs drop constraint if exists shared_docs_kind_check;
alter table public.shared_docs add constraint shared_docs_kind_check check (kind in ('estimate','invoice','photos'));
alter table public.shared_docs enable row level security;
drop policy if exists shared_docs_owner on public.shared_docs;
create policy shared_docs_owner on public.shared_docs for all using (public.is_owner(company_id)) with check (public.is_owner(company_id));

create or replace function public.get_shared_doc(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r shared_docs;
begin
  update shared_docs set viewed_at = coalesce(viewed_at, now()) where token = p_token returning * into r;
  if r.token is null then return null; end if;
  return jsonb_build_object('data', r.data, 'status', r.status, 'approved_name', r.approved_name, 'approved_at', r.approved_at,
    'can_pay', r.kind = 'invoice' and exists (select 1 from company_billing b where b.company_id = r.company_id and b.charges_enabled),
    'online', coalesce((select jsonb_agg(jsonb_build_object('amount', p.amount, 'ref', p.stripe_session, 'date', p.paid_at::date)) from doc_payments p where p.token = r.token), '[]'::jsonb));
end $$;

create or replace function public.respond_shared_doc(p_token text, p_name text, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r shared_docs;
begin
  update shared_docs set status = case when p_approve then 'approved' else 'declined' end,
         approved_name = nullif(left(trim(coalesce(p_name, '')), 120), ''), approved_at = now()
   where token = p_token and kind = 'estimate' and status = 'sent' returning * into r;
  if r.token is null then
    select * into r from shared_docs where token = p_token;
    if r.token is null then raise exception 'Not found'; end if;
  end if;
  return jsonb_build_object('data', r.data, 'status', r.status, 'approved_name', r.approved_name, 'approved_at', r.approved_at);
end $$;
revoke all on function public.get_shared_doc(text) from public;
revoke all on function public.respond_shared_doc(text, text, boolean) from public;
grant execute on function public.get_shared_doc(text) to anon, authenticated;
grant execute on function public.respond_shared_doc(text, text, boolean) to anon, authenticated;

-- ============ Daily job reports from the crew ============
create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id text not null,
  job_id text not null,
  date date not null default current_date,
  notes text not null default '' check (length(notes) <= 5000),
  photos text[] not null default '{}' check (cardinality(photos) <= 20),
  created_at timestamptz not null default now()
);
create index if not exists daily_reports_company_date on public.daily_reports(company_id, date desc);
alter table public.daily_reports enable row level security;
drop policy if exists reports_read on public.daily_reports;
create policy reports_read on public.daily_reports for select using (user_id = auth.uid() or public.is_owner(company_id));
drop policy if exists reports_insert on public.daily_reports;
create policy reports_insert on public.daily_reports for insert with check (user_id = auth.uid() and employee_id = public.my_employee_id(company_id));
drop policy if exists reports_delete on public.daily_reports;
create policy reports_delete on public.daily_reports for delete using (user_id = auth.uid() or public.is_owner(company_id));

-- Crew may upload report photos into <company>/reports/. Only the owner can read them (photos_owner_all).
drop policy if exists photos_crew_reports on storage.objects;
create policy photos_crew_reports on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[2] = 'reports'
              and public.my_employee_id(((storage.foldername(name))[1])::uuid) is not null);

-- ============ Time-off requests from the crew ============
create table if not exists public.time_off (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id text not null,
  start_date date not null,
  end_date date not null,
  reason text check (length(reason) <= 200),
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
alter table public.time_off enable row level security;
drop policy if exists timeoff_read on public.time_off;
create policy timeoff_read on public.time_off for select using (user_id = auth.uid() or public.is_owner(company_id));
drop policy if exists timeoff_insert on public.time_off;
create policy timeoff_insert on public.time_off for insert with check (user_id = auth.uid() and status = 'pending' and employee_id = public.my_employee_id(company_id));
drop policy if exists timeoff_decide on public.time_off;
create policy timeoff_decide on public.time_off for update using (public.is_owner(company_id)) with check (public.is_owner(company_id));
drop policy if exists timeoff_delete on public.time_off;
create policy timeoff_delete on public.time_off for delete using ((user_id = auth.uid() and status = 'pending') or public.is_owner(company_id));

-- ============ Phone notifications (iPhone app) ============
-- One row per phone. The "notify" Edge Function reads these with the service role.
create table if not exists public.device_tokens (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null default 'ios',
  updated_at timestamptz not null default now()
);
alter table public.device_tokens enable row level security;
drop policy if exists tokens_own on public.device_tokens;
create policy tokens_own on public.device_tokens for select using (user_id = auth.uid());
create or replace function public.register_device(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into device_tokens(token, user_id, updated_at) values (left(p_token, 200), auth.uid(), now())
    on conflict (token) do update set user_id = auth.uid(), updated_at = now();
end $$;
create or replace function public.unregister_device(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from device_tokens where token = p_token and user_id = auth.uid();
$$;
revoke all on function public.register_device(text) from public, anon;
revoke all on function public.unregister_device(text) from public, anon;
grant execute on function public.register_device(text) to authenticated;
grant execute on function public.unregister_device(text) to authenticated;

-- ============ Punch lists: crew tick off tasks ============
-- Tasks themselves live on the job in the owner's data; this table only records crew check-offs.
create table if not exists public.task_checks (
  company_id uuid not null references public.companies(id) on delete cascade,
  task_id text not null,
  job_id text not null,
  done boolean not null,
  employee_id text,
  user_id uuid references auth.users(id) on delete set null,
  done_at timestamptz not null default now(),
  primary key (company_id, task_id)
);
alter table public.task_checks enable row level security;
drop policy if exists task_checks_read on public.task_checks;
create policy task_checks_read on public.task_checks for select using (public.is_member(company_id));
create or replace function public.set_task(p_company uuid, p_job text, p_task text, p_done boolean) returns public.task_checks
language plpgsql security definer set search_path = public as $$
declare emp text; r task_checks;
begin
  emp := public.my_employee_id(p_company);
  if emp is null then raise exception 'You are not on this company''s crew'; end if;
  insert into task_checks(company_id, task_id, job_id, done, employee_id, user_id, done_at)
    values (p_company, left(p_task, 64), left(p_job, 64), p_done, emp, auth.uid(), now())
    on conflict (company_id, task_id) do update set done = excluded.done, employee_id = excluded.employee_id, user_id = excluded.user_id, done_at = now()
    returning * into r;
  return r;
end $$;
revoke all on function public.set_task(uuid, text, text, boolean) from public, anon;
grant execute on function public.set_task(uuid, text, text, boolean) to authenticated;

-- ============ Customer page: milestones and picks the customer makes ============
-- The owner publishes a snapshot of a job's customer page (dates, milestones, picks to make).
-- The customer opens it with a long random token (no account) through the two functions below.
create table if not exists public.customer_portals (
  token text primary key check (length(token) >= 32),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id text not null,
  data jsonb not null,
  viewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.customer_portals enable row level security;
drop policy if exists portals_owner on public.customer_portals;
create policy portals_owner on public.customer_portals for all using (public.is_owner(company_id)) with check (public.is_owner(company_id));

-- One row per pick the customer has made. Written only through portal_decide.
create table if not exists public.portal_choices (
  token text not null references public.customer_portals(token) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  item_id text not null,
  option_id text,
  label text not null default '' check (length(label) <= 200),
  note text not null default '' check (length(note) <= 1000),
  name text not null default '' check (length(name) <= 120),
  decided_at timestamptz not null default now(),
  notified_at timestamptz,
  primary key (token, item_id)
);
alter table public.portal_choices enable row level security;
drop policy if exists choices_owner_read on public.portal_choices;
create policy choices_owner_read on public.portal_choices for select using (public.is_owner(company_id));
drop policy if exists choices_owner_delete on public.portal_choices;
create policy choices_owner_delete on public.portal_choices for delete using (public.is_owner(company_id));

create or replace function public.get_portal(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r customer_portals;
begin
  update customer_portals set viewed_at = coalesce(viewed_at, now()) where token = p_token returning * into r;
  if r.token is null then return null; end if;
  return jsonb_build_object('data', r.data,
    'choices', coalesce((select jsonb_agg(jsonb_build_object('item_id', c.item_id, 'option_id', c.option_id, 'label', c.label, 'note', c.note, 'name', c.name, 'at', c.decided_at))
                         from portal_choices c where c.token = r.token), '[]'::jsonb));
end $$;

create or replace function public.portal_decide(p_token text, p_item text, p_option text, p_note text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r customer_portals; it jsonb; o jsonb; lbl text := '';
begin
  select * into r from customer_portals where token = p_token;
  if r.token is null then raise exception 'Not found'; end if;
  select e into it from jsonb_array_elements(r.data->'items') e where e->>'id' = p_item and e->>'kind' = 'pick';
  if it is null then raise exception 'That choice was removed'; end if;
  if coalesce(it->>'locked', '') = 'true' then raise exception 'This choice is locked. Contact your contractor to change it.'; end if;
  if nullif(p_option, '') is not null then
    select e into o from jsonb_array_elements(it->'options') e where e->>'id' = p_option;
    if o is null then raise exception 'That option was removed'; end if;
    lbl := left(coalesce(o->>'label', ''), 200);
  elsif length(trim(coalesce(p_note, ''))) < 1 then
    raise exception 'Pick an option or type your answer';
  end if;
  insert into portal_choices(token, company_id, item_id, option_id, label, note, name, decided_at)
    values (r.token, r.company_id, p_item, nullif(p_option, ''), lbl, left(trim(coalesce(p_note, '')), 1000), left(trim(coalesce(p_name, '')), 120), now())
    on conflict (token, item_id) do update set option_id = excluded.option_id, label = excluded.label, note = excluded.note, name = excluded.name,
      decided_at = now(),
      -- a quick second change doesn't send a second phone alert
      notified_at = case when portal_choices.notified_at < now() - interval '2 minutes' then null else portal_choices.notified_at end;
  return public.get_portal(p_token);
end $$;
revoke all on function public.get_portal(text) from public;
revoke all on function public.portal_decide(text, text, text, text, text) from public;
grant execute on function public.get_portal(text) to anon, authenticated;
grant execute on function public.portal_decide(text, text, text, text, text) to anon, authenticated;

-- Photos, files and voice memos on a customer page. Public bucket: files open by their exact link,
-- which holds the page's random token, and nobody can list the bucket. Only the owner can upload or delete.
insert into storage.buckets (id, name, public, file_size_limit) values ('portal', 'portal', true, 26214400) on conflict (id) do nothing;
drop policy if exists portal_owner_read on storage.objects;
create policy portal_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'portal' and public.is_owner(((storage.foldername(name))[1])::uuid));
drop policy if exists portal_owner_insert on storage.objects;
create policy portal_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'portal' and public.is_owner(((storage.foldername(name))[1])::uuid));
drop policy if exists portal_owner_delete on storage.objects;
create policy portal_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'portal' and public.is_owner(((storage.foldername(name))[1])::uuid));

-- Customer codes: the short code (like ABCDE-FGHJK) a customer types into the app to open their page.
-- 10 characters from the crew-code alphabet (32^10, about 10^15 codes), so guessing one isn't practical.
alter table public.customer_portals add column if not exists code text;
create unique index if not exists customer_portals_code on public.customer_portals(code) where code is not null;

-- Every lookup is recorded BEFORE the code is checked, so a call that can't write (a read-only
-- request) fails instead of skipping the count. Limit: 10 tries per network address in 10 minutes.
-- No limit across everyone, so one person can't lock every customer out of the code box.
-- The address is Cloudflare's cf-connecting-ip, else the last X-Forwarded-For entry (the one the
-- proxy adds); the first entry is whatever the caller typed. Not verified against Supabase's live
-- headers yet; the 10-character code is what keeps guessing impractical either way.
create table if not exists public.portal_code_tries (
  at timestamptz not null default now(),
  ip text not null default ''
);
drop table if exists public.portal_code_fails;
create index if not exists portal_code_tries_ip_at on public.portal_code_tries(ip, at);
alter table public.portal_code_tries enable row level security;
-- No policies: only portal_token_for_code (security definer) reads or writes it.

create or replace function public.portal_token_for_code(p_code text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare h json; v_ip text; v_code text; v_token text;
begin
  h := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  v_ip := left(coalesce(nullif(trim(h->>'cf-connecting-ip'), ''),
                        trim(regexp_replace(coalesce(h->>'x-forwarded-for', ''), '^.*,', ''))), 64);
  insert into portal_code_tries(ip) values (v_ip);
  if (select count(*) from portal_code_tries where ip = v_ip and at > now() - interval '10 minutes') > 10 then
    raise exception 'Too many tries. Wait a few minutes and try again.';
  end if;
  delete from portal_code_tries where at < now() - interval '1 day';
  v_code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  select token into v_token from customer_portals where code = v_code and length(code) = 10;
  return v_token;
end $$;
revoke all on function public.portal_token_for_code(text) from public;
grant execute on function public.portal_token_for_code(text) to anon, authenticated;

-- ============ Blue Board plans (subscriptions) ============
-- One row per company. Written only by the "billing" Edge Function (service role) and the trigger
-- below; everyone in the company can read it (crew need to know if the company's plan has lapsed).
-- status is 'trialing' with no stripe_subscription_id during the free trial, otherwise Stripe's status.
-- comp = true gives a company free access (demo account, friends, testing).
create table if not exists public.subscriptions (
  company_id uuid primary key references public.companies(id) on delete cascade,
  plan text check (plan in ('solo','crew','company')),
  status text not null default 'trialing',
  trial_ends timestamptz not null default now() + interval '14 days',
  comp boolean not null default false,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
drop policy if exists subscriptions_read on public.subscriptions;
create policy subscriptions_read on public.subscriptions for select using (public.is_member(company_id));

-- Every new company starts a 14-day free trial.
create or replace function public.start_trial() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.subscriptions(company_id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists companies_start_trial on public.companies;
create trigger companies_start_trial after insert on public.companies for each row execute function public.start_trial();

-- Companies that existed before plans get a 14-day trial from the day this runs.
insert into public.subscriptions(company_id) select id from public.companies on conflict do nothing;
