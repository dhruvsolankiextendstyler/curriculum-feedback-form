-- =============================================================
-- 0010_hod_role.sql — the HOD role label, and nothing else
--
-- WHY THIS IS A MIGRATION OF ITS OWN
-- Postgres allows `alter type ... add value` inside a transaction block, but it
-- refuses to let the new label be USED until that transaction commits
-- ("unsafe use of new value of enum type"). Everything that mentions 'hod' — the
-- policies, the guard branch, the forms check constraint — therefore has to land
-- in a separate transaction, which is 0011_hod_scope.sql.
--
-- Run before 0011. Applying the two together fails.
-- =============================================================

alter type user_role add value if not exists 'hod';

comment on type user_role is
  'admin is global; hod administers one department (see 0011_hod_scope.sql); the other five are respondent types, one per form.';
