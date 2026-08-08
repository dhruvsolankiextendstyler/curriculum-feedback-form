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

/**
 * The question a stored answer belongs to, from the embedded question_versions
 * join. PostgREST returns an embedded to-one as an object or, depending on how
 * the relationship is inferred, a one-element array — so both are accepted.
 */
export function questionIdOf(row) {
  return Array.isArray(row.question_versions)
    ? row.question_versions[0]?.question_id ?? null
    : row.question_versions?.question_id ?? null
}

/**
 * Decides what a resave does to each stored answer (FR-31, FR-32).
 *
 * Replacing the whole answer set — delete every row, insert what the form is
 * showing — loses two things that cannot be reconstructed afterwards:
 *
 *   1. Answers to a question that has since been soft-deleted. They have no
 *      field on the live form, so they are not among the rows being written and
 *      the blanket delete destroys them. FR-32 promises the opposite: a deleted
 *      question leaves the form but its data stays in analytics. Under the old
 *      behaviour a respondent fixing a typo in their course title silently
 *      erased their answer, so the recorded response count decayed over a cycle
 *      with nothing to show for it.
 *
 *   2. The version each answer was actually given against. Re-inserting an
 *      untouched answer at the question's current version rewrites history,
 *      which is what FR-31 exists to prevent — and it hides the FR-34 warning
 *      that an average spans reworded variants, because the evidence for that
 *      warning is precisely which versions the answers sit on.
 *
 * So a row is rewritten only when its value actually changed. Everything else
 * is left exactly as stored.
 *
 * @param {object[]} existing  rows from `answers`, each carrying its id and the
 *                             embedded question_versions.question_id
 * @param {object[]} questions the live form's questions, at current versions
 * @param {object} values      form values, keyed by current version id
 * @returns {{ keepIds: string[], deleteIds: string[], insertRows: object[] }}
 */
export function planAnswerWrite(existing, questions, values) {
  const liveByQuestionId = new Map(questions.map((q) => [q.id, q]))

  const keepIds = []
  const deleteIds = []
  const insertRows = []

  // Split the stored rows by the question they answer. A row whose question is
  // not on the live form is kept untouched: either it was soft-deleted, or the
  // join came back in a shape we cannot read, and destroying data is the worse
  // failure in both cases.
  const storedByQuestionId = new Map()
  for (const row of existing) {
    const questionId = questionIdOf(row)
    if (!questionId || !liveByQuestionId.has(questionId)) {
      keepIds.push(row.id)
      continue
    }
    const rows = storedByQuestionId.get(questionId)
    if (rows) rows.push(row)
    else storedByQuestionId.set(questionId, [row])
  }

  for (const question of questions) {
    const stored = storedByQuestionId.get(question.id) ?? []
    const desired = toAnswerRow(question, values[question.versionId])

    // Answered before, blank now — the respondent cleared the field.
    if (!desired) {
      for (const row of stored) deleteIds.push(row.id)
      continue
    }

    // Unchanged: keep the stored row, still pointing at the wording it was
    // given against. `find` rather than a single lookup because one response can
    // legitimately hold rows on two versions of the same question — the unique
    // constraint is per version, not per question.
    const unchanged = stored.find((row) => sameAnswer(row, desired))
    if (unchanged) {
      keepIds.push(unchanged.id)
      for (const row of stored) {
        if (row.id !== unchanged.id) deleteIds.push(row.id)
      }
      continue
    }

    for (const row of stored) deleteIds.push(row.id)
    insertRows.push(desired)
  }

  return { keepIds, deleteIds, insertRows }
}

/** True when a stored row already holds the answer a save is about to write. */
function sameAnswer(stored, desired) {
  return (
    sameText(stored.value_text, desired.value_text) &&
    sameNumber(stored.value_numeric, desired.value_numeric) &&
    sameOptions(stored.value_options, desired.value_options)
  )
}

const isNullish = (value) => value === null || value === undefined

const sameText = (a, b) => (isNullish(a) ? isNullish(b) : !isNullish(b) && a === b)

/** numeric comes back from PostgREST as a number, but string-safe either way. */
const sameNumber = (a, b) =>
  isNullish(a) ? isNullish(b) : !isNullish(b) && Number(a) === Number(b)

function sameOptions(a, b) {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  // A multi_select is a set: re-ticking the same boxes in a different order is
  // not a change, and re-versioning over it would be a false FR-34 signal.
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, i) => value === sortedRight[i])
}

/**
 * Which row a save should target, given the current route and any id produced
 * by an earlier save in this same mount (FR-13, FR-15).
 *
 * Extracted from FeedbackForm so the rule is testable without React. The bug
 * this guards against: React keeps FeedbackForm mounted when navigating
 * /feedback/<id> -> /feedback/new, so an id left over from a previous save
 * would silently UPDATE the earlier submission instead of INSERTing a new one —
 * losing the first response and never surfacing the duplicate warning.
 *
 * @param {string|undefined} routeId  the :responseId param, undefined on /new
 * @param {string|null} savedId       id returned by a save during this mount
 * @returns {string|null} the id to update, or null to insert
 */
export function bindingIdFor(routeId, savedId) {
  // The route always wins: it is the user's explicit intent.
  if (routeId) return routeId
  // On /feedback/new, only an id created during THIS visit may be reused, so a
  // second save of the same course edits rather than erroring.
  return savedId ?? null
}
