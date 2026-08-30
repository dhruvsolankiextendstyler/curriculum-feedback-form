/**
 * Unit tests for how a sign-in identifier is read, and what a SAP ID may be
 * (FR-1). These rules decide which of two credentials the login field means, so
 * a mistake here is a lockout or a mistaken identity rather than a cosmetic bug.
 *
 * Run with `npm run check`.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const {
  classifyIdentifier,
  isEmail,
  isValidSapId,
  normaliseSapId,
  validateSapId,
  SAP_ID_PATTERN,
} = await load('src/lib/identifier.js')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('\nnormaliseSapId')
check('trims and upper-cases', () => assert.equal(normaliseSapId('  ab12  '), 'AB12'))
check('null is safe', () => assert.equal(normaliseSapId(null), ''))
check('a number is accepted', () => assert.equal(normaliseSapId(70011234567), '70011234567'))

console.log('\nisValidSapId')
check('a numeric college ID passes', () => assert.equal(isValidSapId('70011234567'), true))
check('letters and digits pass', () => assert.equal(isValidSapId('CSE-2026/014'), true))
check('case does not matter', () => assert.equal(isValidSapId('ab12'), true))
check('two characters is too short', () => assert.equal(isValidSapId('a1'), false))
check('33 characters is too long', () =>
  assert.equal(isValidSapId('A'.repeat(33)), false))
check('a leading separator is rejected', () => assert.equal(isValidSapId('-70011'), false))
check('a space is rejected', () => assert.equal(isValidSapId('700 112'), false))
check('an email address is not a SAP ID', () =>
  assert.equal(isValidSapId('a@college.edu'), false))
check('blank is not valid on its own', () => assert.equal(isValidSapId(''), false))

console.log('\nvalidateSapId — optional, so blank succeeds with null')
check('blank yields a null value', () =>
  assert.deepEqual(validateSapId(''), { ok: true, value: null }))
check('whitespace only yields a null value', () =>
  assert.deepEqual(validateSapId('   '), { ok: true, value: null }))
check('undefined yields a null value', () =>
  assert.deepEqual(validateSapId(undefined), { ok: true, value: null }))
check('a good ID comes back normalised', () =>
  assert.deepEqual(validateSapId(' cse-14 '), { ok: true, value: 'CSE-14' }))
check('an "@" is called out specifically', () => {
  const result = validateSapId('a@b.com')
  assert.equal(result.ok, false)
  assert.match(result.reason, /@/)
})
check('a bad shape explains the rule', () => {
  const result = validateSapId('a b')
  assert.equal(result.ok, false)
  assert.match(result.reason, /letters, digits/i)
})

console.log('\nclassifyIdentifier — which credential was typed')
check('an address is read as email, lowercased', () =>
  assert.deepEqual(classifyIdentifier('  Asha@College.EDU '), {
    kind: 'email',
    value: 'asha@college.edu',
    valid: true,
  }))
check('anything with an "@" is an email, even a broken one', () => {
  const result = classifyIdentifier('asha@college')
  assert.equal(result.kind, 'email')
  assert.equal(result.valid, false)
})
check('a number is read as a SAP ID', () =>
  assert.deepEqual(classifyIdentifier('70011234567'), {
    kind: 'sap_id',
    value: '70011234567',
    valid: true,
  }))
check('a SAP ID is upper-cased to its stored form', () =>
  assert.equal(classifyIdentifier('cse-14').value, 'CSE-14'))
check('an unusable SAP ID is still classified, and marked invalid', () => {
  const result = classifyIdentifier('a1')
  assert.equal(result.kind, 'sap_id')
  assert.equal(result.valid, false)
})
check('empty is its own kind, so the form can say so', () =>
  assert.equal(classifyIdentifier('   ').kind, 'empty'))
check('null does not throw', () => assert.equal(classifyIdentifier(null).kind, 'empty'))

console.log('\nthe two identifier kinds cannot overlap')
check('no valid SAP ID contains an "@"', () => {
  // This is what makes one login field unambiguous. If it ever stops holding,
  // classifyIdentifier is guessing.
  for (const candidate of ['a@b.co', 'a@b', '@700112', '700112@', 'x@y.z']) {
    assert.equal(SAP_ID_PATTERN.test(normaliseSapId(candidate)), false, candidate)
  }
})
check('no email address passes as a SAP ID', () => {
  for (const candidate of ['asha@college.edu', 'A.B@x.co.in']) {
    assert.equal(isEmail(candidate), true, candidate)
    assert.equal(isValidSapId(candidate), false, candidate)
  }
})

console.log(`\n${passed} identifier checks passed\n`)
