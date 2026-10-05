-- Upgrade after 20261005213000_content_drafts.sql. Keep its applied snapshot intact.
-- Legacy first-publication requests cannot overwrite a saved teaching draft.
DO $studychat_draft_publish_guard$
BEGIN
create or replace function public.clear_content_draft_on_publish()
returns trigger language plpgsql set search_path = public, pg_temp as $guard_draft$
begin
  if new.active_experiment_id is not null and new.active_experiment_id is distinct from old.active_experiment_id then
    if old.content_draft is not null then
      if pg_catalog.current_setting('studychat.content_draft_revision',true) is distinct from old.draft_revision::text then
        raise exception 'CONFLICT';
      end if;
      new.draft_revision := old.draft_revision+1;
    end if;
    new.content_draft := null; new.draft_enabled := false;
    new.draft_updated_at := null; new.draft_updated_by := null;
  end if;
  return new;
end;
$guard_draft$;

create or replace function public.publish_experiment_with_content_draft(p_settings jsonb,p_keys jsonb,p_actor uuid,
  p_expected_revision bigint,p_enabled boolean,p_expected_draft_revision bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $publish_checked_draft$
declare state public.study_state;
begin
  if not exists(select 1 from admin_users where user_id=p_actor) then raise exception 'FORBIDDEN'; end if;
  select * into state from study_state where id=1 for update;
  if not found then raise exception 'NOT_CONFIGURED'; end if;
  if state.active_experiment_id is not null then raise exception 'CONTENT_DRAFT_UNAVAILABLE'; end if;
  if p_expected_draft_revision is null or state.draft_revision <> p_expected_draft_revision then raise exception 'CONFLICT'; end if;
  -- The row lock prevents another writer from changing this checked revision.
  -- Transaction-local state is discarded on commit or rollback, including an
  -- error from publish_experiment, and cannot leak to a pooled next request.
  perform pg_catalog.set_config('studychat.content_draft_revision',state.draft_revision::text,true);
  return public.publish_experiment(p_settings,p_keys,p_actor,p_expected_revision,p_enabled);
end;
$publish_checked_draft$;

revoke all on function public.clear_content_draft_on_publish() from public,anon,authenticated;
revoke all on function public.publish_experiment_with_content_draft(jsonb,jsonb,uuid,bigint,boolean,bigint) from public,anon,authenticated;
grant execute on function public.clear_content_draft_on_publish() to service_role;
grant execute on function public.publish_experiment_with_content_draft(jsonb,jsonb,uuid,bigint,boolean,bigint) to service_role;
END;
$studychat_draft_publish_guard$;
