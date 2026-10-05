-- Run once in the Supabase SQL editor. No public config or credential access.
begin;

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.config_versions (
  id uuid primary key default gen_random_uuid(),
  revision bigint generated always as identity unique,
  settings jsonb not null,
  api_key_ciphertext text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table public.study_state (
  id int primary key check (id = 1),
  active_config_id uuid references public.config_versions(id),
  enabled boolean not null default false
);
insert into public.study_state(id) values (1);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  participant_code text not null unique default ('P-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  config_id uuid not null references public.config_versions(id),
  title text not null default '尚未开始对话',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  lock_token uuid,
  locked_until timestamptz,
  request_count int not null default 0
);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  turn_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 50000),
  status text not null check (status in ('pending', 'complete', 'failed')),
  error_code text,
  sequence bigint generated always as identity,
  created_at timestamptz not null default now(),
  unique(conversation_id, turn_id, role)
);
create index messages_order on public.messages(conversation_id, sequence);
create table public.request_events (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index request_events_recent on public.request_events(conversation_id, created_at desc);
create index conversations_recent on public.conversations(updated_at desc);

alter table public.admin_users enable row level security;
alter table public.config_versions enable row level security;
alter table public.study_state enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.request_events enable row level security;

revoke all on public.admin_users, public.config_versions, public.study_state,
  public.conversations, public.messages, public.request_events from anon, authenticated;
grant select on public.conversations, public.messages to authenticated;
grant all on public.admin_users, public.config_versions, public.study_state,
  public.conversations, public.messages, public.request_events to service_role;
grant usage, select on public.config_versions_revision_seq, public.messages_sequence_seq, public.request_events_id_seq to service_role;

create policy own_conversations on public.conversations for select to authenticated
  using (owner_id = (select auth.uid()));
create policy own_messages on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())));

create function public.publish_config(p_settings jsonb, p_ciphertext text, p_actor uuid, p_expected_revision bigint, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare current_revision bigint; result public.config_versions;
begin
  perform 1 from study_state where id = 1 for update;
  if not exists(select 1 from admin_users where user_id = p_actor) then raise exception 'FORBIDDEN'; end if;
  select coalesce(v.revision, 0) into current_revision from study_state s
    left join config_versions v on v.id = s.active_config_id where s.id = 1;
  if current_revision <> p_expected_revision then raise exception 'CONFLICT'; end if;
  insert into config_versions(settings, api_key_ciphertext, created_by)
    values(p_settings, p_ciphertext, p_actor) returning * into result;
  update study_state set active_config_id = result.id, enabled = p_enabled where id = 1;
  return to_jsonb(result);
end;
$$;

create function public.get_or_create_conversation(p_owner uuid)
returns public.conversations language plpgsql security definer set search_path = public, pg_temp as $$
declare result public.conversations; active_config uuid; is_enabled boolean;
begin
  select * into result from conversations where owner_id = p_owner;
  if found then
    -- Interrupted streams retain partial text, and become retryable after lease expiry.
    if result.locked_until is not null and result.locked_until < now() then
      update conversations set lock_token = null, locked_until = null
        where id = result.id and locked_until < now();
      if found then
        update messages set status = 'failed', error_code = 'interrupted'
          where conversation_id = result.id and status = 'pending';
      end if;
    end if;
    select * into result from conversations where id = result.id;
    return result;
  end if;
  select active_config_id, enabled into active_config, is_enabled from study_state where id = 1;
  if active_config is null then raise exception 'NOT_CONFIGURED'; end if;
  if not is_enabled then raise exception 'STUDY_PAUSED'; end if;
  insert into conversations(owner_id, config_id) values(p_owner, active_config)
    on conflict(owner_id) do nothing;
  select * into result from conversations where owner_id = p_owner;
  return result;
end;
$$;

create function public.begin_turn(p_conversation uuid, p_owner uuid, p_turn uuid, p_content text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.conversations; u public.messages; a public.messages; lease uuid; recent_count int;
begin
  if char_length(trim(p_content)) < 1 or char_length(p_content) > 8000 then raise exception 'INVALID_CONTENT'; end if;
  select * into c from conversations where id = p_conversation for update;
  if not found or c.owner_id <> p_owner then raise exception 'FORBIDDEN'; end if;
  select * into u from messages where conversation_id = c.id and turn_id = p_turn and role = 'user';
  if found and u.content <> p_content then raise exception 'TURN_CONFLICT'; end if;
  select * into a from messages where conversation_id = c.id and turn_id = p_turn and role = 'assistant';
  if found and a.status = 'complete' then
    return jsonb_build_object('state', 'complete', 'user', to_jsonb(u), 'assistant', to_jsonb(a));
  end if;
  if not (select enabled from study_state where id = 1) then raise exception 'STUDY_PAUSED'; end if;
  if c.locked_until > now() then raise exception 'BUSY'; end if;
  if exists(select 1 from messages where conversation_id = c.id and role = 'assistant' and status <> 'complete' and turn_id <> p_turn) then
    raise exception 'BUSY';
  end if;
  select count(*) into recent_count from request_events where conversation_id = c.id and created_at > now() - interval '1 minute';
  if recent_count >= 8 then raise exception 'RATE_LIMITED'; end if;
  if c.request_count >= 200 then raise exception 'SESSION_LIMIT'; end if;
  lease := gen_random_uuid();
  update conversations set lock_token = lease, locked_until = now() + interval '150 seconds',
    request_count = request_count + 1, updated_at = now(),
    title = case when title = '尚未开始对话' then left(p_content, 60) else title end where id = c.id;
  insert into request_events(conversation_id) values(c.id);
  insert into messages(conversation_id, turn_id, role, content, status)
    values(c.id, p_turn, 'user', p_content, 'complete') on conflict(conversation_id, turn_id, role) do nothing;
  insert into messages(conversation_id, turn_id, role, content, status)
    values(c.id, p_turn, 'assistant', '', 'pending')
    on conflict(conversation_id, turn_id, role) do update set content = '', status = 'pending', error_code = null;
  select * into u from messages where conversation_id = c.id and turn_id = p_turn and role = 'user';
  select * into a from messages where conversation_id = c.id and turn_id = p_turn and role = 'assistant';
  return jsonb_build_object('state', 'acquired', 'lock_token', lease, 'user', to_jsonb(u), 'assistant', to_jsonb(a));
end;
$$;

create function public.save_reply(p_conversation uuid, p_turn uuid, p_lease uuid, p_content text, p_status text, p_error text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare result public.messages;
begin
  if p_status not in ('pending', 'complete', 'failed') then raise exception 'INVALID_STATUS'; end if;
  perform 1 from conversations where id = p_conversation and lock_token = p_lease for update;
  if not found then raise exception 'STALE_LEASE'; end if;
  update messages set content = p_content, status = p_status, error_code = p_error
    where conversation_id = p_conversation and turn_id = p_turn and role = 'assistant' returning * into result;
  if not found then raise exception 'MISSING_REPLY'; end if;
  if p_status <> 'pending' then
    update conversations set lock_token = null, locked_until = null, updated_at = now() where id = p_conversation;
  end if;
  return to_jsonb(result);
end;
$$;

revoke all on function public.publish_config(jsonb,text,uuid,bigint,boolean) from public, anon, authenticated;
revoke all on function public.get_or_create_conversation(uuid) from public, anon, authenticated;
revoke all on function public.begin_turn(uuid,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.save_reply(uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.publish_config(jsonb,text,uuid,bigint,boolean) to service_role;
grant execute on function public.get_or_create_conversation(uuid) to service_role;
grant execute on function public.begin_turn(uuid,uuid,uuid,text) to service_role;
grant execute on function public.save_reply(uuid,uuid,uuid,text,text,text) to service_role;
commit;
