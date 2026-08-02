import { urlProblem } from '../lib/supabase'

/** Shown instead of the app when Supabase env vars are missing or malformed. */
export default function ConfigError() {
  return (
    <main className="shell">
      <div className="notice error" role="alert">
        <h1>Setup needed</h1>

        {urlProblem ? (
          <>
            <p>{urlProblem}</p>
            <p className="muted">
              The API URL is under <strong>Project Settings → API → Project URL</strong>.
              It looks like <code>https://abcdefgh.supabase.co</code> — not the
              dashboard address in your browser bar.
            </p>
          </>
        ) : (
          <p>
            Supabase credentials are missing, so the app cannot start. Create a{' '}
            <code>.env</code> file in the project root:
          </p>
        )}

        <pre>
          {`VITE_SUPABASE_URL=https://<your-ref>.supabase.co`}
          <br />
          {`VITE_SUPABASE_ANON_KEY=<your anon public key>`}
        </pre>

        <p className="muted">
          Restart the dev server after editing <code>.env</code> — Vite only
          reads env files at startup.
        </p>
      </div>
    </main>
  )
}
