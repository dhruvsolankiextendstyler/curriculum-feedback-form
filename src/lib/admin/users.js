import { supabase } from '../supabase'
import { chunk } from './csv'

/**
 * Admin user management (FR-19 to FR-24).
 *
 * Reads and profile edits go straight to Postgres under the admin's own RLS
 * policies. Anything that creates an auth account is delegated to the
 * invite-users Edge Function, because that needs the service_role key.
 */

export async function loadUsers({ role = null, status = null, search = '' } = {}) {
  let query = supabase
    .from('profiles')
    .select('id, email, full_name, role, status, invite_status, created_at')
    .order('created_at', { ascending: false })

  if (role) query = query.eq('role', role)
  if (status) query = query.eq('status', status)
  if (search.trim()) {
    const term = `%${search.trim()}%`
    query = query.or(`email.ilike.${term},full_name.ilike.${term}`)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function loadAllEmails() {
  const { data, error } = await supabase.from('profiles').select('email')
  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => r.email.toLowerCase())
}

/** FR-20: edit name or role. Email is immutable — it identifies the auth user. */
export async function updateUser(userId, { full_name, role }) {
  const patch = {}
  if (full_name !== undefined) patch.full_name = full_name.trim() || null
  if (role !== undefined) patch.role = role

  if (Object.keys(patch).length === 0) return

  const { error } = await supabase.from('profiles').update(patch).eq('id', userId)
  if (error) throw new Error(translateUserError(error))
}

/**
 * FR-21: deactivate rather than delete.
 *
 * A hard delete would cascade to the user's responses and silently remove their
 * feedback from every past cycle's analytics. Deactivating blocks sign-in (the
 * route guard rejects a non-active profile) and keeps the history intact.
 */
export async function setUserStatus(userId, status) {
  const { error } = await supabase.from('profiles').update({ status }).eq('id', userId)
  if (error) throw new Error(translateUserError(error))
}

/**
 * Sends invites in paced batches (FR-23, FR-24).
 *
 * @param {object[]} users [{ email, full_name, role }]
 * @param {(progress: {done: number, total: number}) => void} onProgress
 * @returns {Promise<{invited: number, skipped: number, failed: number, results: object[]}>}
 */
export async function inviteUsers(users, onProgress = () => {}) {
  const { data: sessionData } = await supabase.auth.getSession()
  if (!sessionData?.session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.')
  }

  const batches = chunk(users, 25)
  const totals = { invited: 0, skipped: 0, failed: 0, results: [] }
  let done = 0

  for (const batch of batches) {
    // functions.invoke attaches the caller's access token and handles CORS, so
    // the Edge Function can verify who is asking. It resolves with { data, error }
    // instead of throwing on a non-2xx.
    const { data: body, error } = await supabase.functions.invoke('invite-users', {
      body: { users: batch, redirectTo: `${window.location.origin}/set-password` },
    })

    if (error) throw new Error(await describeInvokeError(error))

    totals.invited += body?.invited ?? 0
    totals.skipped += body?.skipped ?? 0
    totals.failed += body?.failed ?? 0
    totals.results.push(...(body?.results ?? []))

    done += batch.length
    onProgress({ done, total: users.length })
  }

  return totals
}

/**
 * Extracts something actionable from a functions.invoke failure.
 *
 * On a non-2xx, supabase-js raises FunctionsHttpError whose own `message` is only
 * "Edge Function returned a non-2xx status code" — the real reason is in the
 * attached response body, which has to be read to be seen.
 */
async function describeInvokeError(error) {
  try {
    const body = await error.context?.json?.()
    if (body?.error) return body.error
  } catch {
    // Body was not JSON (a platform-level error page, say); fall through.
  }

  const status = error.context?.status

  // 404 means the function was never deployed — the most likely state for a
  // teammate who has just cloned the repo.
  if (status === 404) {
    return (
      'The invite-users function is not deployed to this Supabase project. ' +
      'Run: supabase functions deploy invite-users'
    )
  }
  if (status === 401) {
    return 'Your session has expired. Please sign in again.'
  }
  if (status === 403) {
    return 'Admin access required to invite users.'
  }

  return error.message ?? 'The invite request failed.'
}

function translateUserError(error) {
  const message = error.message ?? 'Could not update this user.'
  if (/row-level security/i.test(message) || error.code === '42501') {
    return 'You do not have permission for that change.'
  }
  if (error.code === '23505') {
    return 'That email address is already registered.'
  }
  return message
}
