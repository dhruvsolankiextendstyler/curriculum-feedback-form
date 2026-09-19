import { useCallback, useEffect, useMemo, useState } from 'react'
import AdminNav from '../components/AdminNav'
import QuestionEditor from '../components/admin/QuestionEditor'
import QuestionHistory from '../components/admin/QuestionHistory'
import { useAuth } from '../context/AuthContext'
import { isAdmin, RESPONDENT_ROLES, ROLE_LABELS } from '../lib/constants'
import { supabase } from '../lib/supabase'
import {
  COLLEGE_WIDE,
  countAnswers,
  createQuestion,
  deactivateQuestion,
  duplicateQuestion,
  loadFormKeys,
  loadQuestionsForAdmin,
  loadScales,
  reorderQuestions,
  restoreQuestion,
  updateQuestion,
} from '../lib/admin/questions'
import { describeDepartment, loadDepartmentTree } from '../lib/admin/departments'

const TYPE_LABELS = {
  rating: 'Rating',
  single_select: 'Dropdown',
  multi_select: 'Checkboxes',
  short_text: 'Short text',
  long_text: 'Long text',
}

const EMPTY_TREE = { streams: [], departments: [] }

function pdfStoragePath(formId, departmentId) {
  return departmentId ? `${formId}/${departmentId}.pdf` : `${formId}/college-wide.pdf`
}

async function uploadCurriculumPdf(formId, departmentId, file) {
  const path = pdfStoragePath(formId, departmentId)
  const { error: uploadErr } = await supabase.storage
    .from('curriculum-pdfs')
    .upload(path, file, { upsert: true, contentType: 'application/pdf' })
  if (uploadErr) throw new Error(uploadErr.message)

  const deptFilter = departmentId || null
  const { data: existing } = await supabase
    .from('curriculum_pdfs')
    .select('id')
    .eq('form_id', formId)
    [deptFilter ? 'eq' : 'is']('department_id', deptFilter)
    .maybeSingle()

  if (existing) {
    const { error } = await supabase
      .from('curriculum_pdfs')
      .update({ pdf_path: path, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase
      .from('curriculum_pdfs')
      .insert({ form_id: formId, department_id: deptFilter, pdf_path: path })
    if (error) throw new Error(error.message)
  }
  return path
}

async function removeCurriculumPdf(formId, departmentId, path) {
  await supabase.storage.from('curriculum-pdfs').remove([path])
  const deptFilter = departmentId || null
  const { error } = await supabase
    .from('curriculum_pdfs')
    .delete()
    .eq('form_id', formId)
    [deptFilter ? 'eq' : 'is']('department_id', deptFilter)
  if (error) throw new Error(error.message)
}

function getCurriculumPdfUrl(path) {
  const { data } = supabase.storage.from('curriculum-pdfs').getPublicUrl(path)
  return data?.publicUrl ?? null
}

async function loadCurriculumPdfForAdmin(formId, departmentId) {
  const deptFilter = departmentId || null
  const { data } = await supabase
    .from('curriculum_pdfs')
    .select('pdf_path')
    .eq('form_id', formId)
    [deptFilter ? 'eq' : 'is']('department_id', deptFilter)
    .maybeSingle()
  return data?.pdf_path ?? null
}

/**
 * FR-25 to FR-34, FR-53: question CRUD with versioning, reorder, soft delete and
 * history — for one *(form, department)* set at a time.
 *
 * Two pickers decide the set. An admin can choose any department, including the
 * college-wide set that every respondent answers. An HOD is pinned to their own
 * department and sees the college-wide set read-only, because an admin owns it.
 */
export default function AdminQuestions() {
  const { user, profile, role } = useAuth()
  const admin = isAdmin(role)

  const [forms, setForms] = useState([])
  const [formId, setFormId] = useState('')
  const [departmentId, setDepartmentId] = useState(COLLEGE_WIDE)
  const [tree, setTree] = useState(EMPTY_TREE)
  const [questions, setQuestions] = useState([])
  const [scales, setScales] = useState([])
  const [state, setState] = useState({ loading: true, error: null })
  const [notice, setNotice] = useState(null)
  const [editing, setEditing] = useState(null) // question object, or 'new'
  const [answerCount, setAnswerCount] = useState(0)
  const [historyFor, setHistoryFor] = useState(null)
  const [copying, setCopying] = useState(null)
  const [showDeleted, setShowDeleted] = useState(false)
  const [pdfPath, setPdfPath] = useState(null)
  const [pdfBusy, setPdfBusy] = useState(false)

  // Forms, scales and the department list are static for the session; load once.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [{ data: formRows, error }, scaleRows, loadedTree] = await Promise.all([
          supabase.from('forms').select('id, title, stakeholder_type'),
          loadScales(),
          loadDepartmentTree().catch(() => EMPTY_TREE),
        ])
        if (error) throw new Error(error.message)
        if (!active) return

        // Present forms in the PRD's stakeholder order, not insertion order.
        const ordered = RESPONDENT_ROLES.map((r) =>
          (formRows ?? []).find((f) => f.stakeholder_type === r),
        ).filter(Boolean)

        setForms(ordered)
        setScales(scaleRows)
        setTree(loadedTree)
        setFormId((current) => current || ordered[0]?.id || '')
        // An HOD opens on their own set: it is the only one they can write.
        if (!admin && profile?.department_id) setDepartmentId(profile.department_id)
      } catch (err) {
        if (active) setState({ loading: false, error: err.message })
      }
    })()
    return () => {
      active = false
    }
  }, [admin, profile?.department_id])

  const refresh = useCallback(async () => {
    if (!formId) return
    setState({ loading: true, error: null })
    try {
      const [qs, pdf] = await Promise.all([
        loadQuestionsForAdmin(formId, departmentId),
        loadCurriculumPdfForAdmin(formId, departmentId),
      ])
      setQuestions(qs)
      setPdfPath(pdf)
      setState({ loading: false, error: null })
    } catch (err) {
      setState({ loading: false, error: err.message })
    }
  }, [formId, departmentId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const departmentsByStream = useMemo(() => {
    const groups = tree.streams.map((stream) => ({
      stream,
      departments: tree.departments.filter(
        (d) => d.stream_id === stream.id && d.is_active,
      ),
    }))
    return groups.filter((group) => group.departments.length > 0)
  }, [tree])

  const currentDepartment = departmentId
    ? tree.departments.find((d) => d.id === departmentId)
    : null

  /**
   * An HOD looking at the college-wide set. Everything is hidden rather than
   * disabled-and-failing, because RLS would refuse the write anyway and a button
   * that always errors is worse than no button.
   */
  const readOnly = !admin && !departmentId

  /** The department slug namespaces a new key — see deriveQuestionKey. */
  const keyPrefix = currentDepartment?.slug ?? ''

  const pdfUrl = pdfPath ? getCurriculumPdfUrl(pdfPath) : null

  async function handlePdfUpload(event) {
    const file = event.target.files?.[0]
    if (!file || !formId) return
    setPdfBusy(true)
    try {
      const path = await uploadCurriculumPdf(formId, departmentId, file)
      setPdfPath(path)
      setNotice('Curriculum PDF uploaded.')
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    } finally {
      setPdfBusy(false)
      event.target.value = ''
    }
  }

  async function handlePdfRemove() {
    if (!pdfPath || !formId) return
    if (!window.confirm('Remove the curriculum PDF?')) return
    setPdfBusy(true)
    try {
      await removeCurriculumPdf(formId, departmentId, pdfPath)
      setPdfPath(null)
      setNotice('Curriculum PDF removed.')
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    } finally {
      setPdfBusy(false)
    }
  }


  async function openEditor(question) {
    setNotice(null)
    if (question) {
      // The count decides whether the editor warns about versioning.
      try {
        setAnswerCount(await countAnswers(question.id))
      } catch {
        setAnswerCount(0)
      }
    } else {
      setAnswerCount(0)
    }
    setEditing(question ?? 'new')
  }

  async function handleSave(draft) {
    try {
      if (editing === 'new') {
        await createQuestion({
          formId,
          departmentId,
          draft,
          // Form-wide, not set-wide: the unique index is on (form_id,
          // question_key), so a new key has to clear the other departments' too.
          existingKeys: await loadFormKeys(formId),
          keyPrefix,
          actorId: user.id,
        })
        setNotice('Question added.')
      } else {
        const outcome = await updateQuestion({ current: editing, draft, actorId: user.id })
        setNotice(
          outcome === 'versioned'
            ? 'Saved as a new version. Existing answers keep the previous wording.'
            : outcome === 'updated'
              ? 'Question updated.'
              : 'No changes to save.',
        )
      }
      setEditing(null)
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    }
  }

  /**
   * FR-56. The copy is a new question with its own key and its own history, not a
   * link — the same wording asked in two places accumulates two sets of answers,
   * and one `question_versions` row cannot belong to two questions.
   */
  async function handleCopy({ targetFormId, targetDepartmentId }) {
    const target = targetDepartmentId
      ? tree.departments.find((d) => d.id === targetDepartmentId)
      : null
    try {
      await duplicateQuestion({
        question: copying,
        targetFormId,
        targetDepartmentId,
        keyPrefix: target?.slug ?? '',
        actorId: user.id,
      })
      const where = target ? target.name : 'the college-wide set'
      const form = forms.find((f) => f.id === targetFormId)
      setNotice(
        `Copied to ${where}${form ? ` on the ${ROLE_LABELS[form.stakeholder_type]} form` : ''}.`,
      )
      setCopying(null)
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    }
  }


  async function handleDeactivate(question) {
    const count = await countAnswers(question.id).catch(() => 0)
    const warning = count
      ? `This question has ${count} answer${count === 1 ? '' : 's'}. ` +
        'It will be removed from the live form but its data stays in reports. Continue?'
      : 'Remove this question from the live form?'
    if (!window.confirm(warning)) return

    try {
      await deactivateQuestion(question.id, user.id)
      setNotice('Question removed from the form. Its history is preserved.')
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    }
  }

  async function handleRestore(question) {
    try {
      await restoreQuestion(question.id, user.id)
      setNotice('Question restored at the end of the form. Move it if it belongs elsewhere.')
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    }
  }

  /**
   * FR-29: swap with the neighbour, then persist the whole SET's order.
   *
   * Soft-deleted rows are renumbered too, after the live ones. They hold no
   * position on the live form, and leaving them on their original numbers is
   * what lets a later FR-33 restore land on a slot a live question now also
   * holds — `display_order` carries no unique constraint.
   */
  async function move(index, direction) {
    const active = questions.filter((q) => q.isActive)
    const target = index + direction
    if (target < 0 || target >= active.length) return

    const reordered = [...active]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]

    const wholeSet = [...reordered, ...questions.filter((q) => !q.isActive)]

    // Optimistic: reflect the move immediately, reconcile from the server after.
    setQuestions(wholeSet)

    try {
      await reorderQuestions(wholeSet.map((q) => q.id), user.id)
      await refresh()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
      await refresh()
    }
  }

  const activeQuestions = questions.filter((q) => q.isActive)
  const deletedQuestions = questions.filter((q) => !q.isActive)

  return (
    <section>
      <h1>Forms</h1>
      <AdminNav />

      {notice && (
        <div className="notice success" role="status">
          <p>{notice}</p>
        </div>
      )}
      {state.error && (
        <div className="notice error" role="alert">
          <p>{state.error}</p>
        </div>
      )}

      <div className="card filters">
        <div className="grow">
          <label htmlFor="form-select">Form</label>
          <select
            id="form-select"
            value={formId}
            onChange={(e) => {
              setFormId(e.target.value)
              setEditing(null)
              setHistoryFor(null)
              setCopying(null)
            }}
          >
            {forms.map((f) => (
              <option key={f.id} value={f.id}>
                {ROLE_LABELS[f.stakeholder_type]} — {f.title}
              </option>
            ))}
          </select>
        </div>
        <div className="grow">
          <label htmlFor="department-select">Question set</label>
          <select
            id="department-select"
            value={departmentId}
            onChange={(e) => {
              setDepartmentId(e.target.value)
              setEditing(null)
              setHistoryFor(null)
              setCopying(null)
            }}
          >
            <option value={COLLEGE_WIDE}>All departments (college-wide)</option>
            {admin ? (
              departmentsByStream.map((group) => (
                <optgroup key={group.stream.id} label={group.stream.name}>
                  {group.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {describeDepartment(d)}
                    </option>
                  ))}
                </optgroup>
              ))
            ) : (
              // An HOD may only write their own set, so it is the only other option.
              currentOwnDepartment(tree, profile) && (
                <option value={currentOwnDepartment(tree, profile).id}>
                  {describeDepartment(currentOwnDepartment(tree, profile))}
                </option>
              )
            )}
          </select>
        </div>
        <div>
          <button
            type="button"
            onClick={() => openEditor(null)}
            disabled={!formId || readOnly}
          >
            Add question
          </button>
        </div>
      </div>

      <div className="card">
        <label><strong>Curriculum PDF</strong></label>
        <p className="muted small">
          {departmentId
            ? `PDF for ${currentDepartment?.name ?? 'this department'} respondents. Falls back to the college-wide PDF if not set.`
            : 'College-wide PDF shown to all respondents of this form.'}
        </p>
        {pdfUrl ? (
          <div className="pdf-row">
            <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
              View current PDF
            </a>
            {!readOnly && (
              <>
                <label className="button-link secondary small-btn">
                  Replace
                  <input
                    type="file"
                    accept="application/pdf"
                    hidden
                    onChange={handlePdfUpload}
                    disabled={pdfBusy}
                  />
                </label>
                <button
                  type="button"
                  className="secondary danger small-btn"
                  onClick={handlePdfRemove}
                  disabled={pdfBusy}
                >
                  Remove
                </button>
              </>
            )}
          </div>
        ) : (
          !readOnly && (
            <label className="button-link secondary small-btn">
              {pdfBusy ? 'Uploading…' : 'Upload PDF'}
              <input
                type="file"
                accept="application/pdf"
                hidden
                onChange={handlePdfUpload}
                disabled={pdfBusy}
              />
            </label>
          )
        )}
      </div>

      <div className="card">
        {departmentId ? (
          <p className="muted">
            These questions are asked only of{' '}
            <strong>{currentDepartment?.name ?? 'this department'}</strong>{' '}
            respondents, in addition to the college-wide set. Other departments never
            see them, and each keeps its own analytics.
          </p>
        ) : (
          <p className="muted">
            The college-wide set. Every respondent of this type answers these,
            whatever their department.{' '}
            {readOnly &&
              'An administrator owns this set — switch to your own department to make changes.'}
          </p>
        )}
      </div>

      {editing && (
        <QuestionEditor
          question={editing === 'new' ? null : editing}
          scales={scales}
          answerCount={answerCount}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}

      {copying && (
        <CopyPanel
          question={copying}
          forms={forms}
          groups={departmentsByStream}
          admin={admin}
          ownDepartment={currentOwnDepartment(tree, profile)}
          currentFormId={formId}
          currentDepartmentId={departmentId}
          onCopy={handleCopy}
          onCancel={() => setCopying(null)}
        />
      )}

      {historyFor && (
        <QuestionHistory question={historyFor} onClose={() => setHistoryFor(null)} />
      )}

      {state.loading ? (
        <p className="muted">Loading questions…</p>
      ) : (
        <>
          <p className="muted">
            {activeQuestions.length} live question
            {activeQuestions.length === 1 ? '' : 's'}
            {deletedQuestions.length > 0 && ` · ${deletedQuestions.length} removed`}
          </p>

          <ol className="question-list">
            {activeQuestions.map((q, i) => (
              <li key={q.id} className="card question-row">
                <div className="question-main">
                  <div className="question-meta">
                    <span className="pill">{TYPE_LABELS[q.type] ?? q.type}</span>
                    {q.required ? (
                      <span className="pill req-pill">Required</span>
                    ) : (
                      <span className="pill muted-pill">Optional</span>
                    )}
                    {q.versionNo > 1 && (
                      <button
                        type="button"
                        className="pill version-pill"
                        onClick={() => setHistoryFor(q)}
                        title="This question has been edited. View its history."
                      >
                        v{q.versionNo}
                      </button>
                    )}
                  </div>
                  <p className="question-text">{q.text}</p>
                  {q.options.length > 0 && (
                    <p className="muted small">
                      {q.options.map((o) => o.label).join(' · ')}
                    </p>
                  )}
                  <code className="muted small">{q.key}</code>
                </div>

                <div className="question-actions">
                  {!readOnly && (
                    <div className="reorder">
                      <button
                        type="button"
                        className="secondary"
                        aria-label={`Move up: ${q.text}`}
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        aria-label={`Move down: ${q.text}`}
                        disabled={i === activeQuestions.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </button>
                    </div>
                  )}
                  {!readOnly && (
                    <button type="button" className="secondary" onClick={() => openEditor(q)}>
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setHistoryFor(q)}
                  >
                    History
                  </button>
                  {/* Copying OUT of a read-only set is allowed: it writes to the
                      target, not here, and seeding a department from the
                      college-wide set is the main reason an HOD wants it. */}
                  <button type="button" className="secondary" onClick={() => setCopying(q)}>
                    Copy to…
                  </button>
                  {!readOnly && (
                    <button
                      type="button"
                      className="secondary danger"
                      onClick={() => handleDeactivate(q)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {deletedQuestions.length > 0 && (
            <div className="deleted-section">
              <button
                type="button"
                className="secondary"
                onClick={() => setShowDeleted((v) => !v)}
              >
                {showDeleted ? 'Hide' : 'Show'} {deletedQuestions.length} removed question
                {deletedQuestions.length === 1 ? '' : 's'}
              </button>

              {showDeleted && (
                <ul className="question-list">
                  {deletedQuestions.map((q) => (
                    <li key={q.id} className="card question-row row-muted">
                      <div className="question-main">
                        <span className="pill muted-pill">Removed</span>
                        <p className="question-text">{q.text}</p>
                        <p className="muted small">
                          Its answers remain in reports and exports.
                        </p>
                      </div>
                      <div className="question-actions">
                        {!readOnly && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => handleRestore(q)}
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** The caller's own department, resolved against the loaded list. */
function currentOwnDepartment(tree, profile) {
  if (!profile?.department_id) return null
  return tree.departments.find((d) => d.id === profile.department_id) ?? null
}

/**
 * FR-56: copy one question into another set.
 *
 * Defaults to the set being viewed so the common move — the same question on
 * another form for the same department — is one change away, and refuses the
 * no-op of copying a question onto itself.
 */
function CopyPanel({
  question,
  forms,
  groups,
  admin,
  ownDepartment,
  currentFormId,
  currentDepartmentId,
  onCopy,
  onCancel,
}) {
  const [targetFormId, setTargetFormId] = useState(currentFormId)
  const [targetDepartmentId, setTargetDepartmentId] = useState(currentDepartmentId)
  const [busy, setBusy] = useState(false)

  const sameSet =
    targetFormId === currentFormId && targetDepartmentId === currentDepartmentId

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    try {
      await onCopy({ targetFormId, targetDepartmentId })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card edit-panel">
      <h2>Copy this question</h2>
      <p className="muted">&ldquo;{question.text}&rdquo;</p>

      <form onSubmit={handleSubmit}>
        <label htmlFor="copy-form">To form</label>
        <select
          id="copy-form"
          value={targetFormId}
          onChange={(event) => setTargetFormId(event.target.value)}
        >
          {forms.map((f) => (
            <option key={f.id} value={f.id}>
              {ROLE_LABELS[f.stakeholder_type]}
            </option>
          ))}
        </select>

        <label htmlFor="copy-department">To question set</label>
        <select
          id="copy-department"
          value={targetDepartmentId}
          onChange={(event) => setTargetDepartmentId(event.target.value)}
        >
          {/* An HOD cannot write the college-wide set, so it is not offered. */}
          {admin && <option value={COLLEGE_WIDE}>All departments (college-wide)</option>}
          {admin
            ? groups.map((group) => (
                <optgroup key={group.stream.id} label={group.stream.name}>
                  {group.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {describeDepartment(d)}
                    </option>
                  ))}
                </optgroup>
              ))
            : ownDepartment && (
                <option value={ownDepartment.id}>
                  {describeDepartment(ownDepartment)}
                </option>
              )}
        </select>

        <p className="field-hint">
          The copy starts at version 1 with a key of its own, so editing either one
          afterwards leaves the other alone and each collects its own answers.
        </p>

        <div className="button-row">
          <button type="submit" disabled={busy || sameSet}>
            {busy ? 'Copying…' : 'Copy question'}
          </button>
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
        {sameSet && (
          <p className="field-hint">
            Choose a different form or department — this is the set it is already in.
          </p>
        )}
      </form>
    </div>
  )
}
