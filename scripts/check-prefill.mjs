/**
 * Unit tests for account-sourced identity answers (src/lib/prefill.js).
 *
 * Run with `npm run check`. The module is deliberately dependency-free, so the
 * rules that decide whether a respondent can type in a field are checked here
 * rather than only in a browser.
 *
 * The cases that matter are the refusals: a locked field the account cannot fill
 * is a form nobody can submit, and a locked field on the wrong question type is a
 * value its own option list rejects.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const { accountIdentity, prefillIdentity, IDENTITY_FIELD_BY_KEY, PREFILL_HINTS } =
  await load('src/lib/prefill.js')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// ---------- fixtures ----------
const questions = [
  { key: 'name', type: 'short_text', versionId: 'v-name' },
  { key: 'sap_number', type: 'short_text', versionId: 'v-sap' },
  { key: 'department', type: 'short_text', versionId: 'v-dept' },
  { key: 'course_title', type: 'short_text', versionId: 'v-course' },
  { key: 'program', type: 'single_select', versionId: 'v-program' },
  { key: 'recommendations', type: 'long_text', versionId: 'v-rec' },
]

const fullProfile = {
  full_name: 'Asha Menon',
  sap_id: '60001234567',
  department_id: 'd-cs',
}

console.log('prefill.js')

// ---------- accountIdentity ----------
check('reads name, SAP ID and the resolved department name', () => {
  const identity = accountIdentity(fullProfile, 'Computer Science')
  assert.deepEqual(identity, {
    fullName: 'Asha Menon',
    sapId: '60001234567',
    departmentName: 'Computer Science',
  })
})

check('blank and whitespace-only account values read as absent', () => {
  const identity = accountIdentity({ full_name: '   ', sap_id: '' }, '  ')
  assert.deepEqual(identity, { fullName: null, sapId: null, departmentName: null })
})

check('a missing profile does not throw', () => {
  assert.deepEqual(accountIdentity(null), {
    fullName: null,
    sapId: null,
    departmentName: null,
  })
})

// ---------- prefillIdentity ----------
check('fills and locks the three identity questions', () => {
  const { values, locked } = prefillIdentity(
    questions,
    accountIdentity(fullProfile, 'Computer Science'),
  )
  assert.deepEqual(values, {
    'v-name': 'Asha Menon',
    'v-sap': '60001234567',
    'v-dept': 'Computer Science',
  })
  assert.deepEqual([...locked].sort(), ['v-dept', 'v-name', 'v-sap'])
})

check('leaves the course and the free-text answer alone', () => {
  // A course is a property of the submission, not of the account: the whole
  // point of one-response-per-course is that a respondent files several.
  const { values, locked } = prefillIdentity(
    questions,
    accountIdentity(fullProfile, 'Computer Science'),
  )
  assert.equal(values['v-course'], undefined)
  assert.equal(values['v-rec'], undefined)
  assert.equal(locked.has('v-course'), false)
  assert.equal(locked.has('v-rec'), false)
})

check('an account with no SAP ID leaves that field fillable', () => {
  const { values, locked } = prefillIdentity(
    questions,
    accountIdentity({ full_name: 'Asha Menon' }, 'Computer Science'),
  )
  assert.equal(values['v-sap'], undefined)
  assert.equal(locked.has('v-sap'), false, 'a required SAP question must stay answerable')
  assert.equal(locked.has('v-name'), true)
})

check('a respondent with no department leaves that field fillable', () => {
  const { locked } = prefillIdentity(questions, accountIdentity(fullProfile, null))
  assert.equal(locked.has('v-dept'), false)
})

check('a retyped identity question is not forced', () => {
  // An admin can change `name` to a dropdown. Writing an account string into it
  // would produce a value its own option list rejects on validation.
  const retyped = [{ key: 'name', type: 'single_select', versionId: 'v-name' }]
  const { values, locked } = prefillIdentity(retyped, accountIdentity(fullProfile))
  assert.deepEqual(values, {})
  assert.equal(locked.size, 0)
})

check('every mapped field has a hint to explain the lock', () => {
  for (const field of Object.values(IDENTITY_FIELD_BY_KEY)) {
    assert.equal(typeof PREFILL_HINTS[field], 'string', `no hint for ${field}`)
    assert.ok(PREFILL_HINTS[field].length > 0)
  }
})

check('an empty form and a missing identity are both no-ops', () => {
  assert.deepEqual(prefillIdentity([], accountIdentity(fullProfile)).values, {})
  assert.deepEqual(prefillIdentity(questions, null).values, {})
  assert.deepEqual(prefillIdentity(undefined, undefined).values, {})
})

console.log(`\n${passed} prefill checks passed.`)
