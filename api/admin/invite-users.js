/**
 * Admin-only user provisioning (FR-19 to FR-24).
 *
 * WHY THIS IS SERVER-SIDE
 * Creating an auth user requires the Supabase `service_role` key, which bypasses
 * every RLS policy. It must never reach the browser, so it lives only in this
 * function's environment. The client calls this endpoint with the caller's own
 * access token; we verify that token belongs to an active admin before doing
 * anything privileged.
 *
 * Runs on Vercel as a Node serverless function. Locally it needs `vercel dev`
 * rather than `vite dev` — see README.
 */
import { createClient } from '@supabase/supabase-js'

const VALID_ROLES = new Set([
  'admin',
  'academic_peer',
  'student',
  'employer',
  'alumni',
  'faculty',
])

/** Kept small so a batch finishes inside the function's execution limit. */
const MAX_BATCH = 25

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    return res.status(500).json({
      error:
        'Server is missing SUPABASE_SERVICE_ROLE_KEY (and/or the project URL). ' +
        'Set both in the Vercel project environment.',
    })
  }

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Missing bearer token.' })

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ---- authorise the caller ----
  const caller = await requireActiveAdmin(admin, token)
  if (!caller.ok) return res.status(caller.status).json({ error: caller.error })

  // ---- validate the batch ----
  const users = Array.isArray(req.body?.users) ? req.body.users : null
  if (!users || users.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty `users` array.' })
  }
  if (users.length > MAX_BATCH) {
    return res.status(400).json({
      error: `Send at most ${MAX_BATCH} users per request; the client paces batches.`,
    })
  }

  const redirectTo = safeRedirectTo(req.body?.redirectTo, req.headers.origin)
  const results = []

  for (const entry of users) {
    results.push(await inviteOne(admin, entry, redirectTo))
  }

  return res.status(200).json({
    invited: results.filter((r) => r.status === 'invited').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  })
}

/** The caller must be a signed-in, active admin — not merely authenticated. */
async function requireActiveAdmin(admin, token) {
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { ok: false, status: 401, error: 'Invalid or expired session.' }
  }

  const { data: profile, error: pError } = await admin
    .from('profiles')
    .select('role, status')
    .eq('id', data.user.id)
    .maybeSingle()

  if (pError) return { ok: false, status: 500, error: pError.message }
  if (!profile || profile.role !== 'admin' || profile.status !== 'active') {
    return { ok: false, status: 403, error: 'Admin access required.' }
  }
  return { ok: true, userId: data.user.id }
}

async function inviteOne(admin, entry, redirectTo) {
  const email = String(entry?.email ?? '').trim().toLowerCase()
  const fullName = String(entry?.full_name ?? '').trim()
  const role = String(entry?.role ?? '').trim()

  if (!isEmail(email)) {
    return { email, status: 'failed', reason: 'Not a valid email address.' }
  }
  if (!VALID_ROLES.has(role)) {
    return { email, status: 'failed', reason: `Unknown role "${role}".` }
  }

  // The 0004_auth_sync trigger reads this metadata to create the profile row.
  // Without a valid role here it deliberately creates none, which is why the
  // role is validated above rather than defaulted.
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { role, full_name: fullName },
    redirectTo,
  })

  if (error) {
    const already = /already been registered|already exists|duplicate/i.test(error.message)
    return {
      email,
      status: already ? 'skipped' : 'failed',
      reason: already ? 'Already registered.' : error.message,
    }
  }

  return { email, status: 'invited', userId: data?.user?.id ?? null }
}

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)

/**
 * Only ever redirect back to our own origin. An attacker-supplied redirectTo
 * would otherwise turn an invite email into an open redirect.
 */
function safeRedirectTo(requested, origin) {
  const base = process.env.PUBLIC_SITE_URL || origin
  if (!base) return undefined

  const fallback = `${base.replace(/\/$/, '')}/set-password`
  if (typeof requested !== 'string' || requested === '') return fallback

  try {
    const target = new URL(requested, base)
    const allowed = new URL(base)
    if (target.origin !== allowed.origin) return fallback
    return target.toString()
  } catch {
    return fallback
  }
}
