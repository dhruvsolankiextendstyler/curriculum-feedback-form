import { supabase } from '../supabase'
import {
  cosmeticPatch,
  deriveQuestionKey,
  requiresNewVersion,
  storedOptionValue,
} from './questionDiff'

/**
 * Admin question management (FR-25 to FR-34, FR-53).
 *
 * The invariant this module exists to hold: a question version that has been
 * answered is never mutated. Edits that change what was asked insert a new
 * version and repoint `questions.current_version_id`; presentation-only edits
 * update `questions` directly. Deletes are soft.
 *
 * Postgres enforces the same thing via the `question_versions_immutable` and
 * `question_options_immutable` triggers, so a bug here surfaces as a raised
 * exception rather than silently rewritten history.
 *
 * Since 0011_hod_scope.sql a question also belongs to a *set*: `department_id`
 * NULL is the college-wide set that only an admin may write, and a non-null one is
 * that department's own, writable by its HOD. Every function here takes the set it
 * is working in explicitly rather than inferring it, because the two are edited
 * from the same page and the wrong default would put a question in front of the
 * whole college.
 */

/** The value the department picker uses for the college-wide set. */
export const COLLEGE_WIDE = ''

/**
 * Every question in one *(form, department)* set, including soft-deleted ones.
 *
 * `departmentId` falsy means the college-wide set. `.is('department_id', null)` and
 * `.eq(...)` are genuinely different queries here, so the caller must say which.
 */
export async function loadQuestionsForAdmin(formId, departmentId = COLLEGE_WIDE) {
  let query = supabase
    .from('questions')
    .select(
      `id, question_key, is_required, display_order, is_active, deleted_at,
       department_id, current_version_id,
       question_versions!questions_current_version_fk (
         id, version_no, text, type, scale_id,
         question_options ( id, label, value, display_order )
       )`,
    )
    .eq('form_id', formId)
    .order('display_order', { ascending: true })
    // Tiebreaker. display_order carries no unique constraint and a restore can
    // legitimately tie, so without a second key this reader and `loadForm`
    // would order the same two rows differently (FR-29, FR-33).
    .order('question_key', { ascending: true })

  query = departmentId
    ? query.eq('department_id', departmentId)
    : query.is('department_id', null)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  return (data ?? []).map((row) => {
    const v = Array.isArray(row.question_versions)
      ? row.question_versions[0]
      : row.question_versions
    return {
      id: row.id,
      key: row.question_key,
      required: row.is_required,
      order: row.display_order,
      isActive: row.is_active,
      deletedAt: row.deleted_at,
      departmentId: row.department_id,
      versionId: v?.id ?? null,
      versionNo: v?.version_no ?? null,
      text: v?.text ?? '(no version)',
      type: v?.type ?? null,
      scaleId: v?.scale_id ?? null,
      options: [...(v?.question_options ?? [])].sort(
        (a, b) => a.display_order - b.display_order,
      ),
    }
  })
}

/**
 * Every question_key already used on a form, across ALL of its sets.
 *
 * `questions (form_id, question_key)` is unique form-wide, not set-wide, so a new
 * key has to be de-duplicated against the other departments' too — otherwise the
 * insert fails on a constraint the editor never showed the admin.
 */
export async function loadFormKeys(formId) {
  const { data, error } = await supabase
    .from('questions')
    .select('question_key')
    .eq('form_id', formId)

  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => row.question_key)
}

/** How many answers exist for a question, across all its versions. */
export async function countAnswers(questionId) {
  const { data: versions, error } = await supabase
    .from('question_versions')
    .select('id')
    .eq('question_id', questionId)

  if (error) throw new Error(error.message)
  const ids = (versions ?? []).map((v) => v.id)
  if (ids.length === 0) return 0

  const { count, error: cError } = await supabase
    .from('answers')
    .select('id', { count: 'exact', head: true })
    .in('question_version_id', ids)

  if (cError) throw new Error(cError.message)
  return count ?? 0
}

export async function loadScales() {
  const { data, error } = await supabase
    .from('rating_scales')
    .select('id, name, rating_scale_options ( id, label, score, display_order )')
    .order('name')

  if (error) throw new Error(error.message)
  return (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    options: [...(s.rating_scale_options ?? [])].sort(
      (a, b) => a.display_order - b.display_order,
    ),
  }))
}

/**
 * FR-25: append a question to one *(form, department)* set.
 *
 * `existingKeys` should be every key on the FORM (see loadFormKeys); `keyPrefix` is
 * the department's slug for a department question and empty for a college-wide one,
 * which is what keeps two departments' identically-worded questions apart in
 * analytics. `display_order` counts within the set, so each numbers itself.
 */
export async function createQuestion({
  formId,
  departmentId = COLLEGE_WIDE,
  draft,
  existingKeys,
  keyPrefix = '',
  actorId,
}) {
  const nextOrder = await nextDisplayOrder(formId, departmentId)

  const { data: question, error } = await supabase
    .from('questions')
    .insert({
      form_id: formId,
      department_id: departmentId || null,
      question_key: deriveQuestionKey(draft.text, existingKeys, keyPrefix),
      is_required: Boolean(draft.required),
      display_order: nextOrder,
      is_active: true,
    })
    .select('id')
    .single()

  if (error) throw new Error(translateQuestionError(error))

  await insertVersion({
    questionId: question.id,
    versionNo: 1,
    draft,
    actorId,
  })

  await audit(question.id, 'created', actorId, { text: draft.text.trim() })
  return question.id
}

/**
 * FR-56: copy a question into another form, another department, or both.
 *
 * The copy is a fresh version-1 question with its own key, not a link — so editing
 * either afterwards leaves the other alone, and each accumulates its own answers
 * and its own history. That is the only shape that keeps the versioning invariant:
 * one `question_versions` row cannot belong to two questions.
 */
export async function duplicateQuestion({
  question,
  targetFormId,
  targetDepartmentId = COLLEGE_WIDE,
  keyPrefix = '',
  actorId,
}) {
  const existingKeys = await loadFormKeys(targetFormId)

  return createQuestion({
    formId: targetFormId,
    departmentId: targetDepartmentId,
    draft: {
      text: question.text,
      type: question.type,
      scaleId: question.scaleId,
      required: question.required,
      options: (question.options ?? []).map((o) => ({ label: o.label, value: o.value })),
    },
    existingKeys,
    keyPrefix,
    actorId,
  })
}

/**
 * The display_order to append at within one *(form, department)* set.
 *
 * Counts soft-deleted rows too. `questions.display_order` carries no unique
 * constraint — deliberately, so a sequential rewrite needs no temporary values —
 * and a removed question keeps its slot, so appending past only the live rows is
 * what lets FR-33's restore land a second live row on an occupied number.
 */
async function nextDisplayOrder(formId, departmentId) {
  let query = supabase
    .from('questions')
    .select('display_order')
    .eq('form_id', formId)
    .order('display_order', { ascending: false })
    .limit(1)

  query = departmentId
    ? query.eq('department_id', departmentId)
    : query.is('department_id', null)

  const { data, error } = await query.maybeSingle()
  if (error) throw new Error(translateQuestionError(error))
  return (data?.display_order ?? 0) + 1
}

/**
 * What to say when the database accepted a write and discarded it.
 *
 * RLS does not raise on an UPDATE it filters out: the statement matches no rows
 * and returns success. Without `.select()` that is indistinguishable from a real
 * write, so the page would report "removed" for a question still on the form
 * (NFR-3). Reachable whenever an admin moves, demotes or removes an HOD while
 * that HOD has this page open — `AuthContext` reads the profile once per session
 * and never revalidates. `src/lib/admin/users.js` already works this way.
 */
const NOTHING_WRITTEN =
  'That change was not saved. Your access may have changed — reload the page and try again.'

/** Runs a `questions` update and insists Postgres actually returned the row. */
async function updateQuestionRow(patch, questionId) {
  const { data, error } = await supabase
    .from('questions')
    .update(patch)
    .eq('id', questionId)
    .select('id')

  if (error) throw new Error(translateQuestionError(error))
  if (!data || data.length === 0) throw new Error(NOTHING_WRITTEN)
  return data
}

/**
 * FR-26 / FR-31: apply an edit.
 * @returns {'versioned'|'updated'|'unchanged'} what happened, for the UI to report.
 */
export async function updateQuestion({ current, draft, actorId }) {
  const substantive = requiresNewVersion(current, draft)
  const patch = cosmeticPatch(current, draft)

  if (substantive) {
    const { data: latest, error } = await supabase
      .from('question_versions')
      .select('version_no')
      .eq('question_id', current.id)
      .order('version_no', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw new Error(translateQuestionError(error))

    await insertVersion({
      questionId: current.id,
      versionNo: (latest?.version_no ?? 0) + 1,
      draft,
      actorId,
    })
  }

  if (Object.keys(patch).length > 0) {
    await updateQuestionRow(patch, current.id)
  }

  if (substantive) {
    // The cosmetic patch rides along in the same audit row rather than being
    // dropped by an early return: is_required and display_order reach
    // `question_audit` nowhere else, and a required-flag flip that travelled
    // with a reword would otherwise vanish from the trail while the identical
    // flip on its own is logged (NFR-9).
    await audit(current.id, 'edited', actorId, {
      from: current.text,
      to: draft.text.trim(),
      new_version: true,
      ...patch,
    })
    return 'versioned'
  }
  if (Object.keys(patch).length > 0) {
    await audit(current.id, 'edited', actorId, { ...patch, new_version: false })
    return 'updated'
  }
  return 'unchanged'
}

/**
 * Inserts a version, its options, and points the question at it.
 *
 * Order matters: the new version has no answers yet, so writing its options
 * passes the immutability trigger. Repointing `current_version_id` last means a
 * concurrent respondent load either sees the old version fully or the new one
 * fully, never a half-built one.
 */
async function insertVersion({ questionId, versionNo, draft, actorId }) {
  const { data: version, error } = await supabase
    .from('question_versions')
    .insert({
      question_id: questionId,
      version_no: versionNo,
      text: draft.text.trim(),
      type: draft.type,
      scale_id: draft.type === 'rating' ? draft.scaleId : null,
      created_by: actorId ?? null,
    })
    .select('id')
    .single()

  if (error) throw new Error(translateQuestionError(error))

  const needsOptions = draft.type === 'single_select' || draft.type === 'multi_select'
  const options = (draft.options ?? []).filter((o) => o.label?.trim())

  if (needsOptions && options.length > 0) {
    const rows = options.map((o, i) => ({
      question_version_id: version.id,
      label: o.label.trim(),
      // An option that already exists carries its stored value across to the
      // new version; only a brand-new one is slugified. Re-deriving the slug
      // here would desynchronise the frozen `answers.value_options` of every
      // previously submitted answer — see storedOptionValue.
      value: storedOptionValue(o),
      display_order: i + 1,
    }))
    const { error: oError } = await supabase.from('question_options').insert(rows)
    if (oError) throw new Error(translateQuestionError(oError))
  }

  await updateQuestionRow({ current_version_id: version.id }, questionId)
  return version.id
}

/** FR-32: soft delete — leaves the live form, stays in analytics. */
export async function deactivateQuestion(questionId, actorId) {
  await updateQuestionRow(
    { is_active: false, deleted_at: new Date().toISOString() },
    questionId,
  )
  await audit(questionId, 'deleted', actorId, null)
}

/**
 * FR-33: restore a soft-deleted question.
 *
 * The row is appended to the end of its set rather than resuming the slot it
 * held when it was removed. A soft delete leaves display_order alone and a
 * reorder renumbers only the live rows, so the old slot is normally occupied by
 * now — restoring into it puts two live questions on one number, and the two
 * readers break that tie differently.
 */
export async function restoreQuestion(questionId, actorId) {
  const { data: question, error } = await supabase
    .from('questions')
    .select('form_id, department_id')
    .eq('id', questionId)
    .maybeSingle()

  if (error) throw new Error(translateQuestionError(error))
  if (!question) throw new Error(NOTHING_WRITTEN)

  const displayOrder = await nextDisplayOrder(question.form_id, question.department_id)

  await updateQuestionRow(
    { is_active: true, deleted_at: null, display_order: displayOrder },
    questionId,
  )
  await audit(questionId, 'restored', actorId, { display_order: displayOrder })
}

/**
 * FR-29: reorder. Writes the whole list's display_order.
 *
 * There is no unique constraint on display_order, so a sequential rewrite needs
 * no temporary values. Not transactional from the client: a mid-flight failure
 * can leave a partial order, which is cosmetic and fixed by reordering again.
 *
 * `orderedIds` must be the WHOLE set, soft-deleted rows included. Renumbering
 * only the live rows leaves every removed question on a number a live one now
 * also holds, which is the tie a later FR-33 restore makes visible.
 */
export async function reorderQuestions(orderedIds, actorId) {
  const updates = orderedIds.map((id, i) =>
    supabase
      .from('questions')
      .update({ display_order: i + 1 })
      .eq('id', id)
      .select('id'),
  )
  const results = await Promise.all(updates)
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(translateQuestionError(failed.error))
  if (results.some((r) => !r.data || r.data.length === 0)) {
    throw new Error(NOTHING_WRITTEN)
  }

  if (orderedIds.length > 0) {
    await audit(orderedIds[0], 'reordered', actorId, { count: orderedIds.length })
  }
}

async function versionRows(questionId) {
  const { data, error } = await supabase
    .from('question_versions')
    .select('id, version_no, text, type, scale_id, created_at, created_by')
    .eq('question_id', questionId)
    .order('version_no', { ascending: false })

  if (error) throw new Error(error.message)
  return data ?? []
}

/** FR-33: version history for one question, with who wrote each version. */
export async function loadVersionHistory(questionId) {
  return withActors(await versionRows(questionId), 'created_by')
}

/**
 * FR-33: both halves of one question's history — "what changed, when, by whom".
 *
 * Pooled deliberately. Called separately the two readers each resolve their own
 * authors, so opening the panel issued two byte-identical
 * `profiles?id=in.(…)` requests and four HTTP calls in total. The author ids
 * overlap almost completely — the same people edit and are audited — so one
 * read serves both.
 */
export async function loadQuestionHistory(questionId) {
  const [versions, audit] = await Promise.all([
    versionRows(questionId),
    auditRows(questionId),
  ])

  const actors = await resolveActors([
    ...versions.map((row) => row.created_by),
    ...audit.map((row) => row.actor_id),
  ])

  return {
    versions: versions.map((row) => ({
      ...row,
      actor: actors.get(row.created_by) ?? null,
    })),
    audit: audit.map((row) => ({ ...row, actor: actors.get(row.actor_id) ?? null })),
  }
}

/** NFR-9: audit trail. Best-effort — a failed log must not undo a good edit. */
async function audit(questionId, action, actorId, details) {
  const { error } = await supabase.from('question_audit').insert({
    question_id: questionId,
    action,
    actor_id: actorId ?? null,
    details,
  })
  if (error) console.warn(`audit log failed (${action}):`, error.message)
}

async function auditRows(questionId) {
  const { data, error } = await supabase
    .from('question_audit')
    .select('id, action, details, created_at, actor_id')
    .eq('question_id', questionId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function loadAuditTrail(questionId) {
  return withActors(await auditRows(questionId), 'actor_id')
}

/**
 * Attaches an `actor` to each row: `{ name, role }`, or null.
 *
 * Worth the extra read now that a question set can have more than one editor — an
 * admin and the department's HOD both write here, and "edited" with no author is
 * not much of an audit trail (NFR-9).
 *
 * A null actor is left null rather than guessed at. An HOD may only read profiles
 * in their own department, so an admin's edit resolves to nothing for them, and
 * inventing "an administrator" would be an inference presented as a fact. The
 * views render the action and the timestamp and simply omit the name.
 */
async function withActors(rows, idField) {
  const actors = await resolveActors(rows.map((row) => row[idField]))
  return rows.map((row) => ({ ...row, actor: actors.get(row[idField]) ?? null }))
}

/** @returns {Promise<Map<string, {name: string, role: string}>>} */
async function resolveActors(ids) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, role')
    .in('id', unique)

  // Not fatal: the history is still readable without the names.
  if (error) return new Map()

  return new Map(
    (data ?? []).map((row) => [
      row.id,
      { name: row.full_name || row.email, role: row.role },
    ]),
  )
}

/**
 * Turns a question write failure into something the editor can act on.
 *
 * The two that actually happen: an HOD reaching outside their own set, which RLS
 * answers with a bare row-level-security message, and a key collision with another
 * department's question on the same form, which the unique index answers with a
 * constraint name.
 *
 * A 23505 is discriminated by constraint NAME, the way `cycles.js` already does
 * it. Matching "duplicate key" instead catches every unique violation, because
 * Postgres prefixes all of them with that phrase — including the version_no
 * collision two concurrent editors produce, which has nothing to do with a key.
 */
export function translateQuestionError(error) {
  const message = error?.message ?? 'Could not save this question.'

  if (/question_versions_question_id_version_no_key/i.test(message)) {
    return 'Someone else saved a change to this question. Reload and try again.'
  }
  if (/questions_form_id_question_key_key/i.test(message)) {
    return 'Another question on this form already uses that key. Reword it slightly.'
  }
  if (error?.code === '23505' || /duplicate key/i.test(message)) {
    return 'Someone else changed this question at the same time. Reload and try again.'
  }
  if (/department_id/i.test(message) && /does not exist|schema cache/i.test(message)) {
    return 'Per-department questions need the database migration applied first: supabase/migrations/0011_hod_scope.sql.'
  }
  if (error?.code === '42501' || /row-level security/i.test(message)) {
    return 'You can only change questions in your own department. The college-wide set is managed by an administrator.'
  }
  return message
}
