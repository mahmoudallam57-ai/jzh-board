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
create or replace function public.put_progress(
  p_sid uuid, p_state jsonb, p_summary jsonb, p_base int, p_epoch int
) returns table (ok boolean, reason text, version int, reset_epoch int, state jsonb)
language plpgsql security definer set search_path = public as $$
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
