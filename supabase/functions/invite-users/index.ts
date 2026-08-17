/**
 * Admin-only direct user provisioning (FR-19 to FR-23).
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
 * This keeps the existing function slug for deployment compatibility, but it
 * does not send invitations. Accounts are created with a temporary password
 * and a confirmed email address, so Supabase sends no onboarding email. A
 * never-used invitation created by the previous function can be converted to
 * the same direct-account state when an admin retries that address.
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
  let payload: { users?: unknown }
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

  // Sequential creation keeps load predictable and makes each result easy to
  // report back to a large CSV import.
  const results = []
  for (const entry of users) {
    results.push(await createOne(admin, entry))
  }

  return json({
    created: results.filter((r) => r.status === 'created').length,
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

  let { data: profile, error: pError } = await admin
    .from('profiles')
    .select('role, status, removed_at, must_change_password')
    .eq('id', data.user.id)
    .maybeSingle()

  // Keep direct creation usable during the short window before migration 0006
  // reaches the project. The migration-aware query is preferred; the legacy
  // query is only a compatibility path for the old profiles shape.
  if (pError && isMissingDirectUserColumn(pError.message)) {
    const legacy = await admin
      .from('profiles')
      .select('role, status')
      .eq('id', data.user.id)
      .maybeSingle()
    profile = legacy.data
      ? { ...legacy.data, removed_at: null, must_change_password: false }
      : null
    pError = legacy.error
  }

  if (pError) return { ok: false as const, status: 500, error: pError.message }
  if (
    !profile ||
    profile.role !== 'admin' ||
    profile.status !== 'active' ||
    profile.removed_at ||
    profile.must_change_password
  ) {
    return { ok: false as const, status: 403, error: 'Admin access required.' }
  }
  return { ok: true as const, userId: data.user.id }
}

async function createOne(admin: any, entry: any) {
  const email = String(entry?.email ?? '').trim().toLowerCase()
  const fullName = String(entry?.full_name ?? '').trim()
  const role = String(entry?.role ?? '').trim()
  const suppliedPassword =
    typeof entry?.temporary_password === 'string' ? entry.temporary_password : ''

  if (!isEmail(email)) {
    return { email, status: 'failed', reason: 'Not a valid email address.' }
  }
  if (!VALID_ROLES.has(role)) {
    return { email, status: 'failed', reason: `Unknown role "${role}".` }
  }
  if (suppliedPassword && (suppliedPassword.length < 8 || suppliedPassword.length > 72)) {
    return {
      email,
      status: 'failed',
      reason: 'Temporary password must be between 8 and 72 characters.',
    }
  }

  const temporaryPassword = suppliedPassword || generateTemporaryPassword()

  // The auth sync trigger reads this metadata to create the profile row.
  // Without a valid role here it deliberately creates none, which is why the
  // role is validated above rather than defaulted.
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: { role, full_name: fullName },
  })

  if (error) {
    const already = /already been registered|already exists|duplicate/i.test(error.message)
    if (already) {
      const recovered = await recoverLegacyInvite(admin, {
        email,
        fullName,
        role,
        temporaryPassword,
      })
      if (recovered) return recovered
    }

    return {
      email,
      status: already ? 'skipped' : 'failed',
      reason: already ? 'Already registered.' : error.message,
    }
  }

  return {
    email,
    status: 'created',
    userId: data?.user?.id ?? null,
    temporary_password: temporaryPassword,
  }
}

/**
 * The old deployment could create an Auth invitation while the new frontend
 * reported failure. Convert only invitations that have never signed in; an
 * existing account must never have its password reset by the add-user form.
 */
async function recoverLegacyInvite(
  admin: any,
  account: {
    email: string
    fullName: string
    role: string
    temporaryPassword: string
  },
) {
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', account.email)
    .maybeSingle()

  if (profileError || !profile) return null

  const { data: authData, error: authError } = await admin.auth.admin.getUserById(
    profile.id,
  )
  const existingUser = authData?.user
  if (
    authError ||
    !existingUser?.invited_at ||
    existingUser.last_sign_in_at
  ) {
    return null
  }

  const { error: updateAuthError } = await admin.auth.admin.updateUserById(profile.id, {
    password: account.temporaryPassword,
    email_confirm: true,
    user_metadata: {
      ...(existingUser.user_metadata ?? {}),
      role: account.role,
      full_name: account.fullName,
    },
  })
  if (updateAuthError) {
    return {
      email: account.email,
      status: 'failed',
      reason: updateAuthError.message,
    }
  }

  // Setting the password fires the Auth password-change trigger, which clears
  // this flag. Set it afterwards so the recovered user still has to replace
  // the admin-issued temporary password on first sign-in.
  let { error: updateProfileError } = await admin
    .from('profiles')
    .update({
      full_name: account.fullName || null,
      role: account.role,
      status: 'active',
      must_change_password: true,
      removed_at: null,
      removed_by: null,
    })
    .eq('id', profile.id)

  if (updateProfileError && isMissingDirectUserColumn(updateProfileError.message)) {
    const legacyUpdate = await admin
      .from('profiles')
      .update({
        full_name: account.fullName || null,
        role: account.role,
        status: 'active',
        invite_status: 'accepted',
      })
      .eq('id', profile.id)
    updateProfileError = legacyUpdate.error
  }

  if (updateProfileError) {
    return {
      email: account.email,
      status: 'failed',
      reason: updateProfileError.message,
    }
  }

  return {
    email: account.email,
    status: 'created',
    userId: profile.id,
    temporary_password: account.temporaryPassword,
    recovered: true,
  }
}

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)

function isMissingDirectUserColumn(message = '') {
  return /(must_change_password|removed_at|removed_by)/i.test(message) &&
    /(does not exist|could not find|schema cache)/i.test(message)
}

function generateTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  let password = 'A1!a'
  for (const byte of bytes) {
    password += alphabet[byte % alphabet.length]
  }
  return password
}
