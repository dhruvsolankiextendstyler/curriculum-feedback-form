import { useCallback, useEffect, useState } from 'react'
import AdminNav from '../components/AdminNav'
import UserImport from '../components/admin/UserImport'
import { useAuth } from '../context/AuthContext'
import { RESPONDENT_ROLES, ROLES, ROLE_LABELS } from '../lib/constants'
import {
  createUsers,
  loadUsers,
  removeUser,
  restoreUser,
  setUserStatus,
  updateUser,
} from '../lib/admin/users'

const ALL_ROLES = [ROLES.ADMIN, ...RESPONDENT_ROLES]

/** FR-19 to FR-23: direct creation, editing, filtering and soft removal. */
export default function AdminUsers() {
  const { user: currentUser } = useAuth()
  const [filters, setFilters] = useState({
    view: 'current',
    role: '',
    status: '',
    search: '',
    sort: 'recent',
  })
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
      setState((current) => ({ ...current, error: err.message }))
    }
  }

  async function handleRemove(target) {
    const confirmed = window.confirm(
      `Remove ${target.email} from the current users list? Their account will be blocked, but their feedback and database record will be preserved.`,
    )
    if (!confirmed) return

    try {
      await removeUser(target.id, currentUser.id)
      setNotice(`${target.email} moved to Removed users.`)
      await refresh()
    } catch (err) {
      setState((current) => ({ ...current, error: err.message }))
    }
  }

  async function handleRestore(target) {
    if (!window.confirm(`Restore ${target.email} to the current users list?`)) return

    try {
      await restoreUser(target.id)
      setNotice(`${target.email} restored.`)
      await refresh()
    } catch (err) {
      setState((current) => ({ ...current, error: err.message }))
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
      setState((current) => ({ ...current, error: err.message }))
    }
  }

  const removedView = filters.view === 'removed'

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
          <button type="button" onClick={() => setShowImport((visible) => !visible)}>
            {showImport ? 'Hide add-user panel' : 'Add users'}
          </button>
        </div>

        {showImport && (
          <UserImport
            onDone={async (summary) => {
              setNotice(summary)
              await refresh()
            }}
            onError={(message) =>
              setState((current) => ({ ...current, error: message }))
            }
            create={createUsers}
          />
        )}
      </div>

      <div className="card filters">
        <div>
          <label htmlFor="filter-list">User list</label>
          <select
            id="filter-list"
            value={filters.view}
            onChange={(event) => {
              setEditing(null)
              setFilters((current) => ({ ...current, view: event.target.value }))
            }}
          >
            <option value="current">Current users</option>
            <option value="removed">Removed users</option>
          </select>
        </div>
        <div>
          <label htmlFor="filter-role">Role</label>
          <select
            id="filter-role"
            value={filters.role}
            onChange={(event) =>
              setFilters((current) => ({ ...current, role: event.target.value }))
            }
          >
            <option value="">All roles</option>
            {ALL_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
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
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
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
            <option value="recent">{removedView ? 'Recently removed' : 'Recently added'}</option>
            <option value="oldest">Oldest first</option>
            <option value="name_asc">Name A-Z</option>
            <option value="name_desc">Name Z-A</option>
            <option value="email_asc">Email A-Z</option>
          </select>
        </div>
        <div className="grow">
          <label htmlFor="filter-search">Search</label>
          <input
            id="filter-search"
            type="search"
            placeholder="Name or email"
            value={filters.search}
            onChange={(event) =>
              setFilters((current) => ({ ...current, search: event.target.value }))
            }
          />
        </div>
      </div>

      {state.loading ? (
        <p className="muted">Loading users...</p>
      ) : users.length === 0 ? (
        <p className="muted">No users match these filters.</p>
      ) : (
        <>
          <p className="muted">
            {users.length} {removedView ? 'removed ' : ''}user
            {users.length === 1 ? '' : 's'}
          </p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">{removedView ? 'Removed' : 'Added'}</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr
                    key={user.id}
                    className={removedView || user.status === 'inactive' ? 'row-muted' : ''}
                  >
                    <td>{user.full_name || <span className="muted">-</span>}</td>
                    <td>{user.email}</td>
                    <td>{ROLE_LABELS[user.role] ?? user.role}</td>
                    <td>
                      {removedView ? (
                        <span className="pill removed">Removed</span>
                      ) : (
                        <>
                          <span className={`pill ${user.status}`}>{user.status}</span>
                          {user.must_change_password && (
                            <span className="muted small account-note">
                              Temporary password
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="muted small">
                      {formatDate(removedView ? user.removed_at : user.created_at)}
                    </td>
                    <td className="actions">
                      {removedView ? (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => handleRestore(user)}
                        >
                          Restore
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setEditing({ ...user })}
                          >
                            Edit
                          </button>
                          {user.id === currentUser?.id ? (
                            <span className="muted small">that's you</span>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => handleToggleStatus(user)}
                              >
                                {user.status === 'active' ? 'Deactivate' : 'Reactivate'}
                              </button>
                              <button
                                type="button"
                                className="secondary danger"
                                onClick={() => handleRemove(user)}
                              >
                                Remove
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && !removedView && (
        <div className="card edit-panel">
          <h2>Edit {editing.email}</h2>
          <form onSubmit={handleSaveEdit}>
            <label htmlFor="edit-name">Full name</label>
            <input
              id="edit-name"
              type="text"
              value={editing.full_name ?? ''}
              onChange={(event) =>
                setEditing((current) => ({ ...current, full_name: event.target.value }))
              }
            />

            <label htmlFor="edit-role">Role</label>
            <select
              id="edit-role"
              value={editing.role}
              onChange={(event) =>
                setEditing((current) => ({ ...current, role: event.target.value }))
              }
            >
              {ALL_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>

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

function formatDate(value) {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}
