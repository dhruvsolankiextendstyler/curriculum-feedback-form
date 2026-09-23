import { cached } from '../cache'
import { supabase } from '../supabase'
import { assertDenominators } from './scales'

/**
 * Analytics reads (FR-34 to FR-42).
 *
 * Thin wrappers over the RPC functions in 0005_analytics.sql. Every aggregate
 * is computed in Postgres over the requested slice; nothing here re-aggregates,
 * because re-folding grouped rows in JS is how average-of-averages and
 * double-counted respondents get in.
 *
 * Filters are passed through unchanged and null means "no filter", matching the
 * SQL defaults, so one filter object drives every panel identically.
 */

/** @typedef {{cycleId?: string|null, stakeholder?: string|null, program?: string|null, courseKey?: string|null, streamId?: string|null, departmentId?: string|null}} Filters */

const params = ({
  cycleId = null,
  stakeholder = null,
  program = null,
  courseKey = null,
  streamId = null,
  departmentId = null,
} = {}) => ({
  p_cycle_id: cycleId || null,
  p_stakeholder: stakeholder || null,
  p_program: program || null,
  p_course_key: courseKey || null,
  p_stream_id: streamId || null,
  p_department_id: departmentId || null,
})

async function call(fn, args) {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(describeRpcError(error, fn))
  return data
}

/**
 * Turns a PostgREST failure into something an admin can act on.
 *
 * 42501 is the analytics guard firing. 42883/PGRST202 means the signature this
 * build calls does not exist on the database — by far the most likely state for a
 * teammate who has just pulled, and since 0008 widened every one of these
 * functions with the stream and department filters, either migration can be the
 * one that is missing.
 */
function describeRpcError(error, fn) {
  const code = error.code ?? ''
  const message = error.message ?? 'The analytics query failed.'

  if (code === '42501' || /access is required/i.test(message)) {
    // The server's own sentence is passed through. Rewriting it to "Admin
    // access is required" named the one role that cannot be the cause — a real
    // admin passes the guard, and ProtectedRoute has already checked it. The
    // actual live case is a head of department with no department: they clear
    // the front-end staff gate but SQL `is_staff()` is false without one, so
    // the department hint is appended rather than the cause being guessed at.
    return `${message} A head of department also needs a department assigned — analytics are scoped to it.`
  }
  if (code === '42883' || code === 'PGRST202' || /could not find the function/i.test(message)) {
    return `The analytics functions on this database do not match this build. Run supabase/migrations/0005_analytics.sql and 0008_departments.sql, then reload. (missing: ${fn})`
  }
  return message
}

/** FR-37: the values the filter dropdowns can offer. Cached 2 min. */
export const loadFilterOptions = cached(
  (cycleId = null) => call('analytics_filter_options', { p_cycle_id: cycleId || null }),
  2 * 60_000,
)

/** FR-35: headline counts, by stakeholder, program, course and cycle. Cached 60 s. */
export const loadTotals = cached(
  (filters) => call('analytics_totals', params(filters)),
  60_000,
)

/** FR-36 + FR-34: per-question averages, denominators and version spread. Cached 60 s. */
export const loadQuestionStats = cached(
  (filters) => call('analytics_question_stats', params(filters)).then((data) => {
    const rows = data ?? []
    rows.forEach(assertDenominators)
    return rows
  }),
  60_000,
)

/** FR-38: Likert distributions, one row per (question, option). Cached 60 s. */
export const loadDistribution = cached(
  (filters) => call('analytics_distribution', params(filters)),
  60_000,
)

/** FR-38: single/multi select distributions. Cached 60 s. */
export const loadChoiceDistribution = cached(
  (filters) => call('analytics_choice_distribution', params(filters)),
  60_000,
)

/** FR-39: per-cycle series for repeated questions. Cached 60 s. */
export const loadTrends = cached(({
  stakeholder = null,
  program = null,
  courseKey = null,
  streamId = null,
  departmentId = null,
} = {}) =>
  call('analytics_trends', {
    p_stakeholder: stakeholder || null,
    p_program: program || null,
    p_course_key: courseKey || null,
    p_stream_id: streamId || null,
    p_department_id: departmentId || null,
  }),
  60_000,
)

/** FR-40: long_text answers only. Cached 60 s. */
export const loadTextAnswers = cached(
  (filters, { limit = 1000, offset = 0 } = {}) =>
    call('analytics_text_answers', { ...params(filters), p_limit: limit, p_offset: offset }),
  60_000,
)

/**
 * FR-42: every answer row for the slice, paged.
 *
 * PostgREST caps the rows a single response may return, so an unpaged export
 * truncates silently — worse than a slow one. Paging stops when a short page
 * arrives, and the SQL orders stably so pages cannot repeat or skip rows.
 */
export async function loadExportRows(filters, { pageSize = 5000, maxRows = 200000 } = {}) {
  const all = []

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const page = await call('analytics_export_rows', {
      ...params(filters),
      p_limit: pageSize,
      p_offset: offset,
    })
    const rows = page ?? []
    all.push(...rows)
    if (rows.length < pageSize) return { rows: all, truncated: false }
  }

  // Hit the ceiling: say so rather than handing over a file that looks complete.
  return { rows: all, truncated: true }
}

/**
 * Streaming variant: calls onPage(rows, isFirstPage) for each chunk instead
 * of accumulating all rows in memory. Raw row objects are GC-eligible after
 * each callback, so peak memory is one page (~5k rows) instead of 200k.
 */
export async function streamExportRows(filters, onPage, { pageSize = 5000, maxRows = 200000 } = {}) {
  let total = 0

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const page = await call('analytics_export_rows', {
      ...params(filters),
      p_limit: pageSize,
      p_offset: offset,
    })
    const rows = page ?? []
    onPage(rows, offset === 0)
    total += rows.length
    if (rows.length < pageSize) return { total, truncated: false }
  }

  return { total, truncated: true }
}

/** Participation rates per (stakeholder, department). Cached 60 s. */
export const loadParticipation = cached(
  (filters) => call('analytics_participation', {
    p_cycle_id: filters.cycleId || null,
    p_stakeholder: filters.stakeholder || null,
    p_stream_id: filters.streamId || null,
    p_department_id: filters.departmentId || null,
  }),
  60_000,
)

/** Normalised averages per (question, department) for the heatmap. Cached 60 s. */
export const loadHeatmap = cached(
  (filters) => call('analytics_heatmap', params(filters)),
  60_000,
)

/** Avg normalised score per course, sorted. Cached 60 s. */
export const loadCourseRanking = cached(
  (filters) => call('analytics_course_ranking', {
    p_cycle_id: filters.cycleId || null,
    p_stakeholder: filters.stakeholder || null,
    p_program: filters.program || null,
    p_stream_id: filters.streamId || null,
    p_department_id: filters.departmentId || null,
  }),
  60_000,
)

/** Per-question avg this cycle vs previous, with delta. Cached 60 s. */
export const loadCycleDelta = cached(
  (filters) => call('analytics_cycle_delta', params(filters)),
  60_000,
)

/** Hourly submission counts. Cached 60 s. */
export const loadSubmissionTimeline = cached(
  (filters) => call('analytics_submission_timeline', {
    p_cycle_id: filters.cycleId || null,
    p_stakeholder: filters.stakeholder || null,
    p_stream_id: filters.streamId || null,
    p_department_id: filters.departmentId || null,
  }),
  60_000,
)

/** % blank/short/substantive text answers per question. Cached 60 s. */
export const loadResponseQuality = cached(
  (filters) => call('analytics_response_quality', params(filters)),
  60_000,
)

/** Dept avg vs college avg per question. Cached 60 s. */
export const loadDepartmentBenchmark = cached(
  (filters) => call('analytics_department_benchmark', {
    p_cycle_id: filters.cycleId || null,
    p_stakeholder: filters.stakeholder || null,
    p_program: filters.program || null,
    p_stream_id: filters.streamId || null,
    p_department_id: filters.departmentId || null,
  }),
  60_000,
)

export { assertDenominators }
