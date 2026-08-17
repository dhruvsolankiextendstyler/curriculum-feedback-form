import { supabase } from '../supabase'
import { chunk } from './csv'
import { sortUserRows } from './userSort'

export { sortUserRows } from './userSort'

/**
 * Admin user management (FR-19 to FR-23).
 *
 * Profile reads and edits use the signed-in admin's RLS policies. Creating an
 * Auth account stays in the Edge Function because it requires service_role.
 */

export async function loadUsers({
  role = null,
  status = null,
  search = '',
  view = 'current',
  sort = 'recent',
} = {}) {
  let query = supabase
    .from('profiles')
    .select(
      'id, email, full_name, role, status, must_change_password, removed_at, removed_by, created_at',
    )

  query =
    view === 'removed'
      ? query.not('removed_at', 'is', null)
      : query.is('removed_at', null)

  if (role) query = query.eq('role', role)
  if (status) query = query.eq('status', status)
  if (search.trim()) {
    const term = `%${search.trim()}%`
    query = query.or(`email.ilike.${term},full_name.ilike.${term}`)
  }

  const { data, error } = await query
  if (!error) return sortUserRows(data ?? [], sort, view)

  // The frontend can be deployed before migration 0006 reaches Supabase. In
  // that window, show the existing profiles instead of turning a schema error
  // into an empty user list. Removed users cannot exist in the legacy schema,
  // so that view is correctly empty until the migration is applied.
  if (!isMissingDirectUserColumn(error.message)) throw new Error(error.message)
  if (view === 'removed') return []

  let legacy = supabase
    .from('profiles')
    .select('id, email, full_name, role, status, created_at')
  if (role) legacy = legacy.eq('role', role)
  if (status) legacy = legacy.eq('status', status)
  if (search.trim()) {
    const term = `%${search.trim()}%`
    legacy = legacy.or(`email.ilike.${term},full_name.ilike.${term}`)
  }

  const { data: legacyRows, error: legacyError } = await legacy
  if (legacyError) throw new Error(legacyError.message)
  return sortUserRows(
    (legacyRows ?? []).map((row) => ({
      ...row,
      must_change_password: false,
      removed_at: null,
      removed_by: null,
    })),
    sort,
    view,
  )
}

export async function loadAllEmails() {
  const { data, error } = await supabase.from('profiles').select('email')
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => row.email.toLowerCase())
}

/** FR-20: edit name or role. Email is immutable because it identifies Auth. */
export async function updateUser(userId, { full_name, role }) {
  const patch = {}
  if (full_name !== undefined) patch.full_name = full_name.trim() || null
  if (role !== undefined) patch.role = role

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

    if (error) throw new Error(await describeInvokeError(error))

    totals.created += body?.created ?? 0
    totals.skipped += body?.skipped ?? 0
    totals.failed += body?.failed ?? 0
    totals.results.push(...(body?.results ?? []))

    done += batch.length
    onProgress({ done, total: users.length })
  }

  return totals
}

async function describeInvokeError(error) {
  try {
    const body = await error.context?.json?.()
    if (body?.error) return body.error
  } catch {
    // A platform error page is not JSON; use the status-specific fallback.
  }

  const status = error.context?.status
  if (status === 404) {
    return (
      'The user provisioning function is not deployed to this Supabase project. ' +
      'Run: supabase functions deploy invite-users'
    )
  }
  if (status === 401) return 'Your session has expired. Please sign in again.'
  if (status === 403) return 'Admin access required to create users.'

  return error.message ?? 'The user creation request failed.'
}

function isMissingDirectUserColumn(message = '') {
  return (
    /(must_change_password|removed_at|removed_by)/i.test(message) &&
    /(does not exist|could not find|schema cache)/i.test(message)
  )
}

function translateUserError(error) {
  const message = error.message ?? 'Could not update this user.'
  if (isMissingDirectUserColumn(message)) {
    return 'The user-management database migration is not applied yet. Apply supabase/migrations/0006_direct_users.sql.'
  }
  if (/row-level security/i.test(message) || error.code === '42501') {
    return 'You do not have permission for that change.'
  }
  if (error.code === '23505') return 'That email address is already registered.'
  return message
}
