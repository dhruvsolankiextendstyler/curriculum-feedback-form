import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart3, Building2, CalendarClock, Clock, ClipboardList,
  FileText, MessageSquareText, ScrollText, TrendingUp, Users,
} from 'lucide'
import Icon from '../components/Icon'
import { useAuth } from '../context/AuthContext'
import { isAdmin } from '../lib/constants'
import { supabase } from '../lib/supabase'
import { useToast } from '../context/ToastContext'

/**
 * Dashboard shortcuts — one per admin section (Dashboard itself excluded, since
 * it is this page). Departments and Logs are admin-only, matching AdminNav.
 */
const SHORTCUTS = [
  { to: '/admin/analytics', icon: BarChart3, title: 'Analytics', desc: 'Averages, distributions, trends and sentiment.', cue: 'Open analytics', cueIcon: TrendingUp },
  { to: '/admin/cycles', icon: CalendarClock, title: 'Cycles', desc: 'Manage academic year deadlines.', cue: 'Manage cycles', cueIcon: CalendarClock },
  { to: '/admin/forms', icon: ClipboardList, title: 'Forms', desc: 'Add or edit feedback questions.', cue: 'Edit forms', cueIcon: ClipboardList },
  { to: '/admin/users', icon: Users, title: 'Users', desc: 'Roles, departments and access.', cue: 'Manage users', cueIcon: Users },
  { to: '/admin/departments', icon: Building2, title: 'Departments', desc: 'Streams, departments and codes.', cue: 'Manage departments', cueIcon: Building2, adminOnly: true },
  { to: '/admin/logs', icon: ScrollText, title: 'Logs', desc: 'Every admin change, with who and when.', cue: 'View logs', cueIcon: ScrollText, adminOnly: true },
]

export default function AdminHome() {
  const { role } = useAuth()
  const admin = isAdmin(role)
  const toast = useToast()
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    let active = true

    async function load() {
      const countOf = (table) =>
        supabase.from(table).select('id', { count: 'exact', head: true })

      const [users, forms, responses, departments, cycle, deptResponses, recentLogs] = await Promise.all([
        countOf('profiles'),
        countOf('forms'),
        countOf('responses'),
        countOf('departments'),
        supabase
          .from('academic_cycles')
          .select('label, closes_at')
          .eq('is_active', true)
          .maybeSingle(),
        supabase
          .from('responses')
          .select('id, profiles!responses_user_id_fkey(departments(name))')
          .order('submitted_at', { ascending: false })
          .limit(500),
        supabase
          .from('question_audit')
          .select(`id, action, created_at,
            questions!inner(question_key, forms!inner(title)),
            profiles!question_audit_actor_id_fkey(full_name)`)
          .order('created_at', { ascending: false })
          .limit(5),
      ])

      if (!active) return

      const error = users.error || forms.error || responses.error || cycle.error
      if (error) {
        toast.error(error.message)
        setState({ loading: false, error: error.message, data: null })
        return
      }

      setState({
        loading: false,
        error: null,
        data: {
          users: users.count ?? 0,
          forms: forms.count ?? 0,
          responses: responses.count ?? 0,
          departments: departments.error ? null : departments.count ?? 0,
          cycle: cycle.data,
          deptResponses: buildDeptCounts(deptResponses.data ?? []),
          recentLogs: recentLogs.data ?? [],
        },
      })
    }

    load()
    return () => { active = false }
  }, [])

  if (state.loading) return <p className="muted">Loading…</p>
  if (state.error) return <p className="muted centered">Could not load the dashboard. Please try refreshing.</p>

  const { users, forms, responses, departments, cycle, deptResponses, recentLogs } = state.data
  const cycleClosed = cycle && new Date(cycle.closes_at) < new Date()
  const daysLeft = cycle && !cycleClosed
    ? Math.ceil((new Date(cycle.closes_at) - new Date()) / 864e5)
    : null

  return (
    <section>
      <h1>Admin dashboard</h1>

      {cycle ? (
        <div className={`notice ${cycleClosed ? 'error' : 'success'}`} role="status">
          <p>
            <strong>Active cycle: {cycle.label}</strong>
            {cycleClosed
              ? ` — closed ${new Date(cycle.closes_at).toLocaleDateString()}. Submissions are read-only.`
              : ` — closes ${new Date(cycle.closes_at).toLocaleDateString()}`}
            {daysLeft !== null && <span className="muted"> ({daysLeft} day{daysLeft !== 1 ? 's' : ''} remaining)</span>}
          </p>
        </div>
      ) : (
        <div className="notice error" role="status">
          <p>No active cycle. <Link to="/admin/cycles">Create one</Link> before collecting feedback.</p>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat">
          <Icon icon={MessageSquareText} size={22} />
          <span className="stat-value">{responses}</span>
          <span className="stat-label">Responses</span>
        </div>
        <div className="stat">
          <Icon icon={Users} size={22} />
          <span className="stat-value">{users}</span>
          <span className="stat-label">Users</span>
        </div>
        {departments !== null && (
          <div className="stat">
            <Icon icon={Building2} size={22} />
            <span className="stat-value">{departments}</span>
            <span className="stat-label">Departments</span>
          </div>
        )}
        <div className="stat">
          <Icon icon={ClipboardList} size={22} />
          <span className="stat-value">{forms}</span>
          <span className="stat-label">Forms</span>
        </div>
      </div>

      <div className="dash-panels">
        <div className="card dash-panel">
          <div className="dash-panel-head">
            <h2><Icon icon={Building2} size={18} /> Responses by department</h2>
            <Link to="/admin/analytics" className="small"><Icon icon={BarChart3} size={14} /> Analytics</Link>
          </div>
          {deptResponses.length === 0 ? (
            <p className="muted">No responses yet.</p>
          ) : (
            <ul className="dash-list">
              {deptResponses.map(({ name, count }) => (
                <li key={name}>
                  <span className="dash-list-title">{name}</span>
                  <span className="muted small">{count} response{count !== 1 ? 's' : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card dash-panel">
          <div className="dash-panel-head">
            <h2><Icon icon={Clock} size={18} /> Recent activity</h2>
            <Link to="/admin/logs" className="small"><Icon icon={FileText} size={14} /> View log</Link>
          </div>
          {recentLogs.length === 0 ? (
            <p className="muted">No activity recorded yet.</p>
          ) : (
            <ul className="dash-list">
              {recentLogs.map((log) => {
                const actor = unwrap(log.profiles)?.full_name ?? 'Someone'
                const q = unwrap(log.questions)
                const form = q?.forms ? unwrap(q.forms) : null
                return (
                  <li key={log.id}>
                    <span className="dash-list-title">
                      {actor} {ACTION_VERBS[log.action] ?? log.action} a question
                      {form?.title ? ` in ${form.title}` : ''}
                    </span>
                    <span className="muted small">{timeAgo(log.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="quick-actions">
        {SHORTCUTS.filter((s) => !s.adminOnly || admin).map((s) => (
          <Link key={s.to} to={s.to} className="card quick-action">
            <h3><Icon icon={s.icon} size={18} /> {s.title}</h3>
            <p className="muted">{s.desc}</p>
            <span className="quick-action-cue">
              <Icon icon={s.cueIcon} size={14} /> {s.cue}
            </span>
          </Link>
        ))}
      </div>
    </section>
  )
}

const ACTION_VERBS = { created: 'added', edited: 'edited', deleted: 'removed', restored: 'restored', reordered: 'reordered' }

function buildDeptCounts(rows) {
  const map = new Map()
  for (const r of rows) {
    const dept = unwrap(r.profiles)?.departments
    const name = (dept ? unwrap(dept) : null)?.name ?? 'Unassigned'
    map.set(name, (map.get(name) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

function unwrap(v) { return Array.isArray(v) ? v[0] : v }

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}
