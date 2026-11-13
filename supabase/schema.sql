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
