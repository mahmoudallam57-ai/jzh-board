-- Al Jazirah Al Hamra lesson board: student progress behind server functions.
-- RLS is enabled on every table with NO policies, so the anon/authenticated
-- roles can read nothing. Only the service key (used by /api functions) has access.

create extension if not exists pgcrypto;

create table public.classes (
  code  text primary key,
  label text not null,
  sort  int  not null default 0
);

create table public.students (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  name_norm    text not null,
  cls          text not null references public.classes(code) on update cascade,
  pin_hash     text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (name_norm, cls)
);

create table public.progress (
  student_id  uuid primary key references public.students(id) on delete cascade,
  state       jsonb not null default '{}',
  summary     jsonb not null default '{}',
  version     int   not null default 0,
  reset_epoch int   not null default 0,
  updated_at  timestamptz not null default now()
);

-- cls = '*' is the default row every class inherits from.
create table public.class_settings (
  cls        text primary key,
  config     jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table public.certificates (
  student_id  uuid primary key references public.students(id) on delete cascade,
  approved_at timestamptz not null default now(),
  approved_by text not null
);

create table public.attempts (
  key          text primary key,
  fails        int not null default 0,
  first_at     timestamptz,
  locked_until timestamptz
);

alter table public.classes        enable row level security;
alter table public.students       enable row level security;
alter table public.progress       enable row level security;
alter table public.class_settings enable row level security;
alter table public.certificates   enable row level security;
alter table public.attempts       enable row level security;

insert into public.class_settings (cls, config) values ('*', '{}');

-- Atomic compare-and-set used by PUT /api/s/sync (one round trip, no race).
-- Called only with the service key (service_role bypasses RLS), so invoker rights suffice.
create or replace function public.put_progress(
  p_sid uuid, p_state jsonb, p_summary jsonb, p_base int, p_epoch int
) returns table (ok boolean, reason text, version int, reset_epoch int, state jsonb)
language plpgsql security invoker strict set search_path = public as $$
declare cur public.progress%rowtype;
begin
  insert into public.progress (student_id) values (p_sid) on conflict do nothing;
  select * into cur from public.progress where student_id = p_sid for update;
  if cur.reset_epoch <> p_epoch then
    return query select false, 'epoch', cur.version, cur.reset_epoch, cur.state; return;
  end if;
  if cur.version <> p_base then
    return query select false, 'stale', cur.version, cur.reset_epoch, cur.state; return;
  end if;
  update public.progress p set state = p_state, summary = p_summary,
    version = cur.version + 1, updated_at = now()
    where p.student_id = p_sid;
  return query select true, null::text, cur.version + 1, cur.reset_epoch, p_state;
end $$;
revoke all on function public.put_progress(uuid, jsonb, jsonb, int, int) from public, anon, authenticated;
grant execute on function public.put_progress(uuid, jsonb, jsonb, int, int) to service_role;

-- Atomic attempt counter: concurrent requests each get their own count, so a burst
-- cannot slip past the lockout. The attempt that reaches p_max is still allowed;
-- later ones are blocked until locked_until.
create or replace function public.hit_attempt(
  p_key text, p_now timestamptz, p_max int, p_window int, p_lock int
) returns table (fails int, locked_until timestamptz, blocked boolean)
language plpgsql security invoker strict set search_path = public as $$
declare r public.attempts%rowtype;
begin
  insert into public.attempts (key, fails, first_at) values (p_key, 0, p_now) on conflict (key) do nothing;
  select * into r from public.attempts a where a.key = p_key for update;
  if r.locked_until is not null and r.locked_until > p_now then
    return query select r.fails, r.locked_until, true; return;
  end if;
  if r.locked_until is not null or r.first_at is null
     or r.first_at + make_interval(secs => p_window) < p_now then
    r.fails := 0; r.first_at := p_now; r.locked_until := null;
  end if;
  r.fails := r.fails + 1;
  if r.fails >= p_max then r.locked_until := p_now + make_interval(secs => p_lock); end if;
  update public.attempts a set fails = r.fails, first_at = r.first_at, locked_until = r.locked_until
    where a.key = p_key;
  return query select r.fails, r.locked_until, false;
end $$;
revoke all on function public.hit_attempt(text, timestamptz, int, int, int) from public, anon, authenticated;
grant execute on function public.hit_attempt(text, timestamptz, int, int, int) to service_role;
