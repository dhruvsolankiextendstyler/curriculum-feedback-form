import { useLocation, useNavigate } from 'react-router-dom'
import { LogOut } from 'lucide'
import { useAuth } from '../context/AuthContext'
import { ROLE_LABELS, isStaff } from '../lib/constants'
import AdminNav from './AdminNav'
import Icon from './Icon'
import ThemeToggle from './ThemeToggle'

export default function Layout({ children }) {
  const { profile, role, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const adminSidebar = location.pathname.startsWith('/admin') && isStaff(role)

  async function handleSignOut() {
    if (!window.confirm('Sign out of Curriculum Feedback?')) return
    await signOut()
    navigate('/login', { replace: true })
  }

  const topbar = (
    <header className="topbar">
      <div className="topbar-left">
        <strong className="topbar-brand">Curriculum Feedback</strong>
        <span className="role-chip">{ROLE_LABELS[role] ?? role}</span>
      </div>
      <div className="topbar-right">
        <span className="muted topbar-name">{profile?.full_name || profile?.email}</span>
        <ThemeToggle />
        <button type="button" className="secondary" onClick={handleSignOut}>
          <Icon icon={LogOut} size={16} />
          Sign out
        </button>
      </div>
    </header>
  )

  if (adminSidebar) {
    return (
      <div className="layout-admin">
        {topbar}
        <div className="admin-body">
          <AdminNav />
          <main className="admin-main">{children}</main>
        </div>
      </div>
    )
  }

  return (
    <div className="shell">
      {topbar}
      <main>{children}</main>
    </div>
  )
}
