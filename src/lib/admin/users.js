import { supabase } from '../supabase'
import { describeFunctionError } from '../functionError'
import { SAP_ID_HINT, validateSapId } from '../identifier'
import { isStaff, ROLE_LABELS } from '../constants'
import { chunk } from './csv'
import { departmentIsAssignable, departmentRequiredFor } from './departmentRules'
import { sortUserRows } from './userSort'

export { sortUserRows } from './userSort'

/**
 * Admin user management (FR-19 to FR-23).
 *
 * Profile reads and edits use the signed-in admin's RLS policies. Creating an
 * Auth account stays in the Edge Function because it requires service_role.
 */

/** The filter value meaning "has no department", distinct from "any". */
export const NO_DEPARTMENT = 'none'

/**
 * The columns the user list wants, widest first.
 *
 * The frontend can be deployed before a migration reaches Supabase. Each entry
 * drops what the next-oldest schema lacks, so that window shows the users it can
 * describe instead of turning a schema error into an empty list.
 *
 * department_id is an id only: the page already loads the department list for its
 * own pickers, so it names the department from that rather than paying for a
 * two-level PostgREST embed on every query.
 */
const USER_COLUMN_SETS = [
  'id, email, full_name, sap_id, role, department_id, status, must_change_password, removed_at, removed_by, created_at',
  'id, email, full_name, sap_id, role, status, must_change_password, removed_at, removed_by, created_at',
  'id, email, full_name, role, status, must_change_password, removed_at, removed_by, created_at',
  'id, email, full_name, role, status, created_at',
]

const USER_ROW_DEFAULTS = {
  sap_id: null,
  department_id: null,
  must_change_password: false,
  removed_at: null,
  removed_by: null,
}

export async function loadUsers({
  role = null,
  status = null,
  search = '',
  view = 'current',
  sort = 'recent',
  department = '',
  departmentIds = null,
} = {}) {
  // A stream filter resolves to the ids of the departments in it. An empty stream
  // matches nobody, which `in.()` cannot express — answer it here instead.
  if (Array.isArray(departmentIds) && departmentIds.length === 0 && !department) return []

  let lastError = null

  for (const columns of USER_COLUMN_SETS) {
    // Soft removal arrived with the columns that describe it, so on an older
    // schema that list is correctly empty rather than an error.
    if (!columns.includes('removed_at') && view === 'removed') return []
    // Same for the department filters: nothing to filter on yet.
    if (!columns.includes('department_id') && (department || departmentIds)) return []

    const { data, error } = await buildUserQuery(columns, {
      role,
      status,
      search,
      view,
      department,
      departmentIds,
    })

    if (!error) {
      const rows = (data ?? []).map((row) => ({ ...USER_ROW_DEFAULTS, ...row }))
      return sortUserRows(rows, sort, view)
    }

    lastError = error
    if (!isMissingProfileColumn(error.message)) break
  }

  throw new Error(lastError.message)
}

function buildUserQuery(
  columns,
  { role, status, search, view, department, departmentIds },
) {
  let query = supabase.from('profiles').select(columns)

  if (columns.includes('removed_at')) {
    query =
      view === 'removed'
        ? query.not('removed_at', 'is', null)
        : query.is('removed_at', null)
  }

  if (role) query = query.eq('role', role)
  if (status) query = query.eq('status', status)

  // A chosen department is narrower than the stream it belongs to, so it wins.
  if (columns.includes('department_id')) {
    if (department === NO_DEPARTMENT) query = query.is('department_id', null)
    else if (department) query = query.eq('department_id', department)
    else if (Array.isArray(departmentIds)) query = query.in('department_id', departmentIds)
  }

  const term = search.trim()
  if (term) {
    // FR-22, plus the SAP ID an admin is most likely to be handed on paper.
    const fields = ['email', 'full_name']
    if (columns.includes('sap_id')) fields.push('sap_id')
    query = query.or(fields.map((field) => `${field}.ilike.${likeValue(term)}`).join(','))
  }

  return query
}

/**
 * PostgREST splits an `or` list on commas and parentheses, so a search term
 * containing either has to be quoted or it corrupts the filter into a 400.
 * Inner quotes and backslashes are escaped for the same reason.
 */
const likeValue = (term) => `"%${term.replace(/[\\"]/g, (char) => `\\${char}`)}%"`

/** Both identifiers a CSV row could collide with, in one round trip. */
export async function loadExistingIdentifiers() {
  const { data, error } = await supabase.from('profiles').select('email, sap_id')

  if (error) {
    if (!isMissingProfileColumn(error.message)) throw new Error(error.message)
    const legacy = await supabase.from('profiles').select('email')
    if (legacy.error) throw new Error(legacy.error.message)
    return { emails: emailsOf(legacy.data), sapIds: [] }
  }

  return {
    emails: emailsOf(data),
    sapIds: (data ?? []).map((row) => row.sap_id).filter(Boolean),
  }
}

const emailsOf = (rows) => (rows ?? []).map((row) => row.email.toLowerCase())

/**
 * FR-20: edit name, role, SAP ID, or department. The email address stays
 * immutable because it is what identifies the account to Auth.
 *
 * The role travels alongside the department so the student-and-faculty
 * requirement (FR-46) can be re-checked here as well as in the form — the edit
 * panel changes both in one submit, so it always has both to give.
 *
 * `asHod` mirrors what the profile guard and RLS already refuse for a head of
 * department (0011_hod_scope.sql). The database is the boundary; this is what turns
 * its refusal into a sentence before the round trip.
 */
export async function updateUser(
  userId,
  { full_name, role, sap_id, department_id },
  { asHod = false, departments = null, streams = [], currentDepartmentId = undefined } = {},
) {
  if (asHod && role !== undefined && isStaff(role)) {
    throw new Error(
      'Only an administrator can appoint an administrator or a head of department.',
    )
  }
  if (asHod && department_id !== undefined) {
    throw new Error('A head of department cannot move an account to another department.')
  }

  const patch = {}
  if (full_name !== undefined) patch.full_name = full_name.trim() || null
  if (role !== undefined) patch.role = role
  if (sap_id !== undefined) {
    const check = validateSapId(sap_id)
    if (!check.ok) throw new Error(check.reason)
    // null clears it: a SAP ID can be removed as well as changed.
    patch.sap_id = check.value
  }
  if (department_id !== undefined) {
    const value = department_id || null
    if (!value && departmentRequiredFor(role)) {
      throw new Error(`${ROLE_LABELS[role] ?? 'This role'} must be assigned a department.`)
    }
    // FR-48: archiving takes a department out of the pickers, and the other two
    // write paths (the Edge Function and the CSV validator) already refuse it.
    // Only a *change* into an archived department is refused — a blanket
    // is_active test would block renaming someone already filed there, which
    // FR-48 requires to keep working. No trigger backs this, so it is enforced
    // wherever the list is available.
    if (value && departments && currentDepartmentId !== undefined) {
      const moving = value !== (currentDepartmentId || null)
      const target = departments.find((row) => row.id === value)
      if (moving && target && !departmentIsAssignable(target, streams)) {
        const parent = streams.find((row) => row.id === target.stream_id)
        throw new Error(
          parent?.is_active === false
            ? `The ${parent.name} stream is archived, so accounts cannot be moved into "${target.name}". Restore the stream on the Departments page, or choose another.`
            : `"${target.name}" is archived, so accounts cannot be moved into it. Restore it on the Departments page, or choose another.`,
        )
      }
    }
    patch.department_id = value
  }

  if (Object.keys(patch).length === 0) return

  // `.select()` for the same reason the three calls below have it: RLS does not
  // raise on an UPDATE it filters out, it matches no rows and returns success.
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', userId)
    .select('id')
    .maybeSingle()

  if (error) throw new Error(translateUserError(error))
  if (!data) {
    throw new Error(
      'Those changes were not saved. Your access may have changed — reload the page and try again.',
    )
  }
}

/** Temporarily blocks a current account without filing it as removed. */
export async function setUserStatus(userId, status, { asHod = false } = {}) {
  if (asHod) {
    throw new Error('Only an administrator can change account status.')
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({ status })
    .eq('id', userId)
    .is('removed_at', null)
    .select('id')
    .maybeSingle()

  if (error) throw new Error(translateUserError(error))
  if (!data) throw new Error('This user is no longer in the current user list.')
}

/** FR-21: soft remove. Responses and answers remain in the database. */
export async function removeUser(userId, actorId) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ removed_at: new Date().toISOString(), removed_by: actorId })
    .eq('id', userId)
    .is('removed_at', null)
    .select('id')
    .maybeSingle()

  if (error) throw new Error(translateUserError(error))
  if (!data) throw new Error('This user has already been removed.')
}

/** Restores a soft-removed account to the current list. */
export async function restoreUser(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ removed_at: null, removed_by: null })
    .eq('id', userId)
    .not('removed_at', 'is', null)
    .select('id')
    .maybeSingle()

  if (error) throw new Error(translateUserError(error))
  if (!data) throw new Error('This user is already in the current user list.')
}

/**
 * Creates confirmed Auth accounts in batches without sending invitation email.
 * Each result includes the one-time temporary password that the admin must pass
 * to the user securely.
 */
export async function createUsers(users, onProgress = () => {}) {
  const { data: sessionData } = await supabase.auth.getSession()
  if (!sessionData?.session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.')
  }

  const batches = chunk(users, 25)
  const totals = { created: 0, skipped: 0, failed: 0, results: [] }
  let done = 0

  for (const batch of batches) {
    const { data: body, error } = await supabase.functions.invoke('invite-users', {
      body: { users: batch },
    })

    if (error) {
      throw new Error(
        await describeFunctionError(error, {
          slug: 'invite-users',
          statusHints: {
            401: 'Your session has expired. Please sign in again.',
            403: 'Admin access required to create users.',
          },
          fallback: 'The user creation request failed.',
        }),
      )
    }

    totals.created += body?.created ?? 0
    totals.skipped += body?.skipped ?? 0
    totals.failed += body?.failed ?? 0
    totals.results.push(...(body?.results ?? []))

    done += batch.length
    onProgress({ done, total: users.length })
  }

  return totals
}

function isMissingProfileColumn(message = '') {
  return (
    /(sap_id|department_id|must_change_password|removed_at|removed_by)/i.test(message) &&
    /(does not exist|could not find|schema cache)/i.test(message)
  )
}

function translateUserError(error) {
  const message = error.message ?? 'Could not update this user.'
  if (/sap_id/i.test(message) && isMissingProfileColumn(message)) {
    return 'SAP IDs need the database migration applied first: supabase/migrations/0007_sap_id.sql.'
  }
  if (/department_id/i.test(message) && isMissingProfileColumn(message)) {
    return 'Departments need the database migration applied first: supabase/migrations/0008_departments.sql.'
  }
  if (isMissingProfileColumn(message)) {
    return 'The user-management database migration is not applied yet. Apply supabase/migrations/0006_direct_users.sql.'
  }
  if (/profiles_sap_id_unique/i.test(message)) {
    return 'That SAP ID is already assigned to another user.'
  }
  if (/profiles_sap_id_format/i.test(message)) {
    return `Invalid SAP ID. Use ${SAP_ID_HINT}.`
  }
  // The department was archived and deleted in another tab between the picker
  // loading and this save.
  if (/profiles_department_id_fkey/i.test(message) || error.code === '23503') {
    return 'That department no longer exists. Reload the page and pick again.'
  }
  if (/Only an administrator can change a department/i.test(message)) {
    return 'Only an administrator can change a department.'
  }
  if (/row-level security/i.test(message) || error.code === '42501') {
    return 'You do not have permission for that change.'
  }
  if (error.code === '23505') return 'That email address is already registered.'
  return message
}
