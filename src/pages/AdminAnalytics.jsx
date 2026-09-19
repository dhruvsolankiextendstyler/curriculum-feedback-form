import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import AdminNav from '../components/AdminNav'
import {
  BreakdownBars, BreakdownPie, ChoiceChart, DistributionChart,
  QuestionAverages, SentimentPie, TopTermsChart, TrendChart,
} from '../components/admin/AnalyticsCharts'
import {
  loadChoiceDistribution, loadDistribution, loadExportRows, loadFilterOptions,
  loadQuestionStats, loadTextAnswers, loadTotals, loadTrends,
} from '../lib/analytics/queries'
import { formatAvg, formatNormalised, spansVersions, versionNote } from '../lib/analytics/scales'
import { createClassifier } from '../lib/analytics/sentiment'
import { buildInsights, topTerms } from '../lib/analytics/insights'
import { BOM, buildCsv, fileName } from '../lib/analytics/csv'
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
  { id: 'overview', label: 'Overview' },
  { id: 'ratings', label: 'Ratings' },
  { id: 'trends', label: 'Trends' },
  { id: 'feedback', label: 'Feedback' },
  { id: 'export', label: 'Export' },
]

const EMPTY_FILTERS = {
  cycleId: '',
  stakeholder: '',
  streamId: '',
  departmentId: '',
  program: '',
  courseKey: '',
}

export default function Analytics() {
  // `?cycle=<id>` is how the Cycles page hands one year over, and it is what
  // makes a filtered view a link an admin can bookmark or send to a colleague.
  const [searchParams, setSearchParams] = useSearchParams()

  const [tab, setTab] = useState('overview')
  const [filters, setFilters] = useState(() => ({
    ...EMPTY_FILTERS,
    cycleId: searchParams.get('cycle') ?? '',
  }))
  const [options, setOptions] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    loadFilterOptions()
      .then((data) => active && setOptions(data))
      .catch((e) => active && setError(e.message))
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

  const hasFilters = Object.values(filters).some(Boolean)

  return (
    <section>
      <h1>Analytics</h1>
      <AdminNav />

      {error && (
        <div className="notice error" role="alert">
          <p>{error}</p>
        </div>
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
            <label htmlFor="f-stakeholder">Stakeholder</label>
            <select id="f-stakeholder" value={filters.stakeholder} onChange={setFilter('stakeholder')}>
              <option value="">All stakeholders</option>
              {(options?.stakeholders ?? []).map((s) => (
                <option key={s} value={s}>
                  {ROLE_LABELS?.[s] ?? s}
                </option>
              ))}
            </select>
          </div>
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
          <div>
            <label htmlFor="f-department">Department</label>
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
          </div>
          <div>
            <label htmlFor="f-program">Program</label>
            <select id="f-program" value={filters.program} onChange={setFilter('program')}>
              <option value="">All programs</option>
              {(options?.programs ?? []).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="grow">
            <label htmlFor="f-course">Course</label>
            <select id="f-course" value={filters.courseKey} onChange={setFilter('courseKey')}>
              <option value="">All courses</option>
              {(options?.courses ?? []).map((c) => (
                <option key={c.key} value={c.key}>{c.title}</option>
              ))}
            </select>
          </div>
          {hasFilters && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setFilters(EMPTY_FILTERS)
                setSearchParams({}, { replace: true })
              }}
            >
              Clear
            </button>
          )}
        </div>
        {filters.program && (
          <p className="muted small">
            Four of the five forms ask for a program, so this slice can hold
            students, faculty, alumni and academic peers &mdash; only employers are
            excluded. Check the Stakeholder column before reporting it as a
            student figure.
          </p>
        )}
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
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab filters={filters} />}
      {tab === 'ratings' && <RatingsTab filters={filters} />}
      {tab === 'trends' && <TrendsTab filters={filters} />}
      {tab === 'feedback' && <FeedbackTab filters={filters} />}
      {tab === 'export' && <ExportTab filters={filters} options={options} />}
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
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const key = JSON.stringify(filters)
  const run = useCallback(loader, [])

  useEffect(() => {
    let active = true
    setState((s) => ({ ...s, loading: true, error: null }))

    run(JSON.parse(key))
      .then((data) => active && setState({ loading: false, error: null, data }))
      .catch((e) => active && setState({ loading: false, error: e.message, data: null }))

    return () => {
      active = false
    }
  }, [run, key])

  return state
}

function Panel({ state, children, empty = 'Nothing to show for this selection.' }) {
  if (state.loading) return <p className="muted">Loading…</p>
  if (state.error) {
    return (
      <div className="notice error" role="alert">
        <p>{state.error}</p>
      </div>
    )
  }
  if (!state.data) return <p className="muted">{empty}</p>
  return children(state.data)
}

/** FR-35. */
function OverviewTab({ filters }) {
  const state = useAnalytics(loadTotals, filters)

  return (
    <Panel state={state}>
      {(totals) => {
        const stakeholderPie = (totals.byStakeholder ?? []).map((r) => ({
          name: ROLE_LABELS?.[r.stakeholderType] ?? r.stakeholderType,
          value: r.responseCount,
        }))
        const streamBars = (totals.byStream ?? []).map((r) => ({
          name: r.stream, value: r.responseCount,
        }))
        const deptBars = (totals.byDepartment ?? []).map((r) => ({
          name: describeDepartment({ name: r.department, code: r.code }),
          value: r.responseCount,
        }))
        const programBars = (totals.byProgram ?? []).map((r) => ({
          name: r.program, value: r.responseCount,
        }))
        const cycleBars = (totals.byCycle ?? []).map((r) => ({
          name: r.label, value: r.responseCount,
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
            <p className="muted small">
              One person can submit for several courses, so responses exceed people.
            </p>

            {stakeholderPie.length > 0 && (
              <div className="card">
                <h2>By stakeholder</h2>
                <div className="chart-table-row">
                  <BreakdownPie data={stakeholderPie} height={260} />
                  <Breakdown
                    rows={totals.byStakeholder}
                    nameOf={(r) => ROLE_LABELS?.[r.stakeholderType] ?? r.stakeholderType}
                    countOf={(r) => r.responseCount}
                    extra={(r) => `${r.respondentCount} ${r.respondentCount === 1 ? 'person' : 'people'}`}
                    inline
                  />
                </div>
              </div>
            )}

            {streamBars.length > 0 ? (
              <div className="card">
                <h2>By stream</h2>
                <BreakdownBars data={streamBars} />
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
                <BreakdownBars data={deptBars} />
              </div>
            ) : (
              <div className="card">
                <h2>By department</h2>
                <p className="muted">No responses carry a department yet.</p>
              </div>
            )}

            {programBars.length > 0 ? (
              <div className="card">
                <h2>By program</h2>
                <BreakdownBars data={programBars} />
              </div>
            ) : (
              <div className="card">
                <h2>By program</h2>
                <p className="muted">No responses carry a program.</p>
              </div>
            )}

            <Breakdown
              title="By course"
              rows={totals.byCourse}
              nameOf={(r) => r.courseTitle}
              countOf={(r) => r.responseCount}
              empty="No responses are tied to a course."
            />

            {cycleBars.length > 0 && (
              <div className="card">
                <h2>By academic year</h2>
                <BreakdownBars data={cycleBars} />
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

/** FR-36, FR-38, FR-34. */
function RatingsTab({ filters }) {
  const stats = useAnalytics(loadQuestionStats, filters)
  const dist = useAnalytics(loadDistribution, filters)
  const choices = useAnalytics(loadChoiceDistribution, filters)
  const [selected, setSelected] = useState(null)

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
          {(data) => <QuestionAverages rows={data} />}
        </Panel>
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
                      {/* `n_respondents` is count(distinct response_id), not
                          distinct people: one person submits for several
                          courses, so this is always >= the Overview tile's
                          People figure. Naming it "People" put two different
                          numbers under one word and overstated the human sample
                          behind every average (FR-36). */}
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
                              // Compared against what state actually holds. The
                              // composite `id` can never equal a bare
                              // question_key, so the `? null` arm was dead code
                              // and Hide did nothing (FR-38). Storing the
                              // composite instead would break
                              // DistributionChart, which filters on
                              // question_key alone.
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
        <div className="card">
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

/** FR-39. Cycle is the axis here, so the year filter does not apply. */
function TrendsTab({ filters }) {
  const trendFilters = useMemo(
    () => ({
      stakeholder: filters.stakeholder,
      program: filters.program,
      courseKey: filters.courseKey,
      streamId: filters.streamId,
      departmentId: filters.departmentId,
    }),
    [
      filters.stakeholder,
      filters.program,
      filters.courseKey,
      filters.streamId,
      filters.departmentId,
    ],
  )
  const state = useAnalytics(loadTrends, trendFilters)

  return (
    <div className="card">
      <h2>Year over year</h2>
      <p className="muted small">
        The academic-year filter does not apply here — the year is the axis.
      </p>
      <Panel state={state}>{(data) => <TrendChart rows={data} />}</Panel>
    </div>
  )
}

/** FR-40, FR-41. */
function FeedbackTab({ filters }) {
  const stats = useAnalytics(loadQuestionStats, filters)
  const text = useAnalytics(loadTextAnswers, filters)
  const [analyzer, setAnalyzer] = useState(null)

  useEffect(() => {
    let active = true
    import('sentiment')
      .then((mod) => {
        const Sentiment = mod.default ?? mod
        if (active) setAnalyzer(new Sentiment())
      })
      .catch(() => active && setAnalyzer(false))
    return () => {
      active = false
    }
  }, [])

  const summary = useMemo(() => {
    if (!analyzer || !text.data) return null
    return createClassifier(analyzer).summarise(text.data)
  }, [analyzer, text.data])

  const insights = useMemo(
    () => buildInsights(stats.data ?? [], summary),
    [stats.data, summary],
  )

  const terms = useMemo(
    () => (summary ? topTerms(summary.rows, 10) : []),
    [summary],
  )

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
        {analyzer === false && (
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
                  <SentimentPie counts={summary.counts} height={240} />
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

                <div className="table-wrap" style={{ marginTop: 20 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Tag</th>
                        <th>Question</th>
                        <th>Answer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.rows.map((row) => (
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
  const [state, setState] = useState({ busy: false, error: null, done: null })

  async function download() {
    setState({ busy: true, error: null, done: null })
    try {
      const { rows, truncated } = await loadExportRows(filters)
      const { csv, rowCount, excludedIdentityRows } = buildCsv(rows)

      // The BOM keeps Excel on Windows from mojibaking the en dashes in the
      // seeded option labels.
      const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' })
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
      setState({ busy: false, error: e.message, done: null })
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

      {state.error && (
        <div className="notice error" role="alert">
          <p>{state.error}</p>
        </div>
      )}
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
        {state.busy ? 'Preparing…' : 'Download CSV'}
      </button>
    </div>
  )
}
