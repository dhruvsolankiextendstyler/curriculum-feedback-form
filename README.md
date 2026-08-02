# Curriculum Feedback & Analysis Platform

Web app for collecting curriculum feedback from five stakeholder groups
(academic peers, students, employers, alumni, faculty) and analysing it.

Requirements live in [prd.md](prd.md). Code comments reference its FR/NFR IDs.

**Stack:** React + Vite · Supabase (Postgres, Auth, RLS) · Vercel · ₹0 budget.

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
| `0004_auth_sync.sql` | Mirrors `auth.users` into `profiles` on invite |

### 4. Create the first admin

Only admins can register users, so the first one is made by hand. Create the
user in **Authentication → Add user**, then run in the SQL editor:

```sql
insert into public.profiles (id, email, full_name, role, status, invite_status)
select id, email, 'Your Name', 'admin', 'active', 'accepted'
from auth.users
where email = 'you@college.edu'
on conflict (id) do update set role = 'admin', status = 'active';
```

### 5. Start

```bash
npm run dev
```

### 6. Inviting users needs `vercel dev`

Creating an auth account requires the Supabase **service_role** key, which
bypasses every RLS policy and must never reach the browser. It therefore lives
only in a serverless function, `api/admin/invite-users.js`.

`npm run dev` serves the SPA alone, so the invite button returns 404 under it.
To exercise invites locally:

```bash
npm i -g vercel
vercel dev
```

Add the key to `.env` (it is gitignored, and is read only by the server-side
function — never prefix it with `VITE_`):

```
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

In production, set the same variable in **Vercel → Project Settings →
Environment Variables**. Everything else — the user list, role edits,
deactivation, question CRUD, cycles — works fine under plain `npm run dev`.

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

**Scale to 100–500 users (FR-23, FR-24).** Onboarding needs custom SMTP; see
below.

### Rating scales are not interchangeable

Four different scales are seeded because the source forms differ. Faculty use a
**4-point** scale while the others use **5-point**, so raw averages are *not*
comparable across forms — normalise before comparing. Non-scoring options
(`Not applicable`) carry a `NULL` score and are excluded from averages rather
than counting as zero.

---

## Before onboarding real users

Supabase's built-in email sender allows only a few messages per hour, which will
not cover 100–500 invites. Connect a free SMTP provider (Brevo, Resend) under
**Project Settings → Auth → SMTP** before importing users.

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
supabase/migrations/       schema, RLS, seed, auth sync
src/
  lib/         supabase client, shared constants
  context/     AuthContext — session + profile + role
  components/  ProtectedRoute, Layout, ConfigError
  pages/       Login, SetPassword, FeedbackHome, AdminHome, NotFound
```

## Status

Week 1 scaffolding. Auth, role-based routing and the full schema are in place;
both panels are placeholders that read live data to prove the stack works.

Next: **Week 2** — the form renderer and submission flow (FR-8 to FR-17).

