import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { describeFunctionError } from '../lib/functionError'
import { classifyIdentifier } from '../lib/identifier'

const AuthContext = createContext(null)

/**
 * Columns the app needs from a profile, widest first.
 *
 * A deployment can reach the browser before its migration reaches Supabase. Each
 * fallback drops the columns the next-oldest schema lacks, so that window costs
 * the user a missing SAP ID rather than the profile-error screen and a session
 * they cannot use.
 */
const PROFILE_COLUMN_SETS = [
  'id, email, full_name, sap_id, role, status, must_change_password, removed_at',
  'id, email, full_name, role, status, must_change_password, removed_at',
  'id, email, full_name, role, status',
]

/** Safe readings of the flags an older schema has no column for. */
const PROFILE_DEFAULTS = {
  sap_id: null,
  must_change_password: false,
  removed_at: null,
}

/** Session and profile data used by routing and role-aware UI. */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState(null)

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session ?? null)
      setSessionLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null)
      setSessionLoading(false)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  const userId = session?.user?.id ?? null

  const refreshProfile = useCallback(async () => {
    if (!userId) {
      setProfile(null)
      setProfileError(null)
      setProfileLoading(false)
      return null
    }

    setProfileLoading(true)
    setProfileError(null)

    let lastError = null
    for (const columns of PROFILE_COLUMN_SETS) {
      const { data, error } = await supabase
        .from('profiles')
        .select(columns)
        .eq('id', userId)
        .maybeSingle()

      if (!error) {
        const row = data ? { ...PROFILE_DEFAULTS, ...data } : null
        setProfile(row)
        setProfileLoading(false)
        return row
      }

      lastError = error
      if (!isMissingProfileColumn(error.message)) break
    }

    setProfileError(lastError.message)
    setProfile(null)
    setProfileLoading(false)
    return null
  }, [userId])

  useEffect(() => {
    refreshProfile()
  }, [refreshProfile])

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      role: profile?.role ?? null,
      loading: sessionLoading || profileLoading,
      profileError,
      refreshProfile,
      signIn: signInWithIdentifier,
      signOut: () => supabase.auth.signOut(),
      resetPassword: requestPasswordReset,
    }),
    [session, profile, sessionLoading, profileLoading, profileError, refreshProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/**
 * FR-1: one field accepts either identifier.
 *
 * An email address is Supabase Auth's own currency, so that path talks straight
 * to Auth — which is what keeps sign-in working (for the administrators who
 * would have to fix it, among others) when the Edge Function is undeployed or
 * broken. A SAP ID means nothing to Auth, so it is exchanged for a session by
 * the `sign-in` function, where the SAP-ID-to-address mapping stays out of
 * reach of the browser. See supabase/functions/sign-in/.
 */
async function signInWithIdentifier(rawIdentifier, password) {
  const identifier = classifyIdentifier(rawIdentifier)

  if (identifier.kind === 'empty') {
    return authFailure('Enter your email address or SAP ID.')
  }
  if (identifier.kind === 'email') {
    return supabase.auth.signInWithPassword({ email: identifier.value, password })
  }
  if (!identifier.valid) {
    // Not an address and not a possible SAP ID: no request can succeed.
    return authFailure('Invalid login credentials')
  }

  const { data, error } = await supabase.functions.invoke('sign-in', {
    body: { identifier: identifier.value, password },
  })

  if (error) return authFailure(await describeSignInFailure(error))
  if (!data?.session) return authFailure('Invalid login credentials')

  // Hand Auth the tokens the function obtained, so the rest of the app sees an
  // ordinary session: persisted, auto-refreshed, and announced to listeners.
  return supabase.auth.setSession(data.session)
}

/**
 * FR-4. A SAP ID does not identify an inbox, so the address to send to is
 * resolved server-side and never comes back — the same reason sign-in works that
 * way. The reply is identical whether or not an account matched.
 */
async function requestPasswordReset(rawIdentifier) {
  const identifier = classifyIdentifier(rawIdentifier)

  if (identifier.kind === 'empty') {
    return { data: null, error: new Error('Enter your email address or SAP ID.') }
  }
  if (identifier.kind === 'email') {
    return supabase.auth.resetPasswordForEmail(identifier.value, {
      redirectTo: `${window.location.origin}/set-password`,
    })
  }

  const { error } = await supabase.functions.invoke('sign-in', {
    body: { action: 'reset', identifier: identifier.value },
  })

  if (error) return { data: null, error: new Error(await describeSignInFailure(error)) }
  return { data: null, error: null }
}

/** Shaped like a supabase-js auth result so callers need no special case. */
const authFailure = (message) => ({
  data: { user: null, session: null },
  error: new Error(message),
})

const describeSignInFailure = (error) =>
  describeFunctionError(error, {
    slug: 'sign-in',
    statusHints: {
      // The platform rejected the call before the function ran, which for an
      // endpoint whose callers are by definition not signed in means one thing.
      401: 'SAP ID sign-in is deployed with JWT verification still on. Redeploy it: ' +
        'supabase functions deploy sign-in --no-verify-jwt',
    },
    fallback: 'Could not sign in with that SAP ID. Please try again.',
  })

function isMissingProfileColumn(message = '') {
  return (
    /(sap_id|must_change_password|removed_at)/i.test(message) &&
    /(does not exist|could not find|schema cache)/i.test(message)
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
