-- Upgrade after 006. Keep existing English course snapshots and history.
-- Six BOPPPS stages stay fixed; administrators may edit their activities.
begin;

create or replace function public.english_curriculum_valid(p_curriculum jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare stage_key text; stage_value jsonb; activity jsonb; limits jsonb;
  total_activities int := 0;
  stages text[] := array['bridge','objectives','pre_assessment','participatory','post_assessment','summary'];
begin
  if p_curriculum is null or jsonb_typeof(p_curriculum) is distinct from 'object' then return false; end if;
  if not (p_curriculum ?& stages) or (select count(*) from jsonb_object_keys(p_curriculum)) <> 6 then return false; end if;
  foreach stage_key in array stages loop
    stage_value := p_curriculum->stage_key;
    if jsonb_typeof(stage_value) is distinct from 'object' then return false; end if;
    if not (stage_value ?& array['description','activities'])
      or (select count(*) from jsonb_object_keys(stage_value)) <> 2 then return false; end if;
    if jsonb_typeof(stage_value->'description') is distinct from 'string'
      or char_length(btrim(stage_value->>'description')) not between 1 and 300
      or jsonb_typeof(stage_value->'activities') is distinct from 'array' then return false; end if;
    if jsonb_array_length(stage_value->'activities') not between 1 and 8 then return false; end if;
    total_activities := total_activities + jsonb_array_length(stage_value->'activities');
    if total_activities > 24 then return false; end if;
    for activity in select value from jsonb_array_elements(stage_value->'activities') loop
      if jsonb_typeof(activity) is distinct from 'object' then return false; end if;
      if not (activity ?& array['title','prompt','criterion'])
        or exists(select 1 from jsonb_object_keys(activity) as fields(name)
          where name not in ('title','prompt','criterion','word_limit')) then return false; end if;
      if jsonb_typeof(activity->'title') is distinct from 'string'
        or char_length(btrim(activity->>'title')) not between 1 and 120
        or jsonb_typeof(activity->'prompt') is distinct from 'string'
        or char_length(btrim(activity->>'prompt')) not between 1 and 4000
        or jsonb_typeof(activity->'criterion') is distinct from 'string'
        or char_length(btrim(activity->>'criterion')) not between 1 and 2000 then return false; end if;
      if activity ? 'word_limit' and jsonb_typeof(activity->'word_limit') is distinct from 'null' then
        limits := activity->'word_limit';
        if jsonb_typeof(limits) is distinct from 'object' then return false; end if;
        if not (limits ?& array['min','max']) or (select count(*) from jsonb_object_keys(limits)) <> 2 then return false; end if;
        if jsonb_typeof(limits->'min') is distinct from 'number'
          or jsonb_typeof(limits->'max') is distinct from 'number' then return false; end if;
        if (limits->>'min')::numeric not between 1 and 1000
          or (limits->>'max')::numeric not between 1 and 1000
          or trunc((limits->>'min')::numeric) <> (limits->>'min')::numeric
          or trunc((limits->>'max')::numeric) <> (limits->>'max')::numeric
          or (limits->>'max')::numeric < (limits->>'min')::numeric then return false; end if;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;

-- Null means the original twelve activities [1,1,3,4,2,1]. No history rewrite.
alter table public.english_assistant_state add column if not exists curriculum jsonb;
alter table public.english_assistant_configs add column if not exists curriculum jsonb;
do $$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.english_assistant_state'::regclass
    and conname='english_assistant_state_curriculum') then
    alter table public.english_assistant_state add constraint english_assistant_state_curriculum
      check (curriculum is null or public.english_curriculum_valid(curriculum));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.english_assistant_configs'::regclass
    and conname='english_assistant_configs_curriculum') then
    alter table public.english_assistant_configs add constraint english_assistant_configs_curriculum
      check (curriculum is null or public.english_curriculum_valid(curriculum));
  end if;
end;
$$;

drop function if exists public.publish_english_course(uuid,bigint,boolean,text,text,text);
create or replace function public.publish_english_course(p_actor uuid,p_expected_revision bigint,
  p_enabled boolean,p_disclosure text,p_base_prompt text,p_personality_prompt text,p_curriculum jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare state public.english_assistant_state;
begin
  if not exists(select 1 from admin_users where user_id=p_actor) then raise exception 'FORBIDDEN'; end if;
  select * into state from english_assistant_state where id=1 for update;
  if not found then raise exception 'NOT_CONFIGURED'; end if;
  if p_expected_revision is null or state.revision <> p_expected_revision then raise exception 'CONFLICT'; end if;
  if p_enabled is null or coalesce(char_length(trim(p_disclosure)),0) not between 1 and 2000
    or coalesce(char_length(trim(p_base_prompt)),0) not between 1 and 10000
    or coalesce(char_length(trim(p_personality_prompt)),0) not between 1 and 10000
    or not public.english_curriculum_valid(p_curriculum) then raise exception 'INVALID_ENGLISH_COURSE'; end if;
  update english_assistant_state set revision=revision+1,enabled=p_enabled,
    disclosure=trim(p_disclosure),base_prompt=trim(p_base_prompt),personality_prompt=trim(p_personality_prompt),
    curriculum=p_curriculum where id=1 returning * into state;
  return to_jsonb(state);
end;
$$;

drop function if exists public.register_english_session(uuid,text,text);
create or replace function public.register_english_session(p_owner uuid,p_student_id text,p_initial_content text,
  p_expected_revision bigint default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sid text := upper(trim(p_student_id)); state public.english_assistant_state;
  shared public.study_state; source public.experiment_versions; s public.english_assistant_sessions;
  selected_group text; has_personality boolean; selected_config uuid; connection jsonb; effective jsonb;
  personality_text text; ciphertext text;
begin
  if sid is null or sid !~ '^[0-9A-Z_-]{1,32}$' then raise exception 'INVALID_STUDENT_ID'; end if;
  -- Serialize only English allocation, prompt publication and its counts.
  select * into state from english_assistant_state where id=1 for update;
  if not found then raise exception 'NOT_CONFIGURED'; end if;
  select * into s from english_assistant_sessions where owner_id=p_owner for update;
  if found then
    if s.student_id<>sid then raise exception 'IDENTITY_BOUND'; end if;
    return restore_english_session(p_owner);
  end if;
  if p_expected_revision is not null and state.revision <> p_expected_revision then raise exception 'CONFLICT'; end if;
  if exists(select 1 from english_assistant_sessions where student_id=sid) then raise exception 'STUDENT_UNAVAILABLE'; end if;
  if not state.enabled then raise exception 'ENGLISH_PAUSED'; end if;
  if coalesce(char_length(trim(p_initial_content)),0) not between 1 and 50000 then raise exception 'INVALID_CONTENT'; end if;

  -- Shared model connection is read-only. Original experiment publication may
  -- not replace it halfway through this enrollment; its enabled flag is ignored.
  select * into shared from study_state where id=1 for share;
  if shared.active_experiment_id is null then raise exception 'NOT_CONFIGURED'; end if;
  select * into source from experiment_versions where id=shared.active_experiment_id;
  connection := source.settings->'connections'->'deepseek';
  ciphertext := source.encrypted_keys->>'deepseek';
  personality_text := coalesce(state.personality_prompt,source.settings->>'personality_prompt');
  if jsonb_typeof(connection) is distinct from 'object'
    or coalesce(char_length(trim(connection->>'model')),0)=0
    or coalesce(char_length(trim(connection->>'api_base_url')),0)=0
    or coalesce(connection->>'protocol','') not in ('openai-chat','openai-responses','anthropic')
    or coalesce(char_length(trim(ciphertext)),0)=0
    or coalesce(char_length(trim(personality_text)),0) not between 1 and 10000
    or coalesce(char_length(trim(state.base_prompt)),0) not between 1 and 10000
    then raise exception 'NOT_CONFIGURED'; end if;

  select groups.code into selected_group from
    (values ('deepseek_personality'),('deepseek_control')) as groups(code)
    left join english_assistant_sessions existing on existing.group_code=groups.code
    group by groups.code order by count(existing.id),random() limit 1;
  has_personality := selected_group='deepseek_personality';
  -- Explicit field selection prevents original prompts, questions, public text
  -- or allocation state from being copied into this English learning snapshot.
  effective := jsonb_build_object(
    'protocol',connection->'protocol',
    'anthropic_auth',coalesce(connection->'anthropic_auth','"x-api-key"'::jsonb),
    'anthropic_workspace',coalesce(connection->'anthropic_workspace','""'::jsonb),
    'api_base_url',connection->'api_base_url',
    'api_url_mode',coalesce(connection->'api_url_mode','"base"'::jsonb),
    'model',connection->'model',
    'temperature',coalesce(connection->'temperature','null'::jsonb),
    'max_tokens',coalesce(connection->'max_tokens','2048'::jsonb),
    'token_parameter',coalesce(connection->'token_parameter','"max_tokens"'::jsonb),
    'title','英语助教','assistant_name','英语助教',
    'welcome_message','依据三份 PEEC 学习材料，按 BOPPPS 六阶段完成大学英语四六级段落写作学习。',
    'disclosure',state.disclosure,
    'system_prompt','BOPPPS PEEC teaching; the server composes the current activity and learning materials.'
  );
  insert into english_assistant_configs(settings,api_key_ciphertext,base_prompt,personality_prompt,
    prompt_revision,source_experiment_id,source_revision,curriculum)
    values(effective,ciphertext,state.base_prompt,case when has_personality then trim(personality_text) else null end,
      state.revision,source.id,source.revision,state.curriculum) returning id into selected_config;
  insert into english_assistant_sessions(owner_id,student_id,config_id,group_code,model_factor,personality,assigned_at)
    values(p_owner,sid,selected_config,selected_group,'deepseek',has_personality,now()) returning * into s;
  insert into english_assistant_messages(session_id,turn_id,role,content,status)
    values(s.id,gen_random_uuid(),'assistant',p_initial_content,'complete');
  return to_jsonb(s);
end;
$$;

create or replace function public.save_english_reply(p_session uuid,p_turn uuid,p_lease uuid,p_expected jsonb,
  p_assessment jsonb,p_content text,p_status text default 'complete',p_error text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.english_assistant_sessions; u public.english_assistant_messages; a public.english_assistant_messages;
  next_state jsonb; stages text[] := array['bridge','objectives','pre_assessment','participatory','post_assessment','summary'];
  lengths int[] := array[1,1,3,4,2,1]; stage_index int; next_step int; achieved boolean; evidence text;
  curriculum jsonb; activity_index int;
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
  select c.curriculum into curriculum from english_assistant_configs c where c.id=s.config_id;
  if curriculum is not null then
    for activity_index in 1..6 loop
      lengths[activity_index] := jsonb_array_length(curriculum->stages[activity_index]->'activities');
    end loop;
  end if;
  next_step := (s.english_progress->>'step')::int;
  if next_step<0 or next_step>=lengths[stage_index] then raise exception 'ENGLISH_STATE_CONFLICT'; end if;
  next_state := s.english_progress || jsonb_build_object('version',(s.english_progress->>'version')::int+1);
  if achieved then
    if next_step+1<lengths[stage_index] then next_state := next_state || jsonb_build_object('step',next_step+1);
    elsif stage_index=6 then next_state := next_state || '{"completed":true}'::jsonb;
    else next_state := next_state || jsonb_build_object('stage',stages[stage_index+1],'step',0); end if;
  end if;
  update english_assistant_messages set content=p_content,status='complete',error_code=null where id=a.id returning * into a;
  update english_assistant_sessions set english_progress=next_state,lock_token=null,locked_until=null,updated_at=now() where id=s.id;
  insert into english_assistant_turns(session_id,turn_id,before_state,after_state,assessment) values(s.id,p_turn,s.english_progress,next_state,p_assessment);
  return jsonb_build_object('message',to_jsonb(a),'english_progress',next_state);
end;
$$;

create table if not exists public.english_assistant_delete_audit (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  deleted_by uuid not null,
  deleted_at timestamptz not null default now(),
  student_id text not null,
  participant_code text not null,
  group_code text,
  prompt_revision bigint,
  messages_count bigint not null check (messages_count >= 0)
);
alter table public.english_assistant_delete_audit enable row level security;
revoke all on public.english_assistant_delete_audit from public,anon,authenticated;
grant all on public.english_assistant_delete_audit to service_role;

create or replace function public.admin_delete_english_conversation(p_conversation uuid,p_actor uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target public.english_assistant_sessions; revision bigint; message_total bigint;
begin
  if not exists(select 1 from public.admin_users where user_id=p_actor) then raise exception 'FORBIDDEN'; end if;
  -- Match English registration/publication lock order. Bloom state is untouched.
  perform 1 from public.english_assistant_state where id=1 for update;
  if not found then raise exception 'NOT_CONFIGURED'; end if;
  select * into target from public.english_assistant_sessions where id=p_conversation for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if target.locked_until > clock_timestamp() then raise exception 'CONVERSATION_BUSY'; end if;
  select prompt_revision into revision from public.english_assistant_configs where id=target.config_id;
  select count(*) into message_total from public.english_assistant_messages where session_id=target.id;
  insert into public.english_assistant_delete_audit(conversation_id,deleted_by,student_id,participant_code,
    group_code,prompt_revision,messages_count)
    values(target.id,p_actor,target.student_id,target.participant_code,target.group_code,revision,message_total);
  -- Existing foreign keys remove only this English session's messages, requests
  -- and assessment turns. Its owner and student binding are released together.
  delete from public.english_assistant_sessions where id=target.id;
  delete from public.english_assistant_configs c where c.id=target.config_id
    and not exists(select 1 from public.english_assistant_sessions s where s.config_id=c.id)
    and not exists(select 1 from public.english_assistant_state state where state.active_config_id=c.id);
  return target.id;
end;
$$;

revoke all on function public.english_curriculum_valid(jsonb) from public,anon,authenticated;
revoke all on function public.publish_english_course(uuid,bigint,boolean,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.register_english_session(uuid,text,text,bigint) from public,anon,authenticated;
revoke all on function public.save_english_reply(uuid,uuid,uuid,jsonb,jsonb,text,text,text) from public,anon,authenticated;
revoke all on function public.admin_delete_english_conversation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.english_curriculum_valid(jsonb) to service_role;
grant execute on function public.publish_english_course(uuid,bigint,boolean,text,text,text,jsonb) to service_role;
grant execute on function public.register_english_session(uuid,text,text,bigint) to service_role;
grant execute on function public.save_english_reply(uuid,uuid,uuid,jsonb,jsonb,text,text,text) to service_role;
grant execute on function public.admin_delete_english_conversation(uuid,uuid) to service_role;

commit;

notify pgrst, 'reload schema';
