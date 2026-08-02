import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <main className="shell">
      <div className="notice">
        <h1>Page not found</h1>
        <p>
          <Link to="/">Go back</Link>
        </p>
      </div>
    </main>
  )
}
