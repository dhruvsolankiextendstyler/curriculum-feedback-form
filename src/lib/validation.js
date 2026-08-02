/**
 * Client-side validation for a feedback form (FR-10, FR-13).
 *
 * Pure and dependency-free so it can be unit-tested in Node. This is a UX
 * layer, not a security boundary: the real guarantees (ownership, edit window,
 * one-per-course) are enforced by RLS and constraints in Postgres.
 */

export const MAX_SHORT_TEXT = 200
export const MAX_LONG_TEXT = 4000

/** True when a value counts as "not answered" for its question type. */
export function isBlank(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Validates one answer. Returns an error string, or null when acceptable.
 *
 * `value` shapes by question type:
 *   rating / single_select -> option value (string)
 *   multi_select           -> array of option values
 *   short_text / long_text -> string
 */
export function validateAnswer(question, value) {
  const blank = isBlank(value)

  if (question.required && blank) {
    return question.type === 'rating' || question.type === 'single_select'
      ? 'Please choose an option.'
      : 'This field is required.'
  }
  if (blank) return null // optional and empty: fine

  switch (question.type) {
    case 'rating':
    case 'single_select': {
      const allowed = allowedValues(question)
      if (typeof value !== 'string') return 'Please choose a single option.'
      if (allowed.length && !allowed.includes(value)) {
        return 'That option is no longer available. Please choose again.'
      }
      return null
    }

    case 'multi_select': {
      if (!Array.isArray(value)) return 'Please choose one or more options.'
      const allowed = allowedValues(question)
      if (allowed.length && !value.every((v) => allowed.includes(v))) {
        return 'One of your choices is no longer available. Please review.'
      }
      if (new Set(value).size !== value.length) return 'Duplicate choice.'
      return null
    }

    case 'short_text':
      if (typeof value !== 'string') return 'Please enter text.'
      if (value.trim().length > MAX_SHORT_TEXT) {
        return `Please keep this under ${MAX_SHORT_TEXT} characters.`
      }
      return null

    case 'long_text':
      if (typeof value !== 'string') return 'Please enter text.'
      if (value.trim().length > MAX_LONG_TEXT) {
        return `Please keep this under ${MAX_LONG_TEXT} characters.`
      }
      return null

    default:
      return null
  }
}

/** Option values a question will accept — from its scale, or its own options. */
export function allowedValues(question) {
  if (question.type === 'rating') {
    return (question.scale?.options ?? []).map((o) => o.label)
  }
  return (question.options ?? []).map((o) => o.value)
}

/**
 * Validates a whole form.
 * @returns {{ errors: Record<string,string>, firstInvalid: string|null, ok: boolean }}
 *          keyed by question version id, matching the form value map.
 */
export function validateForm(questions, values) {
  const errors = {}
  let firstInvalid = null

  for (const q of questions) {
    const message = validateAnswer(q, values[q.versionId])
    if (message) {
      errors[q.versionId] = message
      if (!firstInvalid) firstInvalid = q.versionId
    }
  }

  return { errors, firstInvalid, ok: firstInvalid === null }
}

/**
 * Inverse of toAnswerRow: DB rows back into form field values.
 *
 * Lives here beside its pair so the two stay in step, and so both are importable
 * in plain Node for tests without pulling in the Supabase client.
 */
export function answersToValues(rows, questionsByVersionId = null) {
  const values = {}
  for (const row of rows) {
    if (Array.isArray(row.value_options) && row.value_options.length > 0) {
      // Both single_select and multi_select store an array, so length alone
      // cannot tell them apart: a multi_select with one box ticked looks
      // identical to a single_select. Consult the question type when we have it,
      // and only fall back to the length heuristic when we don't — otherwise a
      // one-choice multi_select reloads as a string and fails validation on save.
      const type = questionsByVersionId?.get(row.question_version_id)?.type
      const unwrap =
        type === 'single_select' ||
        (type === undefined && row.value_options.length === 1)

      values[row.question_version_id] = unwrap
        ? row.value_options[0]
        : row.value_options
    } else if (row.value_text !== null && row.value_text !== undefined) {
      values[row.question_version_id] = row.value_text
    } else if (row.value_numeric !== null && row.value_numeric !== undefined) {
      values[row.question_version_id] = String(row.value_numeric)
    }
  }
  return values
}

/**
 * Maps a validated answer onto the `answers` column that fits its type.
 *
 * Ratings store BOTH: value_text keeps the chosen label (so a distribution chart
 * can show what was picked) and value_numeric keeps the score (so averages work).
 * A non-scoring option like "Not applicable" has score null and is therefore
 * excluded from averages while still being counted in distributions.
 */
export function toAnswerRow(question, value) {
  if (isBlank(value)) return null

  const base = { question_version_id: question.versionId }

  switch (question.type) {
    case 'rating': {
      const option = (question.scale?.options ?? []).find((o) => o.label === value)
      return {
        ...base,
        value_text: value,
        value_numeric: option?.score ?? null,
        value_options: null,
      }
    }
    case 'single_select':
      return { ...base, value_text: null, value_numeric: null, value_options: [value] }
    case 'multi_select':
      return { ...base, value_text: null, value_numeric: null, value_options: value }
    case 'short_text':
    case 'long_text':
      return {
        ...base,
        value_text: value.trim(),
        value_numeric: null,
        value_options: null,
      }
    default:
      return null
  }
}
