import { MAX_LONG_TEXT, MAX_SHORT_TEXT } from '../lib/validation'

/**
 * Renders one question as the input its type calls for (FR-24 types).
 *
 * Every control is wired to the same contract: `value` in, `onChange(next)` out,
 * with errors announced via aria-describedby + aria-invalid so screen readers
 * get them too (NFR-7).
 */
export default function QuestionField({ question, value, error, disabled, onChange }) {
  const fieldId = `q-${question.versionId}`
  const errorId = `${fieldId}-error`
  const describedBy = error ? errorId : undefined

  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <FieldLabel question={question} fieldId={fieldId} />

      <Control
        question={question}
        fieldId={fieldId}
        value={value}
        disabled={disabled}
        describedBy={describedBy}
        invalid={Boolean(error)}
        onChange={onChange}
      />

      {error && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function FieldLabel({ question, fieldId }) {
  const required = question.required
  const text = (
    <>
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

function Control({ question, fieldId, value, disabled, describedBy, invalid, onChange }) {
  const common = { disabled, 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined }

  switch (question.type) {
    case 'rating':
      return (
        <RatingGroup
          question={question}
          fieldId={fieldId}
          value={value}
          onChange={onChange}
          {...common}
        />
      )

    case 'single_select':
      return (
        <select
          id={fieldId}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
          {...common}
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
