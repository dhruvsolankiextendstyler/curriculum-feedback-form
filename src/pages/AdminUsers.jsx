import { useCallback, useEffect, useState } from 'react'
import AdminNav from '../components/AdminNav'
import UserImport from '../components/admin/UserImport'
import { useAuth } from '../context/AuthContext'
import { RESPONDENT_ROLES, ROLES, ROLE_LABELS } from '../lib/constants'
import {
  inviteUsers,
  loadUsers,
  setUserStatus,
  updateUser,
} from '../lib/admin/users'

const ALL_ROLES = [ROLES.ADMIN, ...RESPONDENT_ROLES]

/** FR-19 to FR-24: user list, single invite, inline edit, deactivate, CSV import. */
export default function AdminUsers() {
  const { user: currentUser } = useAuth()
  const [filters, setFilters] = useState({ role: '', status: '', search: '' })
  const [users, setUsers] = useState([])
  const [state, setState] = useState({ loading: true, error: null })
  const [notice, setNotice] = useState(null)
  const [editing, setEditing] = useState(null)
  const [showImport, setShowImport] = useState(false)

  const refresh = useCallback(async () => {
    setState({ loading: true, error: null })
    try {
      setUsers(await loadUsers(filters))
      setState({ loading: false, error: null })
    } catch (err) {
      setState({ loading: false, error: err.message })
    }
  }, [filters])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function handleToggleStatus(target) {
    const next = target.status === 'active' ? 'inactive' : 'active'
    const verb = next === 'inactive' ? 'Deactivate' : 'Reactivate'
    if (!window.confirm(`${verb} ${target.email}?`)) return

    try {
      await setUserStatus(target.id, next)
      setNotice(`${target.email} is now ${next}.`)
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    }
  }

  async function handleSaveEdit(event) {
    event.preventDefault()
    try {
      await updateUser(editing.id, {
        full_name: editing.full_name ?? '',
        role: editing.role,
      })
      setNotice(`Saved changes to ${editing.email}.`)
      setEditing(null)
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    }
  }

  return (
    <section>
      <h1>Users</h1>
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
        <div className="button-row">
          <button type="button" onClick={() => setShowImport((v) => !v)}>
            {showImport ? 'Hide invite panel' : 'Invite users'}
          </button>
        </div>

        {showImport && (
          <UserImport
            onDone={async (summary) => {
              setNotice(summary)
              await refresh()
            }}
            onError={(message) => setState((s) => ({ ...s, error: message }))}
            invite={inviteUsers}
          />
        )}
      </div>

      <div className="card filters">
        <div>
          <label htmlFor="filter-role">Role</label>
          <select
            id="filter-role"
            value={filters.role}
            onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value }))}
          >
            <option value="">All roles</option>
            {ALL_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-status">Status</label>
          <select
            id="filter-status"
            value={filters.status}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div className="grow">
          <label htmlFor="filter-search">Search</label>
          <input
            id="filter-search"
            type="search"
            placeholder="Name or email"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          />
        </div>
      </div>

      {state.loading ? (
        <p className="muted">Loading users…</p>
      ) : users.length === 0 ? (
        <p className="muted">No users match these filters.</p>
      ) : (
        <>
          <p className="muted">{users.length} user{users.length === 1 ? '' : 's'}</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Invite</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.status === 'inactive' ? 'row-muted' : ''}>
                    <td>{u.full_name || <span className="muted">—</span>}</td>
                    <td>{u.email}</td>
                    <td>{ROLE_LABELS[u.role] ?? u.role}</td>
                    <td>
                      <span className={`pill ${u.status}`}>{u.status}</span>
                    </td>
                    <td className="muted small">{u.invite_status}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setEditing({ ...u })}
                      >
                        Edit
                      </button>
                      {u.id === currentUser?.id ? (
                        <span className="muted small">that's you</span>
                      ) : (
                        <button
                          type="button"
                          className="secondary danger"
                          onClick={() => handleToggleStatus(u)}
                        >
                          {u.status === 'active' ? 'Deactivate' : 'Reactivate'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && (
        <div className="card edit-panel">
          <h2>Edit {editing.email}</h2>
          <form onSubmit={handleSaveEdit}>
            <label htmlFor="edit-name">Full name</label>
            <input
              id="edit-name"
              type="text"
              value={editing.full_name ?? ''}
              onChange={(e) => setEditing((x) => ({ ...x, full_name: e.target.value }))}
            />

            <label htmlFor="edit-role">Role</label>
            <select
              id="edit-role"
              value={editing.role}
              onChange={(e) => setEditing((x) => ({ ...x, role: e.target.value }))}
            >
              {ALL_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <p className="muted small">
              Changing a role sends this user to a different feedback form. Any
              feedback they have already given stays as it is.
            </p>

            <div className="button-row">
              <button type="submit">Save changes</button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
