import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './components/common/ErrorBoundary.jsx'
import { AuthProvider } from './auth/AuthContext.jsx'
import AuthGate from './auth/AuthGate.jsx'
import './index.css'
import './components/auth/auth.css'

/**
 * The protected application. The authenticated top bar (identity + role badge +
 * sign out) is rendered by App itself, on every screen, and tab state lives
 * there too.
 *
 * Entry is via SSO: AuthProvider reads the portal's context off the URL and
 * AuthGate holds everything below it behind the landing page until the role
 * comes back. Nothing here mounts before that resolves.
 */
const AuthenticatedApp = () => <App />

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <AuthGate>
          <AuthenticatedApp />
        </AuthGate>
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
