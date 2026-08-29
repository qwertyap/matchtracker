-- =========================================================================
-- MatchTracker - Supabase schema
-- MIGRATION - paste into Supabase -> SQL Editor -> New query -> Run.
-- Safe to re-run. This does NOT delete any players or matches.
-- Use supabase-setup.sql instead only if you want a completely fresh start.
--
-- Accounts created:
--   ayushp / onlybadminton   -> SUPER admin (every privilege)
--   admin  / admin           -> LIMITED admin (can only add players)
--
-- Players added by the limited admin arrive as "pending" and must be
-- approved by the super admin. Declining a player deletes that player AND
-- every match they took part in (so opponents' records of those matches go
-- too), exactly as requested.
-- =========================================================================
create extension if not exists pgcrypto;
-- ------------------------------- tables ---------------------------------
create table if not exists public.mt_admins (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  username      text not null unique,
  password_hash text not null,
  role          text not null default 'limited' check (role in ('super','limited')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
alter table public.mt_admins add column if not exists role text not null default 'limited';
create table if not exists public.mt_players (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (char_length(btrim(name)) between 2 and 40),
  status      text not null default 'pending' check (status in ('pending','approved')),
  added_by    uuid references public.mt_admins(id) on delete set null,
  created_at  timestamptz not null default now()
);
alter table public.mt_players add column if not exists status text not null default 'pending';
alter table public.mt_players add column if not exists added_by uuid;
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
drop policy if exists mt_players_read on public.mt_players;
create policy mt_players_read on public.mt_players for select to anon, authenticated using (true);
drop policy if exists mt_matches_read on public.mt_matches;
create policy mt_matches_read on public.mt_matches for select to anon, authenticated using (true);
drop policy if exists mt_matches_insert on public.mt_matches;
create policy mt_matches_insert on public.mt_matches for insert to anon, authenticated
  with check (status = 'pending' and duration_ms <= 1800000);
-- mt_admins / mt_sessions have NO policies: password hashes are unreadable.
-- ---------------------------- session helpers ----------------------------
create or replace function public.mt_admin_row(p_token uuid)
returns public.mt_admins language sql security definer set search_path = public as $$
  select a.* from mt_sessions s join mt_admins a on a.id = s.admin_id
  where s.token = p_token and s.expires_at > now() and a.active;
$$;
create or replace function public.mt_require(p_token uuid, p_super boolean)
returns public.mt_admins language plpgsql security definer set search_path = public as $$
declare a mt_admins;
begin
  a := mt_admin_row(p_token);
  if a.id is null then raise exception 'Please sign in as an admin.'; end if;
  if p_super and a.role <> 'super' then
    raise exception 'Only the main admin can do this.';
  end if;
  return a;
end $$;
-- --------------------------------- auth ----------------------------------
create or replace function public.mt_login(p_username text, p_password text)
returns json language plpgsql security definer set search_path = public as $$
declare a mt_admins; t uuid;
begin
  select * into a from mt_admins where lower(username) = lower(btrim(p_username)) and active;
  if a.id is null then raise exception 'No such admin.'; end if;
  if a.password_hash <> crypt(p_password, a.password_hash) then
    raise exception 'Wrong password.';
  end if;
  delete from mt_sessions where expires_at < now();
  insert into mt_sessions(admin_id) values (a.id) returning token into t;
  return json_build_object('token', t, 'id', a.id, 'name', a.name,
                           'username', a.username, 'role', a.role);
end $$;
create or replace function public.mt_logout(p_token uuid)
returns void language sql security definer set search_path = public as $$
  delete from mt_sessions where token = p_token;
$$;
create or replace function public.mt_me(p_token uuid)
returns json language plpgsql security definer set search_path = public as $$
declare a mt_admins;
begin
  a := mt_admin_row(p_token);
  if a.id is null then return null; end if;
  return json_build_object('id', a.id, 'name', a.name, 'username', a.username, 'role', a.role);
end $$;
create or replace function public.mt_list_admins(p_token uuid)
returns table (id uuid, name text, username text, role text, active boolean)
language plpgsql security definer set search_path = public as $$
begin
  perform mt_require(p_token, true);
  return query select a.id, a.name, a.username, a.role, a.active from mt_admins a order by a.role, a.name;
end $$;
create or replace function public.mt_create_admin(p_token uuid, p_name text, p_username text, p_password text, p_role text default 'limited')
returns json language plpgsql security definer set search_path = public as $$
declare nid uuid;
begin
  perform mt_require(p_token, true);
  if char_length(btrim(p_username)) < 3 then raise exception 'Username must be at least 3 characters.'; end if;
  if char_length(p_password) < 4 then raise exception 'Password must be at least 4 characters.'; end if;
  if p_role not in ('super','limited') then raise exception 'Bad role.'; end if;
  if exists (select 1 from mt_admins where lower(username) = lower(btrim(p_username))) then
    raise exception 'That username already exists.';
  end if;
  insert into mt_admins(name, username, password_hash, role)
  values (btrim(p_name), lower(btrim(p_username)), crypt(p_password, gen_salt('bf')), p_role)
  returning id into nid;
  return json_build_object('id', nid, 'name', btrim(p_name), 'username', lower(btrim(p_username)), 'role', p_role);
end $$;
create or replace function public.mt_reset_password(p_token uuid, p_id uuid, p_password text)
returns json language plpgsql security definer set search_path = public as $$
declare a mt_admins;
begin
  perform mt_require(p_token, true);
  if char_length(p_password) < 4 then raise exception 'Password must be at least 4 characters.'; end if;
  update mt_admins set password_hash = crypt(p_password, gen_salt('bf')) where id = p_id returning * into a;
  if a.id is null then raise exception 'Admin not found.'; end if;
  return json_build_object('id', a.id, 'name', a.name, 'username', a.username);
end $$;
create or replace function public.mt_delete_admin(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me mt_admins;
begin
  me := mt_require(p_token, true);
  if me.id = p_id then raise exception 'You cannot delete yourself.'; end if;
  delete from mt_admins where id = p_id;
end $$;
-- -------------------------------- players --------------------------------
-- Super admin adds an approved player straight away.
-- Limited admin adds a player that waits for approval.
create or replace function public.mt_add_player(p_token uuid, p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare a mt_admins; nid uuid; st text;
begin
  a := mt_require(p_token, false);
  st := case when a.role = 'super' then 'approved' else 'pending' end;
  insert into mt_players(name, status, added_by) values (btrim(p_name), st, a.id) returning id into nid;
  return json_build_object('id', nid, 'name', btrim(p_name), 'status', st);
end $$;
create or replace function public.mt_approve_player(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform mt_require(p_token, true);
  update mt_players set status = 'approved' where id = p_id;
end $$;
-- Decline = remove the player AND every match they appeared in.
create or replace function public.mt_decline_player(p_token uuid, p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare pname text; removed int;
begin
  perform mt_require(p_token, true);
  select name into pname from mt_players where id = p_id;
  if pname is null then raise exception 'Player not found.'; end if;
  delete from mt_matches m
   where exists (select 1 from jsonb_array_elements(m.teams) t
                 where t->'names' ? pname);
  get diagnostics removed = row_count;
  delete from mt_players where id = p_id;
  return json_build_object('player', pname, 'matches_removed', removed);
end $$;
create or replace function public.mt_rename_player(p_token uuid, p_id uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform mt_require(p_token, true);
  update mt_players set name = btrim(p_name) where id = p_id;
end $$;
create or replace function public.mt_delete_player(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform mt_require(p_token, true);
  delete from mt_players where id = p_id;
end $$;
-- -------------------------------- matches --------------------------------
create or replace function public.mt_set_match_status(p_token uuid, p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform mt_require(p_token, true);
  if p_status not in ('pending','approved','declined') then raise exception 'Bad status.'; end if;
  update mt_matches set status = p_status, status_changed_at = now() where id = p_id;
end $$;
create or replace function public.mt_delete_match(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform mt_require(p_token, true);
  delete from mt_matches where id = p_id;
end $$;
-- ---------------- accounts (KEEPS all existing data) ---------------------
-- Players that existed before approvals were introduced have no "added_by",
-- so they are treated as already approved and stay selectable.
update public.mt_players set status = 'approved' where added_by is null;
insert into public.mt_admins(name, username, password_hash, role)
values ('Ayush Pandey', 'ayushp', crypt('onlybadminton', gen_salt('bf')), 'super')
on conflict (username) do update
  set password_hash = excluded.password_hash, role = 'super', active = true;
insert into public.mt_admins(name, username, password_hash, role)
values ('Match Desk', 'admin', crypt('admin', gen_salt('bf')), 'limited')
on conflict (username) do update
  set password_hash = excluded.password_hash, role = 'limited', active = true;
grant execute on all functions in schema public to anon, authenticated;
