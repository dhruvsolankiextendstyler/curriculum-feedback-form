import { supabase } from './supabase'

/**
 * Loads one stakeholder form: its live questions, each question's CURRENT
 * version, that version's options, and the rating scale it uses.
 *
 * Answers are stored against a question VERSION (0001_schema.sql), so the
 * version id travels with every field and is what we write back. Reading
 * `current_version_id` here means a respondent always answers the newest
 * wording, while past answers keep pointing at the wording they were given.
 *
 * Since 0011_hod_scope.sql a form has two question sets: the college-wide one
 * (`department_id is null`, admin-managed) and the respondent's own department's
 * (HOD-managed). A respondent answers both, college-wide questions first.
 * `questions_read` already limits the rows to those two sets, so the filter below
 * is belt-and-braces — it makes the intent readable here rather than only in the
 * policy, and it keeps a respondent whose department is not yet loaded from
 * briefly seeing another department's questions.
 */
export async function loadForm(role, departmentId = null) {
  const { data: form, error: formError } = await supabase
    .from('forms')
    .select('id, title, description, stakeholder_type')
    .eq('stakeholder_type', role)
    .maybeSingle()

  if (formError) throw new Error(formError.message)
  if (!form) throw new Error(`No form is configured for the "${role}" role.`)

  let query = supabase
    .from('questions')
    .select(
      `id, question_key, is_required, display_order, department_id, current_version_id,
       question_versions!questions_current_version_fk (
         id, text, type, scale_id,
         question_options ( id, label, value, display_order )
       )`,
    )
    .eq('form_id', form.id)
    .eq('is_active', true)
    .order('display_order', { ascending: true })
    .order('question_key', { ascending: true })

  query = departmentId
    ? query.or(`department_id.is.null,department_id.eq.${departmentId}`)
    : query.is('department_id', null)

  const { data: rows, error: qError } = await query

  if (qError) throw new Error(qError.message)

  // Supabase returns an embedded to-one join as an object or a 1-element array
  // depending on how it infers the relationship; normalise both.
  const questions = (rows ?? [])
    .map((row) => {
      const v = Array.isArray(row.question_versions)
        ? row.question_versions[0]
        : row.question_versions
      if (!v) return null
      return {
        id: row.id,
        key: row.question_key,
        required: row.is_required,
        order: row.display_order,
        departmentId: row.department_id,
        versionId: v.id,
        text: v.text,
        type: v.type,
        scaleId: v.scale_id,
        options: [...(v.question_options ?? [])].sort(
          (a, b) => a.display_order - b.display_order,
        ),
      }
    })
    .filter(Boolean)
    // Each set numbers its own display_order from 1, so the two would interleave
    // on a single sort. College-wide first, then the department's.
    //
    // `key` breaks a display_order tie. Two live rows CAN share a number — there
    // is no unique constraint and a restore can collide — and without a second
    // key this reader and `loadQuestionsForAdmin` would put the same two rows in
    // different orders, so the admin's list and the respondent's form would
    // disagree (FR-29, FR-33).
    .sort((a, b) =>
      a.departmentId === b.departmentId
        ? a.order - b.order || a.key.localeCompare(b.key)
        : (a.departmentId ? 1 : 0) - (b.departmentId ? 1 : 0),
    )

  const scales = await loadScales(questions)
  const departmentName = departmentId ? await loadDepartmentName(departmentId) : null

  return {
    form,
    questions,
    scales,
    sections: sectionise(questions, departmentName),
  }
}

/** Names the department section. Failure is not fatal: the section falls back. */
async function loadDepartmentName(departmentId) {
  const { data } = await supabase
    .from('departments')
    .select('name')
    .eq('id', departmentId)
    .maybeSingle()
  return data?.name ?? null
}

/** Fetches only the scales this form actually references. */
async function loadScales(questions) {
  const ids = [...new Set(questions.map((q) => q.scaleId).filter(Boolean))]
  if (ids.length === 0) return {}

  const { data, error } = await supabase
    .from('rating_scales')
    .select('id, name, rating_scale_options ( id, label, score, display_order )')
    .in('id', ids)

  if (error) throw new Error(error.message)

  return Object.fromEntries(
    (data ?? []).map((s) => [
      s.id,
      {
        id: s.id,
        name: s.name,
        options: [...(s.rating_scale_options ?? [])].sort(
          (a, b) => a.display_order - b.display_order,
        ),
      },
    ]),
  )
}

/**
 * FR-8 asks for the form in logical sections. Rather than hard-code which key
 * belongs where per form, derive it from the seeded order: the rating block sits
 * in one contiguous run, so anything before it is profile and anything after is
 * closing feedback. Holds for all five forms.
 *
 * The department's own questions are a section of their own rather than merged in.
 * The derivation above depends on the ratings forming ONE contiguous run, and a
 * department rating question appended after the college-wide free-text block would
 * break it — the "Your feedback" section would swallow a rating, or the rating
 * section would swallow the free text. Keeping them separate also tells the
 * respondent whose question they are answering.
 */
function sectionise(questions, departmentName = null) {
  const collegeWide = questions.filter((q) => !q.departmentId)
  const departmental = questions.filter((q) => q.departmentId)

  const sections = sectioniseCollegeWide(collegeWide)

  if (departmental.length > 0) {
    sections.push({
      key: 'department',
      title: departmentName ? `From ${departmentName}` : 'From your department',
      hint: 'Asked by your department in addition to the questions above.',
      questions: departmental,
    })
  }

  return sections
}

function sectioniseCollegeWide(questions) {
  const first = questions.findIndex((q) => q.type === 'rating')
  const lastRating = findLastIndex(questions, (q) => q.type === 'rating')

  if (first === -1) {
    return questions.length > 0
      ? [{ key: 'about', title: 'About you', questions }]
      : []
  }

  return [
    {
      key: 'about',
      title: 'About you',
      hint: 'Tells us whose perspective this feedback represents.',
      questions: questions.slice(0, first),
    },
    {
      key: 'ratings',
      title: 'Your ratings',
      hint: 'Pick the option closest to your view for each statement.',
      questions: questions.slice(first, lastRating + 1),
    },
    {
      key: 'feedback',
      title: 'Your feedback',
      hint: 'Free-text answers. This is what shapes curriculum changes.',
      questions: questions.slice(lastRating + 1),
    },
  ].filter((s) => s.questions.length > 0)
}

// Array.prototype.findLastIndex needs Node 18+/modern browsers; inline it so the
// build target stays wide.
function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i -= 1) if (pred(arr[i])) return i
  return -1
}

/** Question keys the app lifts onto `responses` columns for filtering (FR-37). */
export const COURSE_KEYS = ['course_title']
export const PROGRAM_KEYS = ['program', 'program_specialization']

export const pickMeta = (questions, values, keys) => {
  for (const k of keys) {
    const q = questions.find((x) => x.key === k)
    if (!q) continue
    const v = values[q.versionId]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (Array.isArray(v) && v.length) return v.join(', ')
  }
  return null
}
