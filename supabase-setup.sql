-- =========================================================================
-- MatchTracker - Supabase schema
-- Paste ALL of this into Supabase -> SQL Editor -> New query -> Run.
-- Safe to re-run.
-- =========================================================================
create extension if not exists pgcrypto;
-- ------------------------------- tables ---------------------------------
create table if not exists public.mt_players (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (char_length(btrim(name)) between 2 and 40),
  created_at  timestamptz not null default now()
);
create table if not exists public.mt_matches (
  id                uuid primary key default gen_random_uuid(),
  type              text not null check (type in ('1v1','2v2')),
  teams             jsonb not null,
  started_at        timestamptz not null,
  ended_at          timestamptz not null,
  duration_ms       bigint not null check (duration_ms >= 0 and duration_ms <= 1800000),
  paused_ms         bigint not null default 0,
  score_a           int not null check (score_a between 0 and 21),
  score_b           int not null check (score_b between 0 and 21),
  winner            text not null check (winner in ('A','B')),
  decided_manually  boolean not null default false,
  status            text not null default 'pending' check (status in ('pending','approved','declined')),
  status_changed_at timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists mt_matches_started_idx on public.mt_matches (started_at desc);
create table if not exists public.mt_admins (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  username      text not null unique,
  password_hash text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create table if not exists public.mt_sessions (
  token      uuid primary key default gen_random_uuid(),
  admin_id   uuid not null references public.mt_admins(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
-- --------------------------- row level security --------------------------
alter table public.mt_players  enable row level security;
alter table public.mt_matches  enable row level security;
alter table public.mt_admins   enable row level security;
alter table public.mt_sessions enable row level security;
-- everybody may READ players and matches
drop policy if exists mt_players_read on public.mt_players;
create policy mt_players_read on public.mt_players for select to anon, authenticated using (true);
drop policy if exists mt_matches_read on public.mt_matches;
create policy mt_matches_read on public.mt_matches for select to anon, authenticated using (true);
-- anybody may RECORD a match (that is the whole point of the app)
drop policy if exists mt_matches_insert on public.mt_matches;
create policy mt_matches_insert on public.mt_matches for insert to anon, authenticated
  with check (status = 'pending' and duration_ms <= 1800000);
-- no direct update/delete anywhere, and mt_admins / mt_sessions have NO
-- policies at all, so password hashes can never be read by the public key.
-- ------------------------------ admin RPCs -------------------------------
create or replace function public.mt_admin_id(p_token uuid)
returns uuid language sql security definer set search_path = public as $$
  select s.admin_id from mt_sessions s
  join mt_admins a on a.id = s.admin_id
  where s.token = p_token and s.expires_at > now() and a.active;
$$;
create or replace function public.mt_login(p_username text, p_password text)
returns json language plpgsql security definer set search_path = public as $$
declare a mt_admins; t uuid;
begin
  select * into a from mt_admins
   where lower(username) = lower(btrim(p_username)) and active;
  if a.id is null then raise exception 'No such admin.'; end if;
  if a.password_hash <> crypt(p_password, a.password_hash) then
    raise exception 'Wrong password.';
  end if;
  delete from mt_sessions where expires_at < now();
  insert into mt_sessions(admin_id) values (a.id) returning token into t;
  return json_build_object('token', t, 'id', a.id, 'name', a.name, 'username', a.username);
end $$;
create or replace function public.mt_logout(p_token uuid)
returns void language sql security definer set search_path = public as $$
  delete from mt_sessions where token = p_token;
$$;
create or replace function public.mt_list_admins(p_token uuid)
returns table (id uuid, name text, username text, active boolean, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if mt_admin_id(p_token) is null then raise exception 'Not signed in as admin.'; end if;
  return query select a.id, a.name, a.username, a.active, a.created_at
               from mt_admins a order by a.name;
end $$;
create or replace function public.mt_create_admin(p_token uuid, p_name text, p_username text, p_password text)
returns json language plpgsql security definer set search_path = public as $$
declare nid uuid;
begin
  if mt_admin_id(p_token) is null then raise exception 'Not signed in as admin.'; end if;
  if char_length(btrim(p_name)) < 2 then raise exception 'Name is too short.'; end if;
  if char_length(btrim(p_username)) < 3 then raise exception 'Username must be at least 3 characters.'; end if;
  if char_length(p_password) < 4 then raise exception 'Password must be at least 4 characters.'; end if;
  if exists (select 1 from mt_admins where lower(username) = lower(btrim(p_username))) then
    raise exception 'That username already exists.';
  end if;
  insert into mt_admins(name, username, password_hash)
  values (btrim(p_name), lower(btrim(p_username)), crypt(p_password, gen_salt('bf')))
  returning id into nid;
  return json_build_object('id', nid, 'name', btrim(p_name), 'username', lower(btrim(p_username)));
end $$;
create or replace function public.mt_reset_password(p_token uuid, p_id uuid, p_password text)
returns json language plpgsql security definer set search_path = public as $$
declare a mt_admins;
begin
  if mt_admin_id(p_token) is null then raise exception 'Not signed in as admin.'; end if;
  if char_length(p_password) < 4 then raise exception 'Password must be at least 4 characters.'; end if;
  update mt_admins set password_hash = crypt(p_password, gen_salt('bf'))
   where id = p_id returning * into a;
  if a.id is null then raise exception 'Admin not found.'; end if;
  return json_build_object('id', a.id, 'name', a.name, 'username', a.username);
end $$;
create or replace function public.mt_delete_admin(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid;
begin
  me := mt_admin_id(p_token);
  if me is null then raise exception 'Not signed in as admin.'; end if;
  if me = p_id then raise exception 'You cannot delete yourself.'; end if;
  if (select count(*) from mt_admins) <= 1 then raise exception 'At least one admin must remain.'; end if;
  delete from mt_admins where id = p_id;
end $$;
-- ----------------------------- player RPCs -------------------------------
create or replace function public.mt_add_player(p_token uuid, p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare nid uuid;
begin
  if mt_admin_id(p_token) is null then raise exception 'Only an admin can add players.'; end if;
  insert into mt_players(name) values (btrim(p_name)) returning id into nid;
  return json_build_object('id', nid, 'name', btrim(p_name));
end $$;
create or replace function public.mt_rename_player(p_token uuid, p_id uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mt_admin_id(p_token) is null then raise exception 'Only an admin can rename players.'; end if;
  update mt_players set name = btrim(p_name) where id = p_id;
end $$;
create or replace function public.mt_delete_player(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mt_admin_id(p_token) is null then raise exception 'Only an admin can delete players.'; end if;
  delete from mt_players where id = p_id;
end $$;
-- ------------------------------ match RPCs -------------------------------
create or replace function public.mt_set_match_status(p_token uuid, p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mt_admin_id(p_token) is null then raise exception 'Only an admin can change approval.'; end if;
  if p_status not in ('pending','approved','declined') then raise exception 'Bad status.'; end if;
  update mt_matches set status = p_status, status_changed_at = now() where id = p_id;
end $$;
create or replace function public.mt_delete_match(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if mt_admin_id(p_token) is null then raise exception 'Only an admin can delete matches.'; end if;
  delete from mt_matches where id = p_id;
end $$;
-- --------------------------- first admin + reset -------------------------
delete from public.mt_matches;
delete from public.mt_players;
insert into public.mt_admins(name, username, password_hash)
select 'Administrator', 'admin', crypt('admin123', gen_salt('bf'))
where not exists (select 1 from public.mt_admins);
-- allow the public (anon) key to call the functions
grant execute on all functions in schema public to anon, authenticated;
