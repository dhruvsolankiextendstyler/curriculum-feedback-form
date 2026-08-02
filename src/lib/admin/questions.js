import { supabase } from '../supabase'
import {
  cosmeticPatch,
  deriveQuestionKey,
  requiresNewVersion,
  slugifyOptionValue,
} from './questionDiff'

/**
 * Admin question management (FR-25 to FR-34).
 *
 * The invariant this module exists to hold: a question version that has been
 * answered is never mutated. Edits that change what was asked insert a new
 * version and repoint `questions.current_version_id`; presentation-only edits
 * update `questions` directly. Deletes are soft.
 *
 * Postgres enforces the same thing via the `question_versions_immutable` and
 * `question_options_immutable` triggers, so a bug here surfaces as a raised
 * exception rather than silently rewritten history.
 */

/** Every question on a form, including soft-deleted ones (admins see all). */
export async function loadQuestionsForAdmin(formId) {
  const { data, error } = await supabase
    .from('questions')
    .select(
      `id, question_key, is_required, display_order, is_active, deleted_at,
       current_version_id,
       question_versions!questions_current_version_fk (
         id, version_no, text, type, scale_id,
         question_options ( id, label, value, display_order )
       )`,
    )
    .eq('form_id', formId)
    .order('display_order', { ascending: true })

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

/** FR-25: append a question to a form. */
export async function createQuestion({ formId, draft, existingKeys, actorId }) {
  const { data: last } = await supabase
    .from('questions')
    .select('display_order')
    .eq('form_id', formId)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle()

  const nextOrder = (last?.display_order ?? 0) + 1

  const { data: question, error } = await supabase
    .from('questions')
    .insert({
      form_id: formId,
      question_key: deriveQuestionKey(draft.text, existingKeys),
      is_required: Boolean(draft.required),
      display_order: nextOrder,
      is_active: true,
    })
    .select('id')
    .single()

  if (error) throw new Error(error.message)

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

    if (error) throw new Error(error.message)

    await insertVersion({
      questionId: current.id,
      versionNo: (latest?.version_no ?? 0) + 1,
      draft,
      actorId,
    })
  }

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from('questions').update(patch).eq('id', current.id)
    if (error) throw new Error(error.message)
  }

  if (substantive) {
    await audit(current.id, 'edited', actorId, {
      from: current.text,
      to: draft.text.trim(),
      new_version: true,
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

  if (error) throw new Error(error.message)

  const needsOptions = draft.type === 'single_select' || draft.type === 'multi_select'
  const options = (draft.options ?? []).filter((o) => o.label?.trim())

  if (needsOptions && options.length > 0) {
    const rows = options.map((o, i) => ({
      question_version_id: version.id,
      label: o.label.trim(),
      value: slugifyOptionValue(o.value || o.label),
      display_order: i + 1,
    }))
    const { error: oError } = await supabase.from('question_options').insert(rows)
    if (oError) throw new Error(oError.message)
  }

  const { error: pError } = await supabase
    .from('questions')
    .update({ current_version_id: version.id })
    .eq('id', questionId)

  if (pError) throw new Error(pError.message)
  return version.id
}

/** FR-32: soft delete — leaves the live form, stays in analytics. */
export async function deactivateQuestion(questionId, actorId) {
  const { error } = await supabase
    .from('questions')
    .update({ is_active: false, deleted_at: new Date().toISOString() })
    .eq('id', questionId)

  if (error) throw new Error(error.message)
  await audit(questionId, 'deleted', actorId, null)
}

/** FR-33: restore a soft-deleted question. */
export async function restoreQuestion(questionId, actorId) {
  const { error } = await supabase
    .from('questions')
    .update({ is_active: true, deleted_at: null })
    .eq('id', questionId)

  if (error) throw new Error(error.message)
  await audit(questionId, 'restored', actorId, null)
}

/**
 * FR-29: reorder. Writes the whole list's display_order.
 *
 * There is no unique constraint on display_order, so a sequential rewrite needs
 * no temporary values. Not transactional from the client: a mid-flight failure
 * can leave a partial order, which is cosmetic and fixed by reordering again.
 */
export async function reorderQuestions(orderedIds, actorId) {
  const updates = orderedIds.map((id, i) =>
    supabase.from('questions').update({ display_order: i + 1 }).eq('id', id),
  )
  const results = await Promise.all(updates)
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(failed.error.message)

  if (orderedIds.length > 0) {
    await audit(orderedIds[0], 'reordered', actorId, { count: orderedIds.length })
  }
}

/** FR-33: version history for one question. */
export async function loadVersionHistory(questionId) {
  const { data, error } = await supabase
    .from('question_versions')
    .select('id, version_no, text, type, scale_id, created_at, created_by')
    .eq('question_id', questionId)
    .order('version_no', { ascending: false })

  if (error) throw new Error(error.message)
  return data ?? []
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

export async function loadAuditTrail(questionId) {
  const { data, error } = await supabase
    .from('question_audit')
    .select('id, action, details, created_at, actor_id')
    .eq('question_id', questionId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw new Error(error.message)
  return data ?? []
}
