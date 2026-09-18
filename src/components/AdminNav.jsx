import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { isAdmin } from '../lib/constants'

/**
 * The admin-panel tabs.
 *
 * Departments is admin-only: an HOD administers one, but cannot create, rename or
 * archive any (FR-52). The route itself is gated by `requireAdmin`, so hiding the
 * tab is courtesy rather than the control.
 */
const TABS = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/departments', label: 'Departments', adminOnly: true },
  { to: '/admin/forms', label: 'Forms' },
  { to: '/admin/cycles', label: 'Cycles' },
  { to: '/admin/analytics', label: 'Analytics' },
]

export default function AdminNav() {
  const { role } = useAuth()
  const tabs = TABS.filter((tab) => !tab.adminOnly || isAdmin(role))

  return (
    <nav className="admin-nav" aria-label="Admin sections">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) => `admin-tab${isActive ? ' active' : ''}`}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
