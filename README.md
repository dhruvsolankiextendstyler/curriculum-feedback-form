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

### 6. Deploy the user provisioning function

Creating an auth account requires the Supabase **service_role** key, which
bypasses every RLS policy and must never reach the browser. It lives only inside
a Supabase Edge Function, `supabase/functions/invite-users/`, where Supabase
injects the key from its own environment — there is no key to copy anywhere.

```bash
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy invite-users
```

User creation works from `npm run dev` too because the function runs on
Supabase, not locally. It creates confirmed accounts directly and returns a
temporary password to the admin; it does not send an invitation email.

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
  migrations/              schema, RLS, seed, auth sync, analytics
  functions/invite-users/  admin-only direct provisioning (service_role stays here)
src/
  lib/             supabase client, validation, form schema, submissions
  lib/admin/       users, questions, cycles, question diffing
  lib/analytics/   RPC wrappers, scale normalising, sentiment, insights, CSV
  context/         AuthContext — session + profile + role
  components/      ProtectedRoute, Layout, fields, ConfigError
  components/admin/ AnalyticsCharts
  pages/           Login, SetPassword, FeedbackHome, FeedbackForm
  pages/           AdminUsers, AdminQuestions, AdminCycles, AdminAnalytics
```

## Status

Weeks 1–4 complete: auth and role-based routing, all five forms rendering from
the database with validation, submission and editing, the admin panel (direct
user creation and soft removal, question CRUD with versioning, cycles), and the
analytics dashboard — response
counts, per-question averages and distributions, year-over-year trends,
rule-based sentiment with auto-insights, and CSV export (FR-34 to FR-42).

Run `npm run check` for the full check suite covering redirect safety,
validation, admin logic, answer remapping across question versions, and the
analytics scale/sentiment/insight/CSV rules.

Not built: the optional PDF export (FR-43).

