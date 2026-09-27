# Curriculum Feedback & Analysis Platform — Project Overview

> A plain-language overview of the whole project, written to be read (by a
> person or by an LLM) as a single narrative source. It complements two other
> documents: `prd.md` (the requirements — the *what and why*) and `README.md`
> (setup and the deep design/security decisions). This file explains *how the
> system is built and how the pieces fit together*.

---

## 1. Executive summary

This is a web application that lets a college collect **curriculum feedback**
from five different stakeholder groups — academic peers, students, employers/
industry experts, alumni, and faculty — and gives administrators tools to turn
that feedback into **analysis and reports**.

It replaces scattered static forms (like Google Forms) that had no user
management, no role-based routing, and no built-in analysis. Instead, every
respondent is a pre-registered account that logs in and is routed to the exact
feedback form for their stakeholder type. Administrators manage the accounts,
edit the questions, run yearly feedback cycles, and read a dashboard of counts,
averages, trends, sentiment, and auto-generated insights.

The whole thing runs on **free tiers only** (a ₹0 budget) and was built by a
team of four over roughly one month.

---

## 2. The project at a glance

| Aspect | Detail |
|---|---|
| **Purpose** | Collect and analyse curriculum feedback from 5 stakeholder groups |
| **Panels** | A respondent panel (fill a form) and an admin panel (manage + analyse) |
| **Frontend** | React 18 single-page app, built with Vite 7, routed with React Router 7 |
| **Backend** | Supabase — Postgres database, Auth, Row-Level Security, Edge Functions |
| **Hosting** | Cloudflare Workers (static assets, with SPA fallback) |
| **Budget** | ₹0 — free tiers only |
| **Scale target** | 100–500 users initially |
| **Team / timeline** | 4 people, ~1 month |
| **Status** | Core platform complete (auth, forms, admin panel, analytics) |

## 3. The problem it solves

The college collected curriculum feedback with static forms. Those forms had
three gaps this project closes:

- **No user management or access control.** Anyone with the link could respond,
  and there was no notion of *who* a respondent was.
- **No role-based routing.** Every stakeholder saw the same generic form, even
  though a student, an employer, and a faculty member should answer different
  questions.
- **No analysis.** Raw responses sat in a spreadsheet; nobody could easily see
  averages, trends over years, or which parts of the curriculum were weak.

The goals, therefore: collect structured feedback from all five groups, route
each person to the right form, give admins control over questions and users,
and turn responses into analysis that reveals curriculum strengths, weaknesses,
and recommended changes.

**Deliberately out of scope (v1):** public/anonymous feedback, self-service
signup, native mobile apps, ERP/LMS integration, paid AI analysis, and
multi-college support.

---

## 4. Architecture

The system is a **pure single-page app talking to a managed backend**. There is
no custom application server — a design choice that keeps the cost at zero and
the number of moving parts small.

```
  Browser (React SPA)
        │
        │  HTTPS + published anon key (JWT auth)
        ▼
  Supabase
   ├─ Postgres           the single source of truth; all rules live here
   │   ├─ Tables         forms, questions, versions, responses, profiles, …
   │   ├─ RLS policies   decide row-by-row what each caller may read/write
   │   └─ Functions      analytics aggregates, triggers, guards
   ├─ Auth               email/password sessions
   └─ Edge Functions (Deno/TypeScript)
        ├─ invite-users  admin-only account creation (uses service_role)
        └─ sign-in       exchanges a SAP ID for a session, privately

  Cloudflare Workers  →  serves the built static files, returns index.html
                         for unmatched paths so deep links / refresh work
```

The load-bearing idea is that **the business rules live in the database, not in
the browser** (PRD NFR-3). A stale browser tab or a hand-crafted API call cannot
get around them, because Row-Level Security policies and triggers enforce every
important rule at the point of writing. The React app is essentially a friendly
face over a database that already refuses to do the wrong thing.

## 5. Technology stack (and why each piece)

- **React 18 + Vite 7** — the UI and its build tool. Vite inlines the two public
  Supabase values into the bundle at build time.
- **React Router 7** — client-side routing between the login, respondent, and
  admin pages.
- **Supabase** — the entire backend: Postgres for data, Auth for sessions,
  Row-Level Security for authorization, and Edge Functions for the two things
  the browser must not be trusted with.
- **Cloudflare Workers (Static Assets)** — serves the compiled site from the
  edge for free, and returns `index.html` for unmatched paths so a hard refresh
  on a deep link like `/admin/users` still reaches the router. Cloudflare is
  used instead of Vercel because its free plan allows deploys from every team
  member, not just the account owner.
- **recharts** — the charts on the analytics dashboard.
- **papaparse** — CSV parsing (bulk user import) and CSV generation (export),
  with formula-injection escaping on export.
- **sentiment** — a free, lexicon/rule-based sentiment library, so text-answer
  sentiment costs nothing (no paid AI).
- **lucide / morphicons** — icon sets used in the interface.

Everything was chosen to fit inside free tiers.

---

## 6. Users and roles

There are two panels and a small set of roles.

- **Admin** — college staff with full control: manage users, departments,
  questions/forms, cycles, analytics, and audit logs.
- **Head of Department (HOD)** — a staff role scoped to a single department.
  An HOD can use the admin pages, but their reach is narrowed *in the database*
  to their own department's profiles, responses, questions, audit entries, and
  analytics. HODs cannot create departments and cannot change account status.
- **Respondent** — a registered user who submits feedback, belonging to one of
  five stakeholder types, each of which sees a different set of questions:
  1. Academic Peers
  2. Students
  3. Employers & Industry Experts
  4. Alumni
  5. Faculty

Students and faculty must be assigned a department; employers, alumni, and
academic peers sit outside the college structure and are left without one.

## 7. How authentication works

- **Accounts are created by an admin only.** Public sign-up is turned off; there
  is no self-registration (FR-2). A first admin is created by hand once, then
  every other account is provisioned through the app.
- **Two ways to sign in, one field.** A user can log in with either their
  **email address** or their **SAP ID** (a student/staff number). The two are
  told apart by the `@` sign, so a SAP ID is forbidden from containing one. The
  password is the same whichever identifier is used (FR-1).
- **The SAP ID never leaks an email address.** Because Supabase Auth is keyed by
  email, a SAP ID must be exchanged for an address before a password can be
  checked. Doing that in the browser would let anyone walk the range of SAP
  numbers and harvest every student's email. So the lookup happens *only* inside
  the `sign-in` Edge Function, which runs privately and returns **a session or a
  generic failure — never the address**. A wrong SAP ID and a wrong password are
  deliberately indistinguishable.
- **Temporary passwords.** New accounts get a temporary password (shown once to
  the admin, not emailed). On first login the user is forced to set a new
  password, and the database withholds their real app role until they do.
- **Sessions** persist, and logout is explicit.

## 8. The respondent experience

1. After login, the user is routed automatically to the feedback form for their
   stakeholder type (FR-7).
2. The form is loaded live from the database — its questions, each question's
   current wording (version), the options, and the rating scale it uses. A
   respondent only sees questions for their own department.
3. The form is shown in **logical sections**: *About you* (profile fields) →
   *Your ratings* (Likert questions) → *Your feedback* (free text). Sections are
   derived from the order of the questions.
4. **Validation** is inline: required fields must be filled before submitting.
5. Each submission is for **one course**, saved against the current academic-year
   cycle. A user can submit again for a *different* course.
6. **One submission per user per course per cycle.** Trying to submit the same
   course again opens the existing submission for editing rather than creating a
   duplicate. Submissions stay **editable until the cycle's close date**, then
   become read-only.
7. A "My submissions" list shows each submission with its course and date, and
   an Edit action that disables once the cycle closes.

## 9. The admin panel

The admin panel is a set of pages, each backed by its own database rules.

- **Users (`/admin/users`)** — create accounts one at a time or in bulk via CSV
  import (bounded batches, producing a temporary-password file for the admin).
  Accounts are removed *softly* (marked removed, not deleted) so their past
  responses stay in analytics. Admins assign each account a role, status, SAP
  ID, and department. Users can be filtered by stream and department.
- **Departments (`/admin/departments`)** — manages two levels of reference data:
  **streams** (Science, Commerce, Arts) and the **departments** inside them.
  Archiving a department removes it from the pickers while keeping its people and
  data; deleting is only allowed when nothing still references it (otherwise the
  page suggests archiving). Admin-only — an HOD cannot create a department.
- **Forms / Questions (`/admin/forms`)** — CRUD over the questions on each of the
  five forms, with **versioning**: editing a question creates a new version, and
  a curriculum PDF can be attached per department. Old answers keep pointing at
  the wording they were given.
- **Cycles (`/admin/cycles`)** — feedback is organised per **academic year**.
  Each cycle has an open period that closes on a set date; writes are only
  allowed while the cycle is open. This enables year-over-year comparison.
- **Analytics (`/admin/analytics`)** — the reporting dashboard (see §10).
- **Logs (`/admin/logs`)** — an audit view; admin-only.

## 10. Analytics and reporting

The dashboard turns responses into insight, all with free/rule-based methods:

- **Response counts** and completion, filterable by stakeholder type, stream,
  and department.
- **Per-question averages and distributions** (Likert bars).
- **Year-over-year trends** across cycles.
- **Sentiment analysis** on free-text answers (lexicon-based) plus
  **auto-generated insights** that surface notable strengths and weaknesses.
- **CSV export** of responses, with identity stripped out (see §11).
- **Per-department curriculum PDF** support.

Two subtleties make the numbers trustworthy:

- **Rating scales are not interchangeable.** Faculty use a **4-point** scale
  while the others use **5-point**, so raw averages are not comparable across
  forms. The analytics layer normalises to a percentage of each scale's real
  range rather than assuming "out of 5", and it refuses to draw a single raw
  axis across two different scales. Non-scoring options like *Not applicable*
  carry a null score and are excluded from averages instead of counting as zero.
- **Every rating uses the right denominator** — one count for distributions, a
  separate count for averages, and their difference for non-scoring answers — so
  bars never appear to sum past 100%.

For performance at scale the project adds database indexes, analytics views, a
materialised view, and a statement timeout so a heavy query fails fast rather
than hanging the dashboard.

## 11. Security model (the important part)

Security is the most carefully considered part of this project, because the
whole authorization story lives in the database where the browser cannot reach
around it. The highlights:

- **Row-Level Security everywhere.** Every table has policies that decide, per
  row, what a given caller may read or write. The edit-window rule, the
  privilege guards, and the HOD's department scope are all enforced here.
- **The privilege guard.** Protected profile columns — `role`, `status`,
  `sap_id`, `removed_at`, `must_change_password`, `department_id` — can only be
  changed by an admin or a privileged server process, never by a user editing
  their own profile. An earlier version of this guard had a real hole: it
  checked `current_user`, but inside a `SECURITY DEFINER` function that is the
  function's *owner*, not the caller, so the check was always true and a student
  could have made themselves an admin. The fix checks the request role that
  PostgREST actually sets, and both directions were verified against the live
  database.
- **SAP-ID sign-in discloses nothing.** As described in §7, the email lookup
  lives inside a private Edge Function and returns only a session or a generic
  failure.
- **Server-stamped provisioning.** Accounts get their role and department from
  server-controlled metadata, so client-supplied sign-up data can never set a
  role. Provisioning happens only through the admin-only `invite-users` function
  under the `service_role` key, which never reaches the browser.
- **A response records its own department.** When a response is created, a
  trigger stamps it with the respondent's department and a second trigger
  refuses to let an edit change it. Department is *not* joined from the profile
  at read time — otherwise a student transferring departments would drag years
  of old feedback with them. The browser never sends the department at all.
- **Analytics are admin-only and fail loudly.** The aggregate functions raise an
  error for a non-admin caller rather than quietly returning a dashboard of
  zeros.
- **The CSV export excludes identity.** Names, SAP numbers, and contact details
  are *answers* on the forms, so they are dropped from exports by question key
  with no opt-in. Free-text cells are escaped so a value can't execute as a
  formula when opened in Excel. Stream and department are deliberately left out
  of the export too.
- **Safe post-login redirects.** The "return to where you were" redirect after
  login rejects absolute URLs and scheme injection, closing an open-redirect/XSS
  pattern.

A note on the one known dependency advisory: React Router 7 has an advisory that
only affects React Server Components mode, which this plain SPA cannot enter, so
it does not apply — and staying on v7 avoids a different advisory that v6 would
expose.

## 12. Data model and database migrations

The schema is built up through ordered migration files. Reading their names is
the fastest way to understand the data model and how it grew.

| Migration | What it adds |
|---|---|
| `0001_schema` | Core tables: forms, questions, question versions, options, rating scales, responses, answers, profiles, cycles; the one-per-course unique index; immutability triggers |
| `0002_rls` | Row-Level Security policies, the edit-window gate, privilege guards |
| `0003_seed` | All 5 forms, their 4 rating scales, every question, and the first cycle |
| `0004_auth_sync` | Mirrors new `auth.users` into `profiles` on account creation |
| `0005_analytics` | Admin-only aggregate functions behind the dashboard |
| `0006_direct_users` | Direct account creation, temporary-password gate, soft removal |
| `0007_sap_id` | Optional unique SAP ID on a profile, usable instead of email at sign-in |
| `0008_departments` | Streams and departments; department on users and responses; department analytics filters |
| `0009_privilege_guard` | **Security fix** — makes the profile privilege guard actually reject self-edits |
| `0010_hod_role` | The head-of-department role |
| `0011_hod_scope` | Narrows an HOD's reach to their own department across every table |
| `harden_provisioning_and_hod_status` | **Security fix** — server-stamped provisioning; stops an HOD changing account status |
| `numeric_rating_scale` | Numeric rating-scale handling |
| `curriculum_pdf` / `per_department_pdf` | Attach a curriculum PDF, per form and per department |
| `performance` / `analytics_views` / `analytics_matview` | Indexes, views, and a materialised view for dashboard speed |
| `save_submission_rpc` | A server-side routine for saving a submission atomically |
| `scalability_indexes` / `analytics_timeout` | Indexes and a statement timeout for the 100–500 user target |
| `temp_password_vault` | Storage for one-time temporary passwords |
| `advanced_analytics` | Additional analytics capabilities |

Core relationships in plain terms: a **form** (one per stakeholder type) has
**questions**; each question has **versions**; an **answer** always points at a
specific question *version*, never the question itself, which is what keeps old
data bound to the exact wording it was given. A **response** is one person's
submission for one course in one cycle, and it owns a stamped copy of the
respondent's department.

## 13. Codebase map

```
prd.md                       requirements — the source of truth
README.md                    setup + deep design/security decisions
PROJECT_OVERVIEW.md          this file
wrangler.jsonc               Cloudflare Workers deploy + SPA fallback
vite.config.js               build config
scripts/                     unit-test scripts, run by `npm run check`

supabase/
  migrations/                schema, RLS, seed, analytics, departments, fixes
  functions/_shared/sapId.ts SAP-ID rules shared by both Edge Functions
  functions/invite-users/    admin-only account creation (service_role)
  functions/sign-in/         SAP ID -> session, keeping the address private

src/
  main.jsx                   app entry
  App.jsx                    all routes + role-based redirects
  styles.css                 the single global stylesheet
  lib/
    supabase.js              the configured Supabase client
    identifier.js            email-vs-SAP-ID rules
    validation.js            form validation
    formSchema.js            loads a form's questions/scales; derives sections
    submissions.js           saving and editing a response
    prefill.js               pre-filling an existing submission for editing
    constants.js             route helpers + the safe-redirect guard
    cache.js                 small client-side cache
    functionError.js         Edge Function error handling
    admin/                   users, departments, questions, cycles, CSV, diffing
    analytics/              query wrappers, scale normalising, sentiment, insights, CSV
  context/
    AuthContext.jsx          session + profile + role, and both sign-in paths
    ToastContext / ConfirmContext   UI notifications and confirm dialogs
  components/
    ProtectedRoute.jsx       gates routes by auth + role
    Layout.jsx, AdminNav.jsx, Icon/LordIcon, ThemeToggle, ConfigError
    QuestionField.jsx        renders one question of any type
    admin/                   AnalyticsCharts, QuestionEditor, QuestionHistory, UserImport
  pages/
    Login, SetPassword       auth screens
    FeedbackHome, FeedbackForm   the respondent panel
    AdminHome, AdminUsers, AdminDepartments, AdminQuestions,
    AdminCycles, AdminAnalytics, AdminLogs   the admin panel
    NotFound
```

## 14. Testing and verification

The project ships a suite of plain Node test scripts under `scripts/`, run all
together with:

```bash
npm run check
```

They cover the pure, high-risk logic: safe-redirect handling, the Supabase URL
check, the sign-in identifier rules, form validation, admin logic, department
rules, answer remapping across question versions, submissions, analytics
(scale/sentiment/insight/CSV rules), provisioning, and prefill. This is where
the rules that *aren't* enforced by the database get their guardrails.

## 15. How it is deployed

- **Database:** the migration files are applied to a Supabase project (via the
  SQL editor or the Supabase CLI). Public sign-up is turned off, and the first
  admin is created by hand.
- **Edge Functions:** `invite-users` is deployed with JWT verification on (it
  additionally checks the caller is an active admin); `sign-in` is deployed with
  verification *off*, because its callers have not signed in yet — that is the
  whole point of it.
- **Frontend:** Cloudflare Workers builds the site with `npm run build` and
  serves `dist/` from the edge. The two public Supabase values are set as
  build-time variables so Vite can inline them. Every push to `main` deploys
  automatically.

The `service_role` key lives only in the Edge runtime's environment and never in
any `VITE_` variable, because Vite would otherwise inline it into the bundle
shipped to every visitor.

## 16. Key decisions that were locked early

| Decision | Choice | Why |
|---|---|---|
| Authentication | Email/SAP ID + password, admin-created accounts | Familiar; no public signup |
| Submission granularity | One course per submission | Simplest clean data model |
| Analytics depth | Sentiment + insights, but free/rule-based | Keeps the budget at ₹0 |
| Feedback organisation | Per academic year (cycles) | Enables year-over-year comparison |
| Question history | Version on edit + soft-delete | Old averages and trends stay accurate |
| Resubmission | One per user/course/cycle, editable until close | Clean data, forgiving of mistakes |
| Expected scale | 100–500 users | Needs CSV bulk import for onboarding |

## 17. Project status

Complete: authentication and role-based routing; all five forms rendering from
the database with validation, submission, and editing; the admin panel (direct
user creation, CSV import, soft removal, question CRUD with versioning, cycles,
departments); and the analytics dashboard (counts, per-question averages and
distributions, year-over-year trends, rule-based sentiment with auto-insights,
and de-identified CSV export). Sign-in accepts an email or a SAP ID. Streams and
departments are managed and used as filters across the user list and analytics.

Not built: the optional analytics/report **PDF export**.

## 18. Glossary

- **Stakeholder type** — one of the five respondent groups; each has its own form.
- **Cycle** — a feedback period for one academic year, with a close date.
- **Question version** — a snapshot of a question's wording; answers bind to a
  version so edits never rewrite past data.
- **Rating scale** — the Likert options for a rating question; faculty use a
  4-point scale, everyone else 5-point, so averages are normalised before
  comparison.
- **`course_key`** — a normalised (lowercased, whitespace-collapsed) course name
  that makes "Linear Algebra" and "linear  algebra" count as one course.
- **RLS (Row-Level Security)** — Postgres feature that decides, per row, what a
  caller may read or write; the project's authorization lives here.
- **Edge Function** — a small server-side function on Supabase (Deno/TypeScript)
  used for the two operations the browser must not be trusted with.
- **`service_role`** — the all-powerful Supabase key that bypasses RLS; it lives
  only server-side and never reaches the browser.
- **FR / NFR** — Functional / Non-Functional Requirement IDs from `prd.md`;
  code comments reference these IDs.

