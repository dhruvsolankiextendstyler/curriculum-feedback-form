# Project Requirements Document (PRD)
## Curriculum Feedback & Analysis Platform

| | |
|---|---|
| **Version** | 1.1 (Draft) |
| **Date** | 2026-08-01 |
| **Status** | Draft for review — key decisions locked |
| **Timeline** | 1 month |
| **Team size** | 4 |
| **Budget** | ₹0 (free tiers only) |

---

## 1. Overview

A web application for a college to collect **curriculum feedback** from five distinct stakeholder groups and give administrators **analysis and reporting** tools to understand curriculum quality and decide what to improve.

The system has **two panels**:
1. **User panel** — respondents log in and fill an interactive feedback form tailored to their stakeholder type.
2. **Admin panel** — administrators manage users, manage questions, and view analysis/reports.

### 1.1 Problem statement
The college currently collects curriculum feedback via static forms (e.g. Google Forms) with no centralized user management, no role-based routing, and no built-in analysis. Admins cannot easily edit questions, control who responds, or turn raw responses into actionable insight.

### 1.2 Goals
- Collect structured curriculum feedback from all five stakeholder types.
- Route each user to the correct form/curriculum based on their role.
- Give admins control over questions and users.
- Turn responses into analysis that reveals curriculum strengths, weaknesses, and recommended changes.

### 1.3 Non-goals (out of scope for v1)
- Public/anonymous feedback (all users are pre-registered by admin).
- Self-service user signup.
- Mobile native apps (responsive web only).
- Integration with the college's existing ERP/LMS.
- Paid AI/LLM-based analysis (see §7 for the free approach).
- Multi-college / multi-tenant support.

---

## 2. Users & Roles

### 2.1 Roles
| Role | Description |
|---|---|
| **Admin** | College staff managing the platform. Full control over users, questions, and analytics. |
| **Respondent** | A registered user who submits feedback. One of five stakeholder types below. |

### 2.2 Respondent stakeholder types
1. **Academic Peers**
2. **Students**
3. **Employers & Industry Experts**
4. **Alumni**
5. **Faculty**

Each type sees a **different set of questions** (defined in §8). Users are directed to the form matching their assigned type.

---

## 3. Scope

### 3.1 In scope (v1 / MVP)
- Email + password authentication.
- Admin-managed user registration (no self-signup).
- Role-based routing to the correct feedback form.
- Interactive, validated multi-section feedback forms for all 5 types.
- Rating questions (Likert scales) + text/recommendation questions + profile fields.
- Admin CRUD for questions, with versioning so edits never corrupt past analytics.
- Admin CRUD for users, including CSV bulk import and throttled invite emails.
- Feedback organized per **academic year** (feedback cycles) with an editable window that closes on a set date.
- Analytics dashboard: counts, averages, charts, filtering.
- Report/data export.
- Sentiment analysis + auto-generated insights on text responses (free/rule-based — see §7).

### 3.2 Out of scope (v1)
See §1.3.

---

## 4. Key Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| **Auth** | Email + password | Familiar; admin creates accounts, user sets/receives password. |
| **Submission granularity** | One course per submission | Simplest data model; user can resubmit for another course. |
| **Analytics depth** | Advanced (sentiment + insights) | Delivered via **free** lexicon/rule-based methods to keep budget at ₹0. |
| **Feedback organization** | Per academic year (cycles) | Matches forms that already ask for academic year; enables year-over-year comparison. |
| **Duplicate rating blocks** | Use each question once | The pasted forms repeat the rating block; treated as copy-paste artifact. |
| **Question history** | Version on edit + soft-delete | Past responses stay bound to the exact wording answered, so averages and year-over-year comparisons remain accurate. |
| **Resubmission** | One submission per user per course per cycle, **editable until the cycle closes** | Clean, dedupe-free data; forgiving for users who mis-click. |
| **Expected scale** | 100–500 users initially | Requires a free SMTP provider + CSV bulk import for onboarding (see §7.1). |

---

## 5. Functional Requirements

### 5.1 Authentication & Access
- **FR-1** Users log in with email + password.
- **FR-2** Only admin-registered users can log in; no public signup.
- **FR-3** On first login, user is prompted to set/change password (temporary password issued at registration, OR password-set link).
- **FR-4** Password reset via email.
- **FR-5** Role-based access control: admins → admin panel; respondents → user panel only.
- **FR-6** Session persistence and secure logout.

### 5.2 User Panel (Respondents)
- **FR-7** After login, user is routed to the feedback form for their assigned stakeholder type.
- **FR-8** Form displays in logical sections: profile fields → rating questions → recommendations/text.
- **FR-9** Rating questions use the Likert scale defined for that form (scales differ by type — see §8).
- **FR-10** Required-field validation with inline errors; cannot submit incomplete required fields.
- **FR-11** User selects the relevant **program/course** where the form requires it (dropdowns per §8).
- **FR-12** On submit, response is saved against the current academic-year cycle.
- **FR-13** User can submit again for a **different** course (one course per submission).
- **FR-14** User sees a confirmation on successful submission and a list of their past submissions (current cycle).
- **FR-15** **One submission per user per course per cycle.** Attempting to submit again for the same course opens the existing submission for editing instead of creating a duplicate.
- **FR-16** User can **edit and resave** an existing submission any time **until the cycle's close date**; after close, submissions are read-only. Each edit updates `updated_at`.
- **FR-17** "My submissions" list shows each submission's course, submitted/updated date, and an **Edit** action (disabled once the cycle is closed, with an explanatory tooltip).
- **FR-18** (Optional) Save draft / resume — *nice-to-have*.

### 5.3 Admin Panel — User Management
- **FR-19** Admin can register a new user: email, name, stakeholder type (role).
- **FR-20** Admin can edit a user's details/role.
- **FR-21** Admin can remove/deactivate a user.
- **FR-22** Admin can view a list of all users with filters (by type, status) and search by name/email.
- **FR-23** **Bulk import users via CSV** (required, not optional — see scale in §4). Import shows a preview, validates rows, reports per-row errors, and skips duplicates.
- **FR-24** Invitation emails are sent in **throttled batches** so onboarding stays inside provider rate limits; admin can see invite status (pending / sent / accepted) and re-send individually.

### 5.4 Admin Panel — Question Management
- **FR-25** Admin can add a question to a stakeholder form.
- **FR-26** Admin can edit a question (text, options, required flag, order).
- **FR-27** Admin can delete a question.
- **FR-28** Question types supported: **rating (Likert)**, **single-select dropdown**, **multi-select**, **short text**, **long text/recommendation**.
- **FR-29** Admin can reorder questions within a form.
- **FR-30** Changes apply to the relevant stakeholder type's form.
- **FR-31** **Versioning on edit:** editing a question's text, type, scale, or options creates a **new version** rather than mutating the existing row. Existing answers stay linked to the version that was actually answered.
  - Cosmetic-only changes (e.g. `is_required`, display order) update in place and do **not** create a version.
  - Each question keeps a stable `question_key` so all its versions can be grouped for trend analysis.
- **FR-32** **Soft delete:** deleting a question sets `is_active = false` (and `deleted_at`). It disappears from the live form but its historical answers remain in analytics and exports.
- **FR-33** Admin can view a question's **version history** (what changed, when, by whom) and restore a soft-deleted question.
- **FR-34** Analytics clearly indicates when a question has multiple versions, so admins know an average may span reworded variants.

### 5.5 Admin Panel — Analytics & Reports
- **FR-35** Dashboard shows total responses, responses by type, responses by program/course, per academic year.
- **FR-36** Average rating per question, visualized (bar/pie charts).
- **FR-37** Filter analytics by stakeholder type, program, course, and academic year.
- **FR-38** Distribution view per question (how many chose each Likert option).
- **FR-39** Year-over-year comparison for repeated questions. When a question has multiple versions (due to edits), the trend line clearly marks version boundaries.
- **FR-40** Sentiment analysis on text/recommendation answers (positive / neutral / negative) — free method.
- **FR-41** Auto-generated insights (e.g. "lowest-rated aspect: X", "most requested addition: Y") — rule-based.
- **FR-42** Export raw responses to **CSV**. Export includes question version metadata so historical rewording is visible in the data.
- **FR-43** Export a summary **report** (PDF) per academic year — *nice-to-have if time permits*.

---

## 6. Non-Functional Requirements
- **NFR-1 Platform:** Responsive web (desktop-first, mobile-friendly).
- **NFR-2 Performance:** Forms and dashboards load < 3s on typical broadband.
- **NFR-3 Security:** Row-level security so users access only their own data; admins scoped appropriately. Passwords hashed (handled by Supabase Auth). **Business rules that protect data integrity — the one-per-course constraint and the edit window — are enforced in the database/RLS layer, not only client-side.**
- **NFR-4 Privacy:** Personal fields (name, contact) stored securely; export limited to admins.
- **NFR-5 Reliability:** Must operate within Supabase & Vercel **free-tier** limits at 100–500 users.
- **NFR-6 Usability:** Non-technical respondents can complete a form without training.
- **NFR-7 Accessibility:** Basic a11y — labels, keyboard nav, sufficient contrast.
- **NFR-8 Browser support:** Latest Chrome, Edge, Firefox, Safari.
- **NFR-9 Auditability:** Question edits/deletes record who changed what and when; submitted answers are never silently rewritten.

---

## 7. Tech Stack & Architecture

| Layer | Choice |
|---|---|
| **Frontend** | JavaScript + React |
| **Backend / DB / Auth** | Supabase (Postgres, Auth, Row-Level Security) |
| **Hosting** | Vercel (frontend) + Supabase (managed backend) |
| **Charts** | Free React charting library (e.g. Recharts/Chart.js) |
| **Transactional email** | Free SMTP provider (Brevo / Resend free tier) wired into Supabase Auth — required at 100–500 users |
| **Sentiment/insights** | Client/edge, free lexicon-based (e.g. rule-based or a lightweight JS sentiment lib) — **no paid LLM** |

### 7.1 Zero-budget constraints & risks
- **Email at 100–500 users (decided scale):** Supabase's built-in email sender is rate-limited to only a few messages per hour — far too slow to onboard hundreds of users. **Mitigation:** connect a **free third-party SMTP provider** (Brevo ~300 emails/day free, or Resend free tier) as Supabase Auth's custom SMTP. Combined with **CSV bulk import** and **throttled batch invites** (FR-23, FR-24), onboarding 500 users spreads over ~2 days at worst. Budget impact: ₹0.
  - Keep the email provider **swappable via config** so switching providers needs no code changes.
- **Supabase free tier capacity:** at 500 users × ~10 courses × ~15 answers, the `answers` table stays in the low hundreds of thousands of rows — comfortably inside free-tier limits. Worth re-checking before a second cycle.
- **Vercel free tier:** fine for this scale.
- **Advanced analytics:** true AI sentiment would need a paid API. v1 uses **free rule-based/lexicon** sentiment + keyword-frequency insights. LLM-based analysis is a **stretch goal**, not committed.

### 7.2 High-level architecture
```
React SPA (Vercel)
   │  (Supabase JS client)
   ▼
Supabase
   ├── Auth (email+password, RLS)
   │     └── custom SMTP → free provider (Brevo/Resend)
   ├── Postgres (users, cycles, forms, questions,
   │             question_versions, options, scales,
   │             responses, answers)
   └── Row-Level Security policies (respondent vs admin)
```

---

## 8. Feedback Forms — Question Specification

> Notes: Rating blocks that were duplicated in the source are listed **once**. Likert scales **differ by form** and are preserved as given.

### 8.1 Academic Peers
**Scale:** Excellent · Very Good · Good · Average · Poor · Not applicable
**Profile fields:**
- Name* (text)
- Designation* (text)
- Organization* (text)
- Years of teaching experience (total)* (number)
- Program & specialization for which feedback is given* (text; e.g. "BA - TY Sociology")
- Course(s) title for which feedback is given* (text)

**Rating questions (about courses):**
1. Relevance of topics in the curriculum to the requirements of the industry
2. Relevance of topics to cater to local, regional, national and global needs
3. Objectives stated for the course
4. Syllabus of the course in relation to the outcomes expected
5. Allocation of the credits to the courses
6. Practical components and application of the curriculum in the practicum
7. Relevance of the text books and reference books suggested

**Text:**
- Recommendations for course improvement (long text; topics to add/drop, new books, changes in teaching-learning methods/experiments)

---

### 8.2 Students
**Scale:** Excellent · Very Good · Good · Average · Poor
**Profile fields:**
- Name (text)
- Class for which feedback is given* (SY / TY / PG I) (single-select)
- Program (single-select — full program list below)*
- SAP number (text)
- Title of course for which feedback is given* (text)

**Rating questions:**
1. Course design (topics covered, readings incl. reference/text books, projects/assignments)
2. Appropriate time allocation vis-à-vis topic coverage
3. Depth of topics outlined for the course
4. Effectiveness of the course in terms of overall contents
5. Faculty — Class delivery
6. Faculty — Class control
7. Faculty — Punctuality
8. Faculty — Imparting knowledge and gaining insight of topics taught
9. Faculty — Effectiveness of communication

**Text:**
- Recommendations for course improvement (long text)

**Student program list (single-select):**
B.A. · BAMMC · B.Com · B.Com (Management & Finance) · B.Com (Accounting & Finance) · B.Com (Banking & Insurance) · B.Com (Financial Markets) · B.Com (Management Studies) · B.Sc · B.Sc Computer Science · B.Sc Applied Statistics · B.Sc Biotechnology · B.Sc. Psychology · M.A. (English) · M.A. (Economics) · M.A. (Psychology) · M.Com (Advanced Accountancy) · M.Com (Business Management) · M.Sc (Botany) · M.Sc. (Biochemistry) · M.Sc. (Biotechnology) · M.Sc (Organic Chemistry) · M.Sc. (Analytical Chemistry) · M.Sc. (Computer Science) · M.Sc. (Data Science) · M.Sc (Mathematics) · M.Sc (Microbiology) · M.Sc (Physics) · M.Sc (Statistics) · M.Sc (Zoology)

---

### 8.3 Employers & Industry Experts
**Scale:** Strongly Agree · Agree · Neutral · Disagree · Strongly Disagree
**Profile fields:**
- Name* (text)
- Designation* (text)
- Organization & location (city, country)* (text)
- Frequency of placement cycles with the college per year* (number/text)
- Since how many years has your organization recruited our students?* (number)
- Students of which program are usually recruited by your firm?* (multi-select — employer program list below, incl. "Other")

**Rating (agreement) questions:**
1. The technical knowledge of the students is good
2. Curriculum and non-curricular initiatives helped students attain required competency
3. The curriculum provides sufficient knowledge in the area of study
4. The curriculum is able to meet industry requirements
5. Students are groomed to work as team members
6. Employed students have required managerial / leadership qualities
7. Students maintain cordial relation with peers and seniors
8. Communication skills of the students are good
9. Employed students can learn industrial practices fast and mould themselves into the stream

**Text:**
- Any other feedback to improve program/students (long text, optional)

**Employer program list (multi-select, + "Other"):**
B.A. · B.A.MMC · B.Com · B.Com Honours · BAF · BFM · BBI · BMS · B.Sc. · B.Sc. Biochemistry · B.Sc. Biochemistry Honours · B.Sc. Biotechnology · B.Sc. Computer Science · B.Sc. Applied Statistics & Data Analytics (Hons) · B.Sc. Psychology (Hons) · M.A. English · M.A. Economics · M.A. Psychology · M.Com Advanced Accountancy · M.Com Business Management · M.Sc. Botany · M.Sc. Biochemistry · M.Sc. Biotechnology · M.Sc. Computer Science · M.Sc. Data Science · M.Sc. Mathematics · M.Sc. Microbiology · M.Sc. Physics · M.Sc. Statistics · M.Sc. Zoology · M.Sc. Organic Chemistry · M.Sc. Analytical Chemistry · Other

---

### 8.4 Alumni
**Scale:** Strongly Agree · Agree · Neutral · Disagree · Strongly Disagree
**Profile fields:**
- Name (text)
- Year of degree completion* (year)
- Active contact number* (text)
- What are you doing currently?* (single-select: Self-employed Professional · In Service (Job) · Home Maker · Entrepreneur (Business) · Further Studies · Other)
- Which program did you graduate/post-graduate in?* (text or program single-select)

**Rating (agreement) questions:**
1. The curriculum was appropriate for my placement / higher education
2. The curriculum increased my competencies and abilities
3. Distribution of course components (practicals, theory, prereading, library, research, etc.) was adequate
4. The college and faculty mentored me in placement / higher education
5. The learning ambience of the college is conducive for learning
6. The college provides sufficient opportunities for extracurricular activities
7. My teachers taught me well; I remember them and their efforts today

**Additional:**
- I would like to contribute to my alma-mater in* (multi-select: Academics – teaching · Academics – curriculum design & development · Placements · Internships · Extracurricular & cocurricular activities · Entrepreneurial opportunities · All the above · Other)

**Text:**
- Any other feedback to improve program/students (long text, optional)

---

### 8.5 Faculty
**Scale:** Strongly Agree · Agree · Disagree · Strongly Disagree · Not Applicable to my Courses
**Profile fields:**
- Name (optional) (text)
- Department* (text)
- Academic year* (text/select)
- Program* (text — as specified in course structure)
- Course/courses title(s) for which feedback is provided* (text; may cover more than one course)

**Rating (agreement) questions:**
1. The content of my syllabus transacted is completed in the given timeframe
2. The practical course is appropriately/adequately correlated with the theory
3. I have freedom to propose, modify, suggest and incorporate new topics through proper forum
4. There are multiple copies of the prescribed books in the library
5. The course achieves the minimum required course outcome attainment level for my class
6. The course outcomes are met for most of the learners in class
7. The credits allocated to the course are appropriate
8. Distribution of contact hours among course components (theory, practicals, research project, internship, etc.) is appropriate/adequate
9. The syllabus content is manageable by the students
10. The syllabus caters to domain knowledge adequately
11. The course contents enhance the learners' employability and/or skills set

**Text:**
- Recommendations for course improvement (long text; topics to add/drop, new books, changes in teaching scheme/experiments)

---

## 9. Data Model (high-level)

Tables (Supabase/Postgres):
- **users** — id, email, name, role (admin | academic_peer | student | employer | alumni | faculty), status, invite_status, created_at.
- **academic_cycles** — id, label (e.g. "2025–26"), is_active, opens_at, **closes_at**.
- **forms** — id, stakeholder_type, title (one form per stakeholder type).
- **questions** — id, form_id, **question_key** (stable across versions), is_required, display_order, is_active, deleted_at, current_version_id.
- **question_versions** — id, question_id, version_no, text, type (rating | single_select | multi_select | short_text | long_text), scale_id (nullable), created_at, created_by. *Immutable once answers reference it.*
- **question_options** — id, **question_version_id**, label, value, order (for selects).
- **rating_scales** — id, name, options[] (e.g. Excellent…Poor).
- **responses** — id, user_id, form_id, cycle_id, program, course_title, submitted_at, **updated_at**.
- **answers** — id, response_id, **question_version_id**, value_numeric (for ratings), value_text, value_options[] (for multi-select).

### 9.1 Key constraints
- **One submission per user per course per cycle** (FR-15):
  ```sql
  UNIQUE (user_id, cycle_id, course_title)   -- on responses
  ```
  The app upserts against this key, so a repeat visit loads the existing response for editing instead of inserting a duplicate.
- **Edit window** (FR-16): writes to `responses` / `answers` are permitted only while `now() < academic_cycles.closes_at` for that response's cycle. Enforced in an **RLS policy**, not just the UI, so a stale browser tab can't post after close.
- **Versioning** (FR-31): `answers.question_version_id` points at a specific immutable version. Editing a question inserts a new `question_versions` row and repoints `questions.current_version_id`; historical answers are untouched.
- **Soft delete** (FR-32): live forms read `WHERE is_active = true`; analytics and exports read all versions regardless of `is_active`.
- **Trend grouping** (FR-34/FR-39): analytics group by `questions.question_key` to follow a question across rewordings, and surface a version count so a mixed average is never presented as if it were one consistent question.

---

## 10. Milestones (1 month, team of 4)

| Week | Deliverables |
|---|---|
| **Week 1** | Finalize PRD; set up repo, Supabase project, Vercel; auth (email+password); **custom SMTP provider connected**; DB schema **incl. question versioning + unique/edit-window constraints and RLS**; seed all 5 forms' questions. |
| **Week 2** | User panel: role-based routing, all 5 interactive forms, validation, submit + confirmation, **"my submissions" with edit-until-close**. |
| **Week 3** | Admin panel: user CRUD, **CSV bulk import + throttled batch invites**, question CRUD + reorder + **versioning/soft-delete UI & history view**, cycle management (incl. close dates). |
| **Week 4** | Analytics dashboard (counts, averages, charts, filters, distributions, version-aware trends), CSV export, rule-based sentiment/insights; QA, polish, deploy. |

**Suggested team split:** 1 lead/backend+DB (schema, RLS, versioning) · 1 auth + admin user mgmt (incl. CSV import & invites) · 1 user panel/forms (incl. edit flow) · 1 analytics+charts. (Adjust to strengths.)

⚠️ **Scope note:** the three locked decisions add roughly **2–3 person-days** over the v1.0 plan (versioning schema + history UI, upsert/edit flow with RLS time-gating, CSV import + batch invites). This fits the month, but Week 3 is now the tightest. If time slips, the first things to defer are the **question version-history viewer** (FR-33, keep versioning in the data layer regardless) and **PDF export** (FR-43).

---

## 11. Open Questions / Assumptions

**Assumptions**
- A1: Each stakeholder type has exactly one form; question edits apply to that shared form (versioned per §9.1).
- A2: Programs/courses can start as static dropdown lists (from §8) rather than an admin-managed catalog in v1.
- A3: "Reports" = on-screen dashboard + CSV export; PDF is nice-to-have.
- A4: Sentiment/insights are free/rule-based in v1; LLM analysis is a stretch goal only.
- A5: Course identity for the uniqueness constraint is the selected/entered `course_title`. If free-text course entry produces inconsistent spellings, the one-per-course rule weakens — a reason to revisit the course catalog (open question 1).

**Resolved** ✅
- ~~Question editing vs. history~~ → **version on edit + soft-delete** (§4, FR-31–34, §9.1).
- ~~Resubmission limits~~ → **once per course per cycle, editable until cycle close** (§4, FR-15–17).
- ~~User onboarding scale~~ → **100–500 users**; free SMTP + CSV import + throttled invites (§4, §7.1, FR-23–24).

**Open questions to resolve before/early in build**
1. **Programs/courses:** static lists (fast) vs. admin-managed catalog (flexible)? Now also affects how reliably the one-per-course constraint works (see A5). Affects Week 1–3 scope.
2. **Multiple admins:** one admin account or several? Any super-admin vs. viewer roles?
3. **Anonymity:** Faculty name is optional and Students' name is unstarred — should some responses be storable anonymously while still tied to a login for access control?
4. **Data retention:** how long to keep responses across cycles?
5. **Cycle close date:** who sets `closes_at`, and should users get a reminder email before their edit window shuts?

---

## 12. Success Criteria
- All 5 stakeholder types can log in and submit valid feedback.
- Admin can register/remove users and add/edit/delete questions without code changes.
- **A user cannot create a duplicate submission for the same course in a cycle, can edit their submission before the cycle closes, and is blocked from editing after it closes** (verified at the database level, not only in the UI).
- **Editing a question does not alter any previously submitted answer**; a deleted question's historical data still appears in analytics and exports.
- Admin dashboard shows accurate counts, averages, distributions, and filters by type/program/course/year, and flags questions whose averages span multiple versions.
- **A batch of ~100+ users can be imported via CSV and invited without hitting an email rate limit.**
- Text responses receive basic sentiment tags and the dashboard surfaces at least a few auto-insights.
- Data exportable to CSV.
- Deployed on Vercel + Supabase within free-tier limits, at ₹0.

---

## 13. Changelog
| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-08-01 | Initial draft. |
| 1.1 | 2026-08-01 | Locked question versioning + soft-delete, one-submission-per-course-editable-until-close, and 100–500 user scale. Added §9.1 constraints, custom SMTP requirement, CSV import promoted to required, FR renumbering, version-aware analytics, scope note in §10. |
