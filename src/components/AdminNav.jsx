import { NavLink } from 'react-router-dom'

const TABS = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/questions', label: 'Questions' },
  { to: '/admin/cycles', label: 'Cycles' },
  { to: '/admin/analytics', label: 'Analytics' },
]

export default function AdminNav() {
  return (
    <nav className="admin-nav" aria-label="Admin sections">
      {TABS.map((tab) => (
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
