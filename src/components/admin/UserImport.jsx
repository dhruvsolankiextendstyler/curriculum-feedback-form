import { useRef, useState } from 'react'
import Papa from 'papaparse'
import { RESPONDENT_ROLES, ROLES, ROLE_LABELS } from '../../lib/constants'
import { CSV_TEMPLATE, validateCsvRows } from '../../lib/admin/csv'
import { loadAllEmails } from '../../lib/admin/users'

const ALL_ROLES = [ROLES.ADMIN, ...RESPONDENT_ROLES]

/** Adds one user or a validated CSV batch without sending email invitations. */
export default function UserImport({ create, onDone, onError }) {
  const [mode, setMode] = useState('single')

  return (
    <div className="import-panel">
      <div className="tab-row" role="tablist" aria-label="Add users method">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'single'}
          className={`tab${mode === 'single' ? ' active' : ''}`}
          onClick={() => setMode('single')}
        >
          One user
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'csv'}
          className={`tab${mode === 'csv' ? ' active' : ''}`}
          onClick={() => setMode('csv')}
        >
          CSV import
        </button>
      </div>

      {mode === 'single' ? (
        <SingleUser create={create} onDone={onDone} onError={onError} />
      ) : (
        <CsvUsers create={create} onDone={onDone} onError={onError} />
      )}
    </div>
  )
}

function SingleUser({ create, onDone, onError }) {
  const [form, setForm] = useState({
    email: '',
    full_name: '',
    role: ROLES.STUDENT,
    temporary_password: '',
  })
  const [credential, setCredential] = useState(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    setCredential(null)
    try {
      const result = await create([form])
      const outcome = result.results?.[0]
      if (outcome?.status === 'created') {
        setCredential({
          email: outcome.email,
          temporary_password: outcome.temporary_password,
        })
        onDone(`${form.email} was added.`)
        setForm({
          email: '',
          full_name: '',
          role: ROLES.STUDENT,
          temporary_password: '',
        })
      } else {
        onError(`${form.email}: ${outcome?.reason ?? 'user creation failed'}`)
      }
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="create-email">Email</label>
      <input
        id="create-email"
        type="email"
        required
        value={form.email}
        onChange={(event) =>
          setForm((current) => ({ ...current, email: event.target.value }))
        }
      />

      <label htmlFor="create-name">Full name</label>
      <input
        id="create-name"
        type="text"
        value={form.full_name}
        onChange={(event) =>
          setForm((current) => ({ ...current, full_name: event.target.value }))
        }
      />

      <label htmlFor="create-role">Role</label>
      <select
        id="create-role"
        value={form.role}
        onChange={(event) =>
          setForm((current) => ({ ...current, role: event.target.value }))
        }
      >
        {ALL_ROLES.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABELS[role]}
          </option>
        ))}
      </select>

      <label htmlFor="create-password">Temporary password</label>
      <input
        id="create-password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={72}
        placeholder="Leave blank to generate"
        value={form.temporary_password}
        onChange={(event) =>
          setForm((current) => ({ ...current, temporary_password: event.target.value }))
        }
      />

      <button type="submit" disabled={busy}>
        {busy ? 'Adding...' : 'Add user'}
      </button>

      {credential && (
        <div className="notice success credential-result" role="status">
          <p>
            <strong>{credential.email}</strong>
          </p>
          <p>
            Temporary password: <code>{credential.temporary_password}</code>
          </p>
        </div>
      )}
    </form>
  )
}

function CsvUsers({ create, onDone, onError }) {
  const fileRef = useRef(null)
  const [preview, setPreview] = useState(null)
  const [credentials, setCredentials] = useState([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)

  async function handleFile(event) {
    const file = event.target.files?.[0]
    if (!file) return

    setPreview(null)
    setCredentials([])
    setProgress(null)

    Papa.parse(file, {
      skipEmptyLines: true,
      complete: async (parsed) => {
        try {
          const existing = await loadAllEmails()
          const result = validateCsvRows(parsed.data, existing)
          if (result.headerError) {
            onError(result.headerError)
            return
          }
          setPreview(result)
        } catch (err) {
          onError(err.message)
        }
      },
      error: (err) => onError(`Could not read the file: ${err.message}`),
    })
  }

  async function handleCreate() {
    if (!preview?.valid.length) return
    setBusy(true)
    setCredentials([])
    setProgress({ done: 0, total: preview.valid.length })

    try {
      const result = await create(preview.valid, setProgress)
      const parts = [`${result.created} created`]
      if (result.skipped) parts.push(`${result.skipped} already registered`)
      if (result.failed) parts.push(`${result.failed} failed`)
      onDone(`${parts.join(', ')}.`)

      const created = (result.results ?? [])
        .filter((row) => row.status === 'created')
        .map((row) => ({
          email: row.email,
          temporary_password: row.temporary_password,
        }))
      setCredentials(created)

      const failures = (result.results ?? []).filter((row) => row.status === 'failed')
      if (failures.length) {
        onError(
          `Failed: ${failures
            .slice(0, 5)
            .map((failure) => `${failure.email} (${failure.reason})`)
            .join('; ')}${failures.length > 5 ? ` and ${failures.length - 5} more` : ''}`,
        )
      }

      setPreview(null)
      if (fileRef.current) fileRef.current.value = ''
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  function downloadTemplate() {
    downloadText(CSV_TEMPLATE, 'user-import-template.csv')
  }

  function downloadCredentials() {
    const csv = Papa.unparse(credentials, { header: true, escapeFormulae: true })
    downloadText(csv, 'new-user-temporary-passwords.csv')
  }

  return (
    <div>
      <p className="muted">
        Columns: <code>email</code>, <code>full_name</code>, <code>role</code>, and
        optional <code>temporary_password</code>.
      </p>

      <div className="button-row">
        <button type="button" className="secondary" onClick={downloadTemplate}>
          Download template
        </button>
      </div>

      <label htmlFor="csv-file">CSV file</label>
      <input
        id="csv-file"
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        onChange={handleFile}
      />

      {credentials.length > 0 && (
        <div className="notice success credential-result" role="status">
          <p>{credentials.length} temporary password file ready.</p>
          <button type="button" className="secondary" onClick={downloadCredentials}>
            Download temporary passwords
          </button>
        </div>
      )}

      {preview && (
        <div className="preview">
          <h3>
            {preview.valid.length} ready to add
            {preview.invalid.length > 0 && `, ${preview.invalid.length} skipped`}
          </h3>

          {preview.invalid.length > 0 && (
            <details>
              <summary>Rows that will be skipped</summary>
              <ul className="issue-list">
                {preview.invalid.slice(0, 50).map((row) => (
                  <li key={`${row.line}-${row.email}`}>
                    Line {row.line}: {row.email || '(no email)'} - {row.reason}
                  </li>
                ))}
                {preview.invalid.length > 50 && (
                  <li className="muted">and {preview.invalid.length - 50} more</li>
                )}
              </ul>
            </details>
          )}

          {preview.valid.length > 0 && (
            <details>
              <summary>Preview first 10</summary>
              <ul className="issue-list">
                {preview.valid.slice(0, 10).map((row) => (
                  <li key={row.email}>
                    {row.email} - {ROLE_LABELS[row.role]}
                    {row.full_name ? ` (${row.full_name})` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="button-row">
            <button
              type="button"
              onClick={handleCreate}
              disabled={busy || !preview.valid.length}
            >
              {busy
                ? `Adding... ${progress?.done ?? 0}/${progress?.total ?? 0}`
                : `Add ${preview.valid.length} user${preview.valid.length === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setPreview(null)
                if (fileRef.current) fileRef.current.value = ''
              }}
            >
              Clear
            </button>
          </div>

          {progress && (
            <progress value={progress.done} max={progress.total}>
              {progress.done} of {progress.total}
            </progress>
          )}
        </div>
      )}
    </div>
  )
}

function downloadText(text, fileName) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}
