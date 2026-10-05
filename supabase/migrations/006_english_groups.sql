-- Upgrade after 005. Existing English sessions keep their history and remain
-- ungrouped. New English enrollments use two independent DeepSeek groups.
begin;

alter table public.english_assistant_state
  add column if not exists revision bigint not null default 0,
  add column if not exists base_prompt text not null default '请依据三份 PEEC 学习材料，以清晰、耐心的中文辅导大学英语四六级写作；例句使用英语，每次围绕当前学习活动给出具体反馈。',
  add column if not exists personality_prompt text;

-- Preserve the published disclosure once during the upgrade, then let the
-- English course administrator maintain it independently.
do $$
begin
  if not exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='english_assistant_state' and column_name='disclosure') then
    alter table public.english_assistant_state add column disclosure text not null
      default '学号用于关联英语助教学习记录。英语对话将独立保存；请勿输入姓名、联系方式或其他敏感个人信息。';
    update public.english_assistant_state s set disclosure=c.settings->>'disclosure'
      from public.english_assistant_configs c where c.id=s.active_config_id
      and char_length(trim(c.settings->>'disclosure')) between 1 and 2000;
  end if;
end;
$$;

alter table public.english_assistant_configs
  add column if not exists base_prompt text,
  add column if not exists personality_prompt text,
  add column if not exists prompt_revision bigint,
  add column if not exists source_experiment_id uuid references public.experiment_versions(id),
  add column if not exists source_revision bigint;

alter table public.english_assistant_sessions
  add column if not exists group_code text,
  add column if not exists model_factor text,
  add column if not exists personality boolean,
  add column if not exists assigned_at timestamptz;

do $$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.english_assistant_sessions'::regclass
    and conname='english_assistant_group_assignment') then
    alter table public.english_assistant_sessions add constraint english_assistant_group_assignment check (
      (group_code is null and model_factor is null and personality is null and assigned_at is null)
      or (group_code is not null and model_factor is not null and personality is not null and assigned_at is not null
        and model_factor='deepseek' and group_code in ('deepseek_personality','deepseek_control')
        and group_code=model_factor || case when personality then '_personality' else '_control' end)
    );
  end if;
end;
$$;
create index if not exists english_assistant_sessions_group
  on public.english_assistant_sessions(group_code) where group_code is not null;

create or replace function public.publish_english_course(p_actor uuid,p_expected_revision bigint,
  p_enabled boolean,p_disclosure text,p_base_prompt text,p_personality_prompt text)
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
    then raise exception 'INVALID_ENGLISH_COURSE'; end if;
  update english_assistant_state set revision=revision+1,enabled=p_enabled,
    disclosure=trim(p_disclosure),base_prompt=trim(p_base_prompt),personality_prompt=trim(p_personality_prompt)
    where id=1 returning * into state;
  return to_jsonb(state);
end;
$$;

create or replace function public.register_english_session(p_owner uuid,p_student_id text,p_initial_content text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sid text := upper(trim(p_student_id)); state public.english_assistant_state;
  shared public.study_state; source public.experiment_versions; s public.english_assistant_sessions;
  selected_group text; has_personality boolean; selected_config uuid; connection jsonb; effective jsonb;
  personality_text text; ciphertext text;
begin
  if sid is null or sid !~ '^[0-9A-Z_-]{1,32}$' then raise exception 'INVALID_STUDENT_ID'; end if;
  -- Serialize only English allocation, prompt publication and its counts.
  select * into state from english_assistant_state where id=1 for update;
  select * into s from english_assistant_sessions where owner_id=p_owner for update;
  if found then
    if s.student_id<>sid then raise exception 'IDENTITY_BOUND'; end if;
    return restore_english_session(p_owner);
  end if;
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
    prompt_revision,source_experiment_id,source_revision)
    values(effective,ciphertext,state.base_prompt,case when has_personality then trim(personality_text) else null end,
      state.revision,source.id,source.revision) returning id into selected_config;
  insert into english_assistant_sessions(owner_id,student_id,config_id,group_code,model_factor,personality,assigned_at)
    values(p_owner,sid,selected_config,selected_group,'deepseek',has_personality,now()) returning * into s;
  insert into english_assistant_messages(session_id,turn_id,role,content,status)
    values(s.id,gen_random_uuid(),'assistant',p_initial_content,'complete');
  return to_jsonb(s);
end;
$$;

create or replace view public.admin_english_conversation_records as
  select s.id,s.config_id,s.student_id,s.group_code,s.model_factor,s.personality,s.assigned_at,
    s.created_at,s.updated_at,s.request_count,s.participant_code,s.title,s.english_progress,
    c.source_experiment_id as experiment_id,c.source_revision as experiment_revision,c.prompt_revision
  from public.english_assistant_sessions s join public.english_assistant_configs c on c.id=s.config_id;
revoke all on public.admin_english_conversation_records from public,anon,authenticated;
grant select on public.admin_english_conversation_records to service_role;

create or replace function public.english_group_counts()
returns table(group_code text,enrolled bigint) language sql stable set search_path = public, pg_temp as $$
  select groups.code,count(s.id) from (values ('deepseek_personality'),('deepseek_control')) as groups(code)
    left join public.english_assistant_sessions s on s.group_code=groups.code
    group by groups.code order by groups.code;
$$;

-- Existing pre-group snapshots remain available for historical restoration.
-- New writes use shared DeepSeek and the independent course-prompt publisher.
revoke all on function public.seed_english_config(jsonb,text) from public,anon,authenticated,service_role;
revoke all on function public.publish_english_config(jsonb,text,uuid,boolean,uuid) from public,anon,authenticated,service_role;
revoke all on function public.publish_english_course(uuid,bigint,boolean,text,text,text) from public,anon,authenticated;
revoke all on function public.register_english_session(uuid,text,text) from public,anon,authenticated;
revoke all on function public.english_group_counts() from public,anon,authenticated;
grant execute on function public.publish_english_course(uuid,bigint,boolean,text,text,text) to service_role;
grant execute on function public.register_english_session(uuid,text,text) to service_role;
grant execute on function public.english_group_counts() to service_role;

commit;

notify pgrst, 'reload schema';
