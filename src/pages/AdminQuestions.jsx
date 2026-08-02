import { useCallback, useEffect, useState } from 'react'
import AdminNav from '../components/AdminNav'
import QuestionEditor from '../components/admin/QuestionEditor'
import QuestionHistory from '../components/admin/QuestionHistory'
import { useAuth } from '../context/AuthContext'
import { RESPONDENT_ROLES, ROLE_LABELS } from '../lib/constants'
import { supabase } from '../lib/supabase'
import {
  countAnswers,
  createQuestion,
  deactivateQuestion,
  loadQuestionsForAdmin,
  loadScales,
  reorderQuestions,
  restoreQuestion,
  updateQuestion,
} from '../lib/admin/questions'

const TYPE_LABELS = {
  rating: 'Rating',
  single_select: 'Dropdown',
  multi_select: 'Checkboxes',
  short_text: 'Short text',
  long_text: 'Long text',
}

/** FR-25 to FR-34: question CRUD with versioning, reorder, soft delete, history. */
export default function AdminQuestions() {
  const { user } = useAuth()
  const [forms, setForms] = useState([])
  const [formId, setFormId] = useState('')
  const [questions, setQuestions] = useState([])
  const [scales, setScales] = useState([])
  const [state, setState] = useState({ loading: true, error: null })
  const [notice, setNotice] = useState(null)
  const [editing, setEditing] = useState(null) // question object, or 'new'
  const [answerCount, setAnswerCount] = useState(0)
  const [historyFor, setHistoryFor] = useState(null)
  const [showDeleted, setShowDeleted] = useState(false)

  // Forms and scales are static for the session; load once.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [{ data: formRows, error }, scaleRows] = await Promise.all([
          supabase.from('forms').select('id, title, stakeholder_type'),
          loadScales(),
        ])
        if (error) throw new Error(error.message)
        if (!active) return

        // Present forms in the PRD's stakeholder order, not insertion order.
        const ordered = RESPONDENT_ROLES.map((role) =>
          (formRows ?? []).find((f) => f.stakeholder_type === role),
        ).filter(Boolean)

        setForms(ordered)
        setScales(scaleRows)
        setFormId((current) => current || ordered[0]?.id || '')
      } catch (err) {
        if (active) setState({ loading: false, error: err.message })
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!formId) return
    setState({ loading: true, error: null })
    try {
      setQuestions(await loadQuestionsForAdmin(formId))
      setState({ loading: false, error: null })
    } catch (err) {
      setState({ loading: false, error: err.message })
    }
  }, [formId])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function openEditor(question) {
    setNotice(null)
    if (question) {
      // The count decides whether the editor warns about versioning.
      try {
        setAnswerCount(await countAnswers(question.id))
      } catch {
        setAnswerCount(0)
      }
    } else {
      setAnswerCount(0)
    }
    setEditing(question ?? 'new')
  }

  async function handleSave(draft) {
    try {
      if (editing === 'new') {
        await createQuestion({
          formId,
          draft,
          existingKeys: questions.map((q) => q.key),
          actorId: user.id,
        })
        setNotice('Question added.')
      } else {
        const outcome = await updateQuestion({ current: editing, draft, actorId: user.id })
        setNotice(
          outcome === 'versioned'
            ? 'Saved as a new version. Existing answers keep the previous wording.'
            : outcome === 'updated'
              ? 'Question updated.'
              : 'No changes to save.',
        )
      }
      setEditing(null)
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    }
  }

  async function handleDeactivate(question) {
    const count = await countAnswers(question.id).catch(() => 0)
    const warning = count
      ? `This question has ${count} answer${count === 1 ? '' : 's'}. ` +
        'It will be removed from the live form but its data stays in reports. Continue?'
      : 'Remove this question from the live form?'
    if (!window.confirm(warning)) return

    try {
      await deactivateQuestion(question.id, user.id)
      setNotice('Question removed from the form. Its history is preserved.')
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    }
  }

  async function handleRestore(question) {
    try {
      await restoreQuestion(question.id, user.id)
      setNotice('Question restored to the form.')
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    }
  }

  /** FR-29: swap with the neighbour, then persist the whole active order. */
  async function move(index, direction) {
    const active = questions.filter((q) => q.isActive)
    const target = index + direction
    if (target < 0 || target >= active.length) return

    const reordered = [...active]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]

    // Optimistic: reflect the move immediately, reconcile from the server after.
    setQuestions((prev) => [...reordered, ...prev.filter((q) => !q.isActive)])

    try {
      await reorderQuestions(reordered.map((q) => q.id), user.id)
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
      await refresh()
    }
  }

  const activeQuestions = questions.filter((q) => q.isActive)
  const deletedQuestions = questions.filter((q) => !q.isActive)

  return (
    <section>
      <h1>Questions</h1>
      <AdminNav />

      {notice && (
        <div className="notice success" role="status">
          <p>{notice}</p>
        </div>
      )}
      {state.error && (
        <div className="notice error" role="alert">
          <p>{state.error}</p>
        </div>
      )}

      <div className="card filters">
        <div className="grow">
          <label htmlFor="form-select">Form</label>
          <select
            id="form-select"
            value={formId}
            onChange={(e) => {
              setFormId(e.target.value)
              setEditing(null)
              setHistoryFor(null)
            }}
          >
            {forms.map((f) => (
              <option key={f.id} value={f.id}>
                {ROLE_LABELS[f.stakeholder_type]} — {f.title}
              </option>
            ))}
          </select>
        </div>
        <div>
          <button type="button" onClick={() => openEditor(null)} disabled={!formId}>
            Add question
          </button>
        </div>
      </div>

      {editing && (
        <QuestionEditor
          question={editing === 'new' ? null : editing}
          scales={scales}
          answerCount={answerCount}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}

      {historyFor && (
        <QuestionHistory question={historyFor} onClose={() => setHistoryFor(null)} />
      )}

      {state.loading ? (
        <p className="muted">Loading questions…</p>
      ) : (
        <>
          <p className="muted">
            {activeQuestions.length} live question
            {activeQuestions.length === 1 ? '' : 's'}
            {deletedQuestions.length > 0 && ` · ${deletedQuestions.length} removed`}
          </p>

          <ol className="question-list">
            {activeQuestions.map((q, i) => (
              <li key={q.id} className="card question-row">
                <div className="question-main">
                  <div className="question-meta">
                    <span className="pill">{TYPE_LABELS[q.type] ?? q.type}</span>
                    {q.required ? (
                      <span className="pill req-pill">Required</span>
                    ) : (
                      <span className="pill muted-pill">Optional</span>
                    )}
                    {q.versionNo > 1 && (
                      <button
                        type="button"
                        className="pill version-pill"
                        onClick={() => setHistoryFor(q)}
                        title="This question has been edited. View its history."
                      >
                        v{q.versionNo}
                      </button>
                    )}
                  </div>
                  <p className="question-text">{q.text}</p>
                  {q.options.length > 0 && (
                    <p className="muted small">
                      {q.options.map((o) => o.label).join(' · ')}
                    </p>
                  )}
                  <code className="muted small">{q.key}</code>
                </div>

                <div className="question-actions">
                  <div className="reorder">
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Move up: ${q.text}`}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Move down: ${q.text}`}
                      disabled={i === activeQuestions.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                  </div>
                  <button type="button" className="secondary" onClick={() => openEditor(q)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setHistoryFor(q)}
                  >
                    History
                  </button>
                  <button
                    type="button"
                    className="secondary danger"
                    onClick={() => handleDeactivate(q)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ol>

          {deletedQuestions.length > 0 && (
            <div className="deleted-section">
              <button
                type="button"
                className="secondary"
                onClick={() => setShowDeleted((v) => !v)}
              >
                {showDeleted ? 'Hide' : 'Show'} {deletedQuestions.length} removed question
                {deletedQuestions.length === 1 ? '' : 's'}
              </button>

              {showDeleted && (
                <ul className="question-list">
                  {deletedQuestions.map((q) => (
                    <li key={q.id} className="card question-row row-muted">
                      <div className="question-main">
                        <span className="pill muted-pill">Removed</span>
                        <p className="question-text">{q.text}</p>
                        <p className="muted small">
                          Its answers remain in reports and exports.
                        </p>
                      </div>
                      <div className="question-actions">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => handleRestore(q)}
                        >
                          Restore
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
