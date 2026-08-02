import { supabase } from '../supabase'
import { chunk } from './csv'

/**
 * Admin user management (FR-19 to FR-24).
 *
 * Reads and profile edits go straight to Postgres under the admin's own RLS
 * policies. Anything that creates an auth account is delegated to
 * /api/admin/invite-users, because that needs the service_role key.
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
  const token = sessionData?.session?.access_token
  if (!token) throw new Error('Your session has expired. Please sign in again.')

  const batches = chunk(users, 25)
  const totals = { invited: 0, skipped: 0, failed: 0, results: [] }
  let done = 0

  for (const batch of batches) {
    const response = await fetch('/api/admin/invite-users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ users: batch }),
    })

    if (!response.ok) {
      let message = `Invite request failed (${response.status}).`
      try {
        const body = await response.json()
        if (body?.error) message = body.error
      } catch {
        // A 404 here almost always means the API route is not running: `vite dev`
        // serves the SPA only. Say so rather than reporting a bare status code.
        if (response.status === 404) {
          message =
            'The invite endpoint was not found. Run the app with `vercel dev` ' +
            'so the /api routes are served (see README).'
        }
      }
      throw new Error(message)
    }

    const body = await response.json()
    totals.invited += body.invited ?? 0
    totals.skipped += body.skipped ?? 0
    totals.failed += body.failed ?? 0
    totals.results.push(...(body.results ?? []))

    done += batch.length
    onProgress({ done, total: users.length })
  }

  return totals
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
