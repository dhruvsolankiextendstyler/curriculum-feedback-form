import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { homePathFor, isAdmin, isStaff } from '../lib/constants'

/**
 * FR-5: route gate.
 *
 * `requireStaff` admits an administrator or a head of department — the admin panel
 * as a whole. `requireAdmin` is the narrower gate, for the branches an HOD has no
 * business in at all (managing departments themselves).
 *
 * This is convenience, not security — every table is protected by RLS
 * (0002_rls.sql, 0011_hod_scope.sql), so a user who forges their way to /admin
 * still cannot read or write anything their role does not allow.
 */
export default function ProtectedRoute({
  children,
  requireAdmin = false,
  requireStaff = false,
}) {
  const { session, profile, role, loading, profileError, signOut } = useAuth()
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
        <button type="button" className="secondary" onClick={signOut}>
          Sign out and return to login
        </button>
      </div>
    )
  }

  // Signed in to Auth but no profiles row: account provisioning did not finish.
  if (!profile) {
    return (
      <div className="notice error" role="alert">
        <h2>Account not set up</h2>
        <p>
          Your login exists but has no role assigned yet. Please contact your
          administrator.
        </p>
        <button type="button" className="secondary" onClick={signOut}>
          Sign out and return to login
        </button>
      </div>
    )
  }

  if (profile.removed_at) {
    return (
      <div className="notice error" role="alert">
        <h2>Account removed</h2>
        <p>This account has been removed. Please contact your administrator.</p>
        <button type="button" className="secondary" onClick={signOut}>
          Sign out and return to login
        </button>
      </div>
    )
  }

  if (profile.status !== 'active') {
    return (
      <div className="notice error" role="alert">
        <h2>Account deactivated</h2>
        <p>This account is no longer active. Please contact your administrator.</p>
        <button type="button" className="secondary" onClick={signOut}>
          Sign out and return to login
        </button>
      </div>
    )
  }

  if (profile.must_change_password) {
    return <Navigate to="/set-password" replace />
  }

  const staffOnly = requireAdmin || requireStaff

  if (requireAdmin && !isAdmin(role)) {
    // An HOD landing here has a panel of their own to go back to, so send them to
    // it rather than to the respondent side.
    return <Navigate to={homePathFor(role)} replace />
  }

  if (requireStaff && !isStaff(role)) {
    return <Navigate to={homePathFor(role)} replace />
  }

  // Staff have no feedback form (`forms_respondent_only`), so the respondent
  // branch would render an error rather than a form.
  if (!staffOnly && isStaff(role)) {
    return <Navigate to="/admin" replace />
  }

  return children
}
