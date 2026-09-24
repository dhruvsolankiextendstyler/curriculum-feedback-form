/**
 * Decides whether an admin's edit needs a NEW question version (FR-31) or can
 * update the existing row in place.
 *
 * Pure and dependency-free so the rule that protects historical answers is
 * unit-testable without a database.
 *
 * The split follows what an answer means:
 *   - text / type / scale / options change what a respondent was asked, so past
 *     answers must keep pointing at the old wording -> new version.
 *   - required flag / display order only affect presentation -> update in place.
 *
 * Option ORDER counts as substantive. Options hang off a version, and the
 * `question_options_immutable` trigger rejects any UPDATE to the options of an
 * answered version — so reordering them is only expressible as a new version.
 */

/** @returns {boolean} true when the edit must be recorded as a new version. */
export function requiresNewVersion(current, next) {
  if (normaliseText(current.text) !== normaliseText(next.text)) return true
  if (current.type !== next.type) return true
  if ((current.scaleId ?? null) !== (next.scaleId ?? null)) return true
  if (optionsChanged(current.options, next.options)) return true
  return false
}

/** Order-sensitive comparison of an option list. */
export function optionsChanged(currentOptions = [], nextOptions = []) {
  const a = currentOptions.map(toComparable)
  const b = nextOptions.map(toComparable)
  if (a.length !== b.length) return true
  return a.some((opt, i) => opt.label !== b[i].label || opt.value !== b[i].value)
}

/**
 * Compares an option the way it will actually be stored.
 *
 * The label is compared raw (rewording a choice IS a change), but the value is
 * compared through `storedOptionValue`, the same resolution `insertVersion`
 * writes with. Otherwise a freshly added option — whose draft `value` is still
 * empty — would look different from an identical stored row purely because of
 * when the slug is applied.
 */
const toComparable = (o) => ({
  label: normaliseText(o.label),
  value: storedOptionValue(o),
})

/** Trailing/leading whitespace is not a meaningful edit. */
const normaliseText = (s) => (typeof s === 'string' ? s.trim() : '')

/**
 * Which presentation-only columns actually changed.
 * @returns {object} a patch for `questions`, empty when nothing moved.
 */
export function cosmeticPatch(current, next) {
  const patch = {}
  if (Boolean(current.required) !== Boolean(next.required)) {
    patch.is_required = Boolean(next.required)
  }
  if (next.order !== undefined && current.order !== next.order) {
    patch.display_order = next.order
  }
  return patch
}

/**
 * Derives a stable option value from its label.
 * Values are what get stored in answers, so they should be terse and stable
 * rather than a copy of a long label.
 */
export function slugifyOptionValue(label) {
  return String(label ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    // Re-strip: the slice can land mid-separator and leave a trailing underscore.
    .replace(/_+$/, '')
}

/**
 * The value an option will actually be stored with.
 *
 * An option that already exists keeps the value it was stored with, verbatim.
 * Only a new option — whose draft `value` is empty, which is the only shape the
 * editor can produce — gets a slug derived from its label.
 *
 * This is load-bearing rather than tidy. `answers.value_options` holds these
 * strings and is frozen once answered (`question_options_immutable`), while the
 * seed inserted `value = label` ('PG I', not 'pg_i'). Re-deriving the slug on
 * every version would rewrite the new version's values out from under those
 * stored answers: the analytics group by value, so one human choice would split
 * into two chart rows, and `validateAnswer` would lock every pre-edit respondent
 * out of editing their own submission (FR-31, FR-56).
 *
 * Rewording a label therefore keeps the old value on purpose. The label is what
 * a respondent reads; the value is the join key their answer already holds.
 */
export function storedOptionValue(option) {
  const existing = typeof option?.value === 'string' ? option.value.trim() : ''
  return existing || slugifyOptionValue(option?.label)
}

/**
 * A question_key for a brand-new question: stable, unique within its form, and
 * readable in exports. Falls back to a timestamp when the text slugifies to
 * nothing (e.g. non-Latin script), and de-duplicates against existing keys.
 *
 * `prefix` namespaces a DEPARTMENT question's key ('computer_science__lab_safety').
 * That is not cosmetic: `analytics_distribution` and
 * `analytics_choice_distribution` group by (stakeholder, form, question_key, scale)
 * with no question id in the key, so two departments both writing "Lab safety" on
 * the student form would have their Likert bars silently pooled into one chart.
 * The prefix ensures identically-worded questions in different departments have
 * distinct keys.
 */
export function deriveQuestionKey(text, existingKeys = [], prefix = '') {
  const slug = slugifyOptionValue(text) || `q_${Date.now().toString(36)}`
  const namespace = slugifyOptionValue(prefix)
  const base = namespace ? `${namespace}__${slug}` : slug

  const taken = new Set(existingKeys)
  if (!taken.has(base)) return base

  for (let n = 2; n < 200; n += 1) {
    const candidate = `${base}_${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}_${Date.now().toString(36)}`
}

/** A rating question needs a scale; anything else must not carry one (schema check). */
export function validateQuestionDraft(draft) {
  const errors = {}

  if (!draft.text || !draft.text.trim()) {
    errors.text = 'Question text is required.'
  }
  if (!draft.type) {
    errors.type = 'Choose a question type.'
  }
  if (draft.type === 'rating' && !draft.scaleId) {
    errors.scaleId = 'A rating question needs a scale.'
  }
  if (draft.type !== 'rating' && draft.scaleId) {
    errors.scaleId = 'Only rating questions use a scale.'
  }

  const needsOptions = draft.type === 'single_select' || draft.type === 'multi_select'
  const options = (draft.options ?? []).filter((o) => o.label?.trim())

  if (needsOptions && options.length < 2) {
    errors.options = 'Add at least two options.'
  }
  if (!needsOptions && (draft.options ?? []).some((o) => o.label?.trim())) {
    errors.options = 'Only dropdown and multi-select questions take options.'
  }
  if (needsOptions) {
    const values = options.map(storedOptionValue)
    if (new Set(values).size !== values.length) {
      errors.options = 'Two options resolve to the same stored value.'
    }
    if (values.some((v) => !v)) {
      errors.options = 'An option label must contain at least one letter or number.'
    }
  }

  return { errors, ok: Object.keys(errors).length === 0 }
}
