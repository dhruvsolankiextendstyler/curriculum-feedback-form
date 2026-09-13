import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import QuestionField from '../components/QuestionField'
import { useAuth } from '../context/AuthContext'
import { loadForm } from '../lib/formSchema'
import {
  cycleIsOpen,
  loadActiveCycle,
  loadCycleById,
  loadResponse,
  saveSubmission,
} from '../lib/submissions'
import { bindingIdFor, validateForm } from '../lib/validation'

/**
 * The feedback form (FR-8 to FR-16).
 *
 * One route serves both cases: /feedback/new starts a submission,
 * /feedback/:responseId reopens an existing one for editing. When the cycle has
 * closed the same page renders read-only (FR-16) rather than 404ing, so a
 * respondent can still see what they submitted.
 */
export default function FeedbackForm() {
  const { responseId } = useParams()
  const { user, role, profile } = useAuth()
  const navigate = useNavigate()

  const [schema, setSchema] = useState(null)
  const [cycle, setCycle] = useState(null)
  const [values, setValues] = useState({})
  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState({ phase: 'loading', message: null })

  /**
   * The row this form is bound to.
   *
   * Starts as the route param and is set after a successful insert, so a second
   * save of the SAME course updates rather than erroring. It must reset to null
   * whenever the route returns to /feedback/new — a `useState` initialiser alone
   * runs once per mount, and React keeps this component mounted across that
   * navigation, so a stale id would silently overwrite the previous submission
   * instead of creating a new one.
   */
  const [savedId, setSavedId] = useState(responseId ?? null)

  const errorSummary = useRef(null)

  // ---------- load ----------
  useEffect(() => {
    let active = true

    // Re-bind to whatever the route now points at. Without this, navigating
    // /feedback/<id> -> /feedback/new leaves savedId set and the next save
    // updates the old row instead of inserting a new one (FR-13, FR-15).
    setSavedId(responseId ?? null)
    setErrors({})
    setStatus({ phase: 'loading', message: null })

    async function load() {
      try {
        const [loadedCycle, loadedSchema] = await Promise.all([
          loadActiveCycle(),
          // The department decides which extra question set is appended (FR-53).
          loadForm(role, profile?.department_id ?? null),
        ])
        if (!active) return

        let initialValues = {}
        // FR-16: the window that governs this page is the one the RESPONSE
        // belongs to, not whichever cycle happens to be active. A closed-cycle
        // submission is reachable by a bookmarked or direct URL — "My
        // submissions" does not link it — and derived from the active cycle it
        // opened fully editable, labelled with the wrong year, against a form
        // the database would then refuse to write.
        let formCycle = loadedCycle
        if (responseId) {
          // Schema first, then the response: loadResponse needs the question
          // types to decode stored answers unambiguously.
          const existing = await loadResponse(responseId, loadedSchema.questions)
          if (!active) return
          if (!existing) {
            setStatus({ phase: 'error', message: 'That submission could not be found.' })
            return
          }
          initialValues = existing.values

          if (existing.response?.cycle_id && existing.response.cycle_id !== loadedCycle?.id) {
            const ownCycle = await loadCycleById(existing.response.cycle_id)
            if (!active) return
            if (ownCycle) formCycle = ownCycle
          }
        }

        setCycle(formCycle)
        setSchema(loadedSchema)
        setValues(initialValues)
        setStatus({ phase: 'ready', message: null })
      } catch (err) {
        if (active) setStatus({ phase: 'error', message: err.message })
      }
    }

    load()
    return () => {
      active = false
    }
  }, [role, profile?.department_id, responseId])

  // Attach each rating question to its scale once, so field components and
  // validation share one shape.
  const questions = useMemo(() => {
    if (!schema) return []
    return schema.questions.map((q) =>
      q.type === 'rating' ? { ...q, scale: schema.scales[q.scaleId] ?? null } : q,
    )
  }, [schema])

  const sections = useMemo(() => {
    if (!schema) return []
    const byId = new Map(questions.map((q) => [q.versionId, q]))
    return schema.sections.map((s) => ({
      ...s,
      questions: s.questions.map((q) => byId.get(q.versionId) ?? q),
    }))
  }, [schema, questions])

  const isOpen = cycleIsOpen(cycle)
  const readOnly = !isOpen
  const isEditing = Boolean(responseId)

  const setValue = useCallback((versionId, next) => {
    setValues((prev) => ({ ...prev, [versionId]: next }))
    // Clear this field's error as soon as the user engages with it; re-validated
    // on submit anyway.
    setErrors((prev) => {
      if (!prev[versionId]) return prev
      const { [versionId]: _drop, ...rest } = prev
      return rest
    })
  }, [])

  // ---------- submit ----------
  async function handleSubmit(event) {
    event.preventDefault()
    if (readOnly) return

    const result = validateForm(questions, values)
    setErrors(result.errors)

    if (!result.ok) {
      setStatus({ phase: 'ready', message: null })
      // Move focus to the summary so keyboard and screen-reader users are told
      // what went wrong instead of silently staying put.
      requestAnimationFrame(() => errorSummary.current?.focus())
      return
    }

    setStatus({ phase: 'saving', message: null })
    try {
      const id = await saveSubmission({
        responseId: bindingIdFor(responseId, savedId),
        userId: user.id,
        form: schema.form,
        cycle,
        questions,
        values,
      })
      setSavedId(id)
      setStatus({ phase: 'saved', message: null })
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      setStatus({
        phase: 'ready',
        message: err.message,
        // 23505 means this course already has a submission; offer to open it.
        duplicate: err.code === '23505',
      })
      requestAnimationFrame(() => errorSummary.current?.focus())
    }
  }

  // ---------- render ----------
  if (status.phase === 'loading') return <p className="muted">Loading form…</p>

  if (status.phase === 'error') {
    return (
      <div className="notice error" role="alert">
        <h2>Could not open this form</h2>
        <p>{status.message}</p>
        <p>
          <Link to="/feedback">Back to my submissions</Link>
        </p>
      </div>
    )
  }

  if (!cycle) {
    return (
      <div className="notice" role="status">
        <h2>No open feedback cycle</h2>
        <p>There is no active cycle right now, so feedback cannot be submitted.</p>
        <p>
          <Link to="/feedback">Back to my submissions</Link>
        </p>
      </div>
    )
  }

  if (status.phase === 'saved') {
    return (
      <div className="notice success" role="status">
        <h2>Feedback saved</h2>
        <p>
          Thank you. Your response for <strong>{cycle.label}</strong> has been
          recorded.
        </p>
        <p className="muted">
          You can change your answers until{' '}
          {new Date(cycle.closes_at).toLocaleDateString()}.
        </p>
        <div className="button-row">
          <Link className="button-link" to="/feedback">
            My submissions
          </Link>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              // Same course would collide, so start genuinely fresh (FR-13).
              setValues({})
              setErrors({})
              setSavedId(null)
              setStatus({ phase: 'ready', message: null })
              navigate('/feedback/new')
            }}
          >
            Give feedback for another course
          </button>
        </div>
      </div>
    )
  }

  const errorCount = Object.keys(errors).length

  return (
    <section>
      <h1>{schema.form.title}</h1>
      <p className="muted">
        Cycle <strong>{cycle.label}</strong>
        {readOnly ? (
          <> — closed on {new Date(cycle.closes_at).toLocaleDateString()}, read-only</>
        ) : (
          <> — open until {new Date(cycle.closes_at).toLocaleDateString()}</>
        )}
      </p>

      {readOnly && (
        <div className="notice" role="status">
          <h2>This cycle is closed</h2>
          <p>
            You can read what you submitted, but it can no longer be changed.
          </p>
        </div>
      )}

      {(errorCount > 0 || status.message) && (
        <div
          className="notice error"
          role="alert"
          tabIndex={-1}
          ref={errorSummary}
        >
          <h2>{status.message ? 'Could not save' : 'Please check your answers'}</h2>
          {status.message ? (
            <>
              <p>{status.message}</p>
              {status.duplicate && (
                <p>
                  <Link to="/feedback">Open my submissions</Link> to edit the
                  existing one.
                </p>
              )}
            </>
          ) : (
            <p>
              {errorCount === 1
                ? '1 question needs attention.'
                : `${errorCount} questions need attention.`}
            </p>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        {sections.map((section) => (
          <fieldset key={section.key} className="card section" disabled={readOnly}>
            <legend>
              <h2>{section.title}</h2>
            </legend>
            {section.hint && <p className="muted section-hint">{section.hint}</p>}

            {section.questions.map((q) => (
              <QuestionField
                key={q.versionId}
                question={q}
                value={values[q.versionId]}
                error={errors[q.versionId]}
                disabled={readOnly}
                onChange={(next) => setValue(q.versionId, next)}
              />
            ))}
          </fieldset>
        ))}

        {!readOnly && (
          <div className="button-row sticky-actions">
            <button type="submit" disabled={status.phase === 'saving'}>
              {status.phase === 'saving'
                ? 'Saving…'
                : isEditing
                  ? 'Save changes'
                  : 'Submit feedback'}
            </button>
            <Link className="button-link secondary" to="/feedback">
              Cancel
            </Link>
          </div>
        )}

        {readOnly && (
          <p>
            <Link to="/feedback">Back to my submissions</Link>
          </p>
        )}
      </form>
    </section>
  )
}
