import { cached } from './cache'
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
 * All questions belong to a department. A respondent sees only their own
 * department's questions.
 */
export const loadForm = cached(async function (role, departmentId = null) {
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

  if (departmentId) query = query.eq('department_id', departmentId)

  const { data: rows, error: qError } = await query

  if (qError) throw new Error(qError.message)

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
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))

  const [scales, departmentName, curriculumPdf] = await Promise.all([
    loadScales(questions),
    departmentId ? loadDepartmentName(departmentId) : null,
    departmentId ? loadCurriculumPdf(form.id, departmentId) : null,
  ])

  return {
    form,
    questions,
    scales,
    curriculumPdf,
    departmentName,
    sections: sectionise(questions),
  }
}, 5 * 60_000)

/** Names the department section. Failure is not fatal: the section falls back. */
async function loadDepartmentName(departmentId) {
  const { data } = await supabase
    .from('departments')
    .select('name')
    .eq('id', departmentId)
    .maybeSingle()
  return data?.name ?? null
}

async function loadCurriculumPdf(formId, departmentId) {
  const { data } = await supabase
    .from('curriculum_pdfs')
    .select('pdf_path')
    .eq('form_id', formId)
    .eq('department_id', departmentId)
    .maybeSingle()
  return data?.pdf_path ?? null
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
 * FR-8 asks for the form in logical sections. Derived from the seeded order:
 * the rating block sits in one contiguous run, so anything before it is profile
 * and anything after is closing feedback.
 */
function sectionise(questions) {
  const first = questions.findIndex((q) => q.type === 'rating')
  const lastRating = questions.findLastIndex((q) => q.type === 'rating')

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
