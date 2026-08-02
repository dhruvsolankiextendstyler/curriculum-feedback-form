import { useEffect, useState } from 'react'
import AdminNav from '../components/AdminNav'
import { supabase } from '../lib/supabase'

/**
 * Admin overview. The counts double as a live check that admin RLS reads work
 * across every table — if the stack is misconfigured, this is where it shows.
 */
export default function AdminHome() {
  const [state, setState] = useState({ loading: true, error: null, counts: null })

  useEffect(() => {
    let active = true

    async function load() {
      const countOf = (table) =>
        supabase.from(table).select('id', { count: 'exact', head: true })

      const [users, forms, questions, responses, cycle] = await Promise.all([
        countOf('profiles'),
        countOf('forms'),
        countOf('questions'),
        countOf('responses'),
        supabase
          .from('academic_cycles')
          .select('label, closes_at')
          .eq('is_active', true)
          .maybeSingle(),
      ])

      if (!active) return

      const error =
        users.error || forms.error || questions.error || responses.error || cycle.error
      if (error) {
        setState({ loading: false, error: error.message, counts: null })
        return
      }

      setState({
        loading: false,
        error: null,
        counts: {
          users: users.count ?? 0,
          forms: forms.count ?? 0,
          questions: questions.count ?? 0,
          responses: responses.count ?? 0,
          cycle: cycle.data,
        },
      })
    }

    load()
    return () => {
      active = false
    }
  }, [])

  if (state.loading) return <p className="muted">Loading…</p>
  if (state.error) {
    return (
      <div className="notice error" role="alert">
        <h2>Could not load the dashboard</h2>
        <p>{state.error}</p>
      </div>
    )
  }

  const { users, forms, questions, responses, cycle } = state.counts

  return (
    <section>
      <h1>Admin dashboard</h1>
      <AdminNav />
      <p className="muted">
        {cycle
          ? `Active cycle: ${cycle.label} — closes ${new Date(
              cycle.closes_at
            ).toLocaleDateString()}`
          : 'No active cycle. Create one before collecting feedback.'}
      </p>

      <div className="stat-grid">
        <div className="stat">
          <span className="stat-value">{users}</span>
          <span className="stat-label">Users</span>
        </div>
        <div className="stat">
          <span className="stat-value">{forms}</span>
          <span className="stat-label">Forms</span>
        </div>
        <div className="stat">
          <span className="stat-value">{questions}</span>
          <span className="stat-label">Questions</span>
        </div>
        <div className="stat">
          <span className="stat-value">{responses}</span>
          <span className="stat-label">Responses</span>
        </div>
      </div>

      <div className="card">
        <h2>Still to build</h2>
        <ul>
          <li>Week 4 — analytics dashboard with charts and filters (FR-35 to FR-40)</li>
          <li>Week 4 — sentiment tags and auto-insights on text answers (FR-41, FR-42)</li>
          <li>Week 4 — CSV export of raw responses (FR-43)</li>
        </ul>
      </div>
    </section>
  )
}
