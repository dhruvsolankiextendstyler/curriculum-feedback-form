import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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

      const [users, forms, responses, departments, cycle] = await Promise.all([
        countOf('profiles'),
        countOf('forms'),
        countOf('responses'),
        countOf('departments'),
        supabase
          .from('academic_cycles')
          .select('label, closes_at')
          .eq('is_active', true)
          .maybeSingle(),
      ])

      if (!active) return

      // A departments failure is deliberately NOT fatal: the table arrives with
      // migration 0008, and a dashboard that refuses to load is a poor way to
      // report a pending migration. The tile is left out instead.
      const error =
        users.error || forms.error || responses.error || cycle.error
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
          responses: responses.count ?? 0,
          departments: departments.error ? null : departments.count ?? 0,
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

  const { users, forms, responses, departments, cycle } = state.counts

  const cycleClosed = cycle && new Date(cycle.closes_at) < new Date()

  return (
    <section>
      <h1>Admin dashboard</h1>
      <AdminNav />

      {cycle ? (
        <div className={`notice ${cycleClosed ? 'error' : 'success'}`} role="status">
          <p>
            <strong>Active cycle: {cycle.label}</strong>
            {cycleClosed
              ? ` — closed ${new Date(cycle.closes_at).toLocaleDateString()}. Submissions are read-only.`
              : ` — closes ${new Date(cycle.closes_at).toLocaleDateString()}`}
          </p>
        </div>
      ) : (
        <div className="notice error" role="status">
          <p>No active cycle. <Link to="/admin/cycles">Create one</Link> before collecting feedback.</p>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat">
          <span className="stat-value">{responses}</span>
          <span className="stat-label">Responses</span>
        </div>
        <div className="stat">
          <span className="stat-value">{users}</span>
          <span className="stat-label">Users</span>
        </div>
        {departments !== null && (
          <div className="stat">
            <span className="stat-value">{departments}</span>
            <span className="stat-label">Departments</span>
          </div>
        )}
        <div className="stat">
          <span className="stat-value">{forms}</span>
          <span className="stat-label">Forms</span>
        </div>
      </div>

      <div className="quick-actions">
        <div className="card">
          <h3>Analytics</h3>
          <p className="muted">Averages, distributions, trends and sentiment.</p>
          <Link to="/admin/analytics">Open analytics</Link>
        </div>
        <div className="card">
          <h3>Cycles</h3>
          <p className="muted">Manage academic year deadlines.</p>
          <Link to="/admin/cycles">Manage cycles</Link>
        </div>
        <div className="card">
          <h3>Forms</h3>
          <p className="muted">Add or edit feedback questions.</p>
          <Link to="/admin/forms">Edit forms</Link>
        </div>
        <div className="card">
          <h3>Users</h3>
          <p className="muted">Roles, departments and access.</p>
          <Link to="/admin/users">Manage users</Link>
        </div>
      </div>
    </section>
  )
}
