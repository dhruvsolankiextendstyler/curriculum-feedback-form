import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { X } from 'lucide'
import Icon from '../components/Icon'

/**
 * App-wide transient notifications, shown as a stack at the top of the viewport
 * rather than inline at a fixed spot on each page.
 *
 * Errors are the reason this exists: an "add users" failure buried in a banner
 * partway down a long admin page is easy to miss, so every error is surfaced
 * here in red, on top of whatever the user is looking at. success/info share the
 * same channel for the rare confirmation worth floating.
 */
const ToastContext = createContext(null)

let nextId = 0

const TTL = { error: 8000, success: 4000, info: 5000 }

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (type, message) => {
      // Nothing to show, and a thrown Error is common — read its message.
      const text = message?.message ?? message
      if (!text) return
      const id = ++nextId
      setToasts((current) => [...current, { id, type, message: String(text) }])
      window.setTimeout(() => dismiss(id), TTL[type] ?? 5000)
      return id
    },
    [dismiss],
  )

  const api = useMemo(
    () => ({
      error: (message) => push('error', message),
      success: (message) => push('success', message),
      info: (message) => push('info', message),
      dismiss,
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="toast-viewport"
        role="region"
        aria-label="Notifications"
        aria-live="assertive"
      >
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} role="alert">
            <p>{t.message}</p>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              <Icon icon={X} size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
