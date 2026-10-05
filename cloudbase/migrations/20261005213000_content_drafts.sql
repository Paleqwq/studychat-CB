-- Add private teaching-content drafts to an existing CloudBase deployment.
-- Apply as a NEW migration. This does not copy model settings or session data.
-- One atomic statement is compatible with CloudBase's PG migration channel.
DO $studychat_content_drafts$
BEGIN
create or replace function public.experiment_content_valid(p_content jsonb)
returns boolean language plpgsql immutable set search_path = public, pg_temp as $content_validation$
declare field_name text; max_length int; qm jsonb; question jsonb;
begin
  if p_content is null or jsonb_typeof(p_content) is distinct from 'object' then return false; end if;
  if not (p_content ?& array['title','assistant_name','welcome_message','disclosure','base_prompt','personality_prompt'])
    or exists(select 1 from jsonb_object_keys(p_content) as fields(name)
      where name not in ('title','assistant_name','welcome_message','disclosure','base_prompt','personality_prompt','question_mode'))
    then return false; end if;
  foreach field_name in array array['title','assistant_name','welcome_message','disclosure','base_prompt','personality_prompt'] loop
    max_length := case field_name when 'title' then 80 when 'assistant_name' then 40
      when 'welcome_message' then 2000 when 'disclosure' then 2000 else 10000 end;
    if jsonb_typeof(p_content->field_name) is distinct from 'string'
      or coalesce(char_length(trim(p_content->>field_name)),0) not between 1 and max_length then return false; end if;
  end loop;
  if p_content ? 'question_mode' then
    qm := p_content->'question_mode';
    if jsonb_typeof(qm) is distinct from 'object' then return false; end if;
    if not (qm ?& array['enabled','questions']) or (select count(*) from jsonb_object_keys(qm)) <> 2
      or jsonb_typeof(qm->'enabled') is distinct from 'boolean'
      or jsonb_typeof(qm->'questions') is distinct from 'array' then return false; end if;
    if jsonb_array_length(qm->'questions') <> 3 then return false; end if;
    for question in select value from jsonb_array_elements(qm->'questions') loop
      if jsonb_typeof(question) is distinct from 'object' then return false; end if;
      if not (question ?& array['title','prompt','reference','target_level'])
        or (select count(*) from jsonb_object_keys(question)) <> 4
        or jsonb_typeof(question->'title') is distinct from 'string'
        or coalesce(char_length(trim(question->>'title')),0) not between 1 and 120
        or jsonb_typeof(question->'prompt') is distinct from 'string'
        or coalesce(char_length(trim(question->>'prompt')),0) not between 1 and 4000
        or jsonb_typeof(question->'reference') is distinct from 'string'
        or coalesce(char_length(trim(question->>'reference')),0) not between 1 and 6000
        or coalesce(question->>'target_level','') not in ('remember','understand','apply','analyze','evaluate','create')
        then return false; end if;
    end loop;
  end if;
  return true;
end;
$content_validation$;

alter table public.study_state
  add column if not exists content_draft jsonb,
  add column if not exists draft_revision bigint not null default 0,
  add column if not exists draft_enabled boolean not null default false,
  add column if not exists draft_updated_at timestamptz,
  add column if not exists draft_updated_by uuid references public.admin_users(user_id) on delete set null;
if not exists(select 1 from pg_constraint where conrelid='public.study_state'::regclass and conname='study_content_draft_valid') then
  alter table public.study_state add constraint study_content_draft_valid
    check (draft_revision >= 0 and (content_draft is null or public.experiment_content_valid(content_draft))
      and (content_draft is not null or not draft_enabled));
end if;

create or replace function public.save_content_draft(p_content jsonb,p_actor uuid,
  p_expected_draft_revision bigint,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $save_content$
declare state public.study_state;
begin
  if not exists(select 1 from admin_users where user_id=p_actor) then raise exception 'FORBIDDEN'; end if;
  select * into state from study_state where id=1 for update;
  if not found then raise exception 'NOT_CONFIGURED'; end if;
  if state.active_experiment_id is not null then raise exception 'CONTENT_DRAFT_UNAVAILABLE'; end if;
  if p_expected_draft_revision is null or state.draft_revision <> p_expected_draft_revision then raise exception 'CONFLICT'; end if;
  if p_enabled is null or not public.experiment_content_valid(p_content) then raise exception 'INVALID_CONTENT_DRAFT'; end if;
  update study_state set content_draft=p_content,draft_enabled=p_enabled,draft_revision=draft_revision+1,
    draft_updated_at=now(),draft_updated_by=p_actor where id=1 returning * into state;
  return jsonb_build_object('content',state.content_draft,'draft_revision',state.draft_revision,
    'enabled',state.draft_enabled,'updated_at',state.draft_updated_at);
end;
$save_content$;

-- The existing publish_experiment updates this pointer only after all four
-- valid model/group snapshots are created. Clear drafts in that SAME transaction.
create or replace function public.clear_content_draft_on_publish()
returns trigger language plpgsql set search_path = public, pg_temp as $clear_content$
begin
  if new.active_experiment_id is not null and new.active_experiment_id is distinct from old.active_experiment_id then
    if old.content_draft is not null then new.draft_revision := old.draft_revision+1; end if;
    new.content_draft := null; new.draft_enabled := false;
    new.draft_updated_at := null; new.draft_updated_by := null;
  end if;
  return new;
end;
$clear_content$;
drop trigger if exists study_clear_content_draft_on_publish on public.study_state;
create trigger study_clear_content_draft_on_publish before update of active_experiment_id on public.study_state
  for each row execute function public.clear_content_draft_on_publish();

-- New clients compare BOTH revisions during first publication. Existing
-- published-config clients retain the original publish_experiment entry point.
create or replace function public.publish_experiment_with_content_draft(p_settings jsonb,p_keys jsonb,p_actor uuid,
  p_expected_revision bigint,p_enabled boolean,p_expected_draft_revision bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $publish_content$
declare state public.study_state;
begin
  if not exists(select 1 from admin_users where user_id=p_actor) then raise exception 'FORBIDDEN'; end if;
  select * into state from study_state where id=1 for update;
  if not found then raise exception 'NOT_CONFIGURED'; end if;
  if state.active_experiment_id is not null then raise exception 'CONTENT_DRAFT_UNAVAILABLE'; end if;
  if p_expected_draft_revision is null or state.draft_revision <> p_expected_draft_revision then raise exception 'CONFLICT'; end if;
  return public.publish_experiment(p_settings,p_keys,p_actor,p_expected_revision,p_enabled);
end;
$publish_content$;

revoke all on function public.experiment_content_valid(jsonb) from public,anon,authenticated;
revoke all on function public.save_content_draft(jsonb,uuid,bigint,boolean) from public,anon,authenticated;
revoke all on function public.clear_content_draft_on_publish() from public,anon,authenticated;
revoke all on function public.publish_experiment_with_content_draft(jsonb,jsonb,uuid,bigint,boolean,bigint) from public,anon,authenticated;
grant execute on function public.experiment_content_valid(jsonb) to service_role;
grant execute on function public.save_content_draft(jsonb,uuid,bigint,boolean) to service_role;
grant execute on function public.clear_content_draft_on_publish() to service_role;
grant execute on function public.publish_experiment_with_content_draft(jsonb,jsonb,uuid,bigint,boolean,bigint) to service_role;
END;
$studychat_content_drafts$;
