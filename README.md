# Curriculum Feedback & Analysis Platform

Web app for collecting curriculum feedback from five stakeholder groups
(academic peers, students, employers, alumni, faculty) and analysing it.

Requirements live in [prd.md](prd.md). Code comments reference its FR/NFR IDs.

**Stack:** React + Vite · Supabase (Postgres, Auth, RLS, Edge Functions) ·
Cloudflare Workers · ₹0 budget.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Create a Supabase project

At [supabase.com](https://supabase.com), then copy your credentials:

```bash
cp .env.example .env
```

Fill both values from **Project Settings → API**. Restart the dev server after
editing `.env` — Vite only reads env files at startup.

> The `service_role` key must never go in `.env` or any `VITE_` variable. It
> would ship to the browser and bypass every RLS policy.

**Then turn public sign-up off.** **Authentication → Sign In / Providers →
Email**, clear *"Allow new users to sign up"*, and confirm with:

```bash
curl -s "$VITE_SUPABASE_URL/auth/v1/settings" -H "apikey: $VITE_SUPABASE_ANON_KEY"
```

`disable_signup` must read `true`. This is not optional and it is not a default:
a new project ships with it **on**, and FR-2 says accounts are created by an
administrator only. Left open, anyone who can receive mail at an address they
control can create an account, and the auth-sync trigger used to take that
account's role straight from the sign-up metadata — i.e. from the attacker. The
trigger now ignores client metadata entirely and provisions a profile only for
accounts the `invite-users` function stamped under `service_role`, so the two
defences are independent; close this one anyway.

### 3. Run the migrations

In order, via **SQL Editor** in the dashboard (or `supabase db push` with the CLI):

| File | What it does |
|---|---|
| `0001_schema.sql` | Tables, question versioning, the one-per-course index, immutability triggers |
| `0002_rls.sql` | RLS policies, the edit-window gate, privilege guards |
| `0003_seed.sql` | All 5 forms, their 4 rating scales, every question from PRD §8, first cycle |
| `0004_auth_sync.sql` | Mirrors `auth.users` into `profiles` on account creation |
| `0005_analytics.sql` | Admin-only aggregate functions behind the dashboard |
| `0006_direct_users.sql` | Direct accounts, temporary-password gate, soft user removal |
| `0007_sap_id.sql` | Optional unique SAP ID on a profile, usable in place of the email at sign-in |
| `0008_departments.sql` | Streams and their departments, the department on a user and on a response, and the stream/department analytics filters |
| `0009_privilege_guard.sql` | **Security fix.** Makes the profile privilege guard actually reject respondent self-edits — see below |
| `0010_hod_role.sql` | The head-of-department role |
| `0011_hod_scope.sql` | Department scoping for an HOD: profiles, responses, questions, audit and analytics all narrowed to their own department |
| `20260910180050_harden_provisioning_and_hod_status.sql` | **Security fix.** Provisions a profile only from server-stamped `raw_app_meta_data`, so client-supplied sign-up metadata can no longer set a role or a department; and stops an HOD changing account status |

### 4. Create the first admin

Only admins can register users, so the first one is made by hand. Create the
user in **Authentication → Add user**, then run in the SQL editor:

```sql
insert into public.profiles (id, email, full_name, role, status)
select id, email, 'Your Name', 'admin', 'active'
from auth.users
where email = 'you@college.edu'
on conflict (id) do update set role = 'admin', status = 'active';
```

### 5. Start

```bash
npm run dev
```

### 6. Deploy the Edge Functions

Two functions, for two things the browser must not be trusted with.

`invite-users` creates auth accounts, which needs the Supabase **service_role**
key — it bypasses every RLS policy and must never reach the browser. `sign-in`
exchanges a SAP ID for a session, which needs to read the SAP-ID-to-address
mapping without handing that mapping to the caller. Both keys come from the Edge
runtime's own environment, so there is nothing to copy anywhere.

```bash
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy invite-users
supabase functions deploy sign-in --no-verify-jwt
```

**`--no-verify-jwt` is required on `sign-in`, and only on `sign-in`.** Its callers
have not signed in yet — that is the point of it. Deployed with verification on,
SAP-ID login returns 401 for everyone. `invite-users` needs the opposite: leave
verification on, so the platform rejects anonymous callers before the function
runs. The function additionally checks that the caller is an active admin.

Both work from `npm run dev` too, because they run on Supabase rather than
locally. Account creation returns a temporary password to the admin; it does not
send an invitation email.

> `.env` needs only the two `VITE_` values. The `service_role` key must never go
> in `.env` or any `VITE_` variable — Vite inlines those into the bundle it ships
> to every visitor.

### 7. Deploy the front end (Cloudflare Workers)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages →
   Create application → Workers → Connect to Git**, and pick this repo
2. Build command `npm run build`, deploy command `npx wrangler deploy`
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as **build-time**
   variables (Vite inlines them into the bundle, so runtime vars are too late)
4. Every push to `main` deploys automatically

Cloudflare has closed **Pages** to new projects; Workers Static Assets is the
supported replacement, so there is no `public/_redirects`. `wrangler.jsonc`
serves `dist/` from the edge and its `not_found_handling` returns `index.html`
for unmatched paths, which is what lets a hard refresh on `/admin/users` reach
the router instead of 404ing. There is no `main` entry: the app is a pure SPA,
so no Worker script ever runs.

Team members are free on Cloudflare's plan — **Members → Invite**. That is why
this project is not on Vercel: its Hobby tier only permits deploys from the
account owner, so a second contributor's push fails the deployment check.

---

## How the locked decisions are enforced

The three decisions in PRD §4 are enforced in the **database**, not the UI, so a
stale browser tab or a direct API call cannot get around them (NFR-3).

**Question versioning (FR-31, FR-32).** `answers` reference a
`question_versions` row, never a `questions` row. Editing a question inserts a
new version; past answers keep pointing at the wording they were given. A
trigger raises an exception on any attempt to modify a version that already has
answers, so history cannot be rewritten even by mistake. Deletes are soft
(`is_active = false`) — the question leaves the live form but its data stays in
analytics.

**One submission per course, editable until close (FR-15, FR-16).** A unique
index on `responses (user_id, cycle_id, course_key)` makes duplicates
impossible; the app upserts on it so a repeat visit edits the existing row.
`course_key` is a generated column that lowercases and collapses whitespace, so
`"Linear Algebra"` and `"linear  algebra"` collide rather than both counting
(PRD A5). Writes are permitted only while `now() < cycle.closes_at`, checked in
the RLS policy itself.

**Scale to 100–500 users (FR-23).** CSV imports create accounts in bounded
batches and produce a temporary-password file for the administrator.

### Signing in with a SAP ID never discloses an address

FR-1 accepts two identifiers in one field, told apart by the `@`. That is why a
SAP ID is forbidden from containing one — in the check constraint, in the browser
and in the Edge Functions, all three.

The interesting part is what does the lookup. Supabase Auth is keyed by email, so
a SAP ID has to be exchanged for an address before any password can be checked.
The obvious implementation — an `email_for_sap_id()` RPC — is the wrong one: the
anon key is published in the browser bundle, SAP IDs run in ranges, and anyone
could walk that range and collect the email address of every student in the
college. So there is no such function. The lookup happens inside the `sign-in`
Edge Function under `service_role`, which returns a **session or a generic
failure**, never the address.

Two consequences worth knowing:

- **Wrong SAP ID and wrong password are indistinguishable.** Both answer
  `Invalid login credentials`, after the same round trip — an unmatched
  identifier is sent to an address in the reserved `.invalid` domain rather than
  short-circuited, so response timing does not answer the question either.
- **Email sign-in does not go through the function.** The browser talks straight
  to Auth for that. A broken or undeployed `sign-in` costs SAP-ID login, not all
  login, which matters because the people who would fix it are administrators.

Routing a password grant through a function does cost the per-IP rate limit Auth
would normally apply, since it sees Supabase's infrastructure as the caller. The
function forwards the real client IP and keeps its own failure counter, generous
enough that a campus behind one NAT address is not locked out by its own traffic.

Only an admin can write `sap_id`, enforced by the same trigger that stops a
respondent granting themselves a role.

### A response records its department, and keeps it

`/admin/departments` manages two levels of reference data — streams (Science,
Commerce, Arts) and the departments inside them — and `/admin/users` assigns a
department to an account. Students and faculty must have one; employers, alumni
and academic peers are outside the college structure and are left without,
because the alternative is placeholder departments cluttering every filter.

The load-bearing decision is that **`responses` carries its own `department_id`,
stamped from the respondent's profile by a trigger when the row is created.** It is
not joined through `profiles` at read time. The reasoning is the one already
written into `0005_analytics.sql` for the stakeholder dimension: an attribute that
can change on the person would retroactively rewrite past cycles. A student
transferring from Statistics to Data Science must not move three years of
Statistics feedback with them.

Two consequences worth knowing:

- **Responses submitted before a department was assigned carry none**, so a
  department filter hides them. The dashboard says so when either new filter is on.
- **The browser never sends `department_id` on a response.** The trigger overwrites
  whatever arrives, and a second trigger refuses to let an edit change it. So
  `src/lib/submissions.js` has nothing to do with departments at all.

Only an admin can write `profiles.department_id`, through the same privilege guard
as `role`, `status` and `sap_id`.

Archiving and deleting are different operations. Archiving (`is_active = false`)
takes a department out of the pickers while its people keep it and its responses
stay in analytics — the same shape as question soft-delete (FR-32). Deleting
removes the row, and `on delete restrict` means Postgres refuses while anything
still references it — including a soft-deleted question, whose history remains
permanent. The page turns that refusal into the suggestion to archive.

Stream and department are deliberately **not** columns in the CSV export. The
export already strips the faculty form's `department` *answer* as identifying data
under NFR-4, and adding the assigned department back would undo that by another
route. Filtering an export by department still works.

The student form's own `program` dropdown is untouched. Its options are immutable
once answered (FR-31), so pointing them at this table would need a new question
version and an answer migration; department is a new analytics dimension beside
program, not a replacement for it.

### `current_user` lies inside a SECURITY DEFINER function

`0009_privilege_guard.sql` fixes a hole that had been open since `0002_rls.sql`.

`is_privileged_writer()` decided whether a caller may write the protected columns
on a profile, and part of its test was
`current_user in ('postgres', 'supabase_admin', 'service_role')`. But it is itself
`SECURITY DEFINER` and owned by `postgres` — and **inside a `SECURITY DEFINER`
function `current_user` is the function's owner, not the caller.** That branch was
therefore always true, the function always returned true, and every clause it
protects was a no-op: `role`, `status`, `sap_id`, `removed_at`,
`must_change_password` and `department_id`. A student holding nothing but their own
JWT could run `update profiles set role = 'admin' where id = auth.uid()` and the
trigger would wave it through. That was reproduced against this database, not
inferred.

The fix asks a question `SECURITY DEFINER` does not rewrite. PostgREST issues
`SET LOCAL ROLE` for every request, and that GUC survives: measured inside the same
function, `current_user` reads `postgres` while `role` still reads `authenticated`.
`anon` and `authenticated` are precisely the two roles reachable with the published
anon key or an end-user token, so those two have to prove they are an admin;
everything else — `service_role`, the Auth service's own connection, psql, a
migration — already holds database credentials.

The old `request.jwt.claim.role` check went with it. That is the pre-2022 spelling
and reads NULL on this project; Supabase publishes the verified JWT as the JSON
`request.jwt.claims`. It was dead code, hidden by the broken branch above.

Both directions are verified: the six self-edits above are now refused with their
own messages, while an admin editing another account, the `invite-users` function
under `service_role`, and the Auth trigger that clears `must_change_password` on
first sign-in all still work.

### Rating scales are not interchangeable

Four different scales are seeded because the source forms differ. Faculty use a
**4-point** scale while the others use **5-point**, so raw averages are *not*
comparable across forms — normalise before comparing. Non-scoring options
(`Not applicable`) carry a `NULL` score and are excluded from averages rather
than counting as zero.

The analytics layer enforces both. Bounds come from `rating_scale_options` per
scale, never a literal `5`: a faculty question averaging 3.5 is 83% of its
range, and assuming a 5-point scale would report 63% and make faculty look
systematically harsher than everyone else. A chart whose rows span two scales is
drawn on a normalised axis with a caption, because a mixed raw axis is not
merely discouraged — `axisFor()` will not return one.

Every rating carries three separate denominators: `n_answers` for distributions,
`n_scored` for averages, and their difference for the non-scoring options.
Sharing one denominator is what makes Likert bars appear to sum past 100%.

### Analytics reads are admin-only, and fail loudly

The functions in `0005_analytics.sql` are `SECURITY INVOKER`, so RLS decides
which rows a caller sees exactly as it would for a plain `select`. On its own
that is not enough: a non-admin would simply see aggregates of their own two
responses and have no way to tell. `analytics_admin_ok()` raises instead.

The table-returning functions are `plpgsql` rather than `sql` for that reason.
In a `sql` body the guard sits inside the row-producing path, and when RLS
empties that path the planner skips the guard entirely — the non-admin then gets
a dashboard of zeros rather than an error. `perform` runs before any row work.

Note also that `revoke execute ... from anon` does nothing on its own:
`create function` grants to `PUBLIC`, and `anon` inherits through it. The
migration revokes from `PUBLIC` and grants back to `authenticated`.

### The CSV export excludes identity

Dropping `user_id` does not de-identify an export. The respondent's name, SAP
number and contact details are *answers* — ordinary questions on the form — so
they are excluded by `question_key` with no opt-in. A downloaded file has left
the app's access controls behind, and NFR-4 keeps personal data inside them.

The `sap_id` on a profile is a different thing from the SAP number *answered* on
the student form, despite the name: it is a sign-in credential, and analytics
never join to `profiles` at all, so it cannot reach an export by either route.

Free text is written through papaparse with `escapeFormulae`, since a quoted
cell is still an executable formula when an admin opens the file in Excel.

---

## Before onboarding real users

Temporary passwords are shown once after account creation. Share them through a
private channel and remove the downloaded credentials file after distribution.
Users must replace the temporary password before the database grants their app
role.

---

## Known advisory: react-router 7

`npm audit` reports one unfixed high-severity advisory against react-router
≥7.12: **RSC Mode CSRF Bypass**. It requires React Server Components mode, which
this app — a plain Vite SPA with no server runtime — cannot enter. No patched
7.x release exists yet.

Staying on v7 was the deliberate trade. React Router 6 carries its own advisory
(XSS via open redirect) whose pattern this app *does* use: the "return to where
you were" redirect after login. That one is mitigated directly in
`safeRedirect()` (`src/lib/constants.js`), which rejects absolute URLs,
protocol-relative paths and scheme injection rather than trusting router state.

Re-check with `npm audit` before launch in case a fix has shipped.

---

## Project layout

```
prd.md                     requirements (source of truth)
wrangler.jsonc             Cloudflare Workers deploy + SPA fallback
scripts/                   unit tests, run by `npm run check`
supabase/
  migrations/              schema, RLS, seed, auth sync, analytics, SAP ID, departments
  functions/_shared/       SAP ID rules used by both functions
  functions/invite-users/  admin-only direct provisioning (service_role stays here)
  functions/sign-in/       SAP ID -> session, so the address never leaves the server
src/
  lib/             supabase client, identifier rules, validation, form schema, submissions
  lib/admin/       users, departments, questions, cycles, question diffing
  lib/analytics/   RPC wrappers, scale normalising, sentiment, insights, CSV
  context/         AuthContext — session + profile + role, and both sign-in paths
  components/      ProtectedRoute, Layout, fields, ConfigError
  components/admin/ AnalyticsCharts
  pages/           Login, SetPassword, FeedbackHome, FeedbackForm
  pages/           AdminUsers, AdminDepartments, AdminQuestions, AdminCycles, AdminAnalytics
```

## Status

Weeks 1–4 complete: auth and role-based routing, all five forms rendering from
the database with validation, submission and editing, the admin panel (direct
user creation and soft removal, question CRUD with versioning, cycles), and the
analytics dashboard — response
counts, per-question averages and distributions, year-over-year trends,
rule-based sentiment with auto-insights, and CSV export (FR-34 to FR-42).

Sign-in accepts an email address or a SAP ID (FR-1). SAP IDs are optional, unique,
and admin-managed; an account without one is unaffected.

Streams and departments are managed at `/admin/departments` and assigned to
accounts on the Users page (FR-44 to FR-48). Students and faculty must have one.
Both are filters on the user list and the analytics dashboard, and both are seeded
with a starting list drawn from the programs the student form already offers.

Run `npm run check` for the full check suite covering redirect safety, sign-in
identifier rules, validation, admin logic, department rules and CSV resolution,
answer remapping across question versions, and the analytics
scale/sentiment/insight/CSV rules.

Not built: the optional PDF export (FR-43).

