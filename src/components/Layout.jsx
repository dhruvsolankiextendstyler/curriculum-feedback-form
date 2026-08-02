import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ROLE_LABELS } from '../lib/constants'

export default function Layout({ children }) {
  const { profile, role, signOut } = useAuth()
  const navigate = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <strong>Curriculum Feedback</strong>
          <span className="muted role-chip">{ROLE_LABELS[role] ?? role}</span>
        </div>
        <div className="topbar-right">
          <span className="muted">{profile?.full_name || profile?.email}</span>
          <button type="button" className="secondary" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  )
}
