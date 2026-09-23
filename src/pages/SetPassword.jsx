import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff } from 'lucide'
import Icon from '../components/Icon'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

/**
 * FR-3 / FR-4: first-sign-in password change and password-reset landing page.
 *
 * Supabase's `detectSessionInUrl` consumes the token in the URL and creates a
 * session before this renders, so updateUser() is authenticated by the time the
 * user submits.
 */
export default function SetPassword() {
  const { session, profile, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('The two passwords do not match.')
      return
    }

    setBusy(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setBusy(false)

    if (updateError) {
      setError(updateError.message)
      return
    }
    await refreshProfile()
    navigate('/', { replace: true })
  }

  return (
    <main className="shell narrow">
      <h1>Set your password</h1>
      {!session && (
        <p className="muted">Use this page from the password-reset link sent to your email.</p>
      )}
      {profile?.must_change_password && (
        <p className="muted">Your administrator created this account with a temporary password. Choose a private password to continue.</p>
      )}
      <form onSubmit={handleSubmit} className="card">
        <label htmlFor="new-password">New password</label>
        <div className="password-field">
          <input
            id="new-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className="password-toggle"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            title={showPassword ? 'Hide password' : 'Show password'}
          >
            <Icon icon={showPassword ? EyeOff : Eye} size={18} />
          </button>
        </div>

        <label htmlFor="confirm-password">Confirm password</label>
        <div className="password-field">
          <input
            id="confirm-password"
            type={showConfirm ? 'text' : 'password'}
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <button
            type="button"
            className="password-toggle"
            onClick={() => setShowConfirm((v) => !v)}
            aria-label={showConfirm ? 'Hide password' : 'Show password'}
            title={showConfirm ? 'Hide password' : 'Show password'}
          >
            <Icon icon={showConfirm ? EyeOff : Eye} size={18} />
          </button>
        </div>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </main>
  )
}
