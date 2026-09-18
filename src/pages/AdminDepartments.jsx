import { useCallback, useEffect, useMemo, useState } from 'react'
import AdminNav from '../components/AdminNav'
import {
  CODE_HINT,
  DEPARTMENT_SORTS,
  createDepartment,
  createStream,
  deleteDepartment,
  deleteStream,
  describeDepartment,
  loadDepartmentTree,
  loadDepartmentUsage,
  sortDepartmentRows,
  updateDepartment,
  updateStream,
} from '../lib/admin/departments'

/**
 * Streams and departments (FR-44 to FR-48).
 *
 * Two pickers at the top, each with a box beneath it for adding to the list it
 * shows — a stream, then a department inside that stream. The pickers double as
 * the way into editing: selecting a row opens it below.
 *
 * Archive and delete are different operations and the page keeps them apart.
 * Archiving takes a department out of the pickers while its people keep it and
 * its responses stay in analytics; deleting removes the row, and the database
 * refuses that while anything still references it (`on delete restrict` in
 * 0008_departments.sql). The counts in the list are there so an admin can see
 * which of the two applies before clicking.
 */
export default function AdminDepartments() {
  const [data, setData] = useState({ streams: [], departments: [], usage: {} })
  const [state, setState] = useState({ loading: true, error: null })
  const [notice, setNotice] = useState(null)
  const [pick, setPick] = useState({ streamId: '', departmentId: '' })
  const [newStream, setNewStream] = useState('')
  const [newDepartment, setNewDepartment] = useState({ name: '', code: '' })
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [filters, setFilters] = useState({
    streamId: '',
    status: 'active',
    search: '',
    sort: 'stream',
  })

  const refresh = useCallback(async () => {
    setState({ loading: true, error: null })
    try {
      const [tree, usage] = await Promise.all([loadDepartmentTree(), loadDepartmentUsage()])
      setData({ ...tree, usage })
      setState({ loading: false, error: null })
      return tree
    } catch (err) {
      setState({ loading: false, error: err.message })
      return null
    }
  }, [])

  useEffect(() => {
    let active = true
    refresh().then((tree) => {
      // Open on something rather than an empty picker; the first active stream is
      // the one an admin is most likely to be adding to.
      if (!active || !tree?.streams?.length) return
      setPick((current) =>
        current.streamId
          ? current
          : { streamId: (tree.streams.find((s) => s.is_active) ?? tree.streams[0]).id, departmentId: '' },
      )
    })
    return () => {
      active = false
    }
  }, [refresh])

  const streamById = useMemo(
    () => new Map(data.streams.map((row) => [row.id, row])),
    [data.streams],
  )

  const pickedStream = pick.streamId ? streamById.get(pick.streamId) : null
  const pickedDepartment = pick.departmentId
    ? data.departments.find((row) => row.id === pick.departmentId)
    : null

  const inPickedStream = useMemo(
    () => data.departments.filter((row) => row.stream_id === pick.streamId),
    [data.departments, pick.streamId],
  )

  /** The list below the pickers: decorated, filtered, then sorted. */
  const rows = useMemo(() => {
    const term = filters.search.trim().toLowerCase()

    const decorated = data.departments.map((row) => ({
      ...row,
      stream_name: streamById.get(row.stream_id)?.name ?? '',
      user_count: data.usage[row.id]?.users ?? 0,
      removed_user_count: data.usage[row.id]?.removedUsers ?? 0,
      response_count: data.usage[row.id]?.responses ?? 0,
      question_count: data.usage[row.id]?.questions ?? 0,
    }))

    const kept = decorated.filter((row) => {
      if (filters.streamId && row.stream_id !== filters.streamId) return false
      if (filters.status === 'active' && !row.is_active) return false
      if (filters.status === 'archived' && row.is_active) return false
      if (term) {
        const haystack = `${row.name} ${row.code ?? ''} ${row.stream_name}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      return true
    })

    return sortDepartmentRows(kept, filters.sort)
  }, [data.departments, data.usage, streamById, filters])

  /** Runs a write, reports it, and reloads. Mirrors AdminCycles' `act`. */
  const act = useCallback(
    async (fn, message) => {
      setNotice(null)
      setBusy(true)
      try {
        const result = await fn()
        await refresh()
        if (message) setNotice(message)
        return result
      } catch (err) {
        setState((current) => ({ ...current, error: err.message }))
        return null
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  async function handleAddStream(event) {
    event.preventDefault()
    const name = newStream
    const id = await act(
      () => createStream({ name }, data.streams),
      `Stream "${name.trim()}" added.`,
    )
    if (id) {
      setNewStream('')
      setPick({ streamId: id, departmentId: '' })
    }
  }

  async function handleAddDepartment(event) {
    event.preventDefault()
    const { name, code } = newDepartment
    const id = await act(
      () => createDepartment({ streamId: pick.streamId, name, code }, data.departments),
      `"${name.trim()}" added to ${pickedStream?.name}.`,
    )
    if (id) {
      setNewDepartment({ name: '', code: '' })
      setPick((current) => ({ ...current, departmentId: id }))
    }
  }

  async function handleSaveDepartment(event) {
    event.preventDefault()
    const draft = editing.row
    const ok = await act(
      () =>
        updateDepartment(
          draft.id,
          { streamId: draft.stream_id, name: draft.name, code: draft.code ?? '' },
          data.departments,
        ),
      `Saved ${draft.name}.`,
    )
    if (ok !== null) setEditing(null)
  }

  async function handleSaveStream(event) {
    event.preventDefault()
    const draft = editing.row
    const ok = await act(
      () => updateStream(draft.id, { name: draft.name }, data.streams),
      `Saved ${draft.name}.`,
    )
    if (ok !== null) setEditing(null)
  }

  function setArchived(row, kind, archived) {
    const verb = archived ? 'Archive' : 'Restore'
    const warning = archived
      ? `${verb} ${row.name}? It leaves the pickers and the add-user form. Nobody loses it, and its responses stay in analytics.`
      : `${verb} ${row.name} to the active list?`
    if (!window.confirm(warning)) return

    const write =
      kind === 'stream'
        ? () => updateStream(row.id, { is_active: !archived }, data.streams)
        : () => updateDepartment(row.id, { is_active: !archived }, data.departments)

    act(write, `${row.name} ${archived ? 'archived' : 'restored'}.`).then((result) => {
      // `act` resolves to null only on failure. The open panel holds a SNAPSHOT
      // of the row, so without this the Archive button it was clicked from keeps
      // its old label while the table beside it already says the opposite.
      if (result === null) return
      setEditing((current) =>
        current?.row?.id === row.id
          ? { ...current, row: { ...current.row, is_active: !archived } }
          : current,
      )
    })
  }

  function handleDeleteDepartment(row) {
    const usage = data.usage[row.id]
    const attached = usage?.blocking ?? 0
    const warning = attached
      ? `${row.name} has ${describeUsage(usage)} attached, so the database will refuse to delete it. Archive it instead?`
      : `Delete ${row.name} permanently? Nothing references it, so this removes the row outright.`
    if (!window.confirm(warning)) return

    act(() => deleteDepartment(row.id), `${row.name} deleted.`).then((result) => {
      // act() resolves to null when the write failed; the picker should only
      // forget a department that has actually gone.
      if (result === null) return
      setPick((current) =>
        current.departmentId === row.id ? { ...current, departmentId: '' } : current,
      )
      setEditing(null)
    })
  }

  function handleDeleteStream(row) {
    const children = data.departments.filter((d) => d.stream_id === row.id).length
    const warning = children
      ? `${row.name} still has ${children} department${children === 1 ? '' : 's'}, so the database will refuse to delete it. Move or delete them first, or archive the stream instead?`
      : `Delete the stream ${row.name} permanently?`
    if (!window.confirm(warning)) return

    act(() => deleteStream(row.id), `${row.name} deleted.`).then((result) => {
      if (result === null) return
      setPick((current) =>
        current.streamId === row.id ? { streamId: '', departmentId: '' } : current,
      )
      setEditing(null)
    })
  }

  return (
    <section>
      <h1>Departments</h1>
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

      <div className="card">
        <h2>Add a department</h2>
        <p className="muted">
          A stream holds departments. Choose a stream to see the departments in it,
          and use the box under either picker to add to that list. Departments are
          what an admin assigns to a student or faculty account on the Users page.
        </p>

        <div className="filters">
          <div className="grow">
            <label htmlFor="pick-stream">Check streams</label>
            <select
              id="pick-stream"
              value={pick.streamId}
              onChange={(event) => {
                setEditing(null)
                setPick({ streamId: event.target.value, departmentId: '' })
              }}
            >
              <option value="">Choose a stream…</option>
              {data.streams.map((stream) => (
                <option key={stream.id} value={stream.id}>
                  {stream.name}
                  {stream.is_active ? '' : ' (archived)'}
                </option>
              ))}
            </select>

            <label htmlFor="new-stream">Add a new stream</label>
            <form className="add-inline" onSubmit={handleAddStream}>
              <input
                id="new-stream"
                type="text"
                placeholder="e.g. Vocational"
                value={newStream}
                onChange={(event) => setNewStream(event.target.value)}
              />
              <button type="submit" disabled={busy || !newStream.trim()}>
                Add
              </button>
            </form>

            {pickedStream && (
              <div className="button-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEditing({ kind: 'stream', row: { ...pickedStream } })}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setArchived(pickedStream, 'stream', pickedStream.is_active)}
                >
                  {pickedStream.is_active ? 'Archive' : 'Restore'}
                </button>
                <button
                  type="button"
                  className="secondary danger"
                  onClick={() => handleDeleteStream(pickedStream)}
                >
                  Delete
                </button>
              </div>
            )}
          </div>

          <div className="grow">
            <label htmlFor="pick-department">Check departments</label>
            <select
              id="pick-department"
              value={pick.departmentId}
              disabled={!pick.streamId}
              onChange={(event) => {
                setEditing(null)
                setPick((current) => ({ ...current, departmentId: event.target.value }))
              }}
            >
              <option value="">{departmentPlaceholder(pick.streamId, inPickedStream)}</option>
              {inPickedStream.map((department) => (
                <option key={department.id} value={department.id}>
                  {describeDepartment(department)}
                  {department.is_active ? '' : ' (archived)'}
                </option>
              ))}
            </select>

            <label htmlFor="new-department">Add a new department</label>
            <form className="add-inline" onSubmit={handleAddDepartment}>
              <input
                id="new-department"
                type="text"
                placeholder="e.g. Computer Science"
                disabled={!pick.streamId}
                value={newDepartment.name}
                onChange={(event) =>
                  setNewDepartment((current) => ({ ...current, name: event.target.value }))
                }
              />
              <input
                className="code"
                type="text"
                aria-label="Short code (optional)"
                placeholder="Code"
                spellCheck="false"
                autoCapitalize="characters"
                disabled={!pick.streamId}
                value={newDepartment.code}
                onChange={(event) =>
                  setNewDepartment((current) => ({ ...current, code: event.target.value }))
                }
              />
              <button
                type="submit"
                disabled={busy || !pick.streamId || !newDepartment.name.trim()}
              >
                Add
              </button>
            </form>
            <p className="field-hint">
              {pickedStream
                ? `Added to ${pickedStream.name}.`
                : 'Choose a stream first.'}{' '}
              The short code is optional — {CODE_HINT}.
            </p>

            {pickedDepartment && (
              <div className="button-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    setEditing({ kind: 'department', row: { ...pickedDepartment } })
                  }
                >
                  Edit {pickedDepartment.name}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {editing?.kind === 'stream' && (
        <div className="card edit-panel">
          <h2>Rename stream</h2>
          <form onSubmit={handleSaveStream}>
            <label htmlFor="edit-stream-name">Name</label>
            <input
              id="edit-stream-name"
              type="text"
              required
              value={editing.row.name}
              onChange={(event) =>
                setEditing((current) => ({
                  ...current,
                  row: { ...current.row, name: event.target.value },
                }))
              }
            />
            <p className="field-hint">
              Renaming is safe: departments, accounts and responses reference the
              stream by id, not by name.
            </p>
            <div className="button-row">
              <button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {editing?.kind === 'department' && (
        <div className="card edit-panel">
          <h2>Edit {streamById.get(editing.row.stream_id)?.name} / {editing.row.name}</h2>
          <form onSubmit={handleSaveDepartment}>
            <label htmlFor="edit-department-stream">Stream</label>
            <select
              id="edit-department-stream"
              value={editing.row.stream_id}
              onChange={(event) =>
                setEditing((current) => ({
                  ...current,
                  row: { ...current.row, stream_id: event.target.value },
                }))
              }
            >
              {data.streams.map((stream) => (
                <option key={stream.id} value={stream.id}>
                  {stream.name}
                  {stream.is_active ? '' : ' (archived)'}
                </option>
              ))}
            </select>
            <p className="field-hint">
              Moving a department carries its people and its past responses with it —
              a response records the department, and reads the stream through it. Add
              a second department instead if the old one should keep its history.
            </p>

            <label htmlFor="edit-department-name">Name</label>
            <input
              id="edit-department-name"
              type="text"
              required
              value={editing.row.name}
              onChange={(event) =>
                setEditing((current) => ({
                  ...current,
                  row: { ...current.row, name: event.target.value },
                }))
              }
            />

            <label htmlFor="edit-department-code">Short code (optional)</label>
            <input
              id="edit-department-code"
              type="text"
              spellCheck="false"
              autoCapitalize="characters"
              aria-describedby="edit-department-code-hint"
              value={editing.row.code ?? ''}
              onChange={(event) =>
                setEditing((current) => ({
                  ...current,
                  row: { ...current.row, code: event.target.value },
                }))
              }
            />
            <p className="field-hint" id="edit-department-code-hint">
              Clear the field to remove it. {CODE_HINT}. Codes only have to be unique
              within a stream.
            </p>

            <div className="button-row">
              <button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              {/* Archive and delete both live here so the choice is made in the
                  same place as the rename, rather than only from the table below.
                  handleDeleteDepartment does the asking: it checks what still
                  references this row and offers archiving when a delete would be
                  refused. `type="button"` on both — inside a <form>, the default
                  is submit, which would save the draft on the way out. */}
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  setArchived(editing.row, 'department', editing.row.is_active)
                }
              >
                {editing.row.is_active ? 'Archive' : 'Restore'}
              </button>
              <button
                type="button"
                className="secondary danger"
                disabled={busy}
                onClick={() => handleDeleteDepartment(editing.row)}
              >
                Delete department
              </button>
            </div>
            <p className="field-hint">
              Archiving takes {editing.row.name} out of the pickers and the add-user
              form but keeps its people and its analytics. Deleting removes the row
              outright, and the database refuses that while any account, response or
              question still points at it.
            </p>
          </form>
        </div>
      )}

      <div className="card filters">
        <div>
          <label htmlFor="filter-stream">Stream</label>
          <select
            id="filter-stream"
            value={filters.streamId}
            onChange={(event) =>
              setFilters((current) => ({ ...current, streamId: event.target.value }))
            }
          >
            <option value="">All streams</option>
            {data.streams.map((stream) => (
              <option key={stream.id} value={stream.id}>
                {stream.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-status">Status</label>
          <select
            id="filter-status"
            value={filters.status}
            onChange={(event) =>
              setFilters((current) => ({ ...current, status: event.target.value }))
            }
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="">Any status</option>
          </select>
        </div>
        <div>
          <label htmlFor="filter-sort">Sort</label>
          <select
            id="filter-sort"
            value={filters.sort}
            onChange={(event) =>
              setFilters((current) => ({ ...current, sort: event.target.value }))
            }
          >
            {DEPARTMENT_SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grow">
          <label htmlFor="filter-search">Search</label>
          <input
            id="filter-search"
            type="search"
            placeholder="Department, code or stream"
            value={filters.search}
            onChange={(event) =>
              setFilters((current) => ({ ...current, search: event.target.value }))
            }
          />
        </div>
      </div>

      {state.loading ? (
        <p className="muted">Loading departments…</p>
      ) : data.streams.length === 0 ? (
        <p className="muted">
          No streams yet. Add one above — Science, Commerce and Arts are the usual
          starting point — then add the departments inside it.
        </p>
      ) : rows.length === 0 ? (
        <p className="muted">No departments match these filters.</p>
      ) : (
        <>
          <p className="muted">
            {rows.length} department{rows.length === 1 ? '' : 's'}
            {filters.status === 'active' && ' shown as active'}
          </p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Department</th>
                  <th scope="col">Code</th>
                  <th scope="col">Stream</th>
                  <th scope="col">Users</th>
                  <th scope="col">Responses</th>
                  {/* Its own column because it is a delete blocker in its own
                      right, and the only one an admin cannot clear. */}
                  <th scope="col">Questions</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={row.is_active ? undefined : 'row-muted'}>
                    <td>{row.name}</td>
                    <td>{row.code || <span className="muted">-</span>}</td>
                    <td>{row.stream_name}</td>
                    <td>
                      {row.user_count}
                      {row.removed_user_count > 0 && (
                        <span className="muted small account-note">
                          +{row.removed_user_count} removed
                        </span>
                      )}
                    </td>
                    <td>{row.response_count}</td>
                    <td>{row.question_count}</td>
                    <td>
                      <span className={`pill ${row.is_active ? 'active' : 'inactive'}`}>
                        {row.is_active ? 'active' : 'archived'}
                      </span>
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setPick({ streamId: row.stream_id, departmentId: row.id })
                          setEditing({ kind: 'department', row: { ...row } })
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setArchived(row, 'department', row.is_active)}
                      >
                        {row.is_active ? 'Archive' : 'Restore'}
                      </button>
                      <button
                        type="button"
                        className="secondary danger"
                        onClick={() => handleDeleteDepartment(row)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Archiving takes a department out of the pickers and the add-user form
            without touching the accounts already in it. Deleting removes the row, and
            the database refuses that while any account, response or question still
            references it — the three counts above are what to check first. A
            department that has ever had its own question can only be archived:
            removing a question from a form keeps its history, and so keeps the
            reference.
          </p>
        </>
      )}
    </section>
  )
}

/**
 * The two edge cases keep their own wording: with no stream picked the control is
 * disabled, and an empty stream is worth saying out loud rather than leaving an
 * admin clicking an empty list.
 */
function departmentPlaceholder(streamId, inStream) {
  if (!streamId) return 'Choose a stream first'
  if (inStream.length === 0) return 'No departments in this stream yet'
  return 'Choose a department…'
}

/** "3 users, 1 removed account and 2 responses" — only the parts that apply. */
function describeUsage(usage) {
  const parts = []
  if (usage?.users) parts.push(`${usage.users} user${usage.users === 1 ? '' : 's'}`)
  if (usage?.removedUsers) {
    parts.push(
      `${usage.removedUsers} removed account${usage.removedUsers === 1 ? '' : 's'}`,
    )
  }
  if (usage?.responses) {
    parts.push(`${usage.responses} response${usage.responses === 1 ? '' : 's'}`)
  }
  if (usage?.questions) {
    parts.push(`${usage.questions} question${usage.questions === 1 ? '' : 's'}`)
  }
  if (parts.length === 0) return 'nothing'
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}
