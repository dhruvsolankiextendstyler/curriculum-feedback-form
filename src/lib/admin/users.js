import { supabase } from '../supabase'
import { describeFunctionError } from '../functionError'
import { SAP_ID_HINT, validateSapId } from '../identifier'
import { chunk } from './csv'
import { sortUserRows } from './userSort'

export { sortUserRows } from './userSort'

/**
 * Admin user management (FR-19 to FR-23).
 *
 * Profile reads and edits use the signed-in admin's RLS policies. Creating an
 * Auth account stays in the Edge Function because it requires service_role.
 */

/**
 * The columns the user list wants, widest first.
 *
 * The frontend can be deployed before a migration reaches Supabase. Each entry
 * drops what the next-oldest schema lacks, so that window shows the users it can
 * describe instead of turning a schema error into an empty list.
 */
const USER_COLUMN_SETS = [
  'id, email, full_name, sap_id, role, status, must_change_password, removed_at, removed_by, created_at',
  'id, email, full_name, role, status, must_change_password, removed_at, removed_by, created_at',
  'id, email, full_name, role, status, created_at',
]

const USER_ROW_DEFAULTS = {
  sap_id: null,
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
} = {}) {
  let lastError = null

  for (const columns of USER_COLUMN_SETS) {
    // Soft removal arrived with the columns that describe it, so on an older
    // schema that list is correctly empty rather than an error.
    if (!columns.includes('removed_at') && view === 'removed') return []

    const { data, error } = await buildUserQuery(columns, { role, status, search, view })

    if (!error) {
      const rows = (data ?? []).map((row) => ({ ...USER_ROW_DEFAULTS, ...row }))
      return sortUserRows(rows, sort, view)
    }

    lastError = error
    if (!isMissingProfileColumn(error.message)) break
  }

  throw new Error(lastError.message)
}

function buildUserQuery(columns, { role, status, search, view }) {
  let query = supabase.from('profiles').select(columns)

  if (columns.includes('removed_at')) {
    query =
      view === 'removed'
        ? query.not('removed_at', 'is', null)
        : query.is('removed_at', null)
  }

  if (role) query = query.eq('role', role)
  if (status) query = query.eq('status', status)

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
 * FR-20: edit name, role, or SAP ID. The email address stays immutable because
 * it is what identifies the account to Auth.
 */
export async function updateUser(userId, { full_name, role, sap_id }) {
  const patch = {}
  if (full_name !== undefined) patch.full_name = full_name.trim() || null
  if (role !== undefined) patch.role = role
  if (sap_id !== undefined) {
    const check = validateSapId(sap_id)
    if (!check.ok) throw new Error(check.reason)
    // null clears it: a SAP ID can be removed as well as changed.
    patch.sap_id = check.value
  }

  if (Object.keys(patch).length === 0) return

  const { error } = await supabase.from('profiles').update(patch).eq('id', userId)
  if (error) throw new Error(translateUserError(error))
}

/** Temporarily blocks a current account without filing it as removed. */
export async function setUserStatus(userId, status) {
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
    /(sap_id|must_change_password|removed_at|removed_by)/i.test(message) &&
    /(does not exist|could not find|schema cache)/i.test(message)
  )
}

function translateUserError(error) {
  const message = error.message ?? 'Could not update this user.'
  if (/sap_id/i.test(message) && isMissingProfileColumn(message)) {
    return 'SAP IDs need the database migration applied first: supabase/migrations/0007_sap_id.sql.'
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
  if (/row-level security/i.test(message) || error.code === '42501') {
    return 'You do not have permission for that change.'
  }
  if (error.code === '23505') return 'That email address is already registered.'
  return message
}
