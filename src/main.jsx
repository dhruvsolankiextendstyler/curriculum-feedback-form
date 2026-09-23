import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import ConfigError from './components/ConfigError'
import { AuthProvider } from './context/AuthContext'
import { ConfirmProvider } from './context/ConfirmContext'
import { ToastProvider } from './context/ToastContext'
import { isSupabaseConfigured } from './lib/supabase'
import './styles.css'

// Guard before mounting: AuthProvider would otherwise dereference a null client.
const tree = isSupabaseConfigured ? (
  <BrowserRouter>
    <ToastProvider>
      <ConfirmProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ConfirmProvider>
    </ToastProvider>
  </BrowserRouter>
) : (
  <ConfigError />
)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>{tree}</React.StrictMode>
)
