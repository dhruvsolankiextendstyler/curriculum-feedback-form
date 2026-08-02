import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { safeRedirect } from '../lib/constants'

export default function Login() {
  const { session, role, loading, signIn, resetPassword } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  if (loading) return <p className="muted centered">Loading…</p>
  if (session) {
    // Sanitised: router state is attacker-influencable via a crafted link.
    return <Navigate to={safeRedirect(location.state?.from?.pathname, role)} replace />
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)

    const { error: signInError } = await signIn(email.trim(), password)
    setBusy(false)

    if (signInError) {
      setError(signInError.message)
      return
    }
    navigate('/', { replace: true })
  }

  // FR-4. Supabase returns success regardless of whether the address exists,
  // so the confirmation is deliberately worded not to confirm the account.
  async function handleReset() {
    if (!email.trim()) {
      setError('Enter your email address first, then choose "Forgot password".')
      return
    }
    setBusy(true)
    setError(null)
    const { error: resetError } = await resetPassword(email.trim())
    setBusy(false)
    if (resetError) setError(resetError.message)
    else setNotice('If that address has an account, a reset link is on its way.')
  }

  return (
    <main className="shell narrow">
      <h1>Curriculum Feedback</h1>
      <p className="muted">
        Accounts are created by your administrator. There is no public sign-up.
      </p>

      <form onSubmit={handleSubmit} className="card">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="field-notice" role="status">
            {notice}
          </p>
        )}

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button
          type="button"
          className="linklike"
          onClick={handleReset}
          disabled={busy}
        >
          Forgot password?
        </button>
      </form>
    </main>
  )
}
