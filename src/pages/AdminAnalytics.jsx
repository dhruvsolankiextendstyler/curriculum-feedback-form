import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ArrowLeftRight, BarChart3, Download, Eye, FilterX, Lightbulb, MessageSquareText,
  Users, X,
} from 'lucide'
import Icon from '../components/Icon'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { isHod } from '../lib/constants'
import {
  BreakdownBars, BreakdownPie, ChoiceChart, DepartmentRankingTable,
  CycleDeltaTable, DepartmentBenchmarkChart, DistributionChart,
  HeatmapTable, ParticipationChart, QuestionAverages, ResponseQualityChart,
  SentimentPie, StakeholderComparisonChart, SubmissionTimelineChart,
  TopTermsChart,
} from '../components/admin/AnalyticsCharts'
import {
  loadChoiceDistribution, loadCycleDelta, loadDepartmentRanking,
  loadDepartmentBenchmark, loadDistribution, loadFilterOptions,
  loadHeatmap, loadParticipation, loadQuestionStats, loadResponseQuality,
  loadSubmissionTimeline, loadTextAnswers, loadTotals,
  streamExportRows,
} from '../lib/analytics/queries'
import { formatAvg, formatNormalised, spansVersions, versionNote } from '../lib/analytics/scales'
import { buildInsights, topTerms } from '../lib/analytics/insights'
import { BOM, buildCsvPage, fileName } from '../lib/analytics/csv'
import { describeDepartment } from '../lib/admin/departmentRules'
import { ROLE_LABELS } from '../lib/constants'

/**
 * Analytics dashboard (FR-34 to FR-42).
 *
 * Tabbed rather than one long page: each tab loads only what it needs, so the
 * sentiment lexicon and the export rows are never fetched for someone who only
 * wanted the response counts.
 *
 * Nothing here re-aggregates. Every figure comes from the RPC layer already
 * computed over the requested slice — folding grouped rows in the browser is
 * how average-of-averages and double-counted respondents get in.
 *
 * A caveat is attached to any number that could be misread: the faculty 4-point
 * scale, the non-scoring options excluded from averages, questions whose
 * answers span reworded variants, the program filter spanning four of the five
 * forms rather than students alone, and the department filter reaching only as
 * far back as the responses that were stamped with one.
 */

const TABS = [
  { id: 'overview', label: 'Overview', icon: Eye },
  { id: 'participation', label: 'Participation', icon: Users },
  { id: 'ratings', label: 'Ratings', icon: BarChart3 },
  { id: 'insights', label: 'Insights', icon: Lightbulb },
  { id: 'feedback', label: 'Feedback', icon: MessageSquareText },
  { id: 'export', label: 'Export', icon: Download },
]

const EMPTY_FILTERS = {
  cycleId: '',
  stakeholder: '',
  streamId: '',
  departmentId: '',
}

export default function Analytics() {
  // `?cycle=<id>` is how the Cycles page hands one year over, and it is what
  // makes a filtered view a link an admin can bookmark or send to a colleague.
  const [searchParams, setSearchParams] = useSearchParams()
  const { profile, role } = useAuth()

  // FR-3 scope: an HOD only ever sees their own department. The department (and
  // its stream) is pinned to their profile and not theirs to change — the
  // pickers are removed and every slice is forced through it. RLS enforces the
  // same server-side, so this is about not offering a control that would only
  // ever produce an empty or refused view.
  const hod = isHod(role)
  const lockedDepartmentId = hod ? (profile?.department_id ?? '') : ''

  const [tab, setTab] = useState('overview')
  const [filters, setFilters] = useState(() => ({
    ...EMPTY_FILTERS,
    cycleId: searchParams.get('cycle') ?? '',
    departmentId: lockedDepartmentId,
  }))
  const [options, setOptions] = useState(null)
  const [error, setError] = useState(null)
  const toast = useToast()

  // The profile can arrive after this mounts, so the initial state above may not
  // yet know the HOD's department. Pin it the moment it is known.
  useEffect(() => {
    if (!hod || !lockedDepartmentId) return
    setFilters((current) =>
      current.departmentId === lockedDepartmentId
        ? current
        : { ...current, departmentId: lockedDepartmentId, streamId: '' },
    )
  }, [hod, lockedDepartmentId])

  useEffect(() => {
    let active = true
    loadFilterOptions()
      .then((data) => active && setOptions(data))
      .catch((e) => { if (active) { toast.error(e.message); setError(e.message) } })
    return () => {
      active = false
    }
  }, [])

  /** Keeps the year in the address bar, so a reload lands on the same slice. */
  const selectCycle = useCallback(
    (cycleId) => {
      setFilters((current) => ({ ...current, cycleId }))
      setSearchParams(cycleId ? { cycle: cycleId } : {}, { replace: true })
    },
    [setSearchParams],
  )

  // A cycle id that no longer exists — a deleted year, a hand-edited URL — would
  // otherwise leave the picker blank while every panel quietly reported on all
  // years. Fall back to "All years" and say so in the URL too.
  useEffect(() => {
    if (!options || !filters.cycleId) return
    if (!(options.cycles ?? []).some((c) => c.id === filters.cycleId)) {
      selectCycle('')
    }
  }, [options, filters.cycleId, selectCycle])

  const setFilter = (key) => (event) =>
    setFilters((current) => ({ ...current, [key]: event.target.value }))

  // A department belongs to exactly one stream, so narrowing the stream can leave
  // a department selected that the list no longer offers.
  const departmentOptions = (options?.departments ?? []).filter(
    (department) => !filters.streamId || department.streamId === filters.streamId,
  )

  // The HOD's own department, resolved for the read-only label.
  const lockedDepartment =
    hod && lockedDepartmentId
      ? (options?.departments ?? []).find((d) => d.id === lockedDepartmentId) ?? null
      : null

  // The pinned department is not a "filter" the Clear button should offer to
  // remove — it is the fixed scope of the whole page for an HOD.
  const hasFilters = Object.entries(filters).some(
    ([key, value]) => Boolean(value) && !(hod && key === 'departmentId'),
  )

  const clearFilters = () => {
    setFilters({ ...EMPTY_FILTERS, departmentId: lockedDepartmentId })
    setSearchParams({}, { replace: true })
  }

  return (
    <section>
      <h1>Analytics</h1>

      {error && <p className="muted">Could not load filter options.</p>}

      {hod && (
        <p className="muted">
          Showing feedback for{' '}
          <strong>
            {lockedDepartment
              ? describeDepartment(lockedDepartment)
              : 'your department'}
          </strong>{' '}
          only. The department is fixed to the one you head.
        </p>
      )}

      <div className="card">
        <div className="filters">
          <div>
            <label htmlFor="f-cycle">Academic year</label>
            <select
              id="f-cycle"
              value={filters.cycleId}
              onChange={(event) => selectCycle(event.target.value)}
            >
              <option value="">All years</option>
              {(options?.cycles ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.isActive ? ' (open)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-stakeholder">Role</label>
            <select id="f-stakeholder" value={filters.stakeholder} onChange={setFilter('stakeholder')}>
              <option value="">All roles</option>
              {(options?.stakeholders ?? []).map((s) => (
                <option key={s} value={s}>
                  {ROLE_LABELS?.[s] ?? s}
                </option>
              ))}
            </select>
          </div>
          {!hod && (
            <div>
              <label htmlFor="f-stream">Stream</label>
              <select
                id="f-stream"
                value={filters.streamId}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    streamId: event.target.value,
                    departmentId: '',
                  }))
                }
              >
                <option value="">All streams</option>
                {(options?.streams ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.isActive ? '' : ' (archived)'}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="f-department">Department</label>
            {hod ? (
              // Fixed to the HOD's own department: shown, not editable.
              <input
                id="f-department"
                type="text"
                readOnly
                disabled
                value={
                  lockedDepartment
                    ? describeDepartment(lockedDepartment)
                    : lockedDepartmentId
                      ? 'Your department'
                      : 'No department assigned'
                }
              />
            ) : (
              <select
                id="f-department"
                value={filters.departmentId}
                onChange={setFilter('departmentId')}
              >
                <option value="">All departments</option>
                {departmentOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {describeDepartment(d)}
                    {d.isActive ? '' : ' (archived)'}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="grow"></div>
          {hasFilters && (
            <button type="button" className="secondary" onClick={clearFilters}>
              <Icon icon={FilterX} size={16} />
              Clear
            </button>
          )}
        </div>
        {(filters.streamId || filters.departmentId) && (
          <p className="muted small">
            A response records the department its author belonged to at the moment
            they submitted it, so that a later transfer cannot rewrite a past year.
            Feedback given before a department was assigned carries none, and this
            filter leaves it out.
          </p>
        )}
      </div>

      <div className="tab-row" role="tablist" aria-label="Analytics sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <Icon icon={t.icon} size={16} />
            {t.label}
          </button>
        ))}
      </div>

      <div className="tab-panel" key={tab}>
        {tab === 'overview' && <OverviewTab filters={filters} setFilters={setFilters} selectCycle={selectCycle} />}
        {tab === 'participation' && <ParticipationTab filters={filters} />}
        {tab === 'ratings' && <RatingsTab filters={filters} />}
        {tab === 'insights' && <InsightsTab filters={filters} />}
        {tab === 'feedback' && <FeedbackTab filters={filters} />}
        {tab === 'export' && <ExportTab filters={filters} options={options} />}
      </div>
    </section>
  )
}

/**
 * Loads on mount and whenever the filters change.
 *
 * The `active` flag is the important part: filters can change faster than a
 * round trip, and without it a slow earlier response can land after a fast
 * later one and render figures for the wrong slice.
 */
function useAnalytics(loader, filters) {
  const toast = useToast()
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const key = JSON.stringify(filters)
  const run = useCallback(loader, [])

  useEffect(() => {
    let active = true
    setState((s) => ({ ...s, loading: true, error: null }))

    run(JSON.parse(key))
      .then((data) => active && setState({ loading: false, error: null, data }))
      .catch((e) => { if (active) { toast.error(e.message); setState({ loading: false, error: e.message, data: null }) } })

    return () => {
      active = false
    }
  }, [run, key])

  return state
}

function Panel({ state, children, empty = 'Nothing to show for this selection.' }) {
  if (state.loading) return <p className="muted">Loading…</p>
  if (state.error) return <p className="muted">Something went wrong loading this section.</p>
  if (!state.data) return <p className="muted">{empty}</p>
  return children(state.data)
}

function DetailCard({ children, onClose }) {
  return (
    <div className="detail-card">
      <button type="button" className="detail-card-close" onClick={onClose} aria-label="Close">
        <Icon icon={X} size={16} />
      </button>
      <div>{children}</div>
    </div>
  )
}

/** FR-35. */
function OverviewTab({ filters, setFilters, selectCycle }) {
  const state = useAnalytics(loadTotals, filters)
  const [detail, setDetail] = useState(null)

  return (
    <Panel state={state}>
      {(totals) => {
        const stakeholderPie = (totals.byStakeholder ?? []).map((r) => ({
          name: ROLE_LABELS?.[r.stakeholderType] ?? r.stakeholderType,
          value: r.responseCount,
          _key: r.stakeholderType,
          respondentCount: r.respondentCount,
        }))
        const streamBars = (totals.byStream ?? []).map((r) => ({
          name: r.stream, value: r.responseCount,
          _key: r.streamId,
        }))
        const deptBars = (totals.byDepartment ?? []).map((r) => ({
          name: describeDepartment({ name: r.department, code: r.code }),
          value: r.responseCount,
          _key: r.departmentId,
        }))
        const cycleBars = (totals.byCycle ?? []).map((r) => ({
          name: r.label, value: r.responseCount,
          _key: r.cycleId,
        }))

        return (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span className="stat-value">{totals.responseCount}</span>
                <span className="stat-label">Responses</span>
              </div>
              <div className="stat">
                <span className="stat-value">{totals.respondentCount}</span>
                <span className="stat-label">People</span>
              </div>
              <div className="stat">
                <span className="stat-value">{totals.answerCount}</span>
                <span className="stat-label">Answers</span>
              </div>
            </div>
            {stakeholderPie.length > 0 && (
              <div className="card">
                <h2>By stakeholder</h2>
                <div className="chart-table-row">
                  <BreakdownPie
                    data={stakeholderPie}
                    height={260}
                    onSelect={(entry) => setDetail(
                      detail?.type === 'stakeholder' && detail.name === entry.name ? null
                        : { type: 'stakeholder', name: entry.name, key: entry._key, responses: entry.value, people: entry.respondentCount },
                    )}
                  />
                  <Breakdown
                    rows={totals.byStakeholder}
                    nameOf={(r) => ROLE_LABELS?.[r.stakeholderType] ?? r.stakeholderType}
                    countOf={(r) => r.responseCount}
                    extra={(r) => `${r.respondentCount} ${r.respondentCount === 1 ? 'person' : 'people'}`}
                    inline
                  />
                </div>
                {detail?.type === 'stakeholder' && (
                  <DetailCard onClose={() => setDetail(null)}>
                    <strong>{detail.name}</strong>
                    <span className="muted"> — {detail.responses} responses from {detail.people} people</span>
                    <p className="muted small" style={{ marginTop: 8 }}>
                      Use the stakeholder filter above to see all analytics for this group.
                    </p>
                  </DetailCard>
                )}
                <p className="muted small">Click a slice to see details.</p>
              </div>
            )}

            {streamBars.length > 0 ? (
              <div className="card">
                <h2>By stream</h2>
                <BreakdownBars
                  data={streamBars}
                  onSelect={(entry) => setDetail(
                    detail?.type === 'stream' && detail.name === entry.name ? null
                      : { type: 'stream', name: entry.name, responses: entry.value },
                  )}
                />
                {detail?.type === 'stream' && (
                  <DetailCard onClose={() => setDetail(null)}>
                    <strong>{detail.name}</strong>
                    <span className="muted"> — {detail.responses} responses</span>
                    <Breakdown
                      rows={(totals.byDepartment ?? []).filter((r) => r.stream === detail.name)}
                      nameOf={(r) => describeDepartment({ name: r.department, code: r.code })}
                      countOf={(r) => r.responseCount}
                      empty="No departments in this stream."
                      inline
                    />
                  </DetailCard>
                )}
              </div>
            ) : (
              <div className="card">
                <h2>By stream</h2>
                <p className="muted">No responses carry a department yet.</p>
              </div>
            )}

            {deptBars.length > 0 ? (
              <div className="card">
                <h2>By department</h2>
                <BreakdownBars
                  data={deptBars}
                  onSelect={(entry) => setDetail(
                    detail?.type === 'department' && detail.name === entry.name ? null
                      : { type: 'department', name: entry.name, responses: entry.value },
                  )}
                />
                {detail?.type === 'department' && (
                  <DetailCard onClose={() => setDetail(null)}>
                    <strong>{detail.name}</strong>
                    <span className="muted"> — {detail.responses} responses</span>
                    <Breakdown
                      rows={(totals.byStakeholder ?? []).map((r) => ({
                        ...r,
                        label: ROLE_LABELS?.[r.stakeholderType] ?? r.stakeholderType,
                      }))}
                      nameOf={(r) => r.label}
                      countOf={(r) => r.responseCount}
                      empty="No data."
                      inline
                    />
                    <p className="muted small">Stakeholder breakdown is across the full slice, not per department. Use the department filter above for a scoped view.</p>
                  </DetailCard>
                )}
              </div>
            ) : (
              <div className="card">
                <h2>By department</h2>
                <p className="muted">No responses carry a department yet.</p>
              </div>
            )}

            {cycleBars.length > 0 && (
              <div className="card">
                <h2>By academic year</h2>
                <BreakdownBars
                  data={cycleBars}
                  onSelect={(entry) => setDetail(
                    detail?.type === 'cycle' && detail.name === entry.name ? null
                      : { type: 'cycle', name: entry.name, responses: entry.value },
                  )}
                />
                {detail?.type === 'cycle' && (
                  <DetailCard onClose={() => setDetail(null)}>
                    <strong>{detail.name}</strong>
                    <span className="muted"> — {detail.responses} responses</span>
                  </DetailCard>
                )}
              </div>
            )}
          </>
        )
      }}
    </Panel>
  )
}

function Breakdown({ title, rows, nameOf, countOf, extra = null, empty = 'None yet.', inline = false }) {
  const table = !rows?.length ? (
    <p className="muted">{empty}</p>
  ) : (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Responses</th>
            {extra && <th>Detail</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${nameOf(row)}-${i}`}>
              <td>{nameOf(row)}</td>
              <td>{countOf(row)}</td>
              {extra && <td className="muted">{extra(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  if (inline) return table

  return (
    <div className="card">
      {title && <h2>{title}</h2>}
      {table}
    </div>
  )
}

function ParticipationTab({ filters }) {
  const state = useAnalytics(loadParticipation, filters)
  const [selectedSt, setSelectedSt] = useState(null)
  const [selectedDept, setSelectedDept] = useState(null)

  return (
    <Panel state={state} empty="No provisioned users found.">
      {(rows) => {
        const totalProvisioned = rows.reduce((s, r) => s + Number(r.provisioned), 0)
        const totalResponded = rows.reduce((s, r) => s + Number(r.responded), 0)
        const overallRate = totalProvisioned > 0 ? ((totalResponded / totalProvisioned) * 100) : 0

        const byStakeholder = new Map()
        const byDepartment = new Map()
        for (const row of rows) {
          const st = row.stakeholder_type
          if (!byStakeholder.has(st)) byStakeholder.set(st, { key: st, provisioned: 0, responded: 0, departments: [] })
          const stEntry = byStakeholder.get(st)
          stEntry.provisioned += Number(row.provisioned)
          stEntry.responded += Number(row.responded)
          if (row.department_name) {
            stEntry.departments.push({ name: describeDepartment({ name: row.department_name, code: row.department_code }), provisioned: Number(row.provisioned), responded: Number(row.responded) })
          }

          if (row.department_id && row.department_name) {
            const key = row.department_id
            if (!byDepartment.has(key)) byDepartment.set(key, { name: row.department_name, code: row.department_code, provisioned: 0, responded: 0, stakeholders: [] })
            const dEntry = byDepartment.get(key)
            dEntry.provisioned += Number(row.provisioned)
            dEntry.responded += Number(row.responded)
            dEntry.stakeholders.push({ name: ROLE_LABELS?.[st] ?? st, provisioned: Number(row.provisioned), responded: Number(row.responded) })
          }
        }

        const stData = [...byStakeholder.entries()]
          .map(([st, v]) => ({ name: ROLE_LABELS?.[st] ?? st, _key: v.key, provisioned: v.provisioned, responded: v.responded, rate: v.provisioned > 0 ? (v.responded / v.provisioned) * 100 : 0, departments: v.departments }))
          .sort((a, b) => b.rate - a.rate)

        const deptData = [...byDepartment.values()]
          .map((v) => ({ name: describeDepartment({ name: v.name, code: v.code }), provisioned: v.provisioned, responded: v.responded, rate: v.provisioned > 0 ? (v.responded / v.provisioned) * 100 : 0, stakeholders: v.stakeholders }))
          .sort((a, b) => b.rate - a.rate)

        const stDetail = selectedSt ? stData.find((s) => s.name === selectedSt) : null
        const deptDetail = selectedDept ? deptData.find((d) => d.name === selectedDept) : null

        return (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span className="stat-value">{totalProvisioned}</span>
                <span className="stat-label">Provisioned</span>
              </div>
              <div className="stat">
                <span className="stat-value">{totalResponded}</span>
                <span className="stat-label">Responded</span>
              </div>
              <div className="stat">
                <span className="stat-value">{overallRate.toFixed(1)}%</span>
                <span className="stat-label">Response rate</span>
              </div>
            </div>

            {stData.length > 0 && (
              <div className="card">
                <h2>By stakeholder</h2>
                <ParticipationChart
                  data={stData}
                  selected={selectedSt}
                  onSelect={(entry) => setSelectedSt(selectedSt === entry.name ? null : entry.name)}
                />
                {stDetail && (
                  <DetailCard onClose={() => setSelectedSt(null)}>
                    <strong>{stDetail.name}</strong>
                    <span className="muted"> — {stDetail.responded} of {stDetail.provisioned} responded ({stDetail.rate.toFixed(1)}%)</span>
                    {stDetail.departments.length > 0 && (
                      <div className="table-wrap" style={{ marginTop: 8 }}>
                        <table className="data-table">
                          <thead><tr><th>Department</th><th>Provisioned</th><th>Responded</th><th>Rate</th></tr></thead>
                          <tbody>
                            {stDetail.departments.sort((a, b) => b.responded - a.responded).map((d) => (
                              <tr key={d.name}>
                                <td>{d.name}</td>
                                <td>{d.provisioned}</td>
                                <td>{d.responded}</td>
                                <td>{d.provisioned > 0 ? `${((d.responded / d.provisioned) * 100).toFixed(1)}%` : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </DetailCard>
                )}
                <p className="muted small">Click a bar to see department breakdown.</p>
              </div>
            )}

            {deptData.length > 0 && (
              <div className="card">
                <h2>By department</h2>
                <ParticipationChart
                  data={deptData}
                  selected={selectedDept}
                  onSelect={(entry) => setSelectedDept(selectedDept === entry.name ? null : entry.name)}
                />
                {deptDetail && (
                  <DetailCard onClose={() => setSelectedDept(null)}>
                    <strong>{deptDetail.name}</strong>
                    <span className="muted"> — {deptDetail.responded} of {deptDetail.provisioned} responded ({deptDetail.rate.toFixed(1)}%)</span>
                    {deptDetail.stakeholders.length > 0 && (
                      <div className="table-wrap" style={{ marginTop: 8 }}>
                        <table className="data-table">
                          <thead><tr><th>Stakeholder</th><th>Provisioned</th><th>Responded</th><th>Rate</th></tr></thead>
                          <tbody>
                            {deptDetail.stakeholders.sort((a, b) => b.responded - a.responded).map((s) => (
                              <tr key={s.name}>
                                <td>{s.name}</td>
                                <td>{s.provisioned}</td>
                                <td>{s.responded}</td>
                                <td>{s.provisioned > 0 ? `${((s.responded / s.provisioned) * 100).toFixed(1)}%` : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </DetailCard>
                )}
                <p className="muted small">Click a bar to see stakeholder breakdown.</p>
              </div>
            )}

            <p className="muted small">
              &ldquo;Provisioned&rdquo; counts active user accounts.
              &ldquo;Responded&rdquo; counts those who submitted at least one
              response{filters.cycleId ? ' in the selected academic year' : ''}.
              Users without a department are excluded from the department chart.
            </p>
          </>
        )
      }}
    </Panel>
  )
}

function CompareTab({ filters }) {
  const compareFilters = useMemo(
    () => ({ ...filters, stakeholder: '' }),
    [filters.cycleId, filters.program, filters.courseKey, filters.streamId, filters.departmentId],
  )
  const stats = useAnalytics(loadQuestionStats, compareFilters)
  const heatmap = useAnalytics(loadHeatmap, filters)
  const [cmpDetail, setCmpDetail] = useState(null)
  const [heatKey, setHeatKey] = useState(null)

  const { data: comparisonData, stakeholders } = useMemo(() => {
    const rows = stats.data ?? []
    if (!rows.length) return { data: [], stakeholders: [] }

    const byQuestion = new Map()
    for (const row of rows) {
      if (row.normalised_avg === null || row.normalised_avg === undefined) continue
      if (!byQuestion.has(row.question_key)) {
        byQuestion.set(row.question_key, { text: row.question_text ?? row.question_key, rows: [] })
      }
      byQuestion.get(row.question_key).rows.push(row)
    }

    const allStakeholders = [...new Set(rows.map((r) => r.stakeholder_type))]
    const comparable = [...byQuestion.entries()].filter(
      ([, v]) => new Set(v.rows.map((r) => r.stakeholder_type)).size > 1,
    )

    if (!comparable.length) return { data: [], stakeholders: [] }

    const usedStakeholders = new Set()
    const data = comparable.map(([, { text, rows: qRows }]) => {
      const point = { label: text?.length > 34 ? text.slice(0, 33) + '…' : text }
      for (const r of qRows) {
        point[r.stakeholder_type] = Number(r.normalised_avg)
        usedStakeholders.add(r.stakeholder_type)
      }
      return point
    })

    const stakeholders = allStakeholders
      .filter((st) => usedStakeholders.has(st))
      .map((st) => ({ key: st, label: ROLE_LABELS?.[st] ?? st }))

    return { data, stakeholders }
  }, [stats.data])

  return (
    <>
      <div className="card">
        <h2>Stakeholder comparison</h2>
        <p className="muted small">
          How different stakeholder groups rate the same question, normalised to
          0–100% so different scales are comparable. Only questions shared across
          two or more stakeholder types appear here.
          {filters.stakeholder && (
            <strong> The stakeholder filter is ignored for this view.</strong>
          )}
        </p>
        <Panel state={stats} empty="No rating data to compare.">
          {() =>
            !comparisonData.length ? (
              <p className="muted">
                No questions are shared across stakeholder types in this slice.
              </p>
            ) : (
              <>
                <StakeholderComparisonChart
                  data={comparisonData}
                  stakeholders={stakeholders}
                  selected={cmpDetail?.label}
                  onSelect={(entry) =>
                    setCmpDetail(cmpDetail?.label === entry.label ? null : entry)
                  }
                />
                {cmpDetail && (
                  <DetailCard onClose={() => setCmpDetail(null)}>
                    <strong>{cmpDetail.label}</strong>
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table className="data-table">
                        <thead><tr><th>Stakeholder</th><th>Normalised average</th></tr></thead>
                        <tbody>
                          {stakeholders
                            .filter((st) => cmpDetail[st.key] != null)
                            .sort((a, b) => cmpDetail[b.key] - cmpDetail[a.key])
                            .map((st) => (
                              <tr key={st.key}>
                                <td>{st.label}</td>
                                <td>{`${(cmpDetail[st.key] * 100).toFixed(1)}%`}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </DetailCard>
                )}
                <p className="muted small">Click a bar to see the per-stakeholder figures.</p>
              </>
            )
          }
        </Panel>
      </div>

      <div className="card">
        <h2>Department heatmap</h2>
        <p className="muted small">
          Normalised average per question per department. Green is high, red is
          low. Hover a cell for the exact figure and sample size. Click a row for
          the figures as a table.
        </p>
        <Panel state={heatmap} empty="No department-level rating data in this slice.">
          {(data) => (
            <>
              <HeatmapTable rows={data} selected={heatKey} onSelect={setHeatKey} />
              {heatKey && (() => {
                const forQ = data.filter((r) => r.question_key === heatKey && r.department_id && r.normalised_avg != null)
                if (!forQ.length) return null
                return (
                  <DetailCard onClose={() => setHeatKey(null)}>
                    <strong>{forQ[0].question_text ?? heatKey}</strong>
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table className="data-table">
                        <thead><tr><th>Department</th><th>Normalised average</th><th>Scored</th></tr></thead>
                        <tbody>
                          {[...forQ]
                            .sort((a, b) => Number(b.normalised_avg) - Number(a.normalised_avg))
                            .map((r) => (
                              <tr key={r.department_id}>
                                <td>{describeDepartment({ name: r.department_name, code: r.department_code })}</td>
                                <td>{`${(Number(r.normalised_avg) * 100).toFixed(1)}%`}</td>
                                <td>{r.n_scored}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </DetailCard>
                )
              })()}
            </>
          )}
        </Panel>
      </div>
    </>
  )
}

/** FR-36, FR-38, FR-34. */
function RatingsTab({ filters }) {
  const stats = useAnalytics(loadQuestionStats, filters)
  const dist = useAnalytics(loadDistribution, filters)
  const choices = useAnalytics(loadChoiceDistribution, filters)
  const [selected, setSelected] = useState(null)
  const distRef = useRef(null)

  useEffect(() => {
    if (selected) distRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selected])

  const rows = stats.data ?? []
  const mixedScales = new Set(rows.map((r) => r.scale_id)).size > 1

  return (
    <>
      <div className="card">
        <h2>Average rating per question</h2>
        {mixedScales && (
          <p className="notice" role="note">
            These results mix rating scales — faculty rate out of 4, everyone else
            out of 5 — so the chart is normalised to 0–100%. Filter by a single
            stakeholder to see raw averages.
          </p>
        )}
        <Panel state={stats} empty="No rating answers in this slice.">
          {(data) => <QuestionAverages rows={data} onSelect={(key) => setSelected(selected === key ? null : key)} />}
        </Panel>
        <p className="muted small">Click a bar to see its answer distribution.</p>
      </div>

      <div className="card">
        <h2>Question detail</h2>
        <Panel state={stats}>
          {(data) =>
            !data.length ? (
              <p className="muted">No rating answers in this slice.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Question</th>
                      <th>Stakeholder</th>
                      <th>Average</th>
                      <th>Normalised</th>
                      <th>Scored</th>
                      <th>N/A</th>
                      <th>Responses</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row) => {
                      const note = versionNote(row)
                      const id = `${row.stakeholder_type}::${row.question_key}`
                      return (
                        <tr key={id} className={row.is_active ? undefined : 'row-muted'}>
                          <td>
                            {row.question_text ?? row.question_key}
                            {!row.is_active && <span className="muted-pill">deleted</span>}
                            {spansVersions(row) && (
                              <span className="muted-pill" title={note}>
                                {row.versions_answered} wordings
                              </span>
                            )}
                            {note && <div className="muted small">{note}</div>}
                          </td>
                          <td>{ROLE_LABELS?.[row.stakeholder_type] ?? row.stakeholder_type}</td>
                          <td>{formatAvg(row)}</td>
                          <td>{formatNormalised(row.normalised_avg)}</td>
                          <td>{row.n_scored}</td>
                          <td>{row.n_not_applicable}</td>
                          <td>{row.n_respondents}</td>
                          <td>
                            <button
                              type="button"
                              className="linklike"
                              onClick={() =>
                                setSelected(
                                  selected === row.question_key ? null : row.question_key,
                                )
                              }
                            >
                              {selected === row.question_key ? 'Hide' : 'Distribution'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          }
        </Panel>
        <p className="muted small">
          &ldquo;N/A&rdquo; counts non-scoring options such as &ldquo;Not
          applicable&rdquo;. They are counted in the distribution but excluded
          from the average, never treated as a zero.
        </p>
      </div>

      {selected && (
        <div className="card" ref={distRef}>
          <h2>Distribution</h2>
          <Panel state={dist}>
            {(data) => <DistributionChart rows={data} questionKey={selected} />}
          </Panel>
        </div>
      )}

      <div className="card">
        <h2>Choice questions</h2>
        <Panel state={choices}>
          {(data) => {
            const keys = [...new Set(data.map((r) => r.question_key))]
            if (!keys.length) return <p className="muted">No choice answers in this slice.</p>
            return keys.map((key) => (
              <div key={key}>
                <h3 className="small">{key}</h3>
                <ChoiceChart rows={data} questionKey={key} />
              </div>
            ))
          }}
        </Panel>
      </div>
    </>
  )
}

function InsightsTab({ filters }) {
  const ranking = useAnalytics(loadDepartmentRanking, filters)
  const timeline = useAnalytics(loadSubmissionTimeline, filters)
  const quality = useAnalytics(loadResponseQuality, filters)
  const benchmark = useAnalytics(loadDepartmentBenchmark, filters)

  return (
    <>
      <div className="card">
        <h2>Department ranking</h2>
        <p className="muted small">Departments sorted by normalised average rating.</p>
        <Panel state={ranking} empty="No department-level rating data.">
          {(data) => <DepartmentRankingTable rows={data} />}
        </Panel>
      </div>

      <div className="card">
        <h2>Submission timeline</h2>
        <p className="muted small">Daily submission volume.</p>
        <Panel state={timeline} empty="No submission timestamps.">
          {(data) => <SubmissionTimelineChart rows={data} />}
        </Panel>
      </div>

      <div className="card">
        <h2>Response quality</h2>
        <p className="muted small">
          How substantive are text answers? Blank includes &ldquo;N/A&rdquo;, &ldquo;nil&rdquo;, etc.
          Short is 1–15 characters. Substantive is 16+.
        </p>
        <Panel state={quality} empty="No text questions in this slice.">
          {(data) => <ResponseQualityChart rows={data} />}
        </Panel>
      </div>

      <div className="card">
        <h2>Department benchmark</h2>
        <p className="muted small">
          Department average vs college average per question. Select a department filter to activate.
        </p>
        <Panel state={benchmark} empty="Select a department to see its benchmark against the college.">
          {(data) => <DepartmentBenchmarkChart rows={data} />}
        </Panel>
      </div>
    </>
  )
}

/** FR-40, FR-41. */
function FeedbackTab({ filters }) {
  const stats = useAnalytics(loadQuestionStats, filters)
  const text = useAnalytics(loadTextAnswers, filters)
  const [summary, setSummaryState] = useState(null)
  const [workerError, setWorkerError] = useState(false)

  useEffect(() => {
    if (!text.data || !text.data.length) { setSummaryState(null); return }
    let active = true
    const worker = new Worker(
      new URL('../lib/analytics/sentiment.worker.js', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (e) => { if (active) setSummaryState(e.data); worker.terminate() }
    worker.onerror = () => { if (active) setWorkerError(true); worker.terminate() }
    worker.postMessage(text.data)
    return () => { active = false; worker.terminate() }
  }, [text.data])

  const insights = useMemo(
    () => buildInsights(stats.data ?? [], summary),
    [stats.data, summary],
  )

  const terms = useMemo(
    () => (summary ? topTerms(summary.rows, 10) : []),
    [summary],
  )

  const [sentiment, setSentiment] = useState(null)

  return (
    <>
      <div className="card">
        <h2>Insights</h2>
        {!insights.insights.length ? (
          <p className="muted">
            Not enough data yet to say anything worth acting on.
          </p>
        ) : (
          <ul className="issue-list">
            {insights.insights.map((insight) => (
              <li key={`${insight.kind}-${insight.subject}`}>
                <strong>{insight.title}:</strong> {insight.subject}
                <div className="muted small">{insight.detail}</div>
              </li>
            ))}
          </ul>
        )}
        {insights.excluded && <p className="muted small">{insights.excluded.reason}</p>}
      </div>

      <div className="card">
        <h2>Written feedback</h2>
        {workerError && (
          <p className="notice error">The sentiment lexicon could not be loaded.</p>
        )}
        <Panel state={text} empty="No written answers in this slice.">
          {(rows) =>
            !rows.length ? (
              <p className="muted">No written answers in this slice.</p>
            ) : !summary ? (
              <p className="muted">Reading answers…</p>
            ) : (
              <>
                <div className="chart-table-row">
                  <SentimentPie
                    counts={summary.counts}
                    height={240}
                    selected={sentiment}
                    onSelect={(label) => setSentiment(sentiment === label ? null : label)}
                  />
                  <div>
                    <div className="stat-grid">
                      <div className="stat">
                        <span className="stat-value">{summary.counts.positive}</span>
                        <span className="stat-label">Positive</span>
                      </div>
                      <div className="stat">
                        <span className="stat-value">{summary.counts.neutral}</span>
                        <span className="stat-label">Neutral</span>
                      </div>
                      <div className="stat">
                        <span className="stat-value">{summary.counts.negative}</span>
                        <span className="stat-label">Negative</span>
                      </div>
                      <div className="stat">
                        <span className="stat-value">{summary.counts.none}</span>
                        <span className="stat-label">No answer</span>
                      </div>
                    </div>
                    {summary.share.positive !== null && (
                      <div className="sentiment-bars">
                        <div className="sentiment-bar positive" style={{ flex: summary.share.positive }} />
                        <div className="sentiment-bar neutral" style={{ flex: summary.share.neutral }} />
                        <div className="sentiment-bar negative" style={{ flex: summary.share.negative }} />
                      </div>
                    )}
                  </div>
                </div>
                <p className="muted small">
                  Percentages are of the {summary.opinionated} answers that said
                  something; &ldquo;no answer&rdquo; counts replies like
                  &ldquo;nil&rdquo; and &ldquo;n/a&rdquo;. Tags come from a word
                  list, not a language model, so treat them as a rough sort —
                  hover a tag to see the words behind it.
                </p>

                {terms.length > 0 && (
                  <div style={{ marginTop: 20 }}>
                    <h3>Most mentioned topics</h3>
                    <TopTermsChart terms={terms} />
                  </div>
                )}

                {sentiment && (
                  <p className="muted small" style={{ marginTop: 12 }}>
                    Showing <strong>{sentiment}</strong> answers only.{' '}
                    <button type="button" className="linklike" onClick={() => setSentiment(null)}>
                      Show all
                    </button>
                  </p>
                )}
                <div className="table-wrap" style={{ marginTop: sentiment ? 4 : 20 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Tag</th>
                        <th>Question</th>
                        <th>Answer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.rows
                        .filter((row) => !sentiment || row.sentiment.label === sentiment)
                        .map((row) => (
                        <tr key={row.answer_id}>
                          <td>
                            <span className={`pill sentiment-${row.sentiment.label}`} title={row.sentiment.reason}>
                              {row.sentiment.label}
                            </span>
                          </td>
                          <td className="muted small">{row.question_text}</td>
                          <td>{row.value_text}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )
          }
        </Panel>
      </div>
    </>
  )
}

/** FR-42. */
function ExportTab({ filters, options }) {
  const toast = useToast()
  const [state, setState] = useState({ busy: false, error: null, done: null })

  async function download() {
    setState({ busy: true, error: null, done: null })
    try {
      const parts = [BOM]
      let rowCount = 0
      let excludedIdentityRows = 0

      const { total, truncated } = await streamExportRows(filters, (rows, isFirst) => {
        const page = buildCsvPage(rows, isFirst)
        parts.push(page.csv)
        parts.push('\n')
        rowCount += page.rowCount
        excludedIdentityRows += page.excludedIdentityRows
      })

      const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName({
        cycleLabel: options?.cycles?.find((c) => c.id === filters.cycleId)?.label,
        stakeholder: filters.stakeholder || null,
      })
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)

      setState({ busy: false, error: null, done: { rowCount, excludedIdentityRows, truncated } })
    } catch (e) {
      toast.error(e.message)
      setState({ busy: false, error: null, done: null })
    }
  }

  return (
    <div className="card">
      <h2>Export raw responses</h2>
      <p className="muted">
        One row per answer for the current filters, including the wording each
        answer was given against so historical rewording is visible in the file
        (FR-42).
      </p>
      <p className="muted small">
        Answers that identify a respondent — name, SAP number, contact details —
        are always left out. A downloaded file is outside the app&rsquo;s access
        controls, and NFR-4 keeps personal data inside them.
      </p>

      {state.done && (
        <div className="notice success" role="status">
          <p>
            Exported {state.done.rowCount} rows.
            {state.done.excludedIdentityRows > 0 &&
              ` ${state.done.excludedIdentityRows} identifying answers were left out.`}
          </p>
          {state.done.truncated && (
            <p>
              <strong>This export hit the row ceiling and is incomplete.</strong>{' '}
              Narrow the filters and export again.
            </p>
          )}
        </div>
      )}

      <button type="button" onClick={download} disabled={state.busy}>
        <Icon icon={Download} size={16} />
        {state.busy ? 'Preparing…' : 'Download CSV'}
      </button>
    </div>
  )
}
