/**
 * Admin-only user provisioning (FR-19 to FR-24).
 *
 * WHY THIS RUNS SERVER-SIDE
 * Creating an auth account requires the Supabase `service_role` key, which
 * bypasses every RLS policy. It must never reach the browser. Here it comes from
 * the Edge runtime's own environment — Supabase injects SUPABASE_SERVICE_ROLE_KEY
 * automatically, so unlike the old Vercel function there is no key to copy into a
 * third-party host's dashboard.
 *
 * The client sends its own access token; we verify that token belongs to an
 * ACTIVE ADMIN before doing anything privileged. `verify_jwt` is enabled too, so
 * an unauthenticated request is rejected by the platform before this code runs.
 *
 * Deploy:  supabase functions deploy invite-users
 * Logs:    supabase functions logs invite-users
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'

const VALID_ROLES = new Set([
  'admin',
  'academic_peer',
  'student',
  'employer',
  'alumni',
  'faculty',
])

/** Kept small so a batch finishes well inside the function's time limit. */
const MAX_BATCH = 25

/**
 * Browser calls arrive cross-origin (Cloudflare Pages -> *.supabase.co), so
 * preflight must be answered.
 *
 * `*` is safe for this endpoint: authorisation is a Bearer token the caller has
 * to attach deliberately, not a cookie the browser would send on its own. Set
 * ALLOWED_ORIGIN to lock it to your site anyway.
 */
const allowedOrigin = Deno.env.get('ALLOWED_ORIGIN') ?? '*'

const corsHeaders = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!url || !serviceKey) {
    return json(
      {
        error:
          'Function environment is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. ' +
          'These are normally injected automatically by Supabase.',
      },
      500,
    )
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Missing bearer token.' }, 401)

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ---- authorise the caller ----
  const caller = await requireActiveAdmin(admin, token)
  if (!caller.ok) return json({ error: caller.error }, caller.status)

  // ---- validate the batch ----
  let payload: { users?: unknown; redirectTo?: unknown }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'Request body must be JSON.' }, 400)
  }

  const users = Array.isArray(payload.users) ? payload.users : null
  if (!users || users.length === 0) {
    return json({ error: 'Provide a non-empty `users` array.' }, 400)
  }
  if (users.length > MAX_BATCH) {
    return json(
      { error: `Send at most ${MAX_BATCH} users per request; the client paces batches.` },
      400,
    )
  }

  const redirectTo = safeRedirectTo(payload.redirectTo, req.headers.get('Origin'))

  // Sequential rather than parallel: the email provider is the bottleneck and
  // rate-limits, so firing 25 at once buys nothing and risks throttling.
  const results = []
  for (const entry of users) {
    results.push(await inviteOne(admin, entry, redirectTo))
  }

  return json({
    invited: results.filter((r) => r.status === 'invited').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  })
})

/** The caller must be a signed-in, ACTIVE admin — not merely authenticated. */
async function requireActiveAdmin(admin: any, token: string) {
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { ok: false as const, status: 401, error: 'Invalid or expired session.' }
  }

  const { data: profile, error: pError } = await admin
    .from('profiles')
    .select('role, status')
    .eq('id', data.user.id)
    .maybeSingle()

  if (pError) return { ok: false as const, status: 500, error: pError.message }
  if (!profile || profile.role !== 'admin' || profile.status !== 'active') {
    return { ok: false as const, status: 403, error: 'Admin access required.' }
  }
  return { ok: true as const, userId: data.user.id }
}

async function inviteOne(admin: any, entry: any, redirectTo?: string) {
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
    const rateLimited = /rate limit|too many requests/i.test(error.message)
    return {
      email,
      status: already ? 'skipped' : 'failed',
      reason: already
        ? 'Already registered.'
        : rateLimited
          ? 'Email rate limit reached. Connect custom SMTP (see README).'
          : error.message,
    }
  }

  return { email, status: 'invited', userId: data?.user?.id ?? null }
}

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)

/**
 * Only ever redirect back to our own site. An attacker-supplied redirectTo would
 * otherwise turn an invitation email into an open redirect.
 *
 * PUBLIC_SITE_URL is what makes this reliable in production: the request Origin
 * is the caller's, so it cannot be trusted as the allow-list on its own.
 */
function safeRedirectTo(requested: unknown, origin: string | null) {
  const base = Deno.env.get('PUBLIC_SITE_URL') ?? origin
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
