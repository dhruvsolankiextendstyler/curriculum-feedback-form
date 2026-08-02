import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { homePathFor, isAdmin } from '../lib/constants'

/**
 * FR-5: route gate. `requireAdmin` restricts a branch to administrators.
 *
 * This is convenience, not security — every table is protected by RLS
 * (0002_rls.sql), so a user who forges their way to /admin still cannot read
 * or write anything their role does not allow.
 */
export default function ProtectedRoute({ children, requireAdmin = false }) {
  const { session, profile, role, loading, profileError } = useAuth()
  const location = useLocation()

  if (loading) {
    return <p className="muted centered">Loading…</p>
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (profileError) {
    return (
      <div className="notice error" role="alert">
        <h2>Could not load your account</h2>
        <p>{profileError}</p>
      </div>
    )
  }

  // Signed in to Auth but no profiles row: an invite that was never completed.
  if (!profile) {
    return (
      <div className="notice error" role="alert">
        <h2>Account not set up</h2>
        <p>
          Your login exists but has no role assigned yet. Please contact your
          administrator.
        </p>
      </div>
    )
  }

  if (profile.status !== 'active') {
    return (
      <div className="notice error" role="alert">
        <h2>Account deactivated</h2>
        <p>This account is no longer active. Please contact your administrator.</p>
      </div>
    )
  }

  if (requireAdmin && !isAdmin(role)) {
    return <Navigate to={homePathFor(role)} replace />
  }

  if (!requireAdmin && isAdmin(role)) {
    return <Navigate to="/admin" replace />
  }

  return children
}
