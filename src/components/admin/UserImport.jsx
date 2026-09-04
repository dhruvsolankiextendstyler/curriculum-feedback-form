import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Papa from 'papaparse'
import { RESPONDENT_ROLES, ROLES, ROLE_LABELS } from '../../lib/constants'
import { SAP_ID_HINT, validateSapId } from '../../lib/identifier'
import { CSV_TEMPLATE, validateCsvRows } from '../../lib/admin/csv'
import { loadExistingIdentifiers } from '../../lib/admin/users'
import { departmentRequiredFor, describeDepartment } from '../../lib/admin/departmentRules'

const ALL_ROLES = [ROLES.ADMIN, ...RESPONDENT_ROLES]

const EMPTY_TREE = { streams: [], departments: [] }

/**
 * Adds one user or a validated CSV batch without sending email invitations.
 *
 * `tree` is the stream/department list the parent already holds for its filters.
 * Passing it down rather than fetching it again keeps one source of truth for
 * what an admin may pick, and lets the CSV importer resolve names to ids without
 * a round trip per row (FR-47).
 */
export default function UserImport({ create, onDone, onError, tree = EMPTY_TREE }) {
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
        <SingleUser create={create} onDone={onDone} onError={onError} tree={tree} />
      ) : (
        <CsvUsers create={create} onDone={onDone} onError={onError} tree={tree} />
      )}
    </div>
  )
}

const EMPTY_USER = {
  email: '',
  full_name: '',
  sap_id: '',
  role: ROLES.STUDENT,
  stream_id: '',
  department_id: '',
  temporary_password: '',
}

function SingleUser({ create, onDone, onError, tree }) {
  const [form, setForm] = useState(EMPTY_USER)
  const [credential, setCredential] = useState(null)
  const [busy, setBusy] = useState(false)

  // Only what an admin may actually assign: an archived stream or department has
  // been taken out of use, and adding a new person to it would defeat that.
  const streams = useMemo(
    () => (tree.streams ?? []).filter((row) => row.is_active),
    [tree.streams],
  )
  const departments = useMemo(
    () =>
      (tree.departments ?? []).filter(
        (row) => row.is_active && row.stream_id === form.stream_id,
      ),
    [tree.departments, form.stream_id],
  )
  const departmentRequired = departmentRequiredFor(form.role)

  async function handleSubmit(event) {
    event.preventDefault()

    // Checked here as well as in the database, so a typo costs no round trip.
    const sapCheck = validateSapId(form.sap_id)
    if (!sapCheck.ok) {
      onError(sapCheck.reason)
      return
    }
    if (departmentRequired && !form.department_id) {
      onError(`${ROLE_LABELS[form.role]} accounts need a stream and a department.`)
      return
    }

    setBusy(true)
    setCredential(null)
    try {
      const result = await create([
        {
          email: form.email,
          full_name: form.full_name,
          sap_id: sapCheck.value ?? '',
          role: form.role,
          department_id: form.department_id || null,
          temporary_password: form.temporary_password,
        },
      ])
      const outcome = result.results?.[0]
      if (outcome?.status === 'created') {
        setCredential({
          email: outcome.email,
          sap_id: outcome.sap_id ?? null,
          temporary_password: outcome.temporary_password,
        })
        onDone(`${form.email} was added.`)
        setForm(EMPTY_USER)
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

      <label htmlFor="create-sap-id">SAP ID (optional)</label>
      <input
        id="create-sap-id"
        type="text"
        autoCapitalize="characters"
        spellCheck="false"
        aria-describedby="create-sap-id-hint"
        value={form.sap_id}
        onChange={(event) =>
          setForm((current) => ({ ...current, sap_id: event.target.value }))
        }
      />
      <p className="field-hint" id="create-sap-id-hint">
        A second identifier this person can sign in with. Leave blank if they have
        none — they will sign in by email. {SAP_ID_HINT}.
      </p>

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

      <label htmlFor="create-stream">
        Stream{departmentRequired ? '' : ' (optional)'}
      </label>
      <select
        id="create-stream"
        required={departmentRequired}
        value={form.stream_id}
        onChange={(event) =>
          // The department list is scoped to the stream, so a stream change
          // invalidates whatever was picked under the previous one.
          setForm((current) => ({
            ...current,
            stream_id: event.target.value,
            department_id: '',
          }))
        }
      >
        <option value="">No stream</option>
        {streams.map((stream) => (
          <option key={stream.id} value={stream.id}>
            {stream.name}
          </option>
        ))}
      </select>

      <label htmlFor="create-department">
        Department{departmentRequired ? '' : ' (optional)'}
      </label>
      <select
        id="create-department"
        required={departmentRequired}
        disabled={!form.stream_id}
        aria-describedby="create-department-hint"
        value={form.department_id}
        onChange={(event) =>
          setForm((current) => ({ ...current, department_id: event.target.value }))
        }
      >
        <option value="">
          {!form.stream_id
            ? 'Choose a stream first'
            : departments.length === 0
              ? 'No departments in this stream'
              : 'Choose a department'}
        </option>
        {departments.map((department) => (
          <option key={department.id} value={department.id}>
            {describeDepartment(department)}
          </option>
        ))}
      </select>
      <p className="field-hint" id="create-department-hint">
        {departmentRequired
          ? `${ROLE_LABELS[form.role]} accounts must belong to a department — it is what the analytics filters group them by.`
          : 'Optional for this role. Employers, alumni and academic peers are outside the college structure.'}{' '}
        {streams.length === 0 && (
          <>
            No streams exist yet — <Link to="/admin/departments">add them first</Link>.
          </>
        )}
      </p>

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
          {credential.sap_id && (
            <p>
              SAP ID: <code>{credential.sap_id}</code>
            </p>
          )}
          <p>
            Temporary password: <code>{credential.temporary_password}</code>
          </p>
        </div>
      )}
    </form>
  )
}

function CsvUsers({ create, onDone, onError, tree }) {
  const fileRef = useRef(null)
  const [preview, setPreview] = useState(null)
  const [credentials, setCredentials] = useState([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)

  const departmentName = useMemo(() => {
    const byId = new Map((tree.departments ?? []).map((row) => [row.id, row]))
    return (id) => (id ? describeDepartment(byId.get(id)) : '')
  }, [tree.departments])

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
          const existing = await loadExistingIdentifiers()
          const result = validateCsvRows(parsed.data, existing, tree)
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
          sap_id: row.sap_id ?? '',
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
        optional <code>sap_id</code>, <code>stream</code>, <code>department</code> and{' '}
        <code>temporary_password</code>.
      </p>
      <p className="muted small">
        A department may be given by name or by its short code, and{' '}
        <code>stream</code> is only needed to tell apart a name that exists in two
        streams. Student and faculty rows without one are skipped.
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
                    {row.sap_id ? ` - SAP ID ${row.sap_id}` : ''}
                    {row.department_id ? ` - ${departmentName(row.department_id)}` : ''}
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
