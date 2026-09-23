import { useEffect, useRef, useState } from 'react'
import { loadQuestionHistory } from '../../lib/admin/questions'

const ACTION_LABELS = {
  created: 'Created',
  edited: 'Edited',
  deleted: 'Removed from form',
  restored: 'Restored to form',
  reordered: 'Reordered',
}

/**
 * FR-33: version history and audit trail for one question.
 *
 * This is the admin-facing proof that editing a question did not rewrite the
 * past: every wording the question has ever had is listed, newest first.
 */
export default function QuestionHistory({ question, onClose }) {
  const panelRef = useRef(null)
  const [versions, setVersions] = useState([])
  const [audit, setAudit] = useState([])
  const [state, setState] = useState({ loading: true, error: null })

  useEffect(() => {
    let active = true
    ;(async () => {
      setState({ loading: true, error: null })
      try {
        const history = await loadQuestionHistory(question.id)
        if (!active) return
        setVersions(history.versions)
        setAudit(history.audit)
        setState({ loading: false, error: null })
      } catch (err) {
        if (active) setState({ loading: false, error: err.message })
      }
    })()
    return () => {
      active = false
    }
  }, [question.id])

  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [question.id])

  return (
    <div ref={panelRef} className="card history-panel">
      <div className="history-head">
        <h2>History</h2>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>

      <p className="muted small">{question.text}</p>

      {state.error && (
        <div className="notice error" role="alert">
          <p>{state.error}</p>
        </div>
      )}

      {state.loading ? (
        <p className="muted">Loading history…</p>
      ) : (
        <>
          <h3>Versions</h3>
          {versions.length <= 1 ? (
            <p className="muted">This question has never been edited.</p>
          ) : (
            <ol className="version-list">
              {versions.map((v) => (
                <li key={v.id} className={v.id === question.versionId ? 'current' : ''}>
                  <div className="version-head">
                    <strong>v{v.version_no}</strong>
                    {v.id === question.versionId && (
                      <span className="pill">current</span>
                    )}
                    <span className="muted small">{formatDate(v.created_at)}</span>
                    <Actor actor={v.actor} />
                  </div>
                  <p>{v.text}</p>
                </li>
              ))}
            </ol>
          )}

          <h3>Activity</h3>
          {audit.length === 0 ? (
            <p className="muted">No recorded activity.</p>
          ) : (
            <ul className="audit-list">
              {audit.map((entry) => (
                <li key={entry.id}>
                  <span className="pill muted-pill">
                    {ACTION_LABELS[entry.action] ?? entry.action}
                  </span>
                  <span className="muted small">{formatDate(entry.created_at)}</span>
                  <Actor actor={entry.actor} />
                  {entry.details?.from && entry.details?.to && (
                    <div className="diff">
                      <p className="was">{entry.details.from}</p>
                      <p className="now">{entry.details.to}</p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/**
 * FR-33's "by whom".
 *
 * Renders nothing when the author is unknown rather than guessing. An HOD may
 * only read profiles in their own department, so an administrator's edit
 * resolves to no row for them — and "an administrator" printed there would be
 * an inference presented as a fact.
 */
function Actor({ actor }) {
  if (!actor?.name) return null
  return (
    <span className="muted small">
      by {actor.name}
      {actor.role === 'hod' && ' (head of department)'}
    </span>
  )
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}
