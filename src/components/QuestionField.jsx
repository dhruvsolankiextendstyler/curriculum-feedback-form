import { MAX_LONG_TEXT, MAX_SHORT_TEXT } from '../lib/validation'

/**
 * Renders one question as the input its type calls for (FR-24 types).
 *
 * Every control is wired to the same contract: `value` in, `onChange(next)` out,
 * with errors announced via aria-describedby + aria-invalid so screen readers
 * get them too (NFR-7).
 */
export default function QuestionField({
  question,
  number = null,
  value,
  error,
  disabled,
  locked = false,
  lockHint = null,
  onChange,
}) {
  const fieldId = `q-${question.versionId}`
  const errorId = `${fieldId}-error`
  const hintId = `${fieldId}-hint`
  // Both, when both apply: a locked field can still be flagged, and dropping the
  // hint from the description would leave "why can't I type here" unanswered.
  const describedBy = [error ? errorId : null, locked && lockHint ? hintId : null]
    .filter(Boolean)
    .join(' ') || undefined

  return (
    <div className={`field${error ? ' field-invalid' : ''}${locked ? ' field-locked' : ''}`}>
      <FieldLabel question={question} fieldId={fieldId} number={number} />

      <Control
        question={question}
        fieldId={fieldId}
        value={value}
        disabled={disabled}
        locked={locked}
        describedBy={describedBy}
        invalid={Boolean(error)}
        onChange={onChange}
      />

      {locked && lockHint && (
        <p className="field-hint" id={hintId}>
          {lockHint}
        </p>
      )}

      {error && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function FieldLabel({ question, fieldId, number = null }) {
  const required = question.required
  const text = (
    <>
      {number != null && <span className="question-number">{number}.</span>}
      {question.text}
      {required && (
        <span className="req" aria-hidden="true">
          {' '}
          *
        </span>
      )}
      {!required && <span className="muted optional"> (optional)</span>}
    </>
  )

  // Radio and checkbox groups get a <legend>-style label rather than a <label
  // for>, since there is no single input to point at.
  const isGroup = question.type === 'rating' || question.type === 'multi_select'
  if (isGroup) {
    return (
      <span className="field-label" id={`${fieldId}-label`}>
        {text}
      </span>
    )
  }
  return (
    <label className="field-label" htmlFor={fieldId}>
      {text}
    </label>
  )
}

/**
 * `locked` is a field the account answers for itself (see lib/prefill.js).
 *
 * Text inputs get `readOnly` rather than `disabled`: a read-only input keeps its
 * normal contrast, stays focusable and is still announced with its value, so a
 * respondent can read back the name being submitted on their behalf. Controls
 * with no read-only mode fall back to `disabled`. Either way the submitted value
 * comes from React state, not the DOM, so nothing is lost on save.
 */
function Control({ question, fieldId, value, disabled, locked, describedBy, invalid, onChange }) {
  const common = { disabled, 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined }
  const lockedText = locked ? { readOnly: true, className: 'locked' } : null

  switch (question.type) {
    case 'rating':
      return (
        <RatingGroup
          question={question}
          fieldId={fieldId}
          value={value}
          onChange={onChange}
          {...common}
          disabled={disabled || locked}
        />
      )

    case 'single_select':
      return (
        <select
          id={fieldId}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
          {...common}
          disabled={disabled || locked}
        >
          <option value="">— Select —</option>
          {question.options.map((o) => (
            <option key={o.id} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )

    case 'multi_select':
      return (
        <CheckboxGroup
          question={question}
          fieldId={fieldId}
          value={value}
          onChange={onChange}
          {...common}
          disabled={disabled || locked}
        />
      )

    case 'long_text':
      return (
        <>
          <textarea
            id={fieldId}
            rows={5}
            maxLength={MAX_LONG_TEXT}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            {...common}
            {...lockedText}
          />
          <CharCount value={value} max={MAX_LONG_TEXT} />
        </>
      )

    case 'short_text':
    default:
      return (
        <input
          id={fieldId}
          type="text"
          maxLength={MAX_SHORT_TEXT}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          {...common}
          {...lockedText}
        />
      )
  }
}

/**
 * Likert scale as a radio group.
 *
 * The stored value is the option LABEL, not the score: scales differ per form
 * and one ("Not applicable") deliberately has no score. Keeping the label as the
 * answer means a non-scoring choice is still recorded and still shows up in
 * distributions, while averages skip it.
 */
function RatingGroup({ question, fieldId, value, disabled, onChange, ...aria }) {
  const options = question.scale?.options ?? []

  if (options.length === 0) {
    return <p className="field-error">This rating question has no scale configured.</p>
  }

  return (
    <div
      className="rating-group"
      role="radiogroup"
      aria-labelledby={`${fieldId}-label`}
      {...aria}
    >
      {options.map((o) => {
        const id = `${fieldId}-${o.id}`
        return (
          <label key={o.id} className="rating-option" htmlFor={id}>
            <input
              id={id}
              type="radio"
              name={fieldId}
              value={o.label}
              checked={value === o.label}
              disabled={disabled}
              onChange={() => onChange(o.label)}
            />
            <span>{o.label}</span>
          </label>
        )
      })}
    </div>
  )
}

function CheckboxGroup({ question, fieldId, value, disabled, onChange, ...aria }) {
  const selected = Array.isArray(value) ? value : []

  function toggle(optionValue) {
    onChange(
      selected.includes(optionValue)
        ? selected.filter((v) => v !== optionValue)
        : [...selected, optionValue],
    )
  }

  return (
    <div className="checkbox-group" role="group" aria-labelledby={`${fieldId}-label`} {...aria}>
      {question.options.map((o) => {
        const id = `${fieldId}-${o.id}`
        return (
          <label key={o.id} className="checkbox-option" htmlFor={id}>
            <input
              id={id}
              type="checkbox"
              value={o.value}
              checked={selected.includes(o.value)}
              disabled={disabled}
              onChange={() => toggle(o.value)}
            />
            <span>{o.label}</span>
          </label>
        )
      })}
    </div>
  )
}

function CharCount({ value, max }) {
  const used = typeof value === 'string' ? value.length : 0
  if (used < max * 0.8) return null
  return (
    <p className="muted char-count" aria-live="polite">
      {used} / {max}
    </p>
  )
}
