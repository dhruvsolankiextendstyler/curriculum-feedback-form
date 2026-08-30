import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { safeRedirect } from '../lib/constants'

export default function Login() {
  const { session, role, loading, signIn, resetPassword } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // FR-1: one field, either identifier. AuthContext decides which it is.
  const [identifier, setIdentifier] = useState('')
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

    const { error: signInError } = await signIn(identifier, password)
    setBusy(false)

    if (signInError) {
      setError(signInError.message)
      return
    }
    navigate('/', { replace: true })
  }

  // FR-4. The confirmation is deliberately worded not to confirm the account:
  // the request succeeds whether or not the identifier matches one. A SAP ID
  // does not tell the browser which address the link will go to, hence "its".
  async function handleReset() {
    if (!identifier.trim()) {
      setError('Enter your email address or SAP ID first, then choose "Forgot password".')
      return
    }
    setBusy(true)
    setError(null)
    const { error: resetError } = await resetPassword(identifier)
    setBusy(false)
    if (resetError) setError(resetError.message)
    else setNotice('If that account exists, a reset link is on its way to its email address.')
  }

  return (
    <main className="shell narrow">
      <h1>Curriculum Feedback</h1>
      <p className="muted">
        Accounts are created by your administrator. There is no public sign-up.
      </p>

      <form onSubmit={handleSubmit} className="card">
        <label htmlFor="identifier">Email or SAP ID</label>
        <input
          id="identifier"
          type="text"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck="false"
          aria-describedby="identifier-hint"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
        <p className="field-hint" id="identifier-hint">
          Your college email address, or your SAP ID if you have been given one.
        </p>

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
