import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, MessageSquare } from 'lucide'
import Icon from '../components/Icon'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { ROLE_LABELS } from '../lib/constants'
import { loadForm } from '../lib/formSchema'
import {
  cycleIsOpen,
  loadActiveCycle,
  loadMySubmissions,
} from '../lib/submissions'

export default function FeedbackHome() {
  const { user, profile, role } = useAuth()
  const toast = useToast()
  const [state, setState] = useState({ loading: true, error: null, data: null })

  const hasDepartment = Boolean(profile?.department_id)

  const load = useCallback(async () => {
    const [cycle, schema] = await Promise.all([
      loadActiveCycle(),
      loadForm(role, profile?.department_id ?? null).catch(() => null),
    ])
    const submissions = cycle && user ? await loadMySubmissions(user.id, cycle.id) : []
    return { cycle, schema, submissions }
  }, [role, profile?.department_id, user])

  useEffect(() => {
    let active = true
    setState({ loading: true, error: null, data: null })

    load()
      .then((data) => active && setState({ loading: false, error: null, data }))
      .catch((err) => {
        if (!active) return
        toast.error(err.message)
        setState({ loading: false, error: err.message, data: null })
      })

    return () => {
      active = false
    }
  }, [load])

  if (state.loading) return <p className="muted">Loading…</p>

  if (state.error) return <p className="muted centered">Could not load your submissions. Please try refreshing.</p>

  const { cycle, schema, submissions } = state.data
  const form = schema?.form ?? null
  const open = cycleIsOpen(cycle)
  const hasDeptQuestions =
    schema?.sections?.some((s) => s.key === 'department') ?? false

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
          <div className="feedback-cards">
            <div className="card">
              <h2>College-wide Feedback</h2>
              <p className="muted">
                Cycle <strong>{cycle.label}</strong>
                {open ? (
                  <> — open until {new Date(cycle.closes_at).toLocaleDateString()}</>
                ) : (
                  <> — closed on {new Date(cycle.closes_at).toLocaleDateString()}</>
                )}
              </p>
              {open ? (
                <Link
                  className="button-link"
                  to={`/feedback/new?scope=college`}
                >
                  <Icon icon={MessageSquare} size={16} />
                  {submissions.length
                    ? 'Give feedback for another course'
                    : 'Start feedback'}
                </Link>
              ) : (
                <p className="muted">
                  This cycle is closed. Existing submissions are read-only.
                </p>
              )}
            </div>

            {hasDepartment && hasDeptQuestions && (
              <div className="card">
                <h2>{schema.departmentName || 'Department'} Feedback</h2>
                <p className="muted">
                  Cycle <strong>{cycle.label}</strong>
                  {open ? (
                    <> — open until {new Date(cycle.closes_at).toLocaleDateString()}</>
                  ) : (
                    <> — closed on {new Date(cycle.closes_at).toLocaleDateString()}</>
                  )}
                </p>
                {open ? (
                  <Link
                    className="button-link"
                    to="/feedback/new?scope=department"
                  >
                    <Icon icon={MessageSquare} size={16} />
                    {submissions.length
                      ? 'Give feedback for another course'
                      : 'Start feedback'}
                  </Link>
                ) : (
                  <p className="muted">
                    This cycle is closed. Existing submissions are read-only.
                  </p>
                )}
              </div>
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
                      <Icon icon={Eye} size={14} /> View
                    </Link>
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
