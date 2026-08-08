/**
 * Tests for the resave planner: what happens to stored answers when a
 * respondent edits a submission (FR-16, FR-17 vs FR-31, FR-32).
 *
 * Run with `npm run check`. No test framework: plain assertions keep the
 * zero-budget dependency list short. planAnswerWrite lives in validation.js
 * precisely so it can be imported here without pulling in the Supabase client.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const { planAnswerWrite, questionIdOf } = await load('src/lib/validation.js')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// ---------- fixtures ----------
const scale = {
  id: 's1',
  options: [
    { id: 'o1', label: 'Very Good', score: 4, display_order: 1 },
    { id: 'o2', label: 'Good', score: 3, display_order: 2 },
    { id: 'o3', label: 'Not applicable', score: null, display_order: 3 },
  ],
}

/** Reworded since it was answered: stored at v1, the form now serves v2. */
const reworded = {
  id: 'q-effectiveness',
  versionId: 'v2-effectiveness',
  type: 'rating',
  required: true,
  scale,
}

const stable = {
  id: 'q-facilities',
  versionId: 'v1-facilities',
  type: 'rating',
  required: true,
  scale,
}

const textQuestion = {
  id: 'q-recommendations',
  versionId: 'v1-recommendations',
  type: 'long_text',
  required: false,
}

const multiQuestion = {
  id: 'q-areas',
  versionId: 'v1-areas',
  type: 'multi_select',
  required: false,
  options: [
    { value: 'labs', label: 'Labs' },
    { value: 'library', label: 'Library' },
  ],
}

const storedAtOldVersion = {
  id: 'a-1',
  question_version_id: 'v1-effectiveness',
  value_text: 'Very Good',
  value_numeric: 4,
  value_options: null,
  question_versions: { question_id: 'q-effectiveness' },
}

/** Its question was soft-deleted, so it has no field on the live form. */
const storedForDeletedQuestion = {
  id: 'a-deleted',
  question_version_id: 'v1-time-allocation',
  value_text: 'Good',
  value_numeric: 3,
  value_options: null,
  question_versions: { question_id: 'q-time-allocation' },
}

console.log('\nplanAnswerWrite')

check('REGRESSION: a soft-deleted question keeps its answer through a resave', () => {
  // The bug: writeAnswers deleted every row and re-inserted only the live form's,
  // so editing anything destroyed this answer. FR-32 promises it survives in
  // analytics after the question leaves the form.
  const plan = planAnswerWrite(
    [storedForDeletedQuestion, storedAtOldVersion],
    [reworded],
    { 'v2-effectiveness': 'Very Good' },
  )
  assert.ok(plan.keepIds.includes('a-deleted'))
  assert.ok(!plan.deleteIds.includes('a-deleted'))
  assert.equal(plan.insertRows.length, 0)
})

check('REGRESSION: an untouched answer keeps the version it was given against', () => {
  // Re-attributing it to v2 would rewrite history (FR-31) and switch off the
  // FR-34 "average spans reworded variants" warning while it is still true.
  const plan = planAnswerWrite([storedAtOldVersion], [reworded], {
    'v2-effectiveness': 'Very Good',
  })
  assert.deepEqual(plan.keepIds, ['a-1'])
  assert.deepEqual(plan.deleteIds, [])
  assert.deepEqual(plan.insertRows, [])
})

check('a changed answer moves to the current version', () => {
  const plan = planAnswerWrite([storedAtOldVersion], [reworded], {
    'v2-effectiveness': 'Good',
  })
  assert.deepEqual(plan.deleteIds, ['a-1'])
  assert.equal(plan.insertRows.length, 1)
  assert.equal(plan.insertRows[0].question_version_id, 'v2-effectiveness')
  assert.equal(plan.insertRows[0].value_text, 'Good')
  assert.equal(plan.insertRows[0].value_numeric, 3)
})

check('a blanked answer is deleted and not re-inserted', () => {
  const plan = planAnswerWrite([storedAtOldVersion], [reworded], {
    'v2-effectiveness': '',
  })
  assert.deepEqual(plan.deleteIds, ['a-1'])
  assert.deepEqual(plan.insertRows, [])
  assert.deepEqual(plan.keepIds, [])
})

check('a newly answered question is inserted', () => {
  const plan = planAnswerWrite([], [stable], { 'v1-facilities': 'Good' })
  assert.deepEqual(plan.deleteIds, [])
  assert.equal(plan.insertRows.length, 1)
  assert.equal(plan.insertRows[0].question_version_id, 'v1-facilities')
})

check('an unanswered, still-blank question writes nothing', () => {
  const plan = planAnswerWrite([], [textQuestion], { 'v1-recommendations': '' })
  assert.deepEqual(plan, { keepIds: [], deleteIds: [], insertRows: [] })
})

check('a non-scoring option is preserved, not treated as unanswered', () => {
  // value_numeric is null for "Not applicable"; a null-vs-null comparison must
  // count as unchanged or every resave would churn the row onto a new version.
  const stored = {
    id: 'a-na',
    question_version_id: 'v1-facilities',
    value_text: 'Not applicable',
    value_numeric: null,
    value_options: null,
    question_versions: { question_id: 'q-facilities' },
  }
  const plan = planAnswerWrite([stored], [stable], { 'v1-facilities': 'Not applicable' })
  assert.deepEqual(plan.keepIds, ['a-na'])
  assert.deepEqual(plan.insertRows, [])
})

check('numeric returned as a string still counts as unchanged', () => {
  const stored = { ...storedAtOldVersion, value_numeric: '4' }
  const plan = planAnswerWrite([stored], [reworded], { 'v2-effectiveness': 'Very Good' })
  assert.deepEqual(plan.keepIds, ['a-1'])
  assert.deepEqual(plan.insertRows, [])
})

check('re-ticking the same multi_select boxes in another order is not a change', () => {
  const stored = {
    id: 'a-multi',
    question_version_id: 'v1-areas',
    value_text: null,
    value_numeric: null,
    value_options: ['labs', 'library'],
    question_versions: { question_id: 'q-areas' },
  }
  const plan = planAnswerWrite([stored], [multiQuestion], {
    'v1-areas': ['library', 'labs'],
  })
  assert.deepEqual(plan.keepIds, ['a-multi'])
  assert.deepEqual(plan.insertRows, [])
})

check('adding a multi_select choice IS a change', () => {
  const stored = {
    id: 'a-multi',
    question_version_id: 'v1-areas',
    value_text: null,
    value_numeric: null,
    value_options: ['labs'],
    question_versions: { question_id: 'q-areas' },
  }
  const plan = planAnswerWrite([stored], [multiQuestion], {
    'v1-areas': ['labs', 'library'],
  })
  assert.deepEqual(plan.deleteIds, ['a-multi'])
  assert.deepEqual(plan.insertRows[0].value_options, ['labs', 'library'])
})

check('text edits are detected, including whitespace-only trims', () => {
  const stored = {
    id: 'a-text',
    question_version_id: 'v1-recommendations',
    value_text: 'More lab time',
    value_numeric: null,
    value_options: null,
    question_versions: { question_id: 'q-recommendations' },
  }
  // toAnswerRow trims, so the padded value is the same stored answer.
  const same = planAnswerWrite([stored], [textQuestion], {
    'v1-recommendations': '  More lab time  ',
  })
  assert.deepEqual(same.keepIds, ['a-text'])

  const changed = planAnswerWrite([stored], [textQuestion], {
    'v1-recommendations': 'More lab time and seats',
  })
  assert.deepEqual(changed.deleteIds, ['a-text'])
  assert.equal(changed.insertRows.length, 1)
})

check('duplicate rows across versions collapse to the matching one', () => {
  // One response can hold rows on two versions of the same question: the unique
  // constraint is (response_id, question_version_id), not per question.
  const older = { ...storedAtOldVersion, id: 'a-old', value_text: 'Good', value_numeric: 3 }
  const newer = {
    ...storedAtOldVersion,
    id: 'a-new',
    question_version_id: 'v2-effectiveness',
  }
  const plan = planAnswerWrite([older, newer], [reworded], {
    'v2-effectiveness': 'Very Good',
  })
  assert.deepEqual(plan.keepIds, ['a-new'])
  assert.deepEqual(plan.deleteIds, ['a-old'])
  assert.deepEqual(plan.insertRows, [])
})

check('a row whose join is missing is kept rather than destroyed', () => {
  const orphan = {
    id: 'a-orphan',
    question_version_id: 'v9',
    value_text: 'x',
    value_numeric: null,
    value_options: null,
  }
  const plan = planAnswerWrite([orphan], [reworded], { 'v2-effectiveness': 'Very Good' })
  assert.deepEqual(plan.keepIds, ['a-orphan'])
  assert.equal(plan.insertRows.length, 1)
})

check('the stored rows are never mutated', () => {
  const before = JSON.parse(JSON.stringify(storedAtOldVersion))
  planAnswerWrite([storedAtOldVersion], [reworded], { 'v2-effectiveness': 'Good' })
  assert.deepEqual(storedAtOldVersion, before)
})

check('every stored row is accounted for exactly once', () => {
  // Nothing may be silently dropped: a row is kept or deleted, never neither.
  const rows = [storedAtOldVersion, storedForDeletedQuestion]
  const plan = planAnswerWrite(rows, [reworded, stable], {
    'v2-effectiveness': 'Good',
    'v1-facilities': 'Good',
  })
  const settled = [...plan.keepIds, ...plan.deleteIds].sort()
  assert.deepEqual(settled, ['a-1', 'a-deleted'])
})

console.log('\nquestionIdOf')

check('reads the embedded join as an object', () =>
  assert.equal(questionIdOf(storedAtOldVersion), 'q-effectiveness'))

check('reads the embedded join as a one-element array', () =>
  assert.equal(
    questionIdOf({ question_versions: [{ question_id: 'q-x' }] }),
    'q-x',
  ))

check('returns null when the join is absent', () =>
  assert.equal(questionIdOf({ question_version_id: 'v9' }), null))

console.log(`\n${passed} submission checks passed\n`)
