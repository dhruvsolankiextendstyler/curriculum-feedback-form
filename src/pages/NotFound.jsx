import { Link } from 'react-router-dom'
import { Home, SearchX } from 'lucide'
import Icon from '../components/Icon'

export default function NotFound() {
  return (
    <main className="shell narrow">
      <div className="not-found-card card">
        <Icon icon={SearchX} size={48} />
        <span className="not-found-code">404</span>
        <h1>Page not found</h1>
        <p className="muted">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link className="button-link" to="/">
          <Icon icon={Home} size={16} /> Go to home
        </Link>
      </div>
    </main>
  )
}
