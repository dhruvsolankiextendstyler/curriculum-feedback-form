import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Catch the easy mistake: pasting the dashboard URL
 * (https://supabase.com/dashboard/project/<ref>) instead of the API URL
 * (https://<ref>.supabase.co).
 *
 * Without this the app looks configured, and the only symptom is an opaque
 * CORS failure at sign-in — supabase-js happily appends /auth/v1/token to
 * whatever base URL it is given.
 */
function describeUrlProblem(value) {
  if (!value) return 'VITE_SUPABASE_URL is missing.'

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return `VITE_SUPABASE_URL is not a valid URL: "${value}"`
  }

  if (parsed.hostname === 'supabase.com' || parsed.hostname === 'www.supabase.com') {
    const ref = parsed.pathname.match(/\/project\/([a-z0-9]+)/i)?.[1]
    return (
      'VITE_SUPABASE_URL points at the Supabase dashboard, not your project API. ' +
      (ref
        ? `Use https://${ref}.supabase.co instead.`
        : 'Use the "Project URL" from Project Settings → API (https://<ref>.supabase.co).')
    )
  }

  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return `VITE_SUPABASE_URL should have no path. Use just https://${parsed.hostname}`
  }

  return null
}

export const urlProblem = describeUrlProblem(url)

export const isSupabaseConfigured = Boolean(url && anonKey) && !urlProblem

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true, // FR-6: session survives a refresh
        autoRefreshToken: true,
        detectSessionInUrl: true, // password-reset links land back here
      },
    })
  : null
