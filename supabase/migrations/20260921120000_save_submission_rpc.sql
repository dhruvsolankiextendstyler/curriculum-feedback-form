-- Atomic submission save (scalability + correctness).
--
-- Replaces the client's 3-4 sequential round trips per save with one RPC that
-- runs the whole write in a single transaction / single connection checkout.
-- Under a submission burst (a cycle opening for thousands of respondents at
-- once) connection HOLD TIME and checkout COUNT are what saturate the pool, not
-- query cost — so collapsing the round trips is the lever, not adding indexes.
--
-- Correctness bonus: the old flow inserted the response, then inserted answers
-- in a separate request. A timeout between the two left a response row with no
-- answers, and the one-per-course unique index then blocked the retry with
-- "you have already submitted". One transaction rolls the whole thing back.
--
-- The client still computes the resave PLAN (planAnswerWrite, in validation.js):
-- which stored rows to keep, delete, or insert. That logic preserves answers to
-- soft-deleted questions and the question version each answer was given against
-- (FR-31, FR-32) and is unit-tested in plain Node. This function does NOT
-- re-derive it — it just applies the plan, so there is no second copy to drift.
--
-- security invoker: every insert/update/delete below still passes through the
-- existing RLS policies (ownership, cycle_is_open, role match). No guarantee is
-- weakened; a closed cycle still raises 42501 and rolls back.
--
-- Safe to run on a live database: additive, with a rollback block at the bottom.

create or replace function save_submission(
  p_response_id  uuid,
  p_form_id      uuid,
  p_cycle_id     uuid,
  p_program      text,
  p_course_title text,
  p_delete_ids   uuid[],
  p_insert_rows  jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid := p_response_id;
begin
  -- New submission: insert. user_id is auth.uid(), never a client param — the
  -- RLS insert policy checks the same, so trusting the client would only ever
  -- fail the check. Editing: touch meta only when the form carried any.
  if v_id is null then
    insert into public.responses (user_id, form_id, cycle_id, program, course_title)
    values ((select auth.uid()), p_form_id, p_cycle_id, p_program, p_course_title)
    returning id into v_id;
  elsif p_program is not null or p_course_title is not null then
    update public.responses
    set program      = coalesce(p_program, program),
        course_title = coalesce(p_course_title, course_title)
    where id = v_id;
  end if;

  -- Deletes before inserts so a changed answer can reuse its version id without
  -- tripping the unique (response_id, question_version_id) pair. Scoping the
  -- delete to this response stops a client passing answer ids from another of
  -- its own open responses (RLS already blocks other users' rows).
  if array_length(p_delete_ids, 1) is not null then
    delete from public.answers
    where id = any(p_delete_ids)
      and response_id = v_id;
  end if;

  if p_insert_rows is not null and jsonb_array_length(p_insert_rows) > 0 then
    insert into public.answers
      (response_id, question_version_id, value_numeric, value_text, value_options)
    select
      v_id,
      x.question_version_id,
      x.value_numeric,
      x.value_text,
      case
        when x.value_options is null or jsonb_typeof(x.value_options) = 'null' then null
        else array(select jsonb_array_elements_text(x.value_options))
      end
    from jsonb_to_recordset(p_insert_rows) as x(
      question_version_id uuid,
      value_numeric       numeric,
      value_text          text,
      value_options       jsonb
    );
  end if;

  return v_id;
end;
$$;

-- Respondents call this; nothing else should.
revoke all on function save_submission(uuid, uuid, uuid, text, text, uuid[], jsonb)
  from public, anon;
grant execute on function save_submission(uuid, uuid, uuid, text, text, uuid[], jsonb)
  to authenticated, service_role;

notify pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK (run this block to undo everything above)
-- ============================================================================
-- drop function if exists save_submission(uuid, uuid, uuid, text, text, uuid[], jsonb);
