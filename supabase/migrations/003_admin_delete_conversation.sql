-- Upgrade after 002_factorial_experiment.sql; safe to rerun.
-- This installs the deletion function only. It does NOT delete existing data.
begin;

create or replace function public.admin_delete_conversation(p_conversation uuid, p_actor uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target public.conversations;
begin
  if not exists(select 1 from public.admin_users where user_id=p_actor) then
    raise exception 'FORBIDDEN';
  end if;
  -- Use the same lock order as enrollment/publication, so releasing a student
  -- identifier and updating allocation counts happens as one transaction.
  perform 1 from public.study_state where id=1 for update;
  if not found then raise exception 'NOT_CONFIGURED'; end if;
  select * into target from public.conversations where id=p_conversation for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if target.locked_until > clock_timestamp() then raise exception 'CONVERSATION_BUSY'; end if;

  delete from public.participant_enrollments where conversation_id=target.id;
  -- The existing foreign keys cascade messages and request_events, not Auth
  -- accounts, other participants, or immutable model/experiment configurations.
  delete from public.conversations where id=target.id;
  return target.id;
end;
$$;

revoke all on function public.admin_delete_conversation(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_conversation(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
