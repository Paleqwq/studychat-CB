-- Upgrade after 001_studychat.sql. Preserves all historical conversations.
-- Run the entire file once in Supabase SQL Editor before deploying the new app.
begin;
create table public.experiment_versions (
  id uuid primary key default gen_random_uuid(),
  revision bigint generated always as identity unique,
  settings jsonb not null,
  encrypted_keys jsonb not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.study_state add column active_experiment_id uuid references public.experiment_versions(id);
create table public.experiment_groups (
  experiment_id uuid not null references public.experiment_versions(id),
  group_code text not null check (group_code in ('deepseek_personality','deepseek_control','chatgpt_personality','chatgpt_control')),
  model_factor text not null check (model_factor in ('deepseek','chatgpt')),
  personality boolean not null,
  config_id uuid not null unique references public.config_versions(id),
  primary key (experiment_id, group_code),
  check (group_code = model_factor || case when personality then '_personality' else '_control' end)
);
create table public.participant_enrollments (
  student_id text primary key check (student_id ~ '^[0-9A-Z_-]{1,32}$'),
  owner_id uuid not null unique references auth.users(id),
  conversation_id uuid not null unique references public.conversations(id),
  experiment_id uuid not null,
  group_code text not null,
  assigned_at timestamptz not null default now(),
  foreign key (experiment_id, group_code) references public.experiment_groups(experiment_id, group_code)
);
create index participant_enrollments_group on public.participant_enrollments(group_code);
alter table public.experiment_versions enable row level security;
alter table public.experiment_groups enable row level security;
alter table public.participant_enrollments enable row level security;
revoke all on public.experiment_versions, public.experiment_groups, public.participant_enrollments from public, anon, authenticated;
grant all on public.experiment_versions, public.experiment_groups, public.participant_enrollments to service_role;
grant usage, select on public.experiment_versions_revision_seq to service_role;

-- Direct authenticated REST queries cannot expose config identifiers or leases.
revoke select on public.conversations from authenticated;
grant select(id,owner_id,participant_code,title,created_at,updated_at,request_count,locked_until)
  on public.conversations to authenticated;
-- Retire the old creation/publishing entry points; existing data remains untouched.
revoke execute on function public.publish_config(jsonb,text,uuid,bigint,boolean) from service_role;
revoke execute on function public.get_or_create_conversation(uuid) from service_role;

create function public.publish_experiment(p_settings jsonb, p_keys jsonb, p_actor uuid, p_expected_revision bigint, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.experiment_versions; current_revision bigint; factor text; has_personality boolean;
  effective jsonb; cfg uuid; base_text text; personality_text text;
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
create function public.restore_conversation(p_owner uuid)
returns public.conversations language plpgsql security definer set search_path = public, pg_temp as $$
declare result public.conversations;
begin
  select * into result from conversations where owner_id=p_owner for update;
  if not found then return null; end if;
  if result.locked_until is not null and result.locked_until < now() then
    update conversations set lock_token=null, locked_until=null where id=result.id returning * into result;
    update messages set status='failed', error_code='interrupted' where conversation_id=result.id and status='pending';
  end if;
  return result;
end;
$$;
create function public.register_participant(p_owner uuid, p_student_id text)
returns public.conversations language plpgsql security definer set search_path = public, pg_temp as $$
declare sid text := upper(trim(p_student_id)); state public.study_state; enrollment public.participant_enrollments;
  selected_group text; selected_config uuid; result public.conversations;
begin
  if sid is null or sid !~ '^[0-9A-Z_-]{1,32}$' then raise exception 'INVALID_STUDENT_ID'; end if;
  -- Serializes enrollment with publication and other enrollments until commit.
  select * into state from study_state where id=1 for update;
  select * into enrollment from participant_enrollments where owner_id=p_owner;
  if found then
    if enrollment.student_id <> sid then raise exception 'IDENTITY_BOUND'; end if;
    return restore_conversation(p_owner);
  end if;
  if exists(select 1 from participant_enrollments where student_id=sid) then raise exception 'STUDENT_UNAVAILABLE'; end if;
  if exists(select 1 from conversations where owner_id=p_owner) then raise exception 'LEGACY_SESSION'; end if;
  if state.active_experiment_id is null then raise exception 'NOT_CONFIGURED'; end if;
  if not state.enabled then raise exception 'STUDY_PAUSED'; end if;
  if (select count(*) from experiment_groups where experiment_id=state.active_experiment_id) <> 4 then raise exception 'NOT_CONFIGURED'; end if;
  -- Min-count random allocation across all revisions, based on registrations.
  select g.group_code,g.config_id into selected_group,selected_config
    from experiment_groups g left join participant_enrollments e on e.group_code=g.group_code
    where g.experiment_id=state.active_experiment_id
    group by g.group_code,g.config_id order by count(e.student_id),random() limit 1;
  insert into conversations(owner_id,config_id) values(p_owner,selected_config) returning * into result;
  insert into participant_enrollments(student_id,owner_id,conversation_id,experiment_id,group_code)
    values(sid,p_owner,result.id,state.active_experiment_id,selected_group);
  return result;
end;
$$;
create view public.admin_conversation_records as
  select c.id,c.participant_code,c.title,c.created_at,c.updated_at,c.config_id,c.request_count,
    e.student_id,e.group_code,e.experiment_id,e.assigned_at,g.model_factor,g.personality,v.revision as experiment_revision
  from public.conversations c left join public.participant_enrollments e on e.conversation_id=c.id
  left join public.experiment_groups g on g.experiment_id=e.experiment_id and g.group_code=e.group_code
  left join public.experiment_versions v on v.id=e.experiment_id;
revoke all on public.admin_conversation_records from public, anon, authenticated;
grant select on public.admin_conversation_records to service_role;
create function public.experiment_group_counts()
returns table(group_code text, enrolled bigint) language sql stable set search_path = public, pg_temp as $$
  select group_code,count(*) from participant_enrollments group by group_code;
$$;
revoke all on function public.publish_experiment(jsonb,jsonb,uuid,bigint,boolean) from public, anon, authenticated;
revoke all on function public.restore_conversation(uuid) from public, anon, authenticated;
revoke all on function public.register_participant(uuid,text) from public, anon, authenticated;
revoke all on function public.experiment_group_counts() from public, anon, authenticated;
grant execute on function public.publish_experiment(jsonb,jsonb,uuid,bigint,boolean) to service_role;
grant execute on function public.restore_conversation(uuid) to service_role;
grant execute on function public.register_participant(uuid,text) to service_role;
grant execute on function public.experiment_group_counts() to service_role;
commit;
