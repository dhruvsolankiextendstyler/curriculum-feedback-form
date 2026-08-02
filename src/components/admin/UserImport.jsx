import { useRef, useState } from 'react'
import Papa from 'papaparse'
import { RESPONDENT_ROLES, ROLES, ROLE_LABELS } from '../../lib/constants'
import { CSV_TEMPLATE, validateCsvRows } from '../../lib/admin/csv'
import { loadAllEmails } from '../../lib/admin/users'

const ALL_ROLES = [ROLES.ADMIN, ...RESPONDENT_ROLES]

/**
 * Invite panel (FR-23, FR-24): one user at a time, or a CSV batch.
 *
 * The CSV path validates every row against existing accounts BEFORE sending
 * anything, so a typo in row 300 is reported up front rather than after 299
 * invite emails have gone out.
 */
export default function UserImport({ invite, onDone, onError }) {
  const [mode, setMode] = useState('single')

  return (
    <div className="import-panel">
      <div className="tab-row" role="tablist" aria-label="Invite method">
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
        <SingleInvite invite={invite} onDone={onDone} onError={onError} />
      ) : (
        <CsvInvite invite={invite} onDone={onDone} onError={onError} />
      )}
    </div>
  )
}

function SingleInvite({ invite, onDone, onError }) {
  const [form, setForm] = useState({ email: '', full_name: '', role: ROLES.STUDENT })
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    try {
      const result = await invite([form])
      const outcome = result.results?.[0]
      if (outcome?.status === 'invited') {
        onDone(`Invitation sent to ${form.email}.`)
        setForm({ email: '', full_name: '', role: ROLES.STUDENT })
      } else {
        onError(`${form.email}: ${outcome?.reason ?? 'invite failed'}`)
      }
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="invite-email">Email</label>
      <input
        id="invite-email"
        type="email"
        required
        value={form.email}
        onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
      />

      <label htmlFor="invite-name">Full name</label>
      <input
        id="invite-name"
        type="text"
        value={form.full_name}
        onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
      />

      <label htmlFor="invite-role">Role</label>
      <select
        id="invite-role"
        value={form.role}
        onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
      >
        {ALL_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>

      <button type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send invitation'}
      </button>
    </form>
  )
}

function CsvInvite({ invite, onDone, onError }) {
  const fileRef = useRef(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)

  async function handleFile(event) {
    const file = event.target.files?.[0]
    if (!file) return

    setPreview(null)
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

  async function handleSend() {
    if (!preview?.valid.length) return
    setBusy(true)
    setProgress({ done: 0, total: preview.valid.length })

    try {
      const result = await invite(preview.valid, setProgress)
      const parts = [`${result.invited} invited`]
      if (result.skipped) parts.push(`${result.skipped} already registered`)
      if (result.failed) parts.push(`${result.failed} failed`)
      onDone(parts.join(', ') + '.')

      // Surface per-row failures; the summary alone would hide which addresses.
      const failures = (result.results ?? []).filter((r) => r.status === 'failed')
      if (failures.length) {
        onError(
          `Failed: ${failures
            .slice(0, 5)
            .map((f) => `${f.email} (${f.reason})`)
            .join('; ')}${failures.length > 5 ? ` … and ${failures.length - 5} more` : ''}`,
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
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'user-import-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <p className="muted">
        Columns: <code>email</code>, <code>full_name</code>, <code>role</code>.
        Rows are checked before any invitation is sent.
      </p>

      <div className="button-row">
        <button type="button" className="secondary" onClick={downloadTemplate}>
          Download template
        </button>
      </div>

      <label htmlFor="csv-file">CSV file</label>
      <input id="csv-file" ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} />

      {preview && (
        <div className="preview">
          <h3>
            {preview.valid.length} ready to invite
            {preview.invalid.length > 0 && `, ${preview.invalid.length} skipped`}
          </h3>

          {preview.invalid.length > 0 && (
            <details>
              <summary>Rows that will be skipped</summary>
              <ul className="issue-list">
                {preview.invalid.slice(0, 50).map((row) => (
                  <li key={`${row.line}-${row.email}`}>
                    Line {row.line}: {row.email || '(no email)'} — {row.reason}
                  </li>
                ))}
                {preview.invalid.length > 50 && (
                  <li className="muted">… and {preview.invalid.length - 50} more</li>
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
                    {row.email} — {ROLE_LABELS[row.role]}
                    {row.full_name ? ` (${row.full_name})` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className="muted small">
            Invites are sent in batches of 25 to stay inside the email provider's
            rate limit. Keep this tab open until it finishes.
          </p>

          <div className="button-row">
            <button type="button" onClick={handleSend} disabled={busy || !preview.valid.length}>
              {busy
                ? `Sending… ${progress?.done ?? 0}/${progress?.total ?? 0}`
                : `Send ${preview.valid.length} invitation${preview.valid.length === 1 ? '' : 's'}`}
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
