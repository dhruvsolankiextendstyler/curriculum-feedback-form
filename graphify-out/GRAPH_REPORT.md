# Graph Report - .  (2026-08-28)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 464 nodes · 831 edges · 36 communities (30 shown, 6 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 22 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ab003019`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Analytics Client Layer
- App Shell & Auth Routing
- Form Rendering & Submission
- Admin User Management
- Dependency Manifest
- Question Editing & Versioning
- Core Schema Tables
- Hosting & Edge Function Design
- Academic Cycle Administration
- RLS Policies & Guards
- Validation Test Harness
- Submission Test Harness
- invite-users Edge Function
- Analytics Test Harness
- Feedback Cycle Requirements
- Admin Test Harness
- Analytics Dashboard Requirements
- Response Data Model
- Role-Based Access Requirements
- Answer Remap Test Harness
- Direct Account Provisioning
- Question Lifecycle Requirements
- Scale Normalisation & Checks
- Submission Uniqueness Rules
- Auth-to-Profile Sync Triggers
- CSV Export Privacy Controls
- Identity & Profile Provisioning
- Supabase URL Check
- MCP Server Config
- Academic Peers Form
- Alumni Form
- Employers Form
- MIN_N Constant

## God Nodes (most connected - your core abstractions)
1. `useAuth()` - 19 edges
2. `call()` - 10 edges
3. `AdminCycles()` - 10 edges
4. `RatingsTab()` - 9 edges
5. `slugifyOptionValue()` - 8 edges
6. `homePathFor()` - 8 edges
7. `requiresNewVersion()` - 7 edges
8. `params()` - 7 edges
9. `loadQuestionStats()` - 7 edges
10. `ROLE_LABELS` - 7 edges

## Surprising Connections (you probably didn't know these)
- `papaparse escapeFormulae on free text` --semantically_similar_to--> `safeRedirect()`  [INFERRED] [semantically similar]
  README.md → src/lib/constants.js
- `react-router 7 RSC CSRF advisory trade-off` --references--> `safeRedirect()`  [EXTRACTED]
  README.md → src/lib/constants.js
- `course_key generated column (lowercase, collapsed whitespace)` --semantically_similar_to--> `Stable question_key Across Versions`  [INFERRED] [semantically similar]
  README.md → prd.md
- `analytics_admin_ok() guard in plpgsql functions` --semantically_similar_to--> `Row-Level Security Enforcement (NFR-3)`  [INFERRED] [semantically similar]
  README.md → prd.md
- `analytics_admin_ok() guard in plpgsql functions` --implements--> `Role-Based Access Control (FR-5)`  [INFERRED]
  README.md → prd.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Five stakeholder feedback forms with per-form scales** — prd_academic_peers_form, prd_students_form, prd_employers_form, prd_alumni_form, prd_faculty_form, prd_likert_scales [EXTRACTED 1.00]
- **Locked decisions enforced in the database, not the UI** — readme_one_per_course_unique_index, readme_course_key_generated_column, readme_edit_window_rls_gate, readme_question_version_immutability_trigger, readme_soft_delete_questions [EXTRACTED 1.00]
- **Zero-budget architecture stack (SPA, Supabase, RLS, Edge Function, Workers)** — prd_react_frontend, prd_supabase_backend, prd_rls_security, prd_invite_users_edge_function, prd_cloudflare_workers_hosting, prd_zero_budget [EXTRACTED 1.00]

## Communities (36 total, 6 thin omitted)

### Community 0 - "Analytics Client Layer"
Cohesion: 0.09
Nodes (47): AverageTooltip(), ChoiceChart(), DistributionChart(), QuestionAverages(), SERIES, shorten(), TrendChart(), buildCsv() (+39 more)

### Community 1 - "App Shell & Auth Routing"
Cohesion: 0.12
Nodes (26): BS, cases, AdminAnalytics, App(), RootRedirect(), ConfigError(), Layout(), ProtectedRoute() (+18 more)

### Community 2 - "Form Rendering & Submission"
Cohesion: 0.10
Nodes (30): QuestionField(), COURSE_KEYS, findLastIndex(), loadForm(), loadScales(), pickMeta(), PROGRAM_KEYS, sectionise() (+22 more)

### Community 3 - "Admin User Management"
Cohesion: 0.10
Nodes (28): ALL_ROLES, CsvUsers(), UserImport(), AdminNav(), TABS, chunk(), HEADER_ALIASES, isEmail() (+20 more)

### Community 4 - "Dependency Manifest"
Cohesion: 0.06
Nodes (34): dependencies, papaparse, react, react-dom, react-router-dom, recharts, sentiment, @supabase/supabase-js (+26 more)

### Community 5 - "Question Editing & Versioning"
Cohesion: 0.13
Nodes (29): emptyDraft, OptionEditor(), QuestionEditor(), TYPES, ACTION_LABELS, formatDate(), QuestionHistory(), cosmeticPatch() (+21 more)

### Community 6 - "Core Schema Tables"
Cohesion: 0.22
Nodes (18): academic_cycles, answers, forms, freeze_answered_question_options(), freeze_answered_question_version(), profiles, profiles_touch_updated_at, question_audit (+10 more)

### Community 7 - "Hosting & Edge Function Design"
Cohesion: 0.14
Nodes (18): SPA HTML shell (#root mount, /src/main.jsx entry), Cloudflare Workers Static Assets Hosting, CSV Bulk User Import (FR-23), Custom Free SMTP Provider for Supabase Auth, Data Model (Supabase/Postgres tables), High-Level Architecture (SPA to Supabase), invite-users Edge Function (service_role stays server-side), React SPA Frontend (+10 more)

### Community 8 - "Academic Cycle Administration"
Cohesion: 0.29
Nodes (16): activateCycle(), closeCycleNow(), createCycle(), CYCLE_STATE_LABELS, cycleState(), deactivateAll(), loadCycleCounts(), loadCycles() (+8 more)

### Community 9 - "RLS Policies & Guards"
Cohesion: 0.16
Nodes (14): academic_cycles, answers, current_role_type(), cycle_is_open(), forms, is_admin(), profiles, question_audit (+6 more)

### Community 10 - "Validation Test Harness"
Cohesion: 0.17
Nodes (9): longText, multi, optionalRating, qMap, rating, root, scale, shortText (+1 more)

### Community 12 - "Submission Test Harness"
Cohesion: 0.18
Nodes (8): multiQuestion, reworded, root, scale, stable, storedAtOldVersion, storedForDeletedQuestion, textQuestion

### Community 13 - "invite-users Edge Function"
Cohesion: 0.31
Nodes (8): corsHeaders, createOne(), generateTemporaryPassword(), isEmail(), isMissingDirectUserColumn(), recoverLegacyInvite(), requireActiveAdmin(), VALID_ROLES

### Community 14 - "Analytics Test Harness"
Cohesion: 0.33
Nodes (7): answers table (question_version_id, value_numeric/text/options), forms table (one per stakeholder type), question_options table (per question_version_id), question_versions table (immutable once answered), questions table (question_key, current_version_id), rating_scales table, responses table (user, form, cycle, course_title)

### Community 15 - "Feedback Cycle Requirements"
Cohesion: 0.22
Nodes (6): { classify, summarise }, exportRow, facultyRow, fakeAnalyzer, root, studentRow

### Community 16 - "Admin Test Harness"
Cohesion: 0.25
Nodes (5): header, ratingQ, root, selectQ, sortFixture

### Community 17 - "Analytics Dashboard Requirements"
Cohesion: 0.38
Nodes (7): Analytics & Reports Dashboard (FR-35 to FR-42), Auto-Generated Rule-Based Insights (FR-41), PDF Summary Report per Academic Year (FR-43), Rule-Based Lexicon Sentiment Analysis (FR-40), Version-Aware Analytics and Trend Grouping (FR-34/FR-39), 0005_analytics.sql migration (admin-only aggregate functions), Rule-based sentiment and auto-insights layer (src/lib/analytics)

### Community 18 - "Response Data Model"
Cohesion: 0.29
Nodes (8): Academic-Year Feedback Cycles, academic_cycles table (opens_at, closes_at), Editable-Until-Cycle-Close Window (FR-16), Row-Level Security Enforcement (NFR-3), Year-over-Year Comparison (FR-39), Edit window checked inside the RLS policy, 0002_rls.sql migration (RLS policies, edit-window gate, privilege guards), 0003_seed.sql migration (5 forms, 4 scales, all questions, first cycle)

### Community 19 - "Role-Based Access Requirements"
Cohesion: 0.29
Nodes (4): answerAtCurrentVersion, answerAtOldVersion, rewordedQuestion, stableQuestion

### Community 20 - "Answer Remap Test Harness"
Cohesion: 0.43
Nodes (5): current_role_type(), handle_auth_user_password_changed(), is_admin(), on_auth_user_password_changed, profiles

### Community 21 - "Direct Account Provisioning"
Cohesion: 0.33
Nodes (6): Admin Panel (users, questions, analytics), Question Versioning on Edit (FR-31), Question Soft Delete (FR-32), 0001_schema.sql migration, Trigger blocking edits to an answered question version, Soft delete (is_active = false) keeps analytics data

### Community 22 - "Question Lifecycle Requirements"
Cohesion: 0.50
Nodes (5): CSV Export of Raw Responses (FR-42), Privacy: Exports Limited to Admins (NFR-4), Stable question_key Across Versions, CSV export excludes identity answers by question_key, papaparse escapeFormulae on free text

### Community 23 - "Scale Normalisation & Checks"
Cohesion: 0.40
Nodes (6): Faculty Feedback Form (4-point scale), Per-Form Likert Rating Scales, npm run check test suite, Scale-aware normalisation (axisFor, bounds from rating_scale_options), react-router 7 RSC CSRF advisory trade-off, Three separate denominators: n_answers, n_scored, and their difference

### Community 24 - "Submission Uniqueness Rules"
Cohesion: 0.29
Nodes (7): Curriculum Feedback & Analysis Platform (PRD), Role-Based Access Control (FR-5), Role-Based Form Routing (FR-7), User Panel (Respondents), analytics_admin_ok() guard in plpgsql functions, Curriculum Feedback Platform README, Revoke execute from PUBLIC, grant back to authenticated

### Community 25 - "Auth-to-Profile Sync Triggers"
Cohesion: 0.50
Nodes (5): One Submission per User per Course per Cycle (FR-15), Static Program Lists vs Admin-Managed Course Catalog (A5 / Open Question 1), Students Feedback Form, course_key generated column (lowercase, collapsed whitespace), Unique index on responses (user_id, cycle_id, course_key)

### Community 26 - "CSV Export Privacy Controls"
Cohesion: 0.60
Nodes (4): handle_auth_user_signed_in(), handle_new_auth_user(), on_auth_user_created, on_auth_user_signed_in

### Community 27 - "Identity & Profile Provisioning"
Cohesion: 0.50
Nodes (4): users table (role, status, must_change_password), Manual first-admin bootstrap SQL, 0004_auth_sync.sql migration (auth.users to profiles), public.profiles table (id, email, full_name, role, status)

## Knowledge Gaps
- **95 isolated node(s):** `supabase`, `name`, `private`, `version`, `type` (+90 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `safeRedirect()` connect `App Shell & Auth Routing` to `Question Lifecycle Requirements`, `Scale Normalisation & Checks`?**
  _High betweenness centrality (0.155) - this node is a cross-community bridge._
- **Why does `papaparse escapeFormulae on free text` connect `Question Lifecycle Requirements` to `App Shell & Auth Routing`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `RatingsTab()` (e.g. with `loadChoiceDistribution()` and `loadDistribution()`) actually correct?**
  _`RatingsTab()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `supabase`, `name`, `private` to the rest of the system?**
  _95 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Analytics Client Layer` be split into smaller, more focused modules?**
  _Cohesion score 0.08583959899749373 - nodes in this community are weakly interconnected._
- **Should `App Shell & Auth Routing` be split into smaller, more focused modules?**
  _Cohesion score 0.11923076923076924 - nodes in this community are weakly interconnected._
- **Should `Form Rendering & Submission` be split into smaller, more focused modules?**
  _Cohesion score 0.10256410256410256 - nodes in this community are weakly interconnected._