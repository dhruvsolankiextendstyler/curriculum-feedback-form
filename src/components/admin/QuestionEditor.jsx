import { useMemo, useState } from 'react'
import {
  requiresNewVersion,
  slugifyOptionValue,
  validateQuestionDraft,
} from '../../lib/admin/questionDiff'

const TYPES = [
  { value: 'rating', label: 'Rating (Likert scale)' },
  { value: 'single_select', label: 'Dropdown (choose one)' },
  { value: 'multi_select', label: 'Checkboxes (choose many)' },
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Long text' },
]

const emptyDraft = { text: '', type: 'rating', scaleId: '', required: true, options: [] }

/**
 * Add/edit form for one question (FR-25, FR-26, FR-31).
 *
 * The panel tells the admin, before they save, whether their edit will create a
 * new version or update in place — the distinction that decides whether past
 * analytics stay intact, so it should not be a surprise.
 */
export default function QuestionEditor({ question, scales, answerCount, onSave, onCancel }) {
  const isNew = !question
  const [draft, setDraft] = useState(() =>
    question
      ? {
          text: question.text,
          type: question.type,
          scaleId: question.scaleId ?? '',
          required: question.required,
          options: question.options.map((o) => ({ label: o.label, value: o.value })),
        }
      : emptyDraft,
  )
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)

  const willVersion = useMemo(() => {
    if (isNew) return false
    return requiresNewVersion(question, { ...draft, scaleId: draft.scaleId || null })
  }, [isNew, question, draft])

  const needsOptions = draft.type === 'single_select' || draft.type === 'multi_select'

  function setField(patch) {
    setDraft((d) => {
      const next = { ...d, ...patch }
      // Switching away from rating clears the scale, and switching away from a
      // select clears options — the schema rejects the mismatched combinations.
      if (patch.type && patch.type !== 'rating') next.scaleId = ''
      if (patch.type && patch.type !== 'single_select' && patch.type !== 'multi_select') {
        next.options = []
      }
      return next
    })
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const payload = { ...draft, scaleId: draft.scaleId || null }
    const result = validateQuestionDraft(payload)
    setErrors(result.errors)
    if (!result.ok) return

    setBusy(true)
    try {
      await onSave(payload)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card edit-panel">
      <h2>{isNew ? 'Add a question' : 'Edit question'}</h2>

      {!isNew && answerCount > 0 && (
        <div className={`notice ${willVersion ? '' : 'success'}`} role="status">
          {willVersion ? (
            <p>
              This question already has <strong>{answerCount}</strong> answer
              {answerCount === 1 ? '' : 's'}. Saving creates{' '}
              <strong>version {(question.versionNo ?? 1) + 1}</strong> — existing
              answers stay attached to the wording they were given, so past
              reports do not change.
            </p>
          ) : (
            <p>
              Changing only the required flag or position updates this question in
              place. No new version, and nothing changes for existing answers.
            </p>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <label htmlFor="q-text">Question text</label>
        <textarea
          id="q-text"
          rows={3}
          value={draft.text}
          onChange={(e) => setField({ text: e.target.value })}
          aria-invalid={Boolean(errors.text) || undefined}
        />
        {errors.text && <p className="field-error" role="alert">{errors.text}</p>}

        <label htmlFor="q-type">Type</label>
        <select
          id="q-type"
          value={draft.type}
          onChange={(e) => setField({ type: e.target.value })}
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {errors.type && <p className="field-error" role="alert">{errors.type}</p>}

        {draft.type === 'rating' && (
          <>
            <label htmlFor="q-scale">Rating scale</label>
            <select
              id="q-scale"
              value={draft.scaleId}
              onChange={(e) => setField({ scaleId: e.target.value })}
              aria-invalid={Boolean(errors.scaleId) || undefined}
            >
              <option value="">— Select a scale —</option>
              {scales.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.options.length} points)
                </option>
              ))}
            </select>
            {errors.scaleId && <p className="field-error" role="alert">{errors.scaleId}</p>}
            <ScalePreview scales={scales} scaleId={draft.scaleId} />
          </>
        )}

        {needsOptions && (
          <OptionEditor
            options={draft.options}
            error={errors.options}
            onChange={(options) => setDraft((d) => ({ ...d, options }))}
          />
        )}

        <label className="inline-check" htmlFor="q-required">
          <input
            id="q-required"
            type="checkbox"
            checked={draft.required}
            onChange={(e) => setField({ required: e.target.checked })}
          />
          <span>Respondents must answer this</span>
        </label>

        <div className="button-row">
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : willVersion ? 'Save as new version' : 'Save'}
          </button>
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

function ScalePreview({ scales, scaleId }) {
  const scale = scales.find((s) => s.id === scaleId)
  if (!scale) return null

  return (
    <div className="scale-preview">
      {scale.options.map((o) => (
        <span key={o.id} className="scale-chip">
          {o.label}
          <span className="muted small">
            {o.score === null ? ' (not scored)' : ` = ${o.score}`}
          </span>
        </span>
      ))}
    </div>
  )
}

function OptionEditor({ options, error, onChange }) {
  const update = (i, patch) =>
    onChange(options.map((o, idx) => (idx === i ? { ...o, ...patch } : o)))

  return (
    <fieldset className="option-editor">
      <legend>Options</legend>
      {error && <p className="field-error" role="alert">{error}</p>}

      {options.length === 0 && (
        <p className="muted small">No options yet. Add at least two.</p>
      )}

      <ol className="option-rows">
        {options.map((o, i) => (
          <li key={i}>
            <input
              type="text"
              aria-label={`Option ${i + 1} label`}
              placeholder="Label shown to respondents"
              value={o.label}
              onChange={(e) => update(i, { label: e.target.value })}
            />
            <code className="muted small stored-value">
              {slugifyOptionValue(o.value || o.label) || '—'}
            </code>
            <button
              type="button"
              className="secondary danger"
              aria-label={`Remove option ${i + 1}`}
              onClick={() => onChange(options.filter((_, idx) => idx !== i))}
            >
              Remove
            </button>
          </li>
        ))}
      </ol>

      <div className="button-row">
        <button
          type="button"
          className="secondary"
          onClick={() => onChange([...options, { label: '', value: '' }])}
        >
          Add option
        </button>
      </div>
      <p className="muted small">
        The grey text is the value stored in the database. It is derived from the
        label and is what appears in exports.
      </p>
    </fieldset>
  )
}
