-- Scalability indexes: composite and standalone indexes for the hot paths
-- that existing single-column indexes don't fully cover.
--
-- Safe to run on a live database: all IF NOT EXISTS, rollback block at bottom.

-- ============================================================================
-- 1. responses(cycle_id) standalone
-- ============================================================================
-- loadMySubmissions filters (user_id, cycle_id). The user_id index gets the
-- user's rows but still needs to scan them for cycle_id. The existing composite
-- (cycle_id, form_id) doesn't help because the leading column isn't selective
-- when form_id isn't in the WHERE. A bare cycle_id index lets the planner
-- bitmap-AND it with user_id when both are present, and serves
-- count_responses_per_cycle's GROUP BY cycle_id directly.
create index if not exists responses_by_cycle
  on responses (cycle_id);

-- ============================================================================
-- 2. responses(user_id, cycle_id) composite
-- ============================================================================
-- The exact pair loadMySubmissions, loadResponse, and the RLS ownership check
-- filter on. Replaces two single-column bitmap-ANDs with one index scan.
create index if not exists responses_by_user_cycle
  on responses (user_id, cycle_id);

-- ============================================================================
-- 3. answers(response_id, question_version_id) composite
-- ============================================================================
-- Every analytics RPC joins answers on response_id then groups or filters by
-- question_version_id. The two single-column indexes force a bitmap-AND or a
-- re-check; one composite gives an index-only path for the join + filter.
create index if not exists answers_by_response_version
  on answers (response_id, question_version_id);

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- drop index if exists answers_by_response_version;
-- drop index if exists responses_by_user_cycle;
-- drop index if exists responses_by_cycle;
