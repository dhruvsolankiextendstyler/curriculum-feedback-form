import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Check, Pencil, Plus, X, XCircle, Zap } from 'lucide'
import Icon from '../components/Icon'
import { useToast } from '../context/ToastContext'
import {
  activateCycle,
  closeCycleNow,
  createCycle,
  cycleState,
  CYCLE_STATE_LABELS,
  loadCycleCounts,
  loadCycles,
  toLocalInput,
  updateCycle,
} from '../lib/admin/cycles'

/**
 * Feedback cycle management.
 *
 * `closes_at` is not just a label: the RLS policies on responses and answers read
 * it to decide whether a respondent may still edit (FR-16). Changing a date here
 * changes what respondents can do immediately, so the UI says so plainly.
 */
/** Analytics, pre-filtered to one academic year (read back by AdminAnalytics). */
export const analyticsPathFor = (cycleId) =>
  `/admin/analytics?cycle=${encodeURIComponent(cycleId)}`

export default function AdminCycles() {
  const navigate = useNavigate()
  const toast = useToast()
  const [cycles, setCycles] = useState([])
  const [counts, setCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState(null)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [sort, setSort] = useState('recent')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, tally] = await Promise.all([loadCycles(), loadCycleCounts()])
      setCycles(rows)
      setCounts(tally)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const sortedCycles = useMemo(() => sortCycles(cycles, sort), [cycles, sort])

  const act = async (fn, message) => {
    setNotice(null)
    try {
      await fn()
      setNotice(message)
      await refresh()
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function handleClose(cycle) {
    const n = counts[cycle.id] ?? 0
    const warning =
      `Close "${cycle.label}" now? ` +
      (n
        ? `Its ${n} submission${n === 1 ? '' : 's'} become read-only and respondents can no longer edit.`
        : 'Respondents will no longer be able to submit or edit.')
    if (!window.confirm(warning)) return
    await act(() => closeCycleNow(cycle.id), `"${cycle.label}" is now closed.`)
  }

  return (
    <section>
      <h1>Feedback cycles</h1>

      {notice && (
        <div className="notice success" role="status">
          <p>{notice}</p>
        </div>
      )}

      <div className="card">
        <p className="muted">
          Feedback is grouped by academic year. Only one cycle collects responses
          at a time, and its closing date is the deadline after which respondents
          can no longer change their answers. Select a row to open that
          year&rsquo;s analytics.
        </p>
        <div className="button-row">
          <button type="button" onClick={() => setCreating((v) => !v)}>
            <Icon icon={creating ? X : Plus} size={16} />
            {creating ? 'Cancel' : 'New cycle'}
          </button>
        </div>
      </div>

      {creating && (
        <CycleForm
          onCancel={() => setCreating(false)}
          onSubmit={async (values) => {
            await act(
              () => createCycle(values),
              `Cycle "${values.label}" created${values.activate ? ' and activated' : ''}.`,
            )
            setCreating(false)
          }}
        />
      )}

      {editing && (
        <CycleForm
          cycle={editing}
          onCancel={() => setEditing(null)}
          onSubmit={async (values) => {
            await act(() => updateCycle(editing.id, values), 'Cycle updated.')
            setEditing(null)
          }}
        />
      )}

      {loading ? (
        <p className="muted">Loading cycles…</p>
      ) : cycles.length === 0 ? (
        <p className="muted">
          No cycles yet. Create one before respondents can give feedback.
        </p>
      ) : (
        <>
          <div className="card filters">
            <div>
              <label htmlFor="cycle-sort">Sort</label>
              <select
                id="cycle-sort"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="recent">Most recent</option>
                <option value="oldest">Oldest first</option>
                <option value="label_asc">Label A–Z</option>
                <option value="label_desc">Label Z–A</option>
                <option value="status">Status</option>
              </select>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Cycle</th>
                  <th scope="col">Status</th>
                  <th scope="col">Opens</th>
                  <th scope="col">Closes</th>
                  <th scope="col">Responses</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedCycles.map((cycle) => {
                  const status = cycleState(cycle)
                  return (
                    <tr
                      key={cycle.id}
                      className={`row-clickable${status === 'closed' ? ' row-muted' : ''}`}
                      // The whole row opens this year's analytics. The label is
                      // also a real link, which is what carries keyboard users,
                      // screen readers and middle-click — a clickable <tr> gives
                      // none of those on its own.
                      onClick={() => navigate(analyticsPathFor(cycle.id))}
                    >
                      <td>
                        <Link
                          className="row-link"
                          to={analyticsPathFor(cycle.id)}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <strong>{cycle.label}</strong>
                        </Link>
                      </td>
                      <td>
                        <span className={`pill state-${status}`}>
                          {CYCLE_STATE_LABELS[status]}
                        </span>
                      </td>
                      <td className="small">{formatDate(cycle.opens_at)}</td>
                      <td className="small">{formatDate(cycle.closes_at)}</td>
                      <td>{counts[cycle.id] ?? 0}</td>
                      {/* Every action here edits the cycle; none of them should
                          also navigate away to analytics. */}
                      <td className="actions" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setEditing(cycle)}
                        >
                          <Icon icon={Pencil} size={14} />
                          Edit
                        </button>
                        {!cycle.is_active && status !== 'closed' && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              act(
                                () => activateCycle(cycle.id),
                                `"${cycle.label}" is now the active cycle.`,
                              )
                            }
                          >
                            <Icon icon={Zap} size={14} />
                            Make active
                          </button>
                        )}
                        {status === 'open' && (
                          <button
                            type="button"
                            className="secondary danger"
                            onClick={() => handleClose(cycle)}
                          >
                            <Icon icon={XCircle} size={14} />
                            Close now
                          </button>
                        )}
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

function CycleForm({ cycle, onSubmit, onCancel }) {
  const isNew = !cycle
  const [values, setValues] = useState(() => ({
    label: cycle?.label ?? suggestLabel(),
    opensAt: cycle ? toLocalInput(cycle.opens_at) : toLocalInput(new Date().toISOString()),
    closesAt: cycle
      ? toLocalInput(cycle.closes_at)
      : toLocalInput(new Date(Date.now() + 120 * 864e5).toISOString()),
    activate: isNew,
  }))
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    try {
      await onSubmit(values)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card edit-panel">
      <h2>{isNew ? 'New cycle' : `Edit ${cycle.label}`}</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="cycle-label">Label</label>
        <input
          id="cycle-label"
          type="text"
          required
          placeholder="2026-27"
          value={values.label}
          onChange={(e) => setValues((v) => ({ ...v, label: e.target.value }))}
        />

        <label htmlFor="cycle-opens">Opens</label>
        <input
          id="cycle-opens"
          type="datetime-local"
          required
          value={values.opensAt}
          onChange={(e) => setValues((v) => ({ ...v, opensAt: e.target.value }))}
        />

        <label htmlFor="cycle-closes">Closes</label>
        <input
          id="cycle-closes"
          type="datetime-local"
          required
          value={values.closesAt}
          onChange={(e) => setValues((v) => ({ ...v, closesAt: e.target.value }))}
        />
        <p className="muted small">
          After this moment, submissions in this cycle become read-only. Enforced
          in the database, so it applies even to a browser tab left open.
        </p>

        {isNew && (
          <label className="inline-check" htmlFor="cycle-activate">
            <input
              id="cycle-activate"
              type="checkbox"
              checked={values.activate}
              onChange={(e) => setValues((v) => ({ ...v, activate: e.target.checked }))}
            />
            <span>Make this the active cycle (stands down any current one)</span>
          </label>
        )}

        <div className="button-row">
          <button type="submit" disabled={busy}>
            <Icon icon={Check} size={16} />
            {busy ? 'Saving…' : isNew ? 'Create cycle' : 'Save changes'}
          </button>
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            <Icon icon={X} size={16} />
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

/** Academic years run mid-year, so before June the current year still applies. */
function suggestLabel() {
  const now = new Date()
  const startYear = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** Client-side sort: cycles are few, so ordering here avoids extra round trips. */
function sortCycles(cycles, sort) {
  const rows = [...cycles]
  const opens = (c) => new Date(c.opens_at).getTime()
  const byLabel = (a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true })
  const statusRank = { open: 0, scheduled: 1, inactive: 2, closed: 3 }

  rows.sort((a, b) => {
    if (sort === 'oldest') return opens(a) - opens(b)
    if (sort === 'label_asc') return byLabel(a, b)
    if (sort === 'label_desc') return byLabel(b, a)
    if (sort === 'status') {
      const diff = statusRank[cycleState(a)] - statusRank[cycleState(b)]
      return diff !== 0 ? diff : opens(b) - opens(a)
    }
    return opens(b) - opens(a) // recent
  })

  return rows
}
