-- Run this once in Supabase SQL Editor. It recreates the shared users table.
-- Admin records use role = 'admin' or 'super_admin'; public registrations use role = 'user'.

create extension if not exists pgcrypto;

drop table if exists public.users cascade;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  username text unique,
  email text unique,
  phone text unique,
  password_hash text,
  location text,
  role text not null default 'user' check (role in ('user', 'admin', 'super_admin')),
  "twoFactorSecret" text,
  "twoFactorEnabled" boolean not null default false,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_role_identity_check check (
    (role = 'user' and phone is not null and password_hash is not null)
    or (role in ('admin', 'super_admin') and email is not null)
  )
);

create index users_role_index on public.users (role);
create index users_phone_index on public.users (phone) where phone is not null;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_set_updated_at
before update on public.users
for each row execute function public.set_updated_at();

-- Needed only when calling PostgREST with the service-role key used by this Worker.
alter table public.users enable row level security;
