-- Upgrade after 004. English tutoring uses its own session, history and progress.
-- Run the entire file once before opening the English assistant. Safe to run again.
begin;

create table if not exists public.english_assistant_configs (
  id uuid primary key default gen_random_uuid(),
  settings jsonb not null,
  api_key_ciphertext text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.english_assistant_state (
  id int primary key check (id=1),
  active_config_id uuid references public.english_assistant_configs(id),
  enabled boolean not null default true
);
insert into public.english_assistant_state(id) values(1) on conflict(id) do nothing;
create table if not exists public.english_assistant_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  student_id text not null unique check (student_id ~ '^[0-9A-Z_-]{1,32}$'),
  config_id uuid not null references public.english_assistant_configs(id),
  participant_code text not null unique default ('EA-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  title text not null default '英语助教 · PEEC写作',
  request_count int not null default 0,
  lock_token uuid,
  locked_until timestamptz,
  english_progress jsonb not null default '{"stage":"bridge","step":0,"version":0,"completed":false}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.english_assistant_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.english_assistant_sessions(id) on delete cascade,
  turn_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 50000),
  status text not null check (status in ('pending', 'complete', 'failed')),
  error_code text,
  sequence bigint generated always as identity,
  created_at timestamptz not null default now(),
  unique(session_id, turn_id, role)
);
create table if not exists public.english_assistant_request_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.english_assistant_sessions(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.english_assistant_turns (
  session_id uuid not null references public.english_assistant_sessions(id) on delete cascade,
  turn_id uuid not null,
  before_state jsonb not null,
  after_state jsonb not null,
  assessment jsonb not null,
  created_at timestamptz not null default now(),
  primary key(session_id, turn_id)
);
create index if not exists english_assistant_messages_order on public.english_assistant_messages(session_id, sequence);
create index if not exists english_assistant_requests_recent on public.english_assistant_request_events(session_id, created_at desc);

alter table public.english_assistant_sessions enable row level security;
alter table public.english_assistant_configs enable row level security;
alter table public.english_assistant_state enable row level security;
alter table public.english_assistant_messages enable row level security;
alter table public.english_assistant_request_events enable row level security;
alter table public.english_assistant_turns enable row level security;
revoke all on public.english_assistant_sessions, public.english_assistant_messages,
  public.english_assistant_request_events, public.english_assistant_turns,
  public.english_assistant_configs, public.english_assistant_state from public, anon, authenticated;
-- Progress and the configuration stay behind the server API. Students can
-- read their messages but have no table mutation or progress mutation grants.
grant select(id, owner_id, student_id, participant_code, title, request_count, locked_until, created_at, updated_at)
  on public.english_assistant_sessions to authenticated;
grant select on public.english_assistant_messages to authenticated;
grant all on public.english_assistant_sessions, public.english_assistant_messages,
  public.english_assistant_request_events, public.english_assistant_turns,
  public.english_assistant_configs, public.english_assistant_state to service_role;
grant usage, select on public.english_assistant_messages_sequence_seq,
  public.english_assistant_request_events_id_seq to service_role;
drop policy if exists own_english_assistant_sessions on public.english_assistant_sessions;
create policy own_english_assistant_sessions on public.english_assistant_sessions for select to authenticated
  using (owner_id = (select auth.uid()));
drop policy if exists own_english_assistant_messages on public.english_assistant_messages;
create policy own_english_assistant_messages on public.english_assistant_messages for select to authenticated
  using (exists (select 1 from public.english_assistant_sessions s where s.id = session_id and s.owner_id = (select auth.uid())));

create or replace function public.seed_english_config(p_settings jsonb,p_ciphertext text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare state public.english_assistant_state; config public.english_assistant_configs;
begin
  select * into state from english_assistant_state where id=1 for update;
  if state.active_config_id is not null then
    select * into config from english_assistant_configs where id=state.active_config_id;
    return to_jsonb(config);
  end if;
  if jsonb_typeof(p_settings) is distinct from 'object' or coalesce(char_length(trim(p_settings->>'model')),0)=0 or
    coalesce(p_settings->>'protocol','') not in ('openai-chat','openai-responses','anthropic') or
    coalesce(char_length(trim(p_ciphertext)),0)=0 then raise exception 'INVALID_ENGLISH_CONFIG'; end if;
  insert into english_assistant_configs(settings,api_key_ciphertext) values(p_settings,p_ciphertext) returning * into config;
  update english_assistant_state set active_config_id=config.id where id=1;
  return to_jsonb(config);
end;
$$;

create or replace function public.publish_english_config(p_settings jsonb,p_ciphertext text,p_actor uuid,
  p_enabled boolean,p_expected_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare state public.english_assistant_state; config public.english_assistant_configs;
begin
  if not exists(select 1 from admin_users where user_id=p_actor) then raise exception 'FORBIDDEN'; end if;
  select * into state from english_assistant_state where id=1 for update;
  if state.active_config_id is distinct from p_expected_id then raise exception 'CONFLICT'; end if;
  if jsonb_typeof(p_settings) is distinct from 'object' or coalesce(char_length(trim(p_settings->>'model')),0)=0 or
    coalesce(p_settings->>'protocol','') not in ('openai-chat','openai-responses','anthropic') or
    coalesce(char_length(trim(p_ciphertext)),0)=0 or p_enabled is null then raise exception 'INVALID_ENGLISH_CONFIG'; end if;
  insert into english_assistant_configs(settings,api_key_ciphertext,created_by) values(p_settings,p_ciphertext,p_actor) returning * into config;
  update english_assistant_state set active_config_id=config.id,enabled=p_enabled where id=1;
  return to_jsonb(config);
end;
$$;

create or replace function public.restore_english_session(p_owner uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.english_assistant_sessions;
begin
  select * into s from english_assistant_sessions where owner_id=p_owner for update;
  if not found then return null; end if;
  if s.locked_until is not null and s.locked_until <= now() then
    update english_assistant_messages set status='failed',error_code='interrupted'
      where session_id=s.id and status='pending';
    update english_assistant_sessions set lock_token=null,locked_until=null where id=s.id returning * into s;
  end if;
  return to_jsonb(s);
end;
$$;

create or replace function public.register_english_session(p_owner uuid,p_student_id text,p_initial_content text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sid text := upper(trim(p_student_id)); state public.english_assistant_state; s public.english_assistant_sessions;
begin
  if sid is null or sid !~ '^[0-9A-Z_-]{1,32}$' then raise exception 'INVALID_STUDENT_ID'; end if;
  select * into state from english_assistant_state where id=1 for update;
  select * into s from english_assistant_sessions where owner_id=p_owner for update;
  if found then
    if s.student_id<>sid then raise exception 'IDENTITY_BOUND'; end if;
    return restore_english_session(p_owner);
  end if;
  if exists(select 1 from english_assistant_sessions where student_id=sid) then raise exception 'STUDENT_UNAVAILABLE'; end if;
  if state.active_config_id is null then raise exception 'NOT_CONFIGURED'; end if;
  if not state.enabled then raise exception 'ENGLISH_PAUSED'; end if;
  if coalesce(char_length(trim(p_initial_content)),0) not between 1 and 50000 then raise exception 'INVALID_CONTENT'; end if;
  insert into english_assistant_sessions(owner_id,student_id,config_id) values(p_owner,sid,state.active_config_id) returning * into s;
  insert into english_assistant_messages(session_id,turn_id,role,content,status)
    values(s.id,gen_random_uuid(),'assistant',p_initial_content,'complete');
  return to_jsonb(s);
end;
$$;

create or replace function public.begin_english_turn(p_session uuid,p_owner uuid,p_turn uuid,p_content text,p_version int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.english_assistant_sessions; u public.english_assistant_messages;
  a public.english_assistant_messages; lease uuid; recent_count int;
begin
  if coalesce(char_length(trim(p_content)),0) < 1 or char_length(p_content) > 8000 then raise exception 'INVALID_CONTENT'; end if;
  select * into s from english_assistant_sessions where id=p_session for update;
  if not found or s.owner_id <> p_owner then raise exception 'FORBIDDEN'; end if;
  select * into u from english_assistant_messages where session_id=s.id and turn_id=p_turn and role='user';
  if found and u.content <> p_content then raise exception 'TURN_CONFLICT'; end if;
  select * into a from english_assistant_messages where session_id=s.id and turn_id=p_turn and role='assistant';
  if found and a.status='complete' then
    return jsonb_build_object('state','complete','user',to_jsonb(u),'assistant',to_jsonb(a),'english_progress',s.english_progress);
  end if;
  if not coalesce((select enabled from english_assistant_state where id=1),false) then raise exception 'ENGLISH_PAUSED'; end if;
  if p_version is null or p_version <> (s.english_progress->>'version')::int then raise exception 'ENGLISH_STATE_CONFLICT'; end if;
  if (s.english_progress->>'completed')::boolean then raise exception 'ENGLISH_COMPLETED'; end if;
  if s.locked_until > now() then raise exception 'BUSY'; end if;
  if s.locked_until is not null then
    update english_assistant_messages set status='failed',error_code='interrupted' where session_id=s.id and status='pending';
  end if;
  if exists(select 1 from english_assistant_messages where session_id=s.id and role='assistant' and status<>'complete' and turn_id<>p_turn) then raise exception 'BUSY'; end if;
  select count(*) into recent_count from english_assistant_request_events where session_id=s.id and created_at>now()-interval '1 minute';
  if recent_count >= 8 then raise exception 'RATE_LIMITED'; end if;
  if s.request_count >= 200 then raise exception 'SESSION_LIMIT'; end if;
  lease := gen_random_uuid();
  update english_assistant_sessions set lock_token=lease,locked_until=now()+interval '150 seconds',
    request_count=request_count+1,updated_at=now() where id=s.id;
  insert into english_assistant_request_events(session_id) values(s.id);
  insert into english_assistant_messages(session_id,turn_id,role,content,status) values(s.id,p_turn,'user',p_content,'complete')
    on conflict(session_id,turn_id,role) do nothing;
  insert into english_assistant_messages(session_id,turn_id,role,content,status) values(s.id,p_turn,'assistant','','pending')
    on conflict(session_id,turn_id,role) do update set content='',status='pending',error_code=null;
  select * into u from english_assistant_messages where session_id=s.id and turn_id=p_turn and role='user';
  select * into a from english_assistant_messages where session_id=s.id and turn_id=p_turn and role='assistant';
  return jsonb_build_object('state','acquired','lock_token',lease,'user',to_jsonb(u),'assistant',to_jsonb(a),'english_progress',s.english_progress);
end;
$$;

create or replace function public.save_english_reply(p_session uuid,p_turn uuid,p_lease uuid,p_expected jsonb,
  p_assessment jsonb,p_content text,p_status text default 'complete',p_error text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.english_assistant_sessions; u public.english_assistant_messages; a public.english_assistant_messages;
  next_state jsonb; stages text[] := array['bridge','objectives','pre_assessment','participatory','post_assessment','summary'];
  lengths int[] := array[1,1,3,4,2,1]; stage_index int; next_step int; achieved boolean; evidence text;
begin
  if p_status is null or p_status not in ('complete','failed') then raise exception 'INVALID_STATUS'; end if;
  if p_content is null or char_length(p_content)>50000 then raise exception 'INVALID_CONTENT'; end if;
  select * into s from english_assistant_sessions where id=p_session for update;
  if not found or p_lease is null or s.lock_token is distinct from p_lease or s.locked_until is null or s.locked_until <= now() then raise exception 'STALE_LEASE'; end if;
  if p_expected is distinct from s.english_progress then raise exception 'ENGLISH_STATE_CONFLICT'; end if;
  select * into a from english_assistant_messages where session_id=s.id and turn_id=p_turn and role='assistant' and status='pending';
  if not found then raise exception 'MISSING_REPLY'; end if;
  if p_status='failed' then
    update english_assistant_messages set content='',status='failed',error_code=p_error where id=a.id returning * into a;
    update english_assistant_sessions set lock_token=null,locked_until=null,updated_at=now() where id=s.id;
    return jsonb_build_object('message',to_jsonb(a),'english_progress',s.english_progress);
  end if;
  if coalesce(char_length(trim(p_content)),0)=0 or jsonb_typeof(p_assessment) is distinct from 'object' or
     jsonb_typeof(p_assessment->'achieved') is distinct from 'boolean' or
     jsonb_typeof(p_assessment->'evidence') is distinct from 'string' or
     jsonb_typeof(p_assessment->'feedback') is distinct from 'string' then raise exception 'INVALID_ENGLISH_ASSESSMENT'; end if;
  achieved := (p_assessment->>'achieved')::boolean;
  evidence := p_assessment->>'evidence';
  if char_length(evidence)>300 or char_length(p_assessment->>'feedback') not between 1 and 6000 then raise exception 'INVALID_ENGLISH_ASSESSMENT'; end if;
  if achieved and s.english_progress->>'stage' in ('participatory','post_assessment') then
    select * into u from english_assistant_messages where session_id=s.id and turn_id=p_turn and role='user';
    if u.id is null or coalesce(char_length(trim(evidence)),0)=0 or position(evidence in u.content)=0 then raise exception 'INVALID_ENGLISH_ASSESSMENT'; end if;
  end if;
  stage_index := array_position(stages,s.english_progress->>'stage');
  if stage_index is null or (s.english_progress->>'completed')::boolean then raise exception 'ENGLISH_COMPLETED'; end if;
  next_step := (s.english_progress->>'step')::int;
  if next_step<0 or next_step>=lengths[stage_index] then raise exception 'ENGLISH_STATE_CONFLICT'; end if;
  next_state := s.english_progress || jsonb_build_object('version',(s.english_progress->>'version')::int+1);
  if achieved then
    if stage_index=6 then next_state := next_state || '{"completed":true}'::jsonb;
    elsif next_step+1<lengths[stage_index] then next_state := next_state || jsonb_build_object('step',next_step+1);
    else next_state := next_state || jsonb_build_object('stage',stages[stage_index+1],'step',0); end if;
  end if;
  update english_assistant_messages set content=p_content,status='complete',error_code=null where id=a.id returning * into a;
  update english_assistant_sessions set english_progress=next_state,lock_token=null,locked_until=null,updated_at=now() where id=s.id;
  insert into english_assistant_turns(session_id,turn_id,before_state,after_state,assessment) values(s.id,p_turn,s.english_progress,next_state,p_assessment);
  return jsonb_build_object('message',to_jsonb(a),'english_progress',next_state);
end;
$$;

revoke all on function public.seed_english_config(jsonb,text) from public,anon,authenticated;
revoke all on function public.publish_english_config(jsonb,text,uuid,boolean,uuid) from public,anon,authenticated;
revoke all on function public.restore_english_session(uuid) from public,anon,authenticated;
revoke all on function public.register_english_session(uuid,text,text) from public,anon,authenticated;
revoke all on function public.begin_english_turn(uuid,uuid,uuid,text,int) from public,anon,authenticated;
revoke all on function public.save_english_reply(uuid,uuid,uuid,jsonb,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.seed_english_config(jsonb,text) to service_role;
grant execute on function public.publish_english_config(jsonb,text,uuid,boolean,uuid) to service_role;
grant execute on function public.restore_english_session(uuid) to service_role;
grant execute on function public.register_english_session(uuid,text,text) to service_role;
grant execute on function public.begin_english_turn(uuid,uuid,uuid,text,int) to service_role;
grant execute on function public.save_english_reply(uuid,uuid,uuid,jsonb,jsonb,text,text,text) to service_role;
notify pgrst, 'reload schema';
commit;
