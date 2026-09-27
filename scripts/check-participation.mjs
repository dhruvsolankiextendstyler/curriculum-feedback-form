/**
 * Unit tests for the HOD feedback-participation helpers.
 *
 * Run with `npm run check`. Only participationRules.js is exercised — it is pure,
 * exactly like departmentRules.js; the Supabase loaders (loadRespondedUserIds,
 * loadActiveCycle) need a browser env and are covered by manual UI test cases.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const { feedbackStatus, matchesFeedbackFilter, FEEDBACK, FEEDBACK_LABELS } = await load(
  'src/lib/admin/participationRules.js',
)

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

const responded = new Set(['u-filled', 'u-also-filled'])
const cycleOpen = { hasActiveCycle: true }

check('staff have no form status (their own row is not a chase target)', () => {
  assert.equal(feedbackStatus({ id: 'a', role: 'admin' }, responded, cycleOpen), FEEDBACK.NA)
  assert.equal(feedbackStatus({ id: 'h', role: 'hod' }, responded, cycleOpen), FEEDBACK.NA)
})

check('with no active cycle a respondent is unknown, never "not filled"', () => {
  assert.equal(
    feedbackStatus({ id: 's', role: 'student' }, responded, { hasActiveCycle: false }),
    FEEDBACK.UNKNOWN,
  )
})

check('a respondent who submitted is filled', () => {
  assert.equal(feedbackStatus({ id: 'u-filled', role: 'student' }, responded, cycleOpen), FEEDBACK.FILLED)
})

check('a respondent who has not submitted is pending', () => {
  assert.equal(feedbackStatus({ id: 'u-none', role: 'faculty' }, responded, cycleOpen), FEEDBACK.PENDING)
})

check('a null/loading responded set does not throw', () => {
  assert.equal(feedbackStatus({ id: 'u-none', role: 'student' }, null, cycleOpen), FEEDBACK.PENDING)
})

check('the filter isolates one status; "all" hides nothing', () => {
  assert.equal(matchesFeedbackFilter(FEEDBACK.PENDING, 'pending'), true)
  assert.equal(matchesFeedbackFilter(FEEDBACK.FILLED, 'pending'), false)
  assert.equal(matchesFeedbackFilter(FEEDBACK.FILLED, 'filled'), true)
  assert.equal(matchesFeedbackFilter(FEEDBACK.NA, 'all'), true)
  assert.equal(matchesFeedbackFilter(FEEDBACK.PENDING, 'all'), true)
})

check('labels read as a chase-list', () => {
  assert.equal(FEEDBACK_LABELS[FEEDBACK.FILLED], 'Filled')
  assert.equal(FEEDBACK_LABELS[FEEDBACK.PENDING], 'Not filled')
})

console.log(`\n${passed} participation checks passed\n`)
