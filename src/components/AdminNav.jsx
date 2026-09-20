import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { isAdmin } from '../lib/constants'
import LordIcon from './LordIcon'

const ICON = 'https://cdn.lordicon.com'

/**
 * The admin-panel tabs.
 *
 * Departments is admin-only: an HOD administers one, but cannot create, rename or
 * archive any (FR-52). The route itself is gated by `requireAdmin`, so hiding the
 * tab is courtesy rather than the control.
 *
 * A tab is one fixed destination, not a toggle, so there is nothing to morph —
 * these use Lordicon (animate on hover). Two-state controls use morphicons.
 * `icon` is a Lordicon CDN URL; swap any by copying a link from lordicon.com.
 */
const TABS = [
  { to: '/admin', label: 'Dashboard', end: true, icon: `${ICON}/jeuxydnh.json` },
  { to: '/admin/users', label: 'Users', icon: `${ICON}/bhfjfgqz.json` },
  { to: '/admin/departments', label: 'Departments', adminOnly: true, icon: `${ICON}/gqzfzudq.json` },
  { to: '/admin/forms', label: 'Forms', icon: `${ICON}/wxnxiano.json` },
  { to: '/admin/cycles', label: 'Cycles', icon: `${ICON}/kbtmbyzy.json` },
  { to: '/admin/analytics', label: 'Analytics', icon: `${ICON}/msoeawqm.json` },
  { to: '/admin/logs', label: 'Logs', adminOnly: true, icon: `${ICON}/nocovwne.json` },
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
          <LordIcon src={tab.icon} size={20} target=".admin-tab" />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
