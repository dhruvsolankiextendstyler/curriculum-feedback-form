import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide'
import Icon from '../components/Icon'

const ConfirmContext = createContext(null)

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)
  const resolveRef = useRef(null)

  const confirm = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setState({ message, ok: opts.ok || 'OK', cancel: opts.cancel || 'Cancel' })
    })
  }, [])

  function respond(value) {
    resolveRef.current?.(value)
    resolveRef.current = null
    setState(null)
  }

  const api = useMemo(() => ({ confirm }), [confirm])

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      {state && (
        <div className="confirm-backdrop" onClick={() => respond(false)}>
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-describedby="confirm-msg"
            onClick={(e) => e.stopPropagation()}
          >
            <Icon icon={AlertTriangle} size={22} className="confirm-icon" />
            <p id="confirm-msg">{state.message}</p>
            <div className="confirm-actions">
              <button type="button" className="secondary" onClick={() => respond(false)} autoFocus>
                {state.cancel}
              </button>
              <button type="button" onClick={() => respond(true)}>
                {state.ok}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return ctx.confirm
}
