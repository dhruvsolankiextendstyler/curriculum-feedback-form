import { supabase } from '../supabase'
import {
  CODE_HINT,
  validateDepartmentDraft,
  validateStreamDraft,
} from './departmentRules'

export {
  CODE_HINT,
  DEPARTMENT_SORTS,
  departmentRequiredFor,
  describeDepartment,
  resolveDepartment,
  sortDepartmentRows,
} from './departmentRules'

/**
 * Streams and departments (FR-44 to FR-48).
 *
 * Reads and writes go through the signed-in admin's RLS policies — there is no
 * privileged path here, because unlike account creation none of this needs one.
 *
 * Removing a department is TWO different operations, deliberately kept apart:
 *   archive  is_active = false  — it leaves the pickers, its people keep theirs
 *   delete   the row goes       — only possible while nothing references it
 * `on delete restrict` in 0008_departments.sql is what makes the second safe; the
 * error it raises is translated below into the suggestion to archive instead.
 */

const STREAM_COLUMNS = 'id, name, slug, display_order, is_active, created_at'
const DEPARTMENT_COLUMNS =
  'id, stream_id, name, code, slug, display_order, is_active, created_at'

export async function loadStreams() {
  const { data, error } = await supabase
    .from('streams')
    .select(STREAM_COLUMNS)
    .order('display_order', { ascending: true })
    .order('name', { ascending: true })

  if (error) throw new Error(translateDepartmentError(error))
  return data ?? []
}

export async function loadDepartments() {
  const { data, error } = await supabase
    .from('departments')
    .select(DEPARTMENT_COLUMNS)
    .order('display_order', { ascending: true })
    .order('name', { ascending: true })

  if (error) throw new Error(translateDepartmentError(error))
  return data ?? []
}

/** Both lists in one round trip; every caller needs them together. */
export async function loadDepartmentTree() {
  const [streams, departments] = await Promise.all([loadStreams(), loadDepartments()])
  return { streams, departments }
}

/**
 * Per-department reference counts, tallied client-side the way loadCycleCounts
 * does: a handful of ids over the wire beats a view per screen.
 *
 * `users` counts only the current list, but `blocking` counts every referencing
 * row — removed accounts included, because the foreign key does not care that a
 * profile is filed under "removed" and will still refuse the delete.
 *
 * All THREE referencing tables are counted. `questions.department_id` is the
 * third `on delete restrict` (0011_hod_scope.sql), and leaving it out made a
 * department with a question and nothing else report zero usage: the confirm
 * dialog promised the delete would succeed, then it failed 23503 and the banner
 * blamed people and responses that did not exist (FR-48). Soft-deleted questions
 * count too — the foreign key still holds.
 */
export async function loadDepartmentUsage() {
  const [profiles, responses, questions] = await Promise.all([
    supabase.from('profiles').select('department_id, removed_at'),
    supabase.from('responses').select('department_id'),
    supabase.from('questions').select('department_id'),
  ])

  // The pre-migration window: report no usage rather than failing the page.
  if (profiles.error || responses.error || questions.error) {
    const error = profiles.error ?? responses.error ?? questions.error
    if (isMissingDepartmentColumn(error.message)) return {}
    throw new Error(translateDepartmentError(error))
  }

  const usage = {}
  const row = (id) => {
    usage[id] ??= { users: 0, removedUsers: 0, responses: 0, questions: 0, blocking: 0 }
    return usage[id]
  }

  for (const profile of profiles.data ?? []) {
    if (!profile.department_id) continue
    const entry = row(profile.department_id)
    entry[profile.removed_at ? 'removedUsers' : 'users'] += 1
    entry.blocking += 1
  }
  for (const response of responses.data ?? []) {
    if (!response.department_id) continue
    const entry = row(response.department_id)
    entry.responses += 1
    entry.blocking += 1
  }
  for (const question of questions.data ?? []) {
    if (!question.department_id) continue
    const entry = row(question.department_id)
    entry.questions += 1
    entry.blocking += 1
  }

  return usage
}

// ---------- streams ----------

/**
 * `existing` is the list the page already holds. Passing it in lets the duplicate
 * check and the display order be decided without two extra round trips; the
 * unique index is still the authority if two admins race.
 */
export async function createStream({ name }, existing = []) {
  const check = validateStreamDraft({ name }, existing)
  if (!check.ok) throw new Error(firstError(check.errors))

  const { data, error } = await supabase
    .from('streams')
    .insert({ name: check.value.name, display_order: nextOrder(existing) })
    .select('id')
    .single()

  if (error) throw new Error(translateDepartmentError(error))
  return data.id
}

export async function updateStream(streamId, { name, is_active }, existing = []) {
  const patch = {}

  if (name !== undefined) {
    const check = validateStreamDraft({ name }, existing, { ignoreId: streamId })
    if (!check.ok) throw new Error(firstError(check.errors))
    patch.name = check.value.name
  }
  if (is_active !== undefined) patch.is_active = Boolean(is_active)
  if (Object.keys(patch).length === 0) return

  await mustAffectRow(
    supabase.from('streams').update(patch).eq('id', streamId).select('id'),
  )
}

export async function deleteStream(streamId) {
  await mustAffectRow(
    supabase.from('streams').delete().eq('id', streamId).select('id'),
  )
}

// ---------- departments ----------

export async function createDepartment({ streamId, name, code }, existing = []) {
  const check = validateDepartmentDraft({ streamId, name, code }, existing)
  if (!check.ok) throw new Error(firstError(check.errors))

  const siblings = existing.filter((row) => row.stream_id === streamId)
  const { data, error } = await supabase
    .from('departments')
    .insert({ ...check.value, display_order: nextOrder(siblings) })
    .select('id')
    .single()

  if (error) throw new Error(translateDepartmentError(error))
  return data.id
}

/**
 * Rename, re-code, move to another stream, or archive — one call, because the
 * page edits a department as one row rather than field by field.
 */
export async function updateDepartment(
  departmentId,
  { streamId, name, code, is_active },
  existing = [],
) {
  const current = existing.find((row) => row.id === departmentId)
  const patch = {}

  if (streamId !== undefined || name !== undefined || code !== undefined) {
    const draft = {
      streamId: streamId ?? current?.stream_id,
      name: name ?? current?.name,
      code: code !== undefined ? code : current?.code,
    }
    const check = validateDepartmentDraft(draft, existing, { ignoreId: departmentId })
    if (!check.ok) throw new Error(firstError(check.errors))

    if (name !== undefined) patch.name = check.value.name
    if (code !== undefined) patch.code = check.value.code
    if (streamId !== undefined) patch.stream_id = check.value.stream_id
  }
  if (is_active !== undefined) patch.is_active = Boolean(is_active)
  if (Object.keys(patch).length === 0) return

  await mustAffectRow(
    supabase.from('departments').update(patch).eq('id', departmentId).select('id'),
  )
}

export async function deleteDepartment(departmentId) {
  await mustAffectRow(
    supabase.from('departments').delete().eq('id', departmentId).select('id'),
  )
}

// ---------- plumbing ----------

const firstError = (errors) => Object.values(errors)[0] ?? 'That change is not valid.'

/**
 * Runs an update or a delete and insists Postgres actually returned the row.
 *
 * RLS does not raise on a statement it filters out and neither does a WHERE that
 * matches nothing: both come back as success with zero rows. Without `.select()`
 * the page then shows "<name> deleted." for a row that never existed, or
 * "Saved <name>." for a rename the database discarded — while `refresh()` puts
 * the truth in the table right beside the notice. The two create paths already
 * work this way; this is the same contract for the other four.
 */
async function mustAffectRow(query) {
  const { data, error } = await query
  if (error) throw new Error(translateDepartmentError(error))
  if (!data || data.length === 0) {
    throw new Error(
      'Nothing was changed. The row may already be gone, or your access may have changed — reload the page.',
    )
  }
  return data
}

/** New rows sort after the ones already there rather than jumping to the top. */
const nextOrder = (rows) =>
  rows.reduce((max, row) => Math.max(max, row.display_order ?? 0), 0) + 1

export const isMissingDepartmentColumn = (message = '') =>
  /department_id|\bdepartments\b|\bstreams\b/i.test(message) &&
  /does not exist|could not find|schema cache/i.test(message)

/**
 * Turns a Postgres or PostgREST failure into a sentence an admin can act on.
 * The constraint names are the ones created in 0008_departments.sql.
 */
export function translateDepartmentError(error) {
  const message = error?.message ?? 'Could not save that change.'
  const code = error?.code ?? ''

  if (isMissingDepartmentColumn(message) || code === '42P01' || code === 'PGRST205') {
    return 'Departments need the database migration applied first: supabase/migrations/0008_departments.sql.'
  }
  if (/streams_slug_unique/i.test(message)) {
    return 'A stream with that name already exists.'
  }
  if (/departments_slug_unique/i.test(message)) {
    return 'That stream already has a department with this name.'
  }
  if (/departments_code_unique/i.test(message)) {
    return 'That short code is already used by another department in this stream.'
  }
  if (/departments_code_shape/i.test(message)) {
    return `Invalid short code. Use ${CODE_HINT}.`
  }
  if (/name_not_blank/i.test(message)) {
    return 'A name is required.'
  }
  // on delete restrict: the row is still referenced. Archiving is the operation
  // the admin actually wants here, so name it.
  if (code === '23503' || /violates foreign key constraint/i.test(message)) {
    if (/departments_stream_id_fkey/i.test(message)) {
      return 'This stream still has departments. Move or delete them first, or archive the stream instead.'
    }
    if (/questions_department_id_fkey/i.test(message)) {
      // Named separately because it is the one blocker the admin cannot clear:
      // questions are only ever soft-deleted (FR-32), and a soft-deleted one
      // still holds the foreign key.
      return 'This department has its own questions, so it cannot be deleted — removing a question from a form does not release it. Archive the department instead; it leaves the pickers and keeps its history.'
    }
    return 'People or responses are still attached to this department, so it cannot be deleted. Archive it instead — it leaves the pickers and keeps its history.'
  }
  if (code === '42501' || /row-level security/i.test(message)) {
    return 'You do not have permission for that change.'
  }
  return message
}
