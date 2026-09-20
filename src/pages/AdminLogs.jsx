import { useEffect, useMemo, useState } from 'react'
import { FilterX } from 'lucide'
import Icon from '../components/Icon'
import { supabase } from '../lib/supabase'
import { useToast } from '../context/ToastContext'

const ACTION_LABELS = {
  created: 'Created',
  edited: 'Edited',
  deleted: 'Removed',
  restored: 'Restored',
  reordered: 'Reordered',
}

export default function AdminLogs() {
  const toast = useToast()
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [actionFilter, setActionFilter] = useState('')
  const [formFilter, setFormFilter] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data, error: err } = await supabase
        .from('question_audit')
        .select(
          `id, action, details, created_at,
           questions!inner ( question_key, form_id,
             forms!inner ( title, stakeholder_type )
           ),
           profiles!question_audit_actor_id_fkey ( full_name, email )`,
        )
        .order('created_at', { ascending: false })
        .limit(200)

      if (!active) return
      if (err) {
        toast.error(err.message)
        setError(err.message)
      } else {
        setLogs(data ?? [])
      }
      setLoading(false)
    })()
    return () => { active = false }
  }, [])

  const forms = useMemo(() => {
    const set = new Map()
    for (const log of logs) {
      const q = Array.isArray(log.questions) ? log.questions[0] : log.questions
      const form = q?.forms ? (Array.isArray(q.forms) ? q.forms[0] : q.forms) : null
      if (form?.title && !set.has(form.title)) set.set(form.title, form.title)
    }
    return [...set.values()].sort()
  }, [logs])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return logs.filter((log) => {
      if (actionFilter && log.action !== actionFilter) return false
      const qn = Array.isArray(log.questions) ? log.questions[0] : log.questions
      const form = qn?.forms ? (Array.isArray(qn.forms) ? qn.forms[0] : qn.forms) : null
      if (formFilter && form?.title !== formFilter) return false
      if (q) {
        const actor = Array.isArray(log.profiles) ? log.profiles[0] : log.profiles
        const haystack = [
          actor?.full_name, actor?.email, qn?.question_key,
          form?.title, formatDetails(log.details),
        ].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [logs, actionFilter, formFilter, search])

  const hasFilters = actionFilter || formFilter || search

  return (
    <section>
      <h1>Activity Log</h1>
      <p className="muted">
        Recent changes to form questions. Shows who changed what and when.
      </p>

      {error && <p className="muted">Something went wrong loading the logs.</p>}

      {!loading && logs.length > 0 && (
        <div className="card">
          <div className="filters">
            <div>
              <label htmlFor="log-action">Action</label>
              <select id="log-action" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
                <option value="">All actions</option>
                {Object.entries(ACTION_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="log-form">Form</label>
              <select id="log-form" value={formFilter} onChange={(e) => setFormFilter(e.target.value)}>
                <option value="">All forms</option>
                {forms.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
            <div className="grow">
              <label htmlFor="log-search">Search</label>
              <input
                id="log-search"
                type="search"
                placeholder="Name, email, question key…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {hasFilters && (
              <button
                type="button"
                className="secondary"
                onClick={() => { setActionFilter(''); setFormFilter(''); setSearch('') }}
              >
                <Icon icon={FilterX} size={16} /> Clear
              </button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <p className="muted">Loading logs…</p>
      ) : logs.length === 0 ? (
        <p className="muted">No activity recorded yet.</p>
      ) : filtered.length === 0 ? (
        <p className="muted">No logs match these filters.</p>
      ) : (
        <>
          <p className="muted small">Showing {filtered.length} of {logs.length} entries</p>
          <div className="table-wrap">
            <table className="log-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Question</th>
                  <th>Form</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log) => {
                  const q = Array.isArray(log.questions) ? log.questions[0] : log.questions
                  const actor = Array.isArray(log.profiles) ? log.profiles[0] : log.profiles
                  const form = q?.forms
                    ? (Array.isArray(q.forms) ? q.forms[0] : q.forms)
                    : null
                  return (
                    <tr key={log.id}>
                      <td className="nowrap">
                        {new Date(log.created_at).toLocaleString()}
                      </td>
                      <td>{actor?.full_name || actor?.email || '—'}</td>
                      <td>
                        <span className={`pill action-${log.action}`}>
                          {ACTION_LABELS[log.action] ?? log.action}
                        </span>
                      </td>
                      <td><code>{q?.question_key ?? '—'}</code></td>
                      <td>{form?.title ?? '—'}</td>
                      <td className="small muted">
                        {log.details ? formatDetails(log.details) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function formatDetails(details) {
  if (typeof details === 'string') return details
  const parts = []
  if (details.text) parts.push(`Text: "${truncate(details.text, 60)}"`)
  if (details.type) parts.push(`Type: ${details.type}`)
  if (details.version_no) parts.push(`v${details.version_no}`)
  if (details.reason) parts.push(details.reason)
  if (parts.length) return parts.join(' · ')
  return JSON.stringify(details).slice(0, 120)
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '…' : str
}
