import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import { useAuth } from './context/AuthContext'
import AdminCycles from './pages/AdminCycles'
import AdminHome from './pages/AdminHome'
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
  const { session, role, loading } = useAuth()
  if (loading) return <p className="muted centered">Loading…</p>
  if (!session) return <Navigate to="/login" replace />
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

      {/* Admin panel (FR-5). Every branch is gated by requireAdmin, and every
          table it touches is additionally protected by RLS. */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute requireAdmin>
            <Layout>
              <AdminHome />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/users"
        element={
          <ProtectedRoute requireAdmin>
            <Layout>
              <AdminUsers />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/questions"
        element={
          <ProtectedRoute requireAdmin>
            <Layout>
              <AdminQuestions />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/cycles"
        element={
          <ProtectedRoute requireAdmin>
            <Layout>
              <AdminCycles />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/analytics"
        element={
          <ProtectedRoute requireAdmin>
            <Layout>
              <Suspense fallback={<p className="muted">Loading analytics…</p>}>
                <AdminAnalytics />
              </Suspense>
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
