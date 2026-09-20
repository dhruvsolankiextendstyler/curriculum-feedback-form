import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ban, Check, CheckCircle, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide'
import Icon from '../components/Icon'
import UserImport from '../components/admin/UserImport'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import {
  ASSIGNABLE_ROLES,
  HOD_CREATABLE_ROLES,
  isHod,
  ROLE_LABELS,
} from '../lib/constants'
import { SAP_ID_HINT } from '../lib/identifier'
import {
  createUsers,
  loadUsers,
  NO_DEPARTMENT,
  removeUser,
  restoreUser,
  setUserStatus,
  updateUser,
} from '../lib/admin/users'
import {
  departmentIsAssignable,
  departmentRequiredFor,
  describeDepartment,
} from '../lib/admin/departmentRules'
import { loadDepartmentTree } from '../lib/admin/departments'

const EMPTY_TREE = { streams: [], departments: [] }

/**
 * What every filter except the role reverts to when a role is picked.
 *
 * Choosing a role is the start of a new question — "show me the faculty" — and
 * carrying a stale department or search term into it answers a different one,
 * usually with an empty table and no clue why. `view` is deliberately NOT in
 * here: Current/Removed selects which LIST is being filtered, and resetting it
 * would throw an admin out of the removed-users list mid-search.
 */
const FILTER_DEFAULTS = {
  status: '',
  streamId: '',
  departmentId: '',
  search: '',
  sort: 'recent',
}

/**
 * FR-19 to FR-23, FR-46, FR-51: direct creation, editing, filtering and soft
 * removal.
 *
 * A head of department sees the same page narrowed to their own department. The
 * narrowing is done by RLS (0011_hod_scope.sql) — the list simply arrives shorter —
 * so everything here is about not offering actions the database would refuse:
 * no other department, only two roles, and no deactivate, remove or restore.
 */
export default function AdminUsers() {
  const { user: currentUser, profile, role: currentRole } = useAuth()
  const toast = useToast()
  const hod = isHod(currentRole)

  const [filters, setFilters] = useState({
    view: 'current',
    role: '',
    ...FILTER_DEFAULTS,
  })
  const [users, setUsers] = useState([])
  const [tree, setTree] = useState(EMPTY_TREE)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState(null)
  const [editing, setEditing] = useState(null)
  const [showImport, setShowImport] = useState(false)

  // Loaded once and shared by the filters, the table, the edit panel and the
  // add-user form. A failure here is swallowed on purpose: before migration 0008
  // there is no department to show, and the rest of this page still works.
  useEffect(() => {
    let active = true
    loadDepartmentTree()
      .then((data) => active && setTree(data))
      .catch(() => active && setTree(EMPTY_TREE))
    return () => {
      active = false
    }
  }, [])

  const departmentById = useMemo(
    () => new Map(tree.departments.map((row) => [row.id, row])),
    [tree.departments],
  )
  const streamById = useMemo(
    () => new Map(tree.streams.map((row) => [row.id, row])),
    [tree.streams],
  )
  const hasDepartments = tree.streams.length > 0
  const ownDepartment = hod ? (departmentById.get(profile?.department_id) ?? null) : null
  const roleOptions = hod ? HOD_CREATABLE_ROLES : ASSIGNABLE_ROLES

  /** A stream filter is the set of its departments; null means "no stream chosen". */
  const departmentIdsForStream = useMemo(
    () =>
      filters.streamId
        ? tree.departments
            .filter((row) => row.stream_id === filters.streamId)
            .map((row) => row.id)
        : null,
    [tree.departments, filters.streamId],
  )

  const departmentOptions = useMemo(
    () =>
      filters.streamId
        ? tree.departments.filter((row) => row.stream_id === filters.streamId)
        : tree.departments,
    [tree.departments, filters.streamId],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setUsers(
        await loadUsers({
          ...filters,
          department: filters.departmentId,
          departmentIds: departmentIdsForStream,
        }),
      )
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [filters, departmentIdsForStream, toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function handleToggleStatus(target) {
    const next = target.status === 'active' ? 'inactive' : 'active'
    const verb = next === 'inactive' ? 'Deactivate' : 'Reactivate'
    if (!window.confirm(`${verb} ${target.email}?`)) return

    try {
      await setUserStatus(target.id, next, { asHod: hod })
      setNotice(`${target.email} is now ${next}.`)
      await refresh()
    } catch (err) {
      toast.error(err.message)
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
      toast.error(err.message)
    }
  }

  async function handleRestore(target) {
    if (!window.confirm(`Restore ${target.email} to the current users list?`)) return

    try {
      await restoreUser(target.id)
      setNotice(`${target.email} restored.`)
      await refresh()
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function handleSaveEdit(event) {
    event.preventDefault()
    try {
      await updateUser(
        editing.id,
        {
          full_name: editing.full_name ?? '',
          sap_id: editing.sap_id ?? '',
          role: editing.role,
          // Omitted entirely when the column is not there yet, rather than sent as
          // null and rejected by the schema cache — and always omitted for an HOD,
          // who cannot move an account between departments at all.
          ...(hasDepartments && !hod
            ? { department_id: editing.department_id ?? '' }
            : {}),
        },
        {
          asHod: hod,
          departments: tree.departments,
          streams: tree.streams,
          currentDepartmentId: editing.original_department_id,
        },
      )
      setNotice(`Saved changes to ${editing.email}.`)
      setEditing(null)
      await refresh()
    } catch (err) {
      toast.error(err.message)
    }
  }

  /** Opens the edit panel, deriving the stream from the department it holds. */
  function startEditing(user) {
    setEditing({
      ...user,
      stream_id: departmentById.get(user.department_id)?.stream_id ?? '',
      // Kept separately because `department_id` is the edited value from here
      // on, and telling a move apart from a rename needs the original.
      original_department_id: user.department_id ?? null,
    })
  }

  const removedView = filters.view === 'removed'

  return (
    <section>
      <h1>Users</h1>

      {hod && (
        <p className="muted">
          {ownDepartment ? (
            <>
              You are administering <strong>{describeDepartment(ownDepartment)}</strong>.
              Only its accounts are listed, and only an administrator can move someone
              in or out, deactivate or remove them.
            </>
          ) : (
            <>
              Your account has no department assigned, so there is nothing to
              administer. Ask an administrator to set one.
            </>
          )}
        </p>
      )}

      {notice && (
        <div className="notice success" role="status">
          <p>{notice}</p>
        </div>
      )}

      <div className="card">
        <div className="button-row">
          <button type="button" onClick={() => setShowImport((visible) => !visible)}>
            <Icon icon={showImport ? X : Plus} size={16} />
            {showImport ? 'Hide add-user panel' : 'Add users'}
          </button>
        </div>

        {showImport && (
          <UserImport
            onDone={async (summary) => {
              setNotice(summary)
              await refresh()
            }}
            onError={(message) => toast.error(message)}
            create={createUsers}
            tree={tree}
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
            onChange={(event) => {
              // A new role starts a new question: everything else goes back to
              // its default so the answer is the whole role, not the role
              // narrowed by whatever was set for the last one.
              setEditing(null)
              setFilters((current) => ({
                ...current,
                role: event.target.value,
                ...FILTER_DEFAULTS,
              }))
            }}
          >
            <option value="">All roles</option>
            {roleOptions.map((role) => (
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
        {hasDepartments && !hod && (
          <>
            <div>
              <label htmlFor="filter-stream">Stream</label>
              <select
                id="filter-stream"
                value={filters.streamId}
                onChange={(event) =>
                  // Narrowing the stream can orphan the chosen department, so it
                  // is cleared rather than left filtering to nothing.
                  setFilters((current) => ({
                    ...current,
                    streamId: event.target.value,
                    departmentId: '',
                  }))
                }
              >
                <option value="">All streams</option>
                {tree.streams.map((stream) => (
                  <option key={stream.id} value={stream.id}>
                    {stream.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="filter-department">Department</label>
              <select
                id="filter-department"
                value={filters.departmentId}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    departmentId: event.target.value,
                  }))
                }
              >
                <option value="">All departments</option>
                <option value={NO_DEPARTMENT}>Not assigned</option>
                {departmentOptions.map((department) => (
                  <option key={department.id} value={department.id}>
                    {describeDepartment(department)}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
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
            placeholder="Name, email or SAP ID"
            value={filters.search}
            onChange={(event) =>
              setFilters((current) => ({ ...current, search: event.target.value }))
            }
          />
        </div>
      </div>

      {loading ? (
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
                  <th scope="col">SAP ID</th>
                  <th scope="col">Role</th>
                  {hasDepartments && <th scope="col">Department</th>}
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
                    <td>{user.sap_id || <span className="muted">-</span>}</td>
                    <td>{ROLE_LABELS[user.role] ?? user.role}</td>
                    {hasDepartments && (
                      <td>
                        <DepartmentCell
                          department={departmentById.get(user.department_id)}
                          streamById={streamById}
                        />
                      </td>
                    )}
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
                        hod ? (
                          <span className="muted small">admin only</span>
                        ) : (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => handleRestore(user)}
                          >
                            <Icon icon={RotateCcw} size={14} /> Restore
                          </button>
                        )
                      ) : (
                        <>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => startEditing(user)}
                          >
                            <Icon icon={Pencil} size={14} /> Edit
                          </button>
                          {user.id === currentUser?.id ? (
                            <span className="muted small">that&rsquo;s you</span>
                          ) : (
                            // FR-51: deactivating and removing stay with an admin,
                            // so an HOD is not offered a button RLS would refuse.
                            !hod && (
                              <>
                                <button
                                  type="button"
                                  className="secondary"
                                  onClick={() => handleToggleStatus(user)}
                                >
                                  <Icon icon={user.status === 'active' ? Ban : CheckCircle} size={14} />
                                  {user.status === 'active' ? 'Deactivate' : 'Reactivate'}
                                </button>
                                <button
                                  type="button"
                                  className="secondary danger"
                                  onClick={() => handleRemove(user)}
                                >
                                  <Icon icon={Trash2} size={14} /> Remove
                                </button>
                              </>
                            )
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

            <label htmlFor="edit-sap-id">SAP ID (optional)</label>
            <input
              id="edit-sap-id"
              type="text"
              autoCapitalize="characters"
              spellCheck="false"
              aria-describedby="edit-sap-id-hint"
              value={editing.sap_id ?? ''}
              onChange={(event) =>
                setEditing((current) => ({ ...current, sap_id: event.target.value }))
              }
            />
            <p className="field-hint" id="edit-sap-id-hint">
              Signs in with this or with {editing.email}. Clear the field to remove
              it. {SAP_ID_HINT}.
            </p>

            <label htmlFor="edit-role">Role</label>
            <select
              id="edit-role"
              value={editing.role}
              onChange={(event) =>
                setEditing((current) => ({ ...current, role: event.target.value }))
              }
            >
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>

            {hasDepartments && !hod && (
              <>
                <label htmlFor="edit-stream">
                  Stream{departmentRequiredFor(editing.role) ? '' : ' (optional)'}
                </label>
                <select
                  id="edit-stream"
                  required={departmentRequiredFor(editing.role)}
                  value={editing.stream_id ?? ''}
                  onChange={(event) =>
                    setEditing((current) => ({
                      ...current,
                      stream_id: event.target.value,
                      department_id: '',
                    }))
                  }
                >
                  <option value="">No stream</option>
                  {tree.streams.map((stream) => (
                    <option key={stream.id} value={stream.id}>
                      {stream.name}
                      {stream.is_active ? '' : ' (archived)'}
                    </option>
                  ))}
                </select>

                <label htmlFor="edit-department">
                  Department{departmentRequiredFor(editing.role) ? '' : ' (optional)'}
                </label>
                <select
                  id="edit-department"
                  required={departmentRequiredFor(editing.role)}
                  disabled={!editing.stream_id}
                  aria-describedby="edit-department-hint"
                  value={editing.department_id ?? ''}
                  onChange={(event) =>
                    setEditing((current) => ({
                      ...current,
                      department_id: event.target.value,
                    }))
                  }
                >
                  <option value="">
                    {editing.stream_id ? 'Not assigned' : 'Choose a stream first'}
                  </option>
                  {tree.departments
                    .filter(
                      (row) =>
                        row.stream_id === editing.stream_id &&
                        // Archiving takes a department out of the pickers
                        // (FR-48), so it is not offered as a target. The
                        // account's CURRENT department stays listed, archived
                        // or not: dropping it would silently reassign someone
                        // already filed there on the next rename.
                        (departmentIsAssignable(row, tree.streams) ||
                          row.id === editing.department_id),
                    )
                    .map((department) => (
                      <option key={department.id} value={department.id}>
                        {describeDepartment(department)}
                        {department.is_active ? '' : ' (archived)'}
                      </option>
                    ))}
                </select>
                <p className="field-hint" id="edit-department-hint">
                  {departmentRequiredFor(editing.role)
                    ? 'Required for this role.'
                    : 'Optional for this role.'}{' '}
                  Changing it does not move feedback this person has already
                  submitted — a response keeps the department it was given under.
                </p>
              </>
            )}

            {hod && (
              <p className="field-notice">
                This account stays in{' '}
                <strong>{describeDepartment(ownDepartment) || 'your department'}</strong>.
                Only an administrator can move it, and only an administrator can
                appoint another head of department.
              </p>
            )}

            <div className="button-row">
              <button type="submit"><Icon icon={Check} size={16} /> Save changes</button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>
                <Icon icon={X} size={16} /> Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}

function DepartmentCell({ department, streamById }) {
  if (!department) return <span className="muted">-</span>

  const stream = streamById.get(department.stream_id)
  return (
    <>
      {describeDepartment(department)}
      {!department.is_active && <span className="muted-pill">archived</span>}
      {stream && <span className="muted small account-note">{stream.name}</span>}
    </>
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
