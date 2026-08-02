import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ROLE_LABELS } from '../lib/constants'
import { loadForm } from '../lib/formSchema'
import {
  cycleIsOpen,
  deleteSubmission,
  loadActiveCycle,
  loadMySubmissions,
} from '../lib/submissions'

/**
 * FR-14 / FR-17: the respondent's landing page — what they have submitted this
 * cycle, and the way in to add or edit one.
 *
 * The Edit action disappears once the cycle closes; the underlying RLS policy
 * enforces the same thing, so this is convenience rather than the guarantee.
 */
export default function FeedbackHome() {
  const { user, profile, role } = useAuth()
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    const cycle = await loadActiveCycle()
    let form = null
    try {
      form = (await loadForm(role)).form
    } catch {
      form = null // no form configured for this role; reported below
    }
    const submissions = cycle && user ? await loadMySubmissions(user.id, cycle.id) : []
    return { cycle, form, submissions }
  }, [role, user])

  useEffect(() => {
    let active = true
    setState({ loading: true, error: null, data: null })

    load()
      .then((data) => active && setState({ loading: false, error: null, data }))
      .catch((err) => active && setState({ loading: false, error: err.message, data: null }))

    return () => {
      active = false
    }
  }, [load])

  async function handleWithdraw(id) {
    if (!window.confirm('Withdraw this submission? This cannot be undone.')) return
    setBusyId(id)
    try {
      await deleteSubmission(id)
      const data = await load()
      setState({ loading: false, error: null, data })
    } catch (err) {
      setState((prev) => ({ ...prev, error: err.message }))
    } finally {
      setBusyId(null)
    }
  }

  if (state.loading) return <p className="muted">Loading…</p>

  if (state.error) {
    return (
      <div className="notice error" role="alert">
        <h2>Could not load your submissions</h2>
        <p>{state.error}</p>
      </div>
    )
  }

  const { cycle, form, submissions } = state.data
  const open = cycleIsOpen(cycle)

  return (
    <section>
      <h1>Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}</h1>
      <p className="muted">
        You are giving feedback as <strong>{ROLE_LABELS[role]}</strong>.
      </p>

      {!cycle && (
        <div className="notice" role="status">
          <h2>No open feedback cycle</h2>
          <p>There is no active cycle right now. Please check back later.</p>
        </div>
      )}

      {cycle && !form && (
        <div className="notice error" role="alert">
          <h2>No form configured</h2>
          <p>
            There is no feedback form set up for your role yet. Please contact
            your administrator.
          </p>
        </div>
      )}

      {cycle && form && (
        <>
          <div className="card">
            <h2>{form.title}</h2>
            <p className="muted">
              Cycle <strong>{cycle.label}</strong>
              {open ? (
                <> — open until {new Date(cycle.closes_at).toLocaleDateString()}</>
              ) : (
                <> — closed on {new Date(cycle.closes_at).toLocaleDateString()}</>
              )}
            </p>

            {open ? (
              <Link className="button-link" to="/feedback/new">
                {submissions.length ? 'Give feedback for another course' : 'Start feedback'}
              </Link>
            ) : (
              <p className="muted">
                This cycle is closed. Existing submissions are read-only.
              </p>
            )}
          </div>

          <h2>My submissions</h2>
          {submissions.length === 0 ? (
            <p className="muted">
              You have not submitted any feedback for this cycle yet.
            </p>
          ) : (
            <ul className="submission-list">
              {submissions.map((s) => (
                <li key={s.id} className="card submission">
                  <div>
                    <strong>{s.course_title || 'General feedback'}</strong>
                    {s.program && <span className="muted"> · {s.program}</span>}
                    <p className="muted small">
                      Submitted {new Date(s.submitted_at).toLocaleDateString()}
                      {s.updated_at !== s.submitted_at && (
                        <> · edited {new Date(s.updated_at).toLocaleDateString()}</>
                      )}
                    </p>
                  </div>
                  <div className="button-row">
                    <Link className="button-link secondary" to={`/feedback/${s.id}`}>
                      {open ? 'Edit' : 'View'}
                    </Link>
                    {open && (
                      <button
                        type="button"
                        className="secondary danger"
                        disabled={busyId === s.id}
                        onClick={() => handleWithdraw(s.id)}
                      >
                        {busyId === s.id ? 'Withdrawing…' : 'Withdraw'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
