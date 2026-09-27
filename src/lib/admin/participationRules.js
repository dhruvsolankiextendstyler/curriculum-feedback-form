// HOD feedback-participation helpers (pure — no Supabase import, so `npm run check`
// can load it, exactly like departmentRules.js beside it).
//
// The question an HOD asks: "who in my department hasn't given feedback this cycle,
// so I can remind them?" The set of ids that HAVE responded is loaded separately
// (loadRespondedUserIds in users.js); RLS already narrows that set to the HOD's own
// department, so nothing here needs to know about departments or scope.
import { isStaff } from '../constants.js'

export const FEEDBACK = {
  FILLED: 'filled', // submitted at least one response in the active cycle
  PENDING: 'pending', // a respondent who has not submitted yet — the chase-list
  NA: 'na', // staff (admin / HOD): no feedback form to fill
  UNKNOWN: 'unknown', // no active cycle, so there is nothing to measure against
}

export const FEEDBACK_LABELS = {
  [FEEDBACK.FILLED]: 'Filled',
  [FEEDBACK.PENDING]: 'Not filled',
  [FEEDBACK.NA]: '—',
  [FEEDBACK.UNKNOWN]: '—',
}

/**
 * Feedback status of one account for the active cycle.
 *
 * @param {{id: string, role: string}} user
 * @param {Set<string>|null} respondedIds  ids that submitted in the active cycle
 * @param {{hasActiveCycle: boolean}} ctx
 * @returns {string} one of FEEDBACK.*
 */
export function feedbackStatus(user, respondedIds, { hasActiveCycle } = {}) {
  // Staff have no form (forms_respondent_only in 0011_hod_scope.sql), so the
  // column is meaningless for the HOD's own row.
  if (isStaff(user.role)) return FEEDBACK.NA
  if (!hasActiveCycle) return FEEDBACK.UNKNOWN
  const has = respondedIds && typeof respondedIds.has === 'function' && respondedIds.has(user.id)
  return has ? FEEDBACK.FILLED : FEEDBACK.PENDING
}

/** Client-side predicate for the "Feedback" filter: 'all' | 'filled' | 'pending'. */
export function matchesFeedbackFilter(status, filter) {
  if (filter === 'filled') return status === FEEDBACK.FILLED
  if (filter === 'pending') return status === FEEDBACK.PENDING
  return true // 'all' (or any unknown value) hides nothing
}
