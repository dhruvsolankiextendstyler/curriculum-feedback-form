/**
 * Tests for remapping stored answers onto the question versions the form is
 * currently rendering (FR-16, FR-17 vs FR-31).
 *
 * The function lives in submissions.js, which imports the Supabase client, so it
 * is re-declared here rather than imported. That duplication is deliberate and
 * the two must be kept in step — the alternative is a browser-only test that
 * never runs in CI.
 *
 * Run with `npm run check`.
 */
import assert from 'node:assert/strict'

// ---- mirror of remapAnswersToCurrentVersions in src/lib/submissions.js ----
function remapAnswersToCurrentVersions(answers, questions) {
  if (!questions) return answers

  const currentVersionByQuestionId = new Map(questions.map((q) => [q.id, q.versionId]))

  return answers
    .map((row) => {
      const questionId = Array.isArray(row.question_versions)
        ? row.question_versions[0]?.question_id
        : row.question_versions?.question_id

      if (!questionId) return row

      const currentVersionId = currentVersionByQuestionId.get(questionId)
      if (!currentVersionId) return null

      return { ...row, question_version_id: currentVersionId }
    })
    .filter(Boolean)
}

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// A question that has been reworded: answered at v1, form now serves v2.
const rewordedQuestion = { id: 'q-effectiveness', versionId: 'v2-effectiveness' }
const stableQuestion = { id: 'q-class', versionId: 'v1-class' }

const answerAtOldVersion = {
  question_version_id: 'v1-effectiveness',
  value_text: 'Very Good',
  value_numeric: 4,
  value_options: null,
  question_versions: { question_id: 'q-effectiveness' },
}

const answerAtCurrentVersion = {
  question_version_id: 'v1-class',
  value_text: null,
  value_numeric: null,
  value_options: ['ty'],
  question_versions: { question_id: 'q-class' },
}

console.log('\nremapAnswersToCurrentVersions')

check('REGRESSION: an answer at an old version is carried onto the current one', () => {
  // The bug: the student's "Very Good" vanished from the form after an admin
  // reworded the question, so re-saving would have silently dropped it.
  const [row] = remapAnswersToCurrentVersions([answerAtOldVersion], [rewordedQuestion])
  assert.equal(row.question_version_id, 'v2-effectiveness')
  assert.equal(row.value_text, 'Very Good')
  assert.equal(row.value_numeric, 4)
})

check('an answer already at the current version is untouched', () => {
  const [row] = remapAnswersToCurrentVersions([answerAtCurrentVersion], [stableQuestion])
  assert.equal(row.question_version_id, 'v1-class')
  assert.deepEqual(row.value_options, ['ty'])
})

check('the stored row is not mutated (history stays intact)', () => {
  const original = { ...answerAtOldVersion }
  remapAnswersToCurrentVersions([answerAtOldVersion], [rewordedQuestion])
  assert.deepEqual(answerAtOldVersion, original)
})

check('an answer to a soft-deleted question is dropped', () => {
  // Its question is absent from the live form, so there is no field to fill.
  const rows = remapAnswersToCurrentVersions([answerAtOldVersion], [stableQuestion])
  assert.equal(rows.length, 0)
})

check('handles the embedded join arriving as an array', () => {
  const arrayShaped = {
    ...answerAtOldVersion,
    question_versions: [{ question_id: 'q-effectiveness' }],
  }
  const [row] = remapAnswersToCurrentVersions([arrayShaped], [rewordedQuestion])
  assert.equal(row.question_version_id, 'v2-effectiveness')
})

check('a row with no question_id is passed through unchanged', () => {
  const noJoin = { question_version_id: 'v9', value_text: 'x' }
  const [row] = remapAnswersToCurrentVersions([noJoin], [rewordedQuestion])
  assert.equal(row.question_version_id, 'v9')
})

check('without a question list, answers pass through untouched', () => {
  const rows = remapAnswersToCurrentVersions([answerAtOldVersion], null)
  assert.equal(rows[0].question_version_id, 'v1-effectiveness')
})

check('an empty answer set stays empty', () =>
  assert.deepEqual(remapAnswersToCurrentVersions([], [rewordedQuestion]), []))

check('a mixed set remaps only what moved', () => {
  const rows = remapAnswersToCurrentVersions(
    [answerAtOldVersion, answerAtCurrentVersion],
    [rewordedQuestion, stableQuestion],
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[0].question_version_id, 'v2-effectiveness')
  assert.equal(rows[1].question_version_id, 'v1-class')
})

console.log(`\n${passed} remap checks passed\n`)
