-- Identity layer for a NEW CloudBase PostgreSQL environment.
-- Run through CloudBase SQL Editor / ExecutePGSql as cloudbase_admin.
-- Platform-owned auth.* tables, functions and roles are deliberately untouched.
-- https://docs.cloudbase.net/authentication-v2/auth/auth-pg
begin;

create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  -- NULL is reserved for UUIDs staged by an administrator during data import.
  -- Fresh application login always creates a non-NULL, verified subject.
  cloudbase_subject text unique,
  created_at timestamptz not null default now(),
  constraint app_users_cloudbase_subject check (cloudbase_subject is null or (
    char_length(cloudbase_subject) between 1 and 128
    and cloudbase_subject = btrim(cloudbase_subject)
    and cloudbase_subject not in ('anon', 'authenticated', 'service_role')
    and cloudbase_subject !~ '[[:space:][:cntrl:]]'))
);
alter table public.app_users enable row level security;
revoke all on public.app_users from public, anon, authenticated;
grant all on public.app_users to service_role;

-- Called ONLY by the server after CloudBase validates the student's/admin's
-- access token. A client-supplied user ID, username or student number is not proof.
create function public.get_or_create_app_user(p_subject text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result public.app_users;
begin
  if p_subject is null or char_length(p_subject) not between 1 and 128
    or p_subject <> btrim(p_subject)
    or p_subject in ('anon','authenticated','service_role')
    or p_subject ~ '[[:space:][:cntrl:]]' then
    raise exception 'INVALID_IDENTITY';
  end if;
  insert into public.app_users(cloudbase_subject) values(p_subject)
    on conflict(cloudbase_subject) do nothing;
  select * into result from public.app_users where cloudbase_subject=p_subject;
  return to_jsonb(result);
end;
$$;

-- Direct authenticated read policies resolve native TEXT auth.uid() into the
-- existing business UUID. Anonymous students use the validated server API;
-- neither a Publishable Key nor an anonymous token gains direct table access.
create function public.app_current_user_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select u.id from public.app_users u
    where auth.role()='authenticated'
      and auth.uid() not in ('anon','authenticated','service_role')
      and u.cloudbase_subject=auth.uid();
$$;

-- Privileged migration staging. Import the original UUIDs before business rows.
-- Never import/restore Supabase auth.users into CloudBase's native auth schema.
create function public.seed_legacy_app_users(p_ids uuid[])
returns bigint language plpgsql security definer set search_path = '' as $$
declare inserted bigint;
begin
  if p_ids is null or cardinality(p_ids)>10000
    or array_position(p_ids,null) is not null then
    raise exception 'INVALID_IDENTITY_IMPORT';
  end if;
  insert into public.app_users(id)
    select distinct legacy_id from unnest(p_ids) as imported(legacy_id)
    on conflict(id) do nothing;
  get diagnostics inserted=row_count;
  return inserted;
end;
$$;

create table public.app_identity_link_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id),
  cloudbase_subject text not null,
  linked_at timestamptz not null default now()
);
alter table public.app_identity_link_audit enable row level security;
revoke all on public.app_identity_link_audit from public, anon, authenticated;
grant all on public.app_identity_link_audit to service_role;

-- An administrator may bind an imported UUID only after verifying both the old
-- identity and new CloudBase identity outside this function. There is NO automatic
-- lookup/claim by student number. Existing bindings cannot be replaced.
create function public.link_legacy_app_user(p_user uuid,p_subject text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.app_users;
begin
  if p_user is null or p_subject is null or char_length(p_subject) not between 1 and 128
    or p_subject <> btrim(p_subject)
    or p_subject in ('anon','authenticated','service_role')
    or p_subject ~ '[[:space:][:cntrl:]]' then
    raise exception 'INVALID_IDENTITY';
  end if;
  select * into target from public.app_users where id=p_user for update;
  if not found then raise exception 'IDENTITY_NOT_FOUND'; end if;
  if target.cloudbase_subject=p_subject then return to_jsonb(target); end if;
  if target.cloudbase_subject is not null
    or exists(select 1 from public.app_users where cloudbase_subject=p_subject) then
    raise exception 'IDENTITY_CONFLICT';
  end if;
  update public.app_users set cloudbase_subject=p_subject where id=p_user returning * into target;
  insert into public.app_identity_link_audit(user_id,cloudbase_subject) values(p_user,p_subject);
  return to_jsonb(target);
exception when unique_violation then
  raise exception 'IDENTITY_CONFLICT';
end;
$$;

revoke all on function public.get_or_create_app_user(text) from public, anon, authenticated;
revoke all on function public.app_current_user_id() from public, anon, authenticated;
revoke all on function public.seed_legacy_app_users(uuid[]) from public, anon, authenticated;
revoke all on function public.link_legacy_app_user(uuid,text) from public, anon, authenticated;
grant execute on function public.get_or_create_app_user(text) to service_role;
grant execute on function public.app_current_user_id() to authenticated, service_role;
grant execute on function public.seed_legacy_app_users(uuid[]) to service_role;
grant execute on function public.link_legacy_app_user(uuid,text) to service_role;

commit;
