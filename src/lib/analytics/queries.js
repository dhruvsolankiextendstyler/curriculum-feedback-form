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

  if (code === '42501' || /admin access is required/i.test(message)) {
    return 'Admin access is required to view analytics.'
  }
  if (code === '42883' || code === 'PGRST202' || /could not find the function/i.test(message)) {
    return `The analytics functions on this database do not match this build. Run supabase/migrations/0005_analytics.sql and 0008_departments.sql, then reload. (missing: ${fn})`
  }
  return message
}

/** FR-37: the values the filter dropdowns can offer. */
export const loadFilterOptions = (cycleId = null) =>
  call('analytics_filter_options', { p_cycle_id: cycleId || null })

/** FR-35: headline counts, by stakeholder, program, course and cycle. */
export const loadTotals = (filters) => call('analytics_totals', params(filters))

/** FR-36 + FR-34: per-question averages, denominators and version spread. */
export async function loadQuestionStats(filters) {
  const rows = (await call('analytics_question_stats', params(filters))) ?? []
  rows.forEach(assertDenominators)
  return rows
}

/** FR-38: Likert distributions, one row per (question, option). */
export const loadDistribution = (filters) => call('analytics_distribution', params(filters))

/** FR-38: single/multi select distributions. */
export const loadChoiceDistribution = (filters) =>
  call('analytics_choice_distribution', params(filters))

/** FR-39: per-cycle series for repeated questions. Cycle is the axis, not a filter. */
export const loadTrends = ({
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
  })

/** FR-40: long_text answers only — see the SQL for why that matters. */
export const loadTextAnswers = (filters, { limit = 1000, offset = 0 } = {}) =>
  call('analytics_text_answers', { ...params(filters), p_limit: limit, p_offset: offset })

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

export { assertDenominators }
