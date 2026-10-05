-- Upgrade after 007. Learning pauses belong to one English session only.
-- Existing teaching progress and histories are preserved. Safe to run again.
begin;

alter table public.english_assistant_sessions
  add column if not exists english_paused boolean not null default false;

-- Controls are recorded separately from teaching assessments, and are removed
-- with their session. Message pairs remain in the normal conversation history.
create table if not exists public.english_assistant_learning_controls (
  session_id uuid not null references public.english_assistant_sessions(id) on delete cascade,
  turn_id uuid not null,
  paused boolean not null,
  before_state jsonb not null,
  after_state jsonb not null,
  created_at timestamptz not null default now(),
  primary key(session_id,turn_id)
);
create index if not exists english_assistant_controls_recent
  on public.english_assistant_learning_controls(session_id,created_at desc);
alter table public.english_assistant_learning_controls enable row level security;
revoke all on public.english_assistant_learning_controls from public,anon,authenticated;
grant all on public.english_assistant_learning_controls to service_role;

create or replace function public.set_english_learning_pause(p_session uuid,p_owner uuid,p_turn uuid,
  p_content text,p_version int,p_paused boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.english_assistant_sessions; control public.english_assistant_learning_controls;
  u public.english_assistant_messages; a public.english_assistant_messages;
  next_state jsonb; reply text; recent_control_count int;
begin
  if coalesce(char_length(trim(p_content)),0)<1 or char_length(p_content)>8000 then raise exception 'INVALID_CONTENT'; end if;
  if p_paused is null or p_turn is null then raise exception 'INVALID_ENGLISH_CONTROL'; end if;
  select * into s from english_assistant_sessions where id=p_session for update;
  if not found or s.owner_id is distinct from p_owner then raise exception 'FORBIDDEN'; end if;
  select * into control from english_assistant_learning_controls where session_id=s.id and turn_id=p_turn;
  if found then
    select * into u from english_assistant_messages where session_id=s.id and turn_id=p_turn and role='user';
    select * into a from english_assistant_messages where session_id=s.id and turn_id=p_turn and role='assistant';
    if control.paused is distinct from p_paused or u.id is null or u.content is distinct from p_content
      or a.id is null or a.status is distinct from 'complete' then raise exception 'TURN_CONFLICT'; end if;
    return jsonb_build_object('user',to_jsonb(u),'assistant',to_jsonb(a),
      'english_progress',s.english_progress,'english_paused',s.english_paused);
  end if;
  -- A teaching turn cannot be repurposed as a learning control, including a
  -- failed turn. Controls use their own turn id and may bypass failed pairs.
  if exists(select 1 from english_assistant_messages where session_id=s.id and turn_id=p_turn)
    then raise exception 'TURN_CONFLICT'; end if;
  if p_version is null or p_version <> (s.english_progress->>'version')::int then raise exception 'ENGLISH_STATE_CONFLICT'; end if;
  if (s.english_progress->>'completed')::boolean then raise exception 'ENGLISH_COMPLETED'; end if;
  if s.locked_until > now() then raise exception 'BUSY'; end if;
  -- Controls have their own rolling limit, independent of teaching requests.
  -- Successful retries above return before this check and consume no event.
  select count(*) into recent_control_count from english_assistant_learning_controls
    where session_id=s.id and created_at>now()-interval '1 minute';
  if recent_control_count>=8 then raise exception 'RATE_LIMITED'; end if;
  if s.locked_until is not null then
    update english_assistant_messages set status='failed',error_code='interrupted'
      where session_id=s.id and status='pending';
  end if;
  next_state := s.english_progress || jsonb_build_object('version',(s.english_progress->>'version')::int+1);
  reply := case when p_paused
    then '可以先休息一下。本次学习已暂停，当前题目和进度已保留。准备好后，点击“继续学习”即可从这里继续。'
    else '欢迎回来，学习已继续。请接着完成暂停前的当前活动。' end;
  insert into english_assistant_messages(session_id,turn_id,role,content,status)
    values(s.id,p_turn,'user',p_content,'complete') returning * into u;
  insert into english_assistant_messages(session_id,turn_id,role,content,status)
    values(s.id,p_turn,'assistant',reply,'complete') returning * into a;
  insert into english_assistant_learning_controls(session_id,turn_id,paused,before_state,after_state)
    values(s.id,p_turn,p_paused,s.english_progress,next_state);
  update english_assistant_sessions set english_paused=p_paused,english_progress=next_state,
    lock_token=null,locked_until=null,updated_at=now() where id=s.id;
  return jsonb_build_object('user',to_jsonb(u),'assistant',to_jsonb(a),
    'english_progress',next_state,'english_paused',p_paused);
end;
$$;

create or replace function public.begin_english_turn(p_session uuid,p_owner uuid,p_turn uuid,p_content text,p_version int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.english_assistant_sessions; u public.english_assistant_messages;
  a public.english_assistant_messages; lease uuid; recent_count int;
begin
  if coalesce(char_length(trim(p_content)),0) < 1 or char_length(p_content) > 8000 then raise exception 'INVALID_CONTENT'; end if;
  select * into s from english_assistant_sessions where id=p_session for update;
  if not found or s.owner_id is distinct from p_owner then raise exception 'FORBIDDEN'; end if;
  select * into u from english_assistant_messages where session_id=s.id and turn_id=p_turn and role='user';
  if found and u.content <> p_content then raise exception 'TURN_CONFLICT'; end if;
  select * into a from english_assistant_messages where session_id=s.id and turn_id=p_turn and role='assistant';
  if found and a.status='complete' then
    return jsonb_build_object('state','complete','user',to_jsonb(u),'assistant',to_jsonb(a),'english_progress',s.english_progress,'english_paused',s.english_paused);
  end if;
  if s.english_paused then raise exception 'ENGLISH_LEARNING_PAUSED'; end if;
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
  return jsonb_build_object('state','acquired','lock_token',lease,'user',to_jsonb(u),'assistant',to_jsonb(a),'english_progress',s.english_progress,'english_paused',s.english_paused);
end;
$$;

-- CREATE OR REPLACE resets view options. Preserve the existing invoker/barrier
-- settings while appending the new column in the original column order.
do $view$
declare prior_options text[];
begin
  select reloptions into prior_options from pg_class
    where oid='public.admin_english_conversation_records'::regclass;
  execute $definition$create or replace view public.admin_english_conversation_records as
  select s.id,s.config_id,s.student_id,s.group_code,s.model_factor,s.personality,s.assigned_at,
    s.created_at,s.updated_at,s.request_count,s.participant_code,s.title,s.english_progress,
    c.source_experiment_id as experiment_id,c.source_revision as experiment_revision,c.prompt_revision,
    s.english_paused
  from public.english_assistant_sessions s join public.english_assistant_configs c on c.id=s.config_id$definition$;
  if coalesce(cardinality(prior_options),0)>0 then
    execute format('alter view public.admin_english_conversation_records set (%s)',array_to_string(prior_options,', '));
  end if;
end;
$view$;
revoke all on public.admin_english_conversation_records from public,anon,authenticated;
grant select on public.admin_english_conversation_records to service_role;

revoke all on function public.set_english_learning_pause(uuid,uuid,uuid,text,int,boolean) from public,anon,authenticated;
revoke all on function public.begin_english_turn(uuid,uuid,uuid,text,int) from public,anon,authenticated;
grant execute on function public.set_english_learning_pause(uuid,uuid,uuid,text,int,boolean) to service_role;
grant execute on function public.begin_english_turn(uuid,uuid,uuid,text,int) to service_role;

commit;

notify pgrst, 'reload schema';
