import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

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
    let { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, status, must_change_password, removed_at')
      .eq('id', userId)
      .maybeSingle()

    // Keep existing sessions usable while a deployment is rolling out the
    // direct-user migration. The legacy schema has no password/removal flags;
    // treating those fields as their safe defaults lets the user reach the app
    // (and avoids trapping them on the profile-error screen).
    if (error && isMissingDirectUserColumn(error.message)) {
      const legacy = await supabase
        .from('profiles')
        .select('id, email, full_name, role, status')
        .eq('id', userId)
        .maybeSingle()

      data = legacy.data
      error = legacy.error
      if (!error && data) {
        data = { ...data, must_change_password: false, removed_at: null }
      }
    }

    if (error) setProfileError(error.message)
    setProfile(data ?? null)
    setProfileLoading(false)
    return data ?? null
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
      signIn: (email, password) =>
        supabase.auth.signInWithPassword({ email, password }),
      signOut: () => supabase.auth.signOut(),
      resetPassword: (email) =>
        supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/set-password`,
        }),
    }),
    [session, profile, sessionLoading, profileLoading, profileError, refreshProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function isMissingDirectUserColumn(message = '') {
  return (
    /column .*must_change_password.* does not exist/i.test(message) ||
    /column .*removed_at.* does not exist/i.test(message)
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
