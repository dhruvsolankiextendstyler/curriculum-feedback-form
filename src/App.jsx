import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import { useAuth } from './context/AuthContext'
import AdminCycles from './pages/AdminCycles'
import AdminDepartments from './pages/AdminDepartments'
import AdminHome from './pages/AdminHome'
import AdminLogs from './pages/AdminLogs'
import AdminQuestions from './pages/AdminQuestions'
import AdminUsers from './pages/AdminUsers'
import FeedbackForm from './pages/FeedbackForm'
import FeedbackHome from './pages/FeedbackHome'
import Login from './pages/Login'
import NotFound from './pages/NotFound'
import SetPassword from './pages/SetPassword'
import { homePathFor } from './lib/constants'

/**
 * Analytics is split out of the main bundle. It pulls in recharts, which is
 * larger than the rest of the app put together, and only admins ever open it —
 * loading it eagerly would make several hundred students download a charting
 * library to fill in a form (NFR-2).
 */
const AdminAnalytics = lazy(() => import('./pages/AdminAnalytics'))

/** Sends a signed-in user to their panel; anyone else to the login screen. */
function RootRedirect() {
  const { session, profile, role, loading } = useAuth()
  if (loading) return <p className="muted centered">Loading…</p>
  if (!session) return <Navigate to="/login" replace />
  if (
    profile?.must_change_password &&
    profile.status === 'active' &&
    !profile.removed_at
  ) {
    return <Navigate to="/set-password" replace />
  }
  return <Navigate to={homePathFor(role)} replace />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<Login />} />
      <Route path="/set-password" element={<SetPassword />} />

      {/* Respondent panel (FR-7) */}
      <Route
        path="/feedback"
        element={
          <ProtectedRoute>
            <Layout>
              <FeedbackHome />
            </Layout>
          </ProtectedRoute>
        }
      />

      {/* New submission and edit-an-existing-one share one page (FR-12..FR-17).
          `new` cannot collide with a uuid, so the literal route is unambiguous. */}
      <Route
        path="/feedback/new"
        element={
          <ProtectedRoute>
            <Layout>
              <FeedbackForm />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/feedback/:responseId"
        element={
          <ProtectedRoute>
            <Layout>
              <FeedbackForm />
            </Layout>
          </ProtectedRoute>
        }
      />

      {/* Admin panel (FR-5). Every branch admits staff — an administrator or a
          head of department — except Departments, which stays admin-only because
          an HOD may not create one. Every table is additionally protected by RLS,
          and an HOD's reach inside these pages is narrowed there rather than
          here (0011_hod_scope.sql). */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute requireStaff>
            <Layout>
              <AdminHome />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/users"
        element={
          <ProtectedRoute requireStaff>
            <Layout>
              <AdminUsers />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/departments"
        element={
          <ProtectedRoute requireAdmin>
            <Layout>
              <AdminDepartments />
            </Layout>
          </ProtectedRoute>
        }
      />
      {/* The section is called Forms. It was /admin/questions until the rename,
          and an admin who bookmarked that is sent on rather than 404'd. */}
      <Route
        path="/admin/forms"
        element={
          <ProtectedRoute requireStaff>
            <Layout>
              <AdminQuestions />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route path="/admin/questions" element={<Navigate to="/admin/forms" replace />} />
      <Route
        path="/admin/cycles"
        element={
          <ProtectedRoute requireStaff>
            <Layout>
              <AdminCycles />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/analytics"
        element={
          <ProtectedRoute requireStaff>
            <Layout>
              <Suspense fallback={<p className="muted">Loading analytics…</p>}>
                <AdminAnalytics />
              </Suspense>
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/logs"
        element={
          <ProtectedRoute requireAdmin>
            <Layout>
              <AdminLogs />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
