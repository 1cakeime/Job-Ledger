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

-- ============ Estimates & invoices: customer links ============
-- The owner shares a snapshot of an estimate or invoice. Customers open it with a long random token
-- (no account) through the two functions below; nobody can list or browse this table.
create table if not exists public.shared_docs (
  token text primary key check (length(token) >= 32),
  company_id uuid not null references public.companies(id) on delete cascade,
  doc_id text not null,
  kind text not null check (kind in ('estimate','invoice')),
  data jsonb not null,
  status text not null default 'sent' check (status in ('sent','approved','declined')),
  approved_name text,
  approved_at timestamptz,
  viewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.shared_docs enable row level security;
drop policy if exists shared_docs_owner on public.shared_docs;
create policy shared_docs_owner on public.shared_docs for all using (public.is_owner(company_id)) with check (public.is_owner(company_id));

create or replace function public.get_shared_doc(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r shared_docs;
begin
  update shared_docs set viewed_at = coalesce(viewed_at, now()) where token = p_token returning * into r;
  if r.token is null then return null; end if;
  return jsonb_build_object('data', r.data, 'status', r.status, 'approved_name', r.approved_name, 'approved_at', r.approved_at);
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
