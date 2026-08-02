-- =============================================================
-- 0003_seed.sql — Forms, scales and questions from PRD §8
--
-- Idempotent: safe to re-run. Questions are seeded at version 1; later edits
-- go through the app and create version 2+ (FR-31).
-- Scales differ per form and are reproduced exactly as given in the PRD.
-- =============================================================

-- ---------- rating scales ----------
insert into rating_scales (name) values
  ('excellent_to_poor_na'),   -- Academic Peers
  ('excellent_to_poor'),      -- Students
  ('agreement_5'),            -- Employers, Alumni
  ('agreement_4_na')          -- Faculty
on conflict (name) do nothing;

-- Scores are best-first descending. 'Not applicable' scores NULL so it is
-- excluded from averages rather than dragging them toward zero.
with s as (select id, name from rating_scales)
insert into rating_scale_options (scale_id, label, score, display_order)
select s.id, o.label, o.score, o.display_order
from s
join (values
  ('excellent_to_poor_na', 'Excellent',       5, 1),
  ('excellent_to_poor_na', 'Very Good',       4, 2),
  ('excellent_to_poor_na', 'Good',            3, 3),
  ('excellent_to_poor_na', 'Average',         2, 4),
  ('excellent_to_poor_na', 'Poor',            1, 5),
  ('excellent_to_poor_na', 'Not applicable',  null, 6),

  ('excellent_to_poor',    'Excellent',       5, 1),
  ('excellent_to_poor',    'Very Good',       4, 2),
  ('excellent_to_poor',    'Good',            3, 3),
  ('excellent_to_poor',    'Average',         2, 4),
  ('excellent_to_poor',    'Poor',            1, 5),

  ('agreement_5',          'Strongly Agree',    5, 1),
  ('agreement_5',          'Agree',             4, 2),
  ('agreement_5',          'Neutral',           3, 3),
  ('agreement_5',          'Disagree',          2, 4),
  ('agreement_5',          'Strongly Disagree', 1, 5),

  ('agreement_4_na',       'Strongly Agree',    4, 1),
  ('agreement_4_na',       'Agree',             3, 2),
  ('agreement_4_na',       'Disagree',          2, 3),
  ('agreement_4_na',       'Strongly Disagree', 1, 4),
  ('agreement_4_na',       'Not Applicable to my Courses', null, 5)
) as o(scale_name, label, score, display_order)
  on o.scale_name = s.name
on conflict (scale_id, label) do nothing;

-- ---------- forms ----------
insert into forms (stakeholder_type, title, description) values
  ('academic_peer', 'Academic Peers Curriculum Feedback',
   'Feedback from academic peers on curriculum design and relevance.'),
  ('student', 'Student Curriculum Feedback',
   'Feedback from students on course design, delivery and faculty.'),
  ('employer', 'Employers & Industry Experts Curriculum Feedback',
   'Feedback from recruiters on graduate competency and industry fit.'),
  ('alumni', 'Alumni Curriculum Feedback',
   'Feedback from alumni on how the curriculum served their career path.'),
  ('faculty', 'Faculty Curriculum Feedback',
   'Feedback from faculty on syllabus workload, outcomes and resources.')
on conflict (stakeholder_type) do nothing;

-- ---------- seeding helper ----------
-- Creates a question at version 1 and points current_version_id at it.
-- Re-running is a no-op, so this migration stays idempotent.
create or replace function seed_question(
  p_stakeholder  user_role,
  p_key          text,
  p_text         text,
  p_type         question_type,
  p_scale_name   text,
  p_order        int,
  p_required     boolean default true
) returns uuid
language plpgsql as $$
declare
  v_form_id    uuid;
  v_scale_id   uuid;
  v_question   uuid;
  v_version    uuid;
begin
  select id into v_form_id from forms where stakeholder_type = p_stakeholder;
  if v_form_id is null then
    raise exception 'no form seeded for stakeholder %', p_stakeholder;
  end if;

  if p_scale_name is not null then
    select id into v_scale_id from rating_scales where name = p_scale_name;
    if v_scale_id is null then
      raise exception 'unknown rating scale %', p_scale_name;
    end if;
  end if;

  select id into v_question
  from questions where form_id = v_form_id and question_key = p_key;

  if v_question is not null then
    return v_question;   -- already seeded
  end if;

  insert into questions (form_id, question_key, is_required, display_order)
  values (v_form_id, p_key, p_required, p_order)
  returning id into v_question;

  insert into question_versions (question_id, version_no, text, type, scale_id)
  values (v_question, 1, p_text, p_type, v_scale_id)
  returning id into v_version;

  update questions set current_version_id = v_version where id = v_question;

  return v_question;
end;
$$;

-- Attaches choice options to a question's current version.
create or replace function seed_options(
  p_stakeholder user_role,
  p_key         text,
  p_labels      text[]
) returns void
language plpgsql as $$
declare
  v_version uuid;
  i int;
begin
  select q.current_version_id into v_version
  from questions q
  join forms f on f.id = q.form_id
  where f.stakeholder_type = p_stakeholder and q.question_key = p_key;

  if v_version is null then
    raise exception 'question %/% not found', p_stakeholder, p_key;
  end if;

  if exists (select 1 from question_options where question_version_id = v_version) then
    return;   -- already seeded
  end if;

  for i in 1 .. array_length(p_labels, 1) loop
    insert into question_options (question_version_id, label, value, display_order)
    values (v_version, p_labels[i], p_labels[i], i);
  end loop;
end;
$$;

-- =============================================================
-- §8.1 ACADEMIC PEERS — scale: Excellent…Poor + Not applicable
-- =============================================================
select seed_question('academic_peer', 'name',         'Name', 'short_text', null, 1);
select seed_question('academic_peer', 'designation',  'Designation', 'short_text', null, 2);
select seed_question('academic_peer', 'organization', 'Organization', 'short_text', null, 3);
select seed_question('academic_peer', 'experience_years',
  'Years of teaching experience (total)', 'short_text', null, 4);
select seed_question('academic_peer', 'program_specialization',
  'Program & specialization for which feedback is given (e.g. BA - TY Sociology)', 'short_text', null, 5);
select seed_question('academic_peer', 'course_title',
  'Course(s) title for which feedback is given', 'short_text', null, 6);

select seed_question('academic_peer', 'industry_relevance',
  'Relevance of topics in the curriculum to the requirements of the industry', 'rating', 'excellent_to_poor_na', 7);
select seed_question('academic_peer', 'regional_global_needs',
  'Relevance of topics to cater to local, regional, national and global needs', 'rating', 'excellent_to_poor_na', 8);
select seed_question('academic_peer', 'course_objectives',
  'Objectives stated for the course', 'rating', 'excellent_to_poor_na', 9);
select seed_question('academic_peer', 'syllabus_vs_outcomes',
  'Syllabus of the course in relation to the outcomes expected', 'rating', 'excellent_to_poor_na', 10);
select seed_question('academic_peer', 'credit_allocation',
  'Allocation of the credits to the courses', 'rating', 'excellent_to_poor_na', 11);
select seed_question('academic_peer', 'practical_components',
  'Practical components and application of the curriculum in the practicum', 'rating', 'excellent_to_poor_na', 12);
select seed_question('academic_peer', 'textbook_relevance',
  'Relevance of the text books and reference books suggested', 'rating', 'excellent_to_poor_na', 13);

select seed_question('academic_peer', 'recommendations',
  'Recommendations for course improvement (topics to add/drop, new books, changes in teaching-learning methods/experiments)',
  'long_text', null, 14, false);

-- =============================================================
-- §8.2 STUDENTS — scale: Excellent…Poor
-- =============================================================
select seed_question('student', 'name', 'Name', 'short_text', null, 1, false);
select seed_question('student', 'class', 'Class for which feedback is given', 'single_select', null, 2);
select seed_options ('student', 'class', array['SY', 'TY', 'PG I']);

select seed_question('student', 'program', 'Program', 'single_select', null, 3);
select seed_options ('student', 'program', array[
  'B.A.', 'BAMMC', 'B.Com', 'B.Com (Management & Finance)', 'B.Com (Accounting & Finance)',
  'B.Com (Banking & Insurance)', 'B.Com (Financial Markets)', 'B.Com (Management Studies)',
  'B.Sc', 'B.Sc Computer Science', 'B.Sc Applied Statistics', 'B.Sc Biotechnology',
  'B.Sc. Psychology', 'M.A. (English)', 'M.A. (Economics)', 'M.A. (Psychology)',
  'M.Com (Advanced Accountancy)', 'M.Com (Business Management)', 'M.Sc (Botany)',
  'M.Sc. (Biochemistry)', 'M.Sc. (Biotechnology)', 'M.Sc (Organic Chemistry)',
  'M.Sc. (Analytical Chemistry)', 'M.Sc. (Computer Science)', 'M.Sc. (Data Science)',
  'M.Sc (Mathematics)', 'M.Sc (Microbiology)', 'M.Sc (Physics)', 'M.Sc (Statistics)',
  'M.Sc (Zoology)']);

select seed_question('student', 'sap_number', 'SAP number', 'short_text', null, 4, false);
select seed_question('student', 'course_title',
  'Title of course for which feedback is given', 'short_text', null, 5);

select seed_question('student', 'course_design',
  'Course design (topics covered, readings incl. reference/text books, projects/assignments)',
  'rating', 'excellent_to_poor', 6);
select seed_question('student', 'time_allocation',
  'Appropriate time allocation vis-à-vis topic coverage', 'rating', 'excellent_to_poor', 7);
select seed_question('student', 'topic_depth',
  'Depth of topics outlined for the course', 'rating', 'excellent_to_poor', 8);
select seed_question('student', 'overall_effectiveness',
  'Effectiveness of the course in terms of overall contents', 'rating', 'excellent_to_poor', 9);
select seed_question('student', 'faculty_delivery',
  'Faculty — Class delivery', 'rating', 'excellent_to_poor', 10);
select seed_question('student', 'faculty_class_control',
  'Faculty — Class control', 'rating', 'excellent_to_poor', 11);
select seed_question('student', 'faculty_punctuality',
  'Faculty — Punctuality', 'rating', 'excellent_to_poor', 12);
select seed_question('student', 'faculty_knowledge',
  'Faculty — Imparting knowledge and gaining insight of topics taught', 'rating', 'excellent_to_poor', 13);
select seed_question('student', 'faculty_communication',
  'Faculty — Effectiveness of communication', 'rating', 'excellent_to_poor', 14);

select seed_question('student', 'recommendations',
  'Recommendations for course improvement', 'long_text', null, 15, false);

-- =============================================================
-- §8.3 EMPLOYERS & INDUSTRY EXPERTS — scale: Strongly Agree…Strongly Disagree
-- =============================================================
select seed_question('employer', 'name', 'Name', 'short_text', null, 1);
select seed_question('employer', 'designation', 'Designation', 'short_text', null, 2);
select seed_question('employer', 'organization_location',
  'Organization & location (city, country)', 'short_text', null, 3);
select seed_question('employer', 'placement_frequency',
  'Frequency of placement cycles with the college per year', 'short_text', null, 4);
select seed_question('employer', 'years_recruiting',
  'Since how many years has your organization recruited our students?', 'short_text', null, 5);

select seed_question('employer', 'programs_recruited',
  'Students of which program are usually recruited by your firm?', 'multi_select', null, 6);
select seed_options ('employer', 'programs_recruited', array[
  'B.A.', 'B.A.MMC', 'B.Com', 'B.Com Honours', 'BAF', 'BFM', 'BBI', 'BMS', 'B.Sc.',
  'B.Sc. Biochemistry', 'B.Sc. Biochemistry Honours', 'B.Sc. Biotechnology',
  'B.Sc. Computer Science', 'B.Sc. Applied Statistics & Data Analytics (Hons)',
  'B.Sc. Psychology (Hons)', 'M.A. English', 'M.A. Economics', 'M.A. Psychology',
  'M.Com Advanced Accountancy', 'M.Com Business Management', 'M.Sc. Botany',
  'M.Sc. Biochemistry', 'M.Sc. Biotechnology', 'M.Sc. Computer Science',
  'M.Sc. Data Science', 'M.Sc. Mathematics', 'M.Sc. Microbiology', 'M.Sc. Physics',
  'M.Sc. Statistics', 'M.Sc. Zoology', 'M.Sc. Organic Chemistry',
  'M.Sc. Analytical Chemistry', 'Other']);

select seed_question('employer', 'technical_knowledge',
  'The technical knowledge of the students is good', 'rating', 'agreement_5', 7);
select seed_question('employer', 'competency_attainment',
  'Curriculum and non-curricular initiatives helped students attain required competency', 'rating', 'agreement_5', 8);
select seed_question('employer', 'sufficient_knowledge',
  'The curriculum provides sufficient knowledge in the area of study', 'rating', 'agreement_5', 9);
select seed_question('employer', 'meets_industry_requirements',
  'The curriculum is able to meet industry requirements', 'rating', 'agreement_5', 10);
select seed_question('employer', 'teamwork',
  'Students are groomed to work as team members', 'rating', 'agreement_5', 11);
select seed_question('employer', 'leadership',
  'Employed students have required managerial / leadership qualities', 'rating', 'agreement_5', 12);
select seed_question('employer', 'cordial_relations',
  'Students maintain cordial relation with peers and seniors', 'rating', 'agreement_5', 13);
select seed_question('employer', 'communication_skills',
  'Communication skills of the students are good', 'rating', 'agreement_5', 14);
select seed_question('employer', 'adaptability',
  'Employed students can learn industrial practices fast and mould themselves into the stream',
  'rating', 'agreement_5', 15);

select seed_question('employer', 'other_feedback',
  'Any other feedback to improve program/students', 'long_text', null, 16, false);

-- =============================================================
-- §8.4 ALUMNI — scale: Strongly Agree…Strongly Disagree
-- =============================================================
select seed_question('alumni', 'name', 'Name', 'short_text', null, 1, false);
select seed_question('alumni', 'completion_year', 'Year of degree completion', 'short_text', null, 2);
select seed_question('alumni', 'contact_number', 'Active contact number', 'short_text', null, 3);

select seed_question('alumni', 'current_activity', 'What are you doing currently?', 'single_select', null, 4);
select seed_options ('alumni', 'current_activity', array[
  'Self-employed Professional', 'In Service (Job)', 'Home Maker',
  'Entrepreneur (Business)', 'Further Studies', 'Other']);

select seed_question('alumni', 'program',
  'Which program did you graduate/post-graduate in?', 'short_text', null, 5);

select seed_question('alumni', 'curriculum_appropriate',
  'The curriculum was appropriate for my placement / higher education', 'rating', 'agreement_5', 6);
select seed_question('alumni', 'competencies_increased',
  'The curriculum increased my competencies and abilities', 'rating', 'agreement_5', 7);
select seed_question('alumni', 'component_distribution',
  'Distribution of course components (practicals, theory, prereading, library, research, etc.) was adequate',
  'rating', 'agreement_5', 8);
select seed_question('alumni', 'mentoring',
  'The college and faculty mentored me in placement / higher education', 'rating', 'agreement_5', 9);
select seed_question('alumni', 'learning_ambience',
  'The learning ambience of the college is conducive for learning', 'rating', 'agreement_5', 10);
select seed_question('alumni', 'extracurricular_opportunities',
  'The college provides sufficient opportunities for extracurricular activities', 'rating', 'agreement_5', 11);
select seed_question('alumni', 'teaching_quality',
  'My teachers taught me well; I remember them and their efforts today', 'rating', 'agreement_5', 12);

select seed_question('alumni', 'contribution_areas',
  'I would like to contribute to my alma-mater in', 'multi_select', null, 13);
select seed_options ('alumni', 'contribution_areas', array[
  'Academics – teaching', 'Academics – curriculum design & development', 'Placements',
  'Internships', 'Extracurricular & cocurricular activities',
  'Entrepreneurial opportunities', 'All the above', 'Other']);

select seed_question('alumni', 'other_feedback',
  'Any other feedback to improve program/students', 'long_text', null, 14, false);

-- =============================================================
-- §8.5 FACULTY — scale: Strongly Agree…Strongly Disagree + Not Applicable
-- Note: this scale has 4 scoring points, not 5. Analytics must normalise
-- before comparing faculty averages against the other forms.
-- =============================================================
select seed_question('faculty', 'name', 'Name (optional)', 'short_text', null, 1, false);
select seed_question('faculty', 'department', 'Department', 'short_text', null, 2);
select seed_question('faculty', 'academic_year', 'Academic year', 'short_text', null, 3);
select seed_question('faculty', 'program',
  'Program (as specified in course structure)', 'short_text', null, 4);
select seed_question('faculty', 'course_title',
  'Course/courses title(s) for which feedback is provided', 'short_text', null, 5);

select seed_question('faculty', 'syllabus_completed_in_time',
  'The content of my syllabus transacted is completed in the given timeframe', 'rating', 'agreement_4_na', 6);
select seed_question('faculty', 'practical_theory_correlation',
  'The practical course is appropriately/adequately correlated with the theory', 'rating', 'agreement_4_na', 7);
select seed_question('faculty', 'freedom_to_propose_topics',
  'I have freedom to propose, modify, suggest and incorporate new topics through proper forum',
  'rating', 'agreement_4_na', 8);
select seed_question('faculty', 'library_book_copies',
  'There are multiple copies of the prescribed books in the library', 'rating', 'agreement_4_na', 9);
select seed_question('faculty', 'outcome_attainment_level',
  'The course achieves the minimum required course outcome attainment level for my class',
  'rating', 'agreement_4_na', 10);
select seed_question('faculty', 'outcomes_met_for_learners',
  'The course outcomes are met for most of the learners in class', 'rating', 'agreement_4_na', 11);
select seed_question('faculty', 'credits_appropriate',
  'The credits allocated to the course are appropriate', 'rating', 'agreement_4_na', 12);
select seed_question('faculty', 'contact_hours_distribution',
  'Distribution of contact hours among course components (theory, practicals, research project, internship, etc.) is appropriate/adequate',
  'rating', 'agreement_4_na', 13);
select seed_question('faculty', 'syllabus_manageable',
  'The syllabus content is manageable by the students', 'rating', 'agreement_4_na', 14);
select seed_question('faculty', 'domain_knowledge',
  'The syllabus caters to domain knowledge adequately', 'rating', 'agreement_4_na', 15);
select seed_question('faculty', 'employability',
  'The course contents enhance the learners'' employability and/or skills set', 'rating', 'agreement_4_na', 16);

select seed_question('faculty', 'recommendations',
  'Recommendations for course improvement (topics to add/drop, new books, changes in teaching scheme/experiments)',
  'long_text', null, 17, false);

-- ---------- first cycle ----------
insert into academic_cycles (label, is_active, opens_at, closes_at)
values ('2025-26', true, now(), now() + interval '120 days')
on conflict (label) do nothing;

-- ---------- cleanup ----------
-- Helpers exist only for seeding; drop them so they are not part of the API surface.
drop function if exists seed_question(user_role, text, text, question_type, text, int, boolean);
drop function if exists seed_options(user_role, text, text[]);
