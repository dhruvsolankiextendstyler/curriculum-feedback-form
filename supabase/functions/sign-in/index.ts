/**
 * Sign in with a SAP ID, and reset a password from one (FR-1, FR-4).
 *
 * WHY THIS RUNS SERVER-SIDE
 * Supabase Auth is keyed by email address; it has never heard of a SAP ID. So
 * signing in with one means a lookup (SAP ID -> email) followed by an ordinary
 * password grant. The lookup is the part that cannot happen in the browser: an
 * anon-callable "which address owns SAP ID x?" endpoint would let anyone holding
 * the public anon key walk a range of IDs and harvest the email address of every
 * student in the college (NFR-4). Here it runs under service_role, and the
 * response carries a session or an uninformative failure — never the address.
 *
 * EMAIL SIGN-IN DOES NOT COME THROUGH HERE. The browser talks straight to
 * Supabase Auth for that, so this function being undeployed or broken cannot
 * lock out the administrators who would have to fix it.
 *
 * NO JWT: the caller is by definition not signed in yet.
 *   Deploy:  supabase functions deploy sign-in --no-verify-jwt
 *   Logs:    Supabase dashboard -> Edge Functions -> sign-in -> Logs
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  isEmail,
  isMissingSapIdColumn,
  normaliseSapId,
  SAP_ID_PATTERN,
} from '../_shared/sapId.ts'

/** See invite-users for why `*` is acceptable here; set ALLOWED_ORIGIN to narrow it. */
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

/**
 * One wording for every rejection, matching what Supabase Auth returns for a
 * wrong password. A caller must not be able to tell "no such SAP ID" from
 * "wrong password" — the first would answer a question about who exists.
 */
const GENERIC_FAILURE = 'Invalid login credentials'

/**
 * Best-effort brute-force brake.
 *
 * A password grant sent from the browser is rate-limited by Supabase Auth per
 * client IP. Routing this one through a function means Auth sees Supabase's own
 * infrastructure instead, so that limit stops applying to the SAP-ID path. The
 * real client IP is forwarded on (see `signIn` below), but whether the platform
 * proxy honours an inbound X-Forwarded-For is not something this code can
 * guarantee — so there is a local brake as well.
 *
 * It lives in the isolate's memory, which makes it a speed bump and not a
 * guarantee. The cap is deliberately generous because a college reaches this
 * endpoint from one NAT address: a tight per-IP limit would lock out a whole
 * computer lab of legitimate users. Only FAILURES count, and a success clears
 * the record.
 */
const FAIL_WINDOW_MS = 5 * 60 * 1000
const MAX_FAILS_PER_WINDOW = 60
const MAX_TRACKED_IPS = 5000
const failures = new Map<string, { count: number; resetAt: number }>()

function tooManyFailures(ip: string) {
  const record = failures.get(ip)
  return Boolean(
    record && record.resetAt > Date.now() && record.count >= MAX_FAILS_PER_WINDOW,
  )
}

function recordFailure(ip: string) {
  const now = Date.now()

  // Bound the memory a long-lived isolate can accumulate. If pruning expired
  // entries is not enough, drop the lot: failing open is the right direction for
  // a brake whose absence only removes a speed bump.
  if (failures.size > MAX_TRACKED_IPS) {
    for (const [key, record] of failures) {
      if (record.resetAt <= now) failures.delete(key)
    }
    if (failures.size > MAX_TRACKED_IPS) failures.clear()
  }

  const record = failures.get(ip)
  if (record && record.resetAt > now) record.count += 1
  else failures.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')

  if (!url || !serviceKey || !anonKey) {
    return json(
      {
        error:
          'Function environment is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ' +
          'SUPABASE_ANON_KEY. These are normally injected automatically by Supabase.',
      },
      500,
    )
  }

  let payload: { identifier?: unknown; password?: unknown; action?: unknown }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'Request body must be JSON.' }, 400)
  }

  const identifier = String(payload.identifier ?? '').trim()
  const password = typeof payload.password === 'string' ? payload.password : ''
  const action = payload.action === 'reset' ? 'reset' : 'password'

  if (!identifier) return json({ error: 'Enter your email address or SAP ID.' }, 400)
  if (action === 'password' && !password) {
    return json({ error: 'Enter your password.' }, 400)
  }

  const clientIp = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
    'unknown'

  if (action === 'password' && tooManyFailures(clientIp)) {
    return json(
      {
        error:
          'Too many failed sign-in attempts from this network. Please wait a few minutes.',
      },
      429,
    )
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const resolved = await resolveEmail(admin, identifier)
  if (resolved.error) return json({ error: resolved.error }, resolved.status)

  return action === 'reset'
    ? await requestReset(admin, resolved.email, req)
    : await signIn({ url, anonKey, email: resolved.email, password, clientIp })
})

type Resolved =
  | { email: string | null; error?: undefined; status?: undefined }
  | { email?: undefined; error: string; status: number }

/**
 * Turns whatever was typed into the login field into the address Auth knows.
 *
 * A `null` email means "no account matches" — reported to the caller as an
 * ordinary credential failure, never as "that SAP ID does not exist".
 */
async function resolveEmail(admin: any, identifier: string): Promise<Resolved> {
  // The '@' is the whole basis for telling the two identifier kinds apart, which
  // is why a SAP ID may not contain one (profiles_sap_id_format, 0007).
  if (identifier.includes('@')) {
    return { email: isEmail(identifier) ? identifier.toLowerCase() : null }
  }

  const sapId = normaliseSapId(identifier)
  if (!SAP_ID_PATTERN.test(sapId)) return { email: null }

  const { data, error } = await admin
    .from('profiles')
    .select('email')
    .eq('sap_id', sapId)
    .maybeSingle()

  if (error) {
    // A missing column is a deployment problem, not a bad password, and saying so
    // is not a disclosure: it is true regardless of which SAP ID was sent.
    if (isMissingSapIdColumn(error.message)) {
      return {
        error:
          'SAP ID sign-in is not enabled on this project yet. Apply ' +
          'supabase/migrations/0007_sap_id.sql, then try again.',
        status: 503,
      }
    }
    console.error('sap_id lookup failed:', error.message)
    return { error: 'Could not check that SAP ID. Please try again.', status: 500 }
  }

  // Status is deliberately not consulted. A deactivated or removed account
  // signs in and is then stopped by the route guard, which can explain why —
  // exactly as it already does for email sign-in.
  return { email: data?.email ?? null }
}

/**
 * The password grant itself, run with the ANON key rather than service_role, so
 * Supabase Auth treats it as the ordinary sign-in it is.
 *
 * When nothing matched the identifier we still make the round trip, against an
 * address that cannot exist (`.invalid` is reserved by RFC 2606). Short-circuiting
 * instead would answer "is this SAP ID real?" through response timing.
 */
async function signIn(
  { url, anonKey, email, password, clientIp }: {
    url: string
    anonKey: string
    email: string | null | undefined
    password: string
    clientIp: string
  },
) {
  const auth = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    // Best effort: give Auth the real client to rate-limit rather than this
    // function's host. See the note on the local brake above.
    global: { headers: { 'X-Forwarded-For': clientIp } },
  })

  const { data, error } = await auth.auth.signInWithPassword({
    email: email ?? `sap-${crypto.randomUUID()}@invalid.invalid`,
    password,
  })

  if (error || !data?.session) {
    recordFailure(clientIp)
    return json({ error: GENERIC_FAILURE }, 400)
  }

  failures.delete(clientIp)

  // The same access/refresh pair the browser would have received directly; the
  // client hands it to supabase.auth.setSession().
  return json({ session: data.session })
}

/**
 * FR-4 for someone who knows their SAP ID but not the address it belongs to.
 *
 * The link goes to the account's own inbox, so this reveals nothing to whoever
 * asked for it — as long as the answer is identical either way. It is: an
 * unmatched identifier, and a send that Auth refuses (its email rate limit is a
 * handful per hour on the free tier), both return the same `ok`. Real failures go
 * to this function's log, which an administrator can read in the dashboard.
 */
async function requestReset(admin: any, email: string | null | undefined, req: Request) {
  if (email) {
    const { error } = await admin.auth.resetPasswordForEmail(email, {
      redirectTo: resetRedirect(req),
    })
    if (error) console.error('password reset send failed:', error.message)
  }

  return json({ ok: true })
}

/**
 * Where the reset link lands. Never taken from the request body: a caller-chosen
 * redirect would aim a password-reset link at whatever site it liked. The Origin
 * header is a last resort, and Supabase Auth independently rejects any target
 * outside the project's Redirect URL allow-list, so an unlisted origin is ignored
 * rather than honoured.
 */
function resetRedirect(req: Request) {
  const configured = Deno.env.get('SITE_URL') ??
    (allowedOrigin !== '*' ? allowedOrigin : null)
  const base = (configured ?? req.headers.get('Origin') ?? '').replace(/\/+$/, '')
  return base ? `${base}/set-password` : undefined
}
