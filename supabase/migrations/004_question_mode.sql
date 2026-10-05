-- Upgrade after 003. Preserves existing prompts, configurations and participant data.
-- Apply the entire file before enabling question mode. Safe to run again.
begin;
alter table public.conversations add column if not exists question_progress jsonb;
create table if not exists public.question_turns (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  turn_id uuid not null,
  before_state jsonb not null,
  after_state jsonb not null,
  assessment jsonb,
  created_at timestamptz not null default now(),
  primary key(conversation_id, turn_id)
);
alter table public.question_turns enable row level security;
revoke all on public.question_turns from public, anon, authenticated;
grant all on public.question_turns to service_role;
-- question_progress deliberately has no authenticated column grant.

create or replace function public.question_mode_available()
returns boolean language sql stable set search_path = public, pg_temp as $$ select true $$;

create or replace function public.publish_experiment(p_settings jsonb, p_keys jsonb, p_actor uuid, p_expected_revision bigint, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.experiment_versions; current_revision bigint; factor text; has_personality boolean;
  effective jsonb; cfg uuid; base_text text; personality_text text; qm jsonb; q jsonb;
begin
  perform 1 from study_state where id=1 for update;
  if not exists(select 1 from admin_users where user_id=p_actor) then raise exception 'FORBIDDEN'; end if;
  select coalesce(e.revision,0) into current_revision from study_state s
    left join experiment_versions e on e.id=s.active_experiment_id where s.id=1;
  if p_expected_revision is null or current_revision <> p_expected_revision then raise exception 'CONFLICT'; end if;
  base_text := trim(p_settings->>'base_prompt');
  personality_text := trim(p_settings->>'personality_prompt');
  if coalesce(char_length(base_text),0) not between 1 and 10000 or
     coalesce(char_length(personality_text),0) not between 1 and 10000 then raise exception 'INVALID_EXPERIMENT'; end if;
  if p_settings ? 'question_mode' then
    qm := p_settings->'question_mode';
    if jsonb_typeof(qm) is distinct from 'object' or jsonb_typeof(qm->'enabled') is distinct from 'boolean' or
       jsonb_typeof(qm->'questions') is distinct from 'array' then raise exception 'INVALID_QUESTION_MODE'; end if;
    if jsonb_array_length(qm->'questions') <> 3 then raise exception 'INVALID_QUESTION_MODE'; end if;
    for q in select value from jsonb_array_elements(qm->'questions') loop
      if jsonb_typeof(q->'title') is distinct from 'string' or coalesce(length(trim(q->>'title')),0) not between 1 and 120 or
         jsonb_typeof(q->'prompt') is distinct from 'string' or coalesce(length(trim(q->>'prompt')),0) not between 1 and 4000 or
         jsonb_typeof(q->'reference') is distinct from 'string' or coalesce(length(trim(q->>'reference')),0) not between 1 and 6000 or
         coalesce(q->>'target_level','') not in ('remember','understand','apply','analyze','evaluate','create')
      then raise exception 'INVALID_QUESTION_MODE'; end if;
    end loop;
  end if;
  foreach factor in array array['deepseek','chatgpt'] loop
    if coalesce(length(trim(p_keys->>factor)),0)=0 or
       coalesce(length(trim(p_settings->'connections'->factor->>'model')),0)=0 or
       coalesce(p_settings->'connections'->factor->>'protocol','') not in ('openai-chat','openai-responses','anthropic')
    then raise exception 'INVALID_EXPERIMENT'; end if;
  end loop;
  insert into experiment_versions(settings,encrypted_keys,created_by)
    values(p_settings,p_keys,p_actor) returning * into v;
  foreach factor in array array['deepseek','chatgpt'] loop
    foreach has_personality in array array[true,false] loop
      effective := jsonb_build_object('title',p_settings->'title','assistant_name',p_settings->'assistant_name',
        'welcome_message',p_settings->'welcome_message','disclosure',p_settings->'disclosure') ||
        (p_settings->'connections'->factor) ||
        jsonb_build_object('system_prompt',base_text || case when has_personality then E'\n\n' || personality_text else '' end);
      if qm is not null then effective := effective || jsonb_build_object('question_mode',qm); end if;
      insert into config_versions(settings,api_key_ciphertext,created_by)
        values(effective,p_keys->>factor,p_actor) returning id into cfg;
      insert into experiment_groups(experiment_id,group_code,model_factor,personality,config_id)
        values(v.id,factor || case when has_personality then '_personality' else '_control' end,factor,has_personality,cfg);
    end loop;
  end loop;
  update study_state set active_experiment_id=v.id, active_config_id=null, enabled=p_enabled where id=1;
  return to_jsonb(v);
end;
$$;

create or replace function public.ensure_question_session(p_conversation uuid, p_owner uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.conversations; qm jsonb; q jsonb; progress jsonb; opening text;
begin
  select * into c from conversations where id=p_conversation for update;
  if not found or c.owner_id <> p_owner then raise exception 'FORBIDDEN'; end if;
  select settings->'question_mode' into qm from config_versions where id=c.config_id;
  if qm->>'enabled' is distinct from 'true' then return null; end if;
  if c.question_progress is not null then return c.question_progress; end if;
  if not (select enabled from study_state where id=1) then raise exception 'STUDY_PAUSED'; end if;
  if exists(select 1 from messages where conversation_id=c.id) then raise exception 'QUESTION_ALREADY_STARTED'; end if;
  q := qm->'questions'->0;
  if q->>'prompt' is null then raise exception 'INVALID_QUESTION_MODE'; end if;
  progress := jsonb_build_object('phase','guided','question_index',0,'guidance_turns',0,'version',0);
  opening := E'第一轮 · 引导学习\n\n### 第 1 题 / 3：' || (q->>'title') || E'\n\n' ||
    (q->>'prompt') || E'\n\n请先说说你的想法，我们会从你的回答开始。';
  insert into messages(conversation_id,turn_id,role,content,status)
    values(c.id,gen_random_uuid(),'assistant',opening,'complete');
  update conversations set question_progress=progress,title='题目问答 · ' || left(q->>'title',50),updated_at=now() where id=c.id;
  return progress;
end;
$$;

create or replace function public.begin_turn(p_conversation uuid, p_owner uuid, p_turn uuid, p_content text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.conversations; u public.messages; a public.messages; lease uuid; recent_count int; qm jsonb;
begin
  if char_length(trim(p_content)) < 1 or char_length(p_content) > 8000 then raise exception 'INVALID_CONTENT'; end if;
  select * into c from conversations where id=p_conversation for update;
  if not found or c.owner_id <> p_owner then raise exception 'FORBIDDEN'; end if;
  select * into u from messages where conversation_id=c.id and turn_id=p_turn and role='user';
  if found and u.content <> p_content then raise exception 'TURN_CONFLICT'; end if;
  select * into a from messages where conversation_id=c.id and turn_id=p_turn and role='assistant';
  if found and a.status='complete' then
    if u.id is null then raise exception 'TURN_CONFLICT'; end if;
    return jsonb_build_object('state','complete','user',to_jsonb(u),'assistant',to_jsonb(a),'question_progress',c.question_progress);
  end if;
  if c.question_progress->>'phase'='completed' then raise exception 'QUESTION_COMPLETED'; end if;
  select settings->'question_mode' into qm from config_versions where id=c.config_id;
  if qm->>'enabled'='true' and c.question_progress is null then raise exception 'QUESTION_NOT_STARTED'; end if;
  if not (select enabled from study_state where id=1) then raise exception 'STUDY_PAUSED'; end if;
  if c.locked_until > now() then raise exception 'BUSY'; end if;
  if exists(select 1 from messages where conversation_id=c.id and role='assistant' and status <> 'complete' and turn_id <> p_turn)
    then raise exception 'BUSY'; end if;
  select count(*) into recent_count from request_events where conversation_id=c.id and created_at > now()-interval '1 minute';
  if recent_count >= 8 then raise exception 'RATE_LIMITED'; end if;
  if c.request_count >= 200 then raise exception 'SESSION_LIMIT'; end if;
  lease := gen_random_uuid();
  update conversations set lock_token=lease,locked_until=now()+interval '150 seconds',
    request_count=request_count+1,updated_at=now(),
    title=case when title='尚未开始对话' then left(p_content,60) else title end where id=c.id;
  insert into request_events(conversation_id) values(c.id);
  insert into messages(conversation_id,turn_id,role,content,status)
    values(c.id,p_turn,'user',p_content,'complete') on conflict(conversation_id,turn_id,role) do nothing;
  insert into messages(conversation_id,turn_id,role,content,status)
    values(c.id,p_turn,'assistant','','pending')
    on conflict(conversation_id,turn_id,role) do update set content='',status='pending',error_code=null;
  select * into u from messages where conversation_id=c.id and turn_id=p_turn and role='user';
  select * into a from messages where conversation_id=c.id and turn_id=p_turn and role='assistant';
  return jsonb_build_object('state','acquired','lock_token',lease,'user',to_jsonb(u),'assistant',to_jsonb(a),'question_progress',c.question_progress);
end;
$$;

create or replace function public.begin_question_turn(p_conversation uuid, p_owner uuid, p_turn uuid, p_content text, p_version int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.conversations;
begin
  select * into c from conversations where id=p_conversation for update;
  if not found or c.owner_id <> p_owner then raise exception 'FORBIDDEN'; end if;
  if c.question_progress is null then raise exception 'QUESTION_NOT_STARTED'; end if;
  -- Recover a committed retry even after the question/round has advanced.
  if not exists(select 1 from messages where conversation_id=c.id and turn_id=p_turn and role='assistant' and status='complete') then
    if p_version is null or p_version <> (c.question_progress->>'version')::int then raise exception 'QUESTION_STATE_CONFLICT'; end if;
  end if;
  return begin_turn(p_conversation,p_owner,p_turn,p_content);
end;
$$;
revoke all on function public.begin_question_turn(uuid,uuid,uuid,text,int) from public, anon, authenticated;
grant execute on function public.begin_question_turn(uuid,uuid,uuid,text,int) to service_role;

create or replace function public.save_question_reply(p_conversation uuid, p_turn uuid, p_lease uuid,
  p_expected jsonb, p_assessment jsonb, p_content text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.conversations; before_state jsonb; after_state jsonb; result jsonb; qm jsonb;
  phase text; idx int; turns int; achieved boolean; student_answer text; levels text[] := array['remember','understand','apply','analyze','evaluate','create'];
begin
  select * into c from conversations where id=p_conversation and lock_token=p_lease for update;
  if not found then raise exception 'STALE_LEASE'; end if;
  before_state := c.question_progress;
  if before_state is null or before_state is distinct from p_expected then raise exception 'QUESTION_STATE_CONFLICT'; end if;
  phase := before_state->>'phase'; idx := (before_state->>'question_index')::int;
  turns := (before_state->>'guidance_turns')::int;
  if phase not in ('guided','retest') then raise exception 'QUESTION_COMPLETED'; end if;
  if phase='guided' then
    select settings->'question_mode' into qm from config_versions where id=c.config_id;
    if jsonb_typeof(p_assessment->'achieved') is distinct from 'boolean' or
       coalesce(p_assessment->>'observed_level','') not in ('unassessed','remember','understand','apply','analyze','evaluate','create') or
       coalesce(length(trim(p_assessment->>'reply')),0) not between 1 and 3000
    then raise exception 'INVALID_QUESTION_ASSESSMENT'; end if;
    achieved := (p_assessment->>'achieved')::boolean;
    if achieved then
      select content into student_answer from messages where conversation_id=c.id and turn_id=p_turn and role='user';
      if array_position(levels,p_assessment->>'observed_level') is null or
         array_position(levels,p_assessment->>'observed_level') < array_position(levels,qm->'questions'->idx->>'target_level') or
         coalesce(length(trim(p_assessment->>'evidence')),0) not between 1 and 300 or
         coalesce(strpos(student_answer,p_assessment->>'evidence'),0)=0
      then raise exception 'INVALID_QUESTION_ASSESSMENT'; end if;
    end if;
  else
    -- Retest never invokes a judge or stores an assessment.
    if p_assessment is not null then raise exception 'INVALID_QUESTION_ASSESSMENT'; end if;
    achieved := true;
  end if;
  after_state := before_state || jsonb_build_object('version',(before_state->>'version')::int+1);
  if phase='guided' and not achieved then
    after_state := after_state || jsonb_build_object('guidance_turns',turns+1);
  elsif idx < 2 then
    after_state := after_state || jsonb_build_object('question_index',idx+1,'guidance_turns',0);
  elsif phase='guided' then
    after_state := after_state || jsonb_build_object('phase','retest','question_index',0,'guidance_turns',0);
  else
    after_state := after_state || jsonb_build_object('phase','completed','guidance_turns',0);
  end if;
  if coalesce(length(trim(p_content)),0)=0 then raise exception 'INVALID_CONTENT'; end if;
  -- Message, assessment and progress commit together; a failed save advances nothing.
  result := save_reply(c.id,p_turn,p_lease,p_content,'complete',null);
  update conversations set question_progress=after_state where id=c.id;
  insert into question_turns(conversation_id,turn_id,before_state,after_state,assessment)
    values(c.id,p_turn,before_state,after_state,p_assessment);
  return jsonb_build_object('message',result,'question_progress',after_state);
end;
$$;

create or replace view public.admin_conversation_records as
  select c.id,c.participant_code,c.title,c.created_at,c.updated_at,c.config_id,c.request_count,
    e.student_id,e.group_code,e.experiment_id,e.assigned_at,g.model_factor,g.personality,v.revision as experiment_revision,
    c.question_progress
  from public.conversations c left join public.participant_enrollments e on e.conversation_id=c.id
  left join public.experiment_groups g on g.experiment_id=e.experiment_id and g.group_code=e.group_code
  left join public.experiment_versions v on v.id=e.experiment_id;
revoke all on function public.question_mode_available() from public, anon, authenticated;
revoke all on function public.ensure_question_session(uuid,uuid) from public, anon, authenticated;
revoke all on function public.save_question_reply(uuid,uuid,uuid,jsonb,jsonb,text) from public, anon, authenticated;
revoke all on function public.publish_experiment(jsonb,jsonb,uuid,bigint,boolean) from public, anon, authenticated;
revoke all on function public.begin_turn(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.question_mode_available() to service_role;
grant execute on function public.ensure_question_session(uuid,uuid) to service_role;
grant execute on function public.save_question_reply(uuid,uuid,uuid,jsonb,jsonb,text) to service_role;
grant execute on function public.publish_experiment(jsonb,jsonb,uuid,bigint,boolean) to service_role;
grant execute on function public.begin_turn(uuid,uuid,uuid,text) to service_role;
notify pgrst, 'reload schema';
commit;
