/**
 * Unit tests for the form validation + answer-mapping layer.
 * Run with `npm run check`. No test framework: plain assertions keep the
 * zero-budget dependency list short.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const { validateAnswer, validateForm, toAnswerRow, isBlank, allowedValues, answersToValues } =
  await load('src/lib/validation.js')

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
    { id: 'o1', label: 'Excellent', score: 5, display_order: 1 },
    { id: 'o2', label: 'Good', score: 3, display_order: 2 },
    { id: 'o3', label: 'Not applicable', score: null, display_order: 3 },
  ],
}

const rating = { versionId: 'v1', type: 'rating', required: true, scale }
const optionalRating = { ...rating, versionId: 'v1o', required: false }
const shortText = { versionId: 'v2', type: 'short_text', required: true }
const longText = { versionId: 'v3', type: 'long_text', required: false }
const single = {
  versionId: 'v4',
  type: 'single_select',
  required: true,
  options: [
    { id: 'a', label: 'SY', value: 'sy', display_order: 1 },
    { id: 'b', label: 'TY', value: 'ty', display_order: 2 },
  ],
}
const multi = {
  versionId: 'v5',
  type: 'multi_select',
  required: false,
  options: [
    { id: 'c', label: 'B.Sc', value: 'bsc', display_order: 1 },
    { id: 'd', label: 'B.Com', value: 'bcom', display_order: 2 },
  ],
}

console.log('\nisBlank')
check('empty string is blank', () => assert.equal(isBlank(''), true))
check('whitespace is blank', () => assert.equal(isBlank('   '), true))
check('empty array is blank', () => assert.equal(isBlank([]), true))
check('null is blank', () => assert.equal(isBlank(null), true))
check('zero is not blank', () => assert.equal(isBlank(0), false))
check('text is not blank', () => assert.equal(isBlank('hi'), false))

console.log('\nrequired fields')
check('required rating unanswered fails', () =>
  assert.match(validateAnswer(rating, undefined), /choose an option/i))
check('required text unanswered fails', () =>
  assert.match(validateAnswer(shortText, '  '), /required/i))
check('optional empty passes', () =>
  assert.equal(validateAnswer(longText, ''), null))
check('optional rating empty passes', () =>
  assert.equal(validateAnswer(optionalRating, null), null))

console.log('\nvalue must exist in the scale/options')
check('valid rating label passes', () =>
  assert.equal(validateAnswer(rating, 'Excellent'), null))
check('non-scoring label is still a valid answer', () =>
  assert.equal(validateAnswer(rating, 'Not applicable'), null))
check('stale rating label rejected', () =>
  assert.match(validateAnswer(rating, 'Superb'), /no longer available/i))
check('valid single_select passes', () =>
  assert.equal(validateAnswer(single, 'ty'), null))
check('unknown single_select rejected', () =>
  assert.match(validateAnswer(single, 'pg'), /no longer available/i))
check('array into single_select rejected', () =>
  assert.match(validateAnswer(single, ['ty']), /single option/i))
check('valid multi_select passes', () =>
  assert.equal(validateAnswer(multi, ['bsc', 'bcom']), null))
check('unknown value in multi_select rejected', () =>
  assert.match(validateAnswer(multi, ['bsc', 'nope']), /no longer available/i))
check('duplicate multi_select rejected', () =>
  assert.match(validateAnswer(multi, ['bsc', 'bsc']), /duplicate/i))

console.log('\nlength limits')
check('over-long short text rejected', () =>
  assert.match(validateAnswer(shortText, 'x'.repeat(201)), /under 200/i))
check('at-limit short text passes', () =>
  assert.equal(validateAnswer(shortText, 'x'.repeat(200)), null))
check('over-long long text rejected', () =>
  assert.match(validateAnswer(longText, 'x'.repeat(4001)), /under 4000/i))

console.log('\nallowedValues')
check('rating draws from scale labels', () =>
  assert.deepEqual(allowedValues(rating), ['Excellent', 'Good', 'Not applicable']))
check('select draws from option values', () =>
  assert.deepEqual(allowedValues(single), ['sy', 'ty']))

console.log('\nvalidateForm')
check('reports every invalid field', () => {
  const { errors, ok } = validateForm([rating, shortText, single], {})
  assert.equal(ok, false)
  assert.equal(Object.keys(errors).length, 3)
})
check('firstInvalid follows question order', () => {
  const { firstInvalid } = validateForm([rating, shortText], { v1: 'Good' })
  assert.equal(firstInvalid, 'v2')
})
check('fully answered form is ok', () => {
  const { ok, firstInvalid } = validateForm([rating, shortText, single, multi], {
    v1: 'Good',
    v2: 'Dharmik',
    v4: 'sy',
  })
  assert.equal(ok, true)
  assert.equal(firstInvalid, null)
})

console.log('\ntoAnswerRow')
check('rating stores label and score', () => {
  const row = toAnswerRow(rating, 'Excellent')
  assert.equal(row.value_text, 'Excellent')
  assert.equal(row.value_numeric, 5)
  assert.equal(row.value_options, null)
})
check('non-scoring option stores null score (excluded from averages)', () => {
  const row = toAnswerRow(rating, 'Not applicable')
  assert.equal(row.value_text, 'Not applicable')
  assert.equal(row.value_numeric, null)
})
check('single_select stores a 1-element array', () =>
  assert.deepEqual(toAnswerRow(single, 'ty').value_options, ['ty']))
check('multi_select stores all values', () =>
  assert.deepEqual(toAnswerRow(multi, ['bsc', 'bcom']).value_options, ['bsc', 'bcom']))
check('text is trimmed', () =>
  assert.equal(toAnswerRow(shortText, '  Dharmik  ').value_text, 'Dharmik'))
check('blank answer produces no row', () =>
  assert.equal(toAnswerRow(longText, '   '), null))
check('row carries the version id, not the question id', () =>
  assert.equal(toAnswerRow(rating, 'Good').question_version_id, 'v1'))

console.log('\nround-trip: form value -> DB row -> form value')
check('rating round-trips to its label', () => {
  const row = toAnswerRow(rating, 'Good')
  assert.equal(answersToValues([row])[rating.versionId], 'Good')
})
check('single_select unwraps back to a string', () => {
  const row = toAnswerRow(single, 'ty')
  assert.equal(answersToValues([row])[single.versionId], 'ty')
})
check('multi_select stays an array', () => {
  const row = toAnswerRow(multi, ['bsc', 'bcom'])
  assert.deepEqual(answersToValues([row])[multi.versionId], ['bsc', 'bcom'])
})
// Both select types store an array, so length alone cannot distinguish them.
// With the question map supplied, a one-choice multi_select must stay an array
// and stay directly re-validatable — otherwise reopening a submission for
// editing fails on save.
const qMap = new Map([
  [single.versionId, single],
  [multi.versionId, multi],
  [rating.versionId, rating],
])

check('type-aware: one-choice multi_select stays an array', () => {
  const row = toAnswerRow(multi, ['bsc'])
  const restored = answersToValues([row], qMap)[multi.versionId]
  assert.deepEqual(restored, ['bsc'])
  assert.equal(validateAnswer(multi, restored), null)
})
check('type-aware: single_select still unwraps to a string', () => {
  const row = toAnswerRow(single, 'ty')
  const restored = answersToValues([row], qMap)[single.versionId]
  assert.equal(restored, 'ty')
  assert.equal(validateAnswer(single, restored), null)
})
check('without the map, one-choice multi_select falls back to a string', () => {
  // Documents the heuristic's limit; loadResponse always passes the map.
  const row = toAnswerRow(multi, ['bsc'])
  assert.equal(answersToValues([row])[multi.versionId], 'bsc')
})


// ---------- bindingIdFor: insert vs update (FR-13, FR-15) ----------
const { bindingIdFor } = await load('src/lib/validation.js')

console.log('\nbindingIdFor — which row a save targets')
check('fresh /feedback/new inserts', () =>
  assert.equal(bindingIdFor(undefined, null), null))
check('editing an existing submission updates that row', () =>
  assert.equal(bindingIdFor('resp-1', null), 'resp-1'))
check('route id wins over a stale saved id', () => {
  // Navigating /feedback/a -> /feedback/b must not write to `a`.
  assert.equal(bindingIdFor('resp-b', 'resp-a'), 'resp-b')
})
check('re-saving the same new submission updates it, not a duplicate', () =>
  assert.equal(bindingIdFor(undefined, 'resp-new'), 'resp-new'))
check('REGRESSION: /feedback/<id> -> /feedback/new must insert', () => {
  // The bug: FeedbackForm stays mounted across this navigation, so an id from
  // the previous save leaked in and silently overwrote the earlier submission.
  // The page now resets savedId in the load effect; if that reset is ever
  // removed, savedId would be 'resp-old' here and this asserts the intent.
  assert.equal(bindingIdFor(undefined, null), null)
})

console.log(`
${passed} validation checks passed
`)
