-- =============================================================
-- 0001_schema.sql — Curriculum Feedback Platform core schema
-- Implements PRD §9 / §9.1. Run before 0002 (RLS) and 0003 (seed).
--
-- Naming note: the PRD calls the people table `users`. Supabase already
-- owns `auth.users`, so ours is `public.profiles`, keyed 1:1 to auth.users.id.
-- =============================================================

-- ---------- enums ----------
create type user_role as enum (
  'admin', 'academic_peer', 'student', 'employer', 'alumni', 'faculty'
);

create type user_status as enum ('active', 'inactive');

create type invite_status as enum ('pending', 'sent', 'accepted');

create type question_type as enum (
  'rating', 'single_select', 'multi_select', 'short_text', 'long_text'
);

-- ---------- profiles (PRD: users) ----------
create table profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text        not null unique,
  full_name     text,
  role          user_role   not null,
  status        user_status not null default 'active',
  invite_status invite_status not null default 'pending',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table profiles is 'PRD §9 users. One row per auth.users row.';

-- ---------- academic cycles ----------
create table academic_cycles (
  id         uuid primary key default gen_random_uuid(),
  label      text        not null unique,          -- e.g. '2025-26'
  is_active  boolean     not null default false,
  opens_at   timestamptz not null default now(),
  closes_at  timestamptz not null,                 -- FR-16 edit window ends here
  created_at timestamptz not null default now(),
  constraint cycle_window_valid check (closes_at > opens_at)
);

-- Only one cycle may be active at a time.
create unique index one_active_cycle
  on academic_cycles (is_active)
  where is_active;

comment on column academic_cycles.closes_at is
  'FR-16: after this instant responses in this cycle become read-only (enforced in RLS, 0002).';

-- ---------- rating scales ----------
-- Scales differ per stakeholder form (PRD §8). Options stored ordered,
-- best-first, with an explicit numeric score so averages are well-defined.
create table rating_scales (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table rating_scale_options (
  id            uuid primary key default gen_random_uuid(),
  scale_id      uuid not null references rating_scales (id) on delete cascade,
  label         text not null,
  score         numeric,          -- null => excluded from averages (e.g. 'Not applicable')
  display_order int  not null,
  unique (scale_id, display_order),
  unique (scale_id, label)
);

comment on column rating_scale_options.score is
  'NULL means the option is non-scoring (e.g. "Not applicable") and is skipped by averages.';

-- ---------- forms ----------
-- Exactly one form per stakeholder type (PRD assumption A1).
create table forms (
  id                uuid primary key default gen_random_uuid(),
  stakeholder_type  user_role not null unique,
  title             text      not null,
  description       text,
  created_at        timestamptz not null default now(),
  constraint forms_not_admin check (stakeholder_type <> 'admin')
);

-- ---------- questions + versions (FR-31, FR-32) ----------
-- `questions` is the stable identity; `question_versions` holds the mutable
-- wording. Answers reference a VERSION, so edits never rewrite history.
create table questions (
  id            uuid primary key default gen_random_uuid(),
  form_id       uuid not null references forms (id) on delete cascade,
  question_key  text not null,          -- stable across versions; groups trends (FR-39)
  is_required   boolean not null default true,
  display_order int not null,
  is_active     boolean not null default true,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  -- current_version_id FK added after question_versions exists (circular ref)
  current_version_id uuid,
  unique (form_id, question_key)
);

create table question_versions (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions (id) on delete cascade,
  version_no  int  not null,
  text        text not null,
  type        question_type not null,
  scale_id    uuid references rating_scales (id),
  created_at  timestamptz not null default now(),
  created_by  uuid references profiles (id),
  unique (question_id, version_no),
  -- a rating question needs a scale; a non-rating question must not have one
  constraint scale_matches_type check (
    (type = 'rating' and scale_id is not null) or
    (type <> 'rating' and scale_id is null)
  )
);

alter table questions
  add constraint questions_current_version_fk
  foreign key (current_version_id) references question_versions (id);

comment on table question_versions is
  'FR-31: immutable once answered. Editing a question inserts a new row here.';

-- Options belong to a VERSION, so rewording a choice is also versioned.
create table question_options (
  id                  uuid primary key default gen_random_uuid(),
  question_version_id uuid not null references question_versions (id) on delete cascade,
  label               text not null,
  value               text not null,
  display_order       int  not null,
  unique (question_version_id, display_order),
  unique (question_version_id, value)
);

-- ---------- responses (FR-15, FR-16) ----------
-- One response == one user's feedback on one course within one cycle.
create table responses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles (id) on delete cascade,
  form_id      uuid not null references forms (id),
  cycle_id     uuid not null references academic_cycles (id),
  program      text,
  course_title text,
  submitted_at timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- PRD A5: course titles are free text, so "Linear Algebra" and "linear  algebra"
  -- would otherwise both count as valid distinct submissions. Normalise for the
  -- uniqueness check only; course_title keeps the user's original spelling.
  -- Forms with no course concept (employer, alumni) collapse to '__none__',
  -- which makes the constraint mean "one submission per cycle" for them.
  course_key text generated always as (
    coalesce(
      nullif(lower(trim(regexp_replace(coalesce(course_title, ''), '\s+', ' ', 'g'))), ''),
      '__none__'
    )
  ) stored
);

-- FR-15: the one-submission-per-course-per-cycle rule.
create unique index responses_one_per_course_per_cycle
  on responses (user_id, cycle_id, course_key);

comment on index responses_one_per_course_per_cycle is
  'FR-15. App upserts on this key so a repeat visit edits instead of duplicating.';

-- ---------- answers ----------
-- Points at a question VERSION, not a question: this is what keeps history intact.
create table answers (
  id                  uuid primary key default gen_random_uuid(),
  response_id         uuid not null references responses (id) on delete cascade,
  question_version_id uuid not null references question_versions (id),
  value_numeric       numeric,    -- rating: the chosen option's score
  value_text          text,       -- short_text / long_text
  value_options       text[],     -- single_select / multi_select (option values)
  unique (response_id, question_version_id)
);

create index answers_by_version on answers (question_version_id);
create index answers_by_response on answers (response_id);

-- ---------- question audit log (NFR-9) ----------
create table question_audit (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions (id) on delete cascade,
  action      text not null check (action in ('created', 'edited', 'deleted', 'restored', 'reordered')),
  actor_id    uuid references profiles (id),
  details     jsonb,
  created_at  timestamptz not null default now()
);

create index question_audit_by_question on question_audit (question_id, created_at desc);

-- ---------- triggers ----------
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger responses_touch_updated_at
  before update on responses
  for each row execute function touch_updated_at();

create trigger profiles_touch_updated_at
  before update on profiles
  for each row execute function touch_updated_at();

-- FR-31: a version that has been answered is frozen. Edits must create a new
-- version instead. This is the backstop that makes "history is never rewritten"
-- true at the database level rather than by convention.
--
-- SECURITY DEFINER: the check must see ALL answers. Under the caller's rights
-- RLS could filter the probe to zero rows and silently permit the edit.
create or replace function freeze_answered_question_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from answers a where a.question_version_id = old.id) then
    raise exception
      'question_version % has answers and is immutable; create a new version instead (FR-31)',
      old.id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger question_versions_immutable
  before update or delete on question_versions
  for each row execute function freeze_answered_question_version();

-- Same freeze applied to the options of an answered version: rewording a choice
-- after the fact would silently change what a past respondent appears to have picked.
create or replace function freeze_answered_question_options()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_version uuid;
begin
  -- Branch on TG_OP: on INSERT the OLD record is unassigned, and reading any
  -- field from it (even inside coalesce) raises "record old is not assigned yet".
  if tg_op = 'DELETE' then
    target_version := old.question_version_id;
  else
    target_version := new.question_version_id;
  end if;

  if exists (select 1 from answers a where a.question_version_id = target_version) then
    raise exception
      'options for question_version % are immutable once answered; create a new version instead (FR-31)',
      target_version;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger question_options_immutable
  before insert or update or delete on question_options
  for each row execute function freeze_answered_question_options();
