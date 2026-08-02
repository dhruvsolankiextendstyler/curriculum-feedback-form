import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

/**
 * Session + profile for the signed-in user.
 *
 * `session` comes from Supabase Auth; `profile` is our public.profiles row and
 * carries the role that drives every routing and RLS decision.
 *
 * The profile fetch deliberately lives in its own effect rather than inside the
 * onAuthStateChange callback: calling another supabase-js method from inside
 * that callback can deadlock on the client's internal auth lock.
 */
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

  useEffect(() => {
    if (!userId) {
      setProfile(null)
      setProfileError(null)
      return
    }

    let active = true
    setProfileLoading(true)
    setProfileError(null)

    supabase
      .from('profiles')
      .select('id, email, full_name, role, status')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        if (error) setProfileError(error.message)
        // maybeSingle() returns null rather than throwing when the row is
        // missing — an account created in Auth but never given a profile.
        // ProtectedRoute surfaces that as "contact your administrator".
        setProfile(data ?? null)
        setProfileLoading(false)
      })

    return () => {
      active = false
    }
  }, [userId])

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      role: profile?.role ?? null,
      loading: sessionLoading || profileLoading,
      profileError,
      signIn: (email, password) =>
        supabase.auth.signInWithPassword({ email, password }),
      signOut: () => supabase.auth.signOut(),
      resetPassword: (email) =>
        supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/set-password`,
        }),
    }),
    [session, profile, sessionLoading, profileLoading, profileError]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
