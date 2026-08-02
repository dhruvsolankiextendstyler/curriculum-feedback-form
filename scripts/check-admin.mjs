/**
 * Unit tests for the admin panel's pure logic: the versioning decision that
 * protects historical answers (FR-31) and CSV import validation (FR-24).
 *
 * Run with `npm run check`. Only dependency-free modules are exercised here —
 * anything importing the Supabase client needs a browser env.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const {
  requiresNewVersion,
  optionsChanged,
  cosmeticPatch,
  slugifyOptionValue,
  deriveQuestionKey,
  validateQuestionDraft,
} = await load('src/lib/admin/questionDiff.js')

const { validateCsvRows, mapHeaders, normaliseRole, isEmail, chunk } =
  await load('src/lib/admin/csv.js')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// ---------- fixtures ----------
const ratingQ = {
  text: 'Relevance of topics to industry',
  type: 'rating',
  scaleId: 'scale-1',
  required: true,
  options: [],
  order: 3,
}

const selectQ = {
  text: 'Class',
  type: 'single_select',
  scaleId: null,
  required: true,
  options: [
    { label: 'SY', value: 'sy' },
    { label: 'TY', value: 'ty' },
  ],
  order: 1,
}

console.log('\nrequiresNewVersion — substantive edits')
check('reworded text needs a version', () =>
  assert.equal(requiresNewVersion(ratingQ, { ...ratingQ, text: 'Industry relevance' }), true))
check('changed type needs a version', () =>
  assert.equal(
    requiresNewVersion(ratingQ, { ...ratingQ, type: 'long_text', scaleId: null }),
    true,
  ))
check('changed scale needs a version', () =>
  assert.equal(requiresNewVersion(ratingQ, { ...ratingQ, scaleId: 'scale-2' }), true))
check('added option needs a version', () =>
  assert.equal(
    requiresNewVersion(selectQ, {
      ...selectQ,
      options: [...selectQ.options, { label: 'PG I', value: 'pg_i' }],
    }),
    true,
  ))
check('removed option needs a version', () =>
  assert.equal(
    requiresNewVersion(selectQ, { ...selectQ, options: [{ label: 'SY', value: 'sy' }] }),
    true,
  ))
check('reworded option needs a version', () =>
  assert.equal(
    requiresNewVersion(selectQ, {
      ...selectQ,
      options: [
        { label: 'Second Year', value: 'sy' },
        { label: 'TY', value: 'ty' },
      ],
    }),
    true,
  ))
check('reordered options need a version (options are immutable once answered)', () =>
  assert.equal(
    requiresNewVersion(selectQ, {
      ...selectQ,
      options: [
        { label: 'TY', value: 'ty' },
        { label: 'SY', value: 'sy' },
      ],
    }),
    true,
  ))

console.log('\nrequiresNewVersion — cosmetic edits stay in place')
check('identical draft needs no version', () =>
  assert.equal(requiresNewVersion(ratingQ, { ...ratingQ }), false))
check('required flag alone needs no version', () =>
  assert.equal(requiresNewVersion(ratingQ, { ...ratingQ, required: false }), false))
check('reorder alone needs no version', () =>
  assert.equal(requiresNewVersion(ratingQ, { ...ratingQ, order: 9 }), false))
check('whitespace-only text change is not an edit', () =>
  assert.equal(
    requiresNewVersion(ratingQ, { ...ratingQ, text: `  ${ratingQ.text}  ` }),
    false,
  ))
check('undefined vs null scale are equivalent', () =>
  assert.equal(
    requiresNewVersion(
      { ...selectQ, scaleId: null },
      { ...selectQ, scaleId: undefined },
    ),
    false,
  ))
check('a new option with no value yet matches its stored slug', () => {
  // The editor leaves `value` empty for freshly typed options; the write path
  // slugifies the label. Comparison must not treat that as a change.
  const stored = { ...selectQ, options: [{ label: 'PG I', value: 'pg_i' }] }
  const draft = { ...selectQ, options: [{ label: 'PG I', value: '' }] }
  assert.equal(requiresNewVersion(stored, draft), false)
})

console.log('\noptionsChanged')
check('empty vs empty is unchanged', () =>
  assert.equal(optionsChanged([], []), false))
check('missing args default to empty', () =>
  assert.equal(optionsChanged(), false))
check('length difference is a change', () =>
  assert.equal(optionsChanged([{ label: 'A' }], []), true))

console.log('\ncosmeticPatch')
check('required flip produces is_required', () =>
  assert.deepEqual(cosmeticPatch(ratingQ, { ...ratingQ, required: false }), {
    is_required: false,
  }))
check('order change produces display_order', () =>
  assert.deepEqual(cosmeticPatch(ratingQ, { ...ratingQ, order: 7 }), {
    display_order: 7,
  }))
check('no change produces an empty patch', () =>
  assert.deepEqual(cosmeticPatch(ratingQ, { ...ratingQ }), {}))
check('absent order is ignored rather than nulled', () =>
  assert.deepEqual(cosmeticPatch(ratingQ, { ...ratingQ, order: undefined }), {}))

console.log('\nslugifyOptionValue')
check('lowercases and underscores', () =>
  assert.equal(slugifyOptionValue('B.Com (Banking & Insurance)'), 'b_com_banking_insurance'))
check('trims leading/trailing separators', () =>
  assert.equal(slugifyOptionValue('  --Yes--  '), 'yes'))
check('non-Latin text slugifies to empty', () =>
  assert.equal(slugifyOptionValue('अध्ययन'), ''))
check('null is safe', () => assert.equal(slugifyOptionValue(null), ''))
check('caps at 60 chars with no trailing underscore', () => {
  const slug = slugifyOptionValue('a '.repeat(50))
  assert.ok(slug.length <= 60)
  assert.doesNotMatch(slug, /_$/)
})

console.log('\nderiveQuestionKey')
check('derives from text', () =>
  assert.equal(deriveQuestionKey('Course design'), 'course_design'))
check('de-duplicates against existing keys', () =>
  assert.equal(deriveQuestionKey('Course design', ['course_design']), 'course_design_2'))
check('keeps counting past the second collision', () =>
  assert.equal(
    deriveQuestionKey('Course design', ['course_design', 'course_design_2']),
    'course_design_3',
  ))
check('unslugifiable text still yields a key', () => {
  const key = deriveQuestionKey('अध्ययन')
  assert.match(key, /^q_/)
})

console.log('\nvalidateQuestionDraft')
check('valid rating passes', () =>
  assert.equal(validateQuestionDraft(ratingQ).ok, true))
check('valid select passes', () =>
  assert.equal(validateQuestionDraft(selectQ).ok, true))
check('blank text fails', () =>
  assert.match(validateQuestionDraft({ ...ratingQ, text: '  ' }).errors.text, /required/i))
check('rating without a scale fails', () =>
  assert.match(
    validateQuestionDraft({ ...ratingQ, scaleId: null }).errors.scaleId,
    /needs a scale/i,
  ))
check('non-rating with a scale fails', () =>
  assert.match(
    validateQuestionDraft({ ...selectQ, scaleId: 'scale-1' }).errors.scaleId,
    /only rating/i,
  ))
check('select with one option fails', () =>
  assert.match(
    validateQuestionDraft({ ...selectQ, options: [{ label: 'SY' }] }).errors.options,
    /at least two/i,
  ))
check('text question with options fails', () =>
  assert.match(
    validateQuestionDraft({
      ...ratingQ,
      type: 'long_text',
      scaleId: null,
      options: [{ label: 'x' }],
    }).errors.options,
    /only dropdown/i,
  ))
check('options colliding on the same slug fail', () =>
  assert.match(
    validateQuestionDraft({
      ...selectQ,
      options: [{ label: 'B.Com' }, { label: 'B Com' }],
    }).errors.options,
    /same stored value/i,
  ))
check('option label with no alphanumerics fails', () =>
  assert.match(
    validateQuestionDraft({
      ...selectQ,
      options: [{ label: 'SY' }, { label: '???' }, { label: 'TY' }],
    }).errors.options,
    /at least one letter/i,
  ))

// ============================================================
// CSV import
// ============================================================
console.log('\nmapHeaders')
check('maps exact headers', () =>
  assert.deepEqual(mapHeaders(['email', 'full_name', 'role']), {
    email: 0,
    full_name: 1,
    role: 2,
  }))
check('tolerates case, spaces and BOM', () =>
  assert.deepEqual(mapHeaders(['﻿Email', ' Full Name ', 'ROLE']), {
    email: 0,
    full_name: 1,
    role: 2,
  }))
check('accepts name as an alias for full_name', () => {
  const map = mapHeaders(['email', 'name', 'role'])
  assert.equal(map.full_name, 1)
})
check('column order does not matter', () =>
  assert.deepEqual(mapHeaders(['role', 'email', 'full_name']), {
    email: 1,
    full_name: 2,
    role: 0,
  }))

console.log('\nnormaliseRole')
check('accepts the enum value', () => assert.equal(normaliseRole('student'), 'student'))
check('accepts a human label', () =>
  assert.equal(normaliseRole('Academic Peer'), 'academic_peer'))
check('is case-insensitive', () => assert.equal(normaliseRole('FACULTY'), 'faculty'))
check('maps "teacher" onto faculty (deliberate alias for college spreadsheets)', () =>
  assert.equal(normaliseRole('teacher'), 'faculty'))
check('collapses repeated spaces in a label', () =>
  assert.equal(normaliseRole('Academic   Peer'), 'academic_peer'))
check('rejects an unknown role', () => assert.equal(normaliseRole('principal'), null))
check('rejects an empty role', () => assert.equal(normaliseRole(''), null))
check('rejects null', () => assert.equal(normaliseRole(null), null))

console.log('\nisEmail')
check('accepts a normal address', () => assert.equal(isEmail('a@b.co'), true))
check('rejects a missing domain dot', () => assert.equal(isEmail('a@b'), false))
check('rejects spaces', () => assert.equal(isEmail('a b@c.com'), false))

console.log('\nvalidateCsvRows')
const header = ['email', 'full_name', 'role']

check('rejects a file with no recognised headers', () => {
  const result = validateCsvRows([['a', 'b', 'c'], ['x@y.com', 'X', 'student']])
  assert.ok(result.headerError)
})
check('accepts a good file', () => {
  const result = validateCsvRows([
    header,
    ['a@x.com', 'Asha', 'student'],
    ['b@x.com', 'Ben', 'Faculty'],
  ])
  assert.equal(result.headerError, null)
  assert.equal(result.valid.length, 2)
  assert.equal(result.invalid.length, 0)
  assert.equal(result.valid[1].role, 'faculty')
})
check('lowercases and trims emails', () => {
  const result = validateCsvRows([header, ['  A@X.COM  ', 'Asha', 'student']])
  assert.equal(result.valid[0].email, 'a@x.com')
})
check('flags a bad email with its line number', () => {
  const result = validateCsvRows([header, ['not-an-email', 'X', 'student']])
  assert.equal(result.valid.length, 0)
  assert.equal(result.invalid[0].line, 2)
  assert.match(result.invalid[0].reason, /email/i)
})
check('flags an unknown role', () => {
  const result = validateCsvRows([header, ['a@x.com', 'X', 'principal']])
  assert.match(result.invalid[0].reason, /role/i)
})
check('flags a duplicate inside the file', () => {
  const result = validateCsvRows([
    header,
    ['a@x.com', 'One', 'student'],
    ['A@X.com', 'Two', 'student'],
  ])
  assert.equal(result.valid.length, 1)
  assert.match(result.invalid[0].reason, /duplicate|twice/i)
})
check('flags an address that already has an account', () => {
  const result = validateCsvRows([header, ['a@x.com', 'X', 'student']], ['a@x.com'])
  assert.equal(result.valid.length, 0)
  assert.match(result.invalid[0].reason, /already/i)
})
check('existing-email check is case-insensitive', () => {
  const result = validateCsvRows([header, ['A@X.com', 'X', 'student']], ['a@x.com'])
  assert.equal(result.valid.length, 0)
})
check('a blank name is allowed', () => {
  const result = validateCsvRows([header, ['a@x.com', '', 'student']])
  assert.equal(result.valid.length, 1)
  assert.equal(result.valid[0].full_name, '')
})
check('skips fully blank rows without reporting them', () => {
  const result = validateCsvRows([header, ['', '', ''], ['a@x.com', 'X', 'student']])
  assert.equal(result.valid.length, 1)
  assert.equal(result.invalid.length, 0)
})
check('a short row is reported, not crashed on', () => {
  const result = validateCsvRows([header, ['a@x.com']])
  assert.equal(result.valid.length + result.invalid.length, 1)
})

console.log('\nchunk')
check('splits into batches of 25 by default', () => {
  const batches = chunk(Array.from({ length: 60 }, (_, i) => i))
  assert.deepEqual(batches.map((b) => b.length), [25, 25, 10])
})
check('an exact multiple leaves no empty batch', () => {
  const batches = chunk(Array.from({ length: 50 }, (_, i) => i))
  assert.equal(batches.length, 2)
})
check('an empty list yields no batches', () => assert.deepEqual(chunk([]), []))
check('honours a custom size', () =>
  assert.equal(chunk([1, 2, 3, 4, 5], 2).length, 3))

console.log(`\n${passed} admin checks passed\n`)
