/**
 * Unit tests for the stream/department rules (FR-44 to FR-48).
 *
 * Run with `npm run check`. Only dependency-free modules are exercised here —
 * departments.js imports the Supabase client and needs a browser env, so
 * everything worth asserting lives in departmentRules.js and csv.js.
 *
 * The normalisation cases are not invented: the expected values were measured
 * against the live database after 0008_departments.sql, because the JS helpers
 * mirror a generated column and a trigger. If Postgres and these ever disagree, a
 * duplicate department gets in.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const {
  CODE_PATTERN,
  DEPARTMENT_REQUIRED_ROLES,
  departmentRequiredFor,
  describeDepartment,
  normaliseCode,
  normaliseName,
  resolveDepartment,
  slugifyName,
  sortDepartmentRows,
  validateDepartmentDraft,
  validateStreamDraft,
} = await load('src/lib/admin/departmentRules.js')

const { validateCsvRows, mapHeaders, CSV_TEMPLATE } = await load('src/lib/admin/csv.js')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// ---------- fixtures ----------
const streams = [
  { id: 'st-sci', name: 'Science', display_order: 1, is_active: true },
  { id: 'st-com', name: 'Commerce', display_order: 2, is_active: true },
  { id: 'st-art', name: 'Arts', display_order: 3, is_active: true },
]

/** Psychology twice on purpose: it is a real department in two streams. */
const departments = [
  { id: 'd-cs', stream_id: 'st-sci', name: 'Computer Science', code: 'CS', is_active: true, display_order: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: 'd-psy-sci', stream_id: 'st-sci', name: 'Psychology', code: 'PSY', is_active: true, display_order: 2, created_at: '2026-01-02T00:00:00Z' },
  { id: 'd-af', stream_id: 'st-com', name: 'Accounting & Finance', code: 'AF', is_active: true, display_order: 1, created_at: '2026-01-03T00:00:00Z' },
  { id: 'd-psy-art', stream_id: 'st-art', name: 'Psychology', code: 'PSY', is_active: true, display_order: 1, created_at: '2026-01-04T00:00:00Z' },
  { id: 'd-retired', stream_id: 'st-sci', name: 'Home Science', code: 'HS', is_active: false, display_order: 9, created_at: '2026-01-05T00:00:00Z' },
]

const tree = { streams, departments }

console.log('\nslugifyName — mirrors the generated slug column')
check('lower-cases', () => assert.equal(slugifyName('Computer Science'), 'computer science'))
check('collapses internal whitespace runs', () =>
  assert.equal(slugifyName('Computer   Science'), 'computer science'))
check('trims the ends', () =>
  assert.equal(slugifyName('  COMPUTER   science '), 'computer science'))
check('keeps punctuation, which the database also keeps', () =>
  assert.equal(slugifyName('Accounting & Finance'), 'accounting & finance'))
check('null is safe', () => assert.equal(slugifyName(null), ''))

console.log('\nnormaliseName / normaliseCode')
check('name keeps its case', () =>
  assert.equal(normaliseName(' Computer   Science '), 'Computer Science'))
check('code is upper-cased', () => assert.equal(normaliseCode(' cs '), 'CS'))
check('a blank code becomes null, not an empty string', () =>
  assert.equal(normaliseCode('   '), null))
check('an absent code becomes null', () => assert.equal(normaliseCode(undefined), null))

console.log('\nCODE_PATTERN — mirrors departments_code_shape')
check('accepts a short code', () => assert.ok(CODE_PATTERN.test('CS')))
check('accepts the punctuation the constraint allows', () =>
  assert.ok(CODE_PATTERN.test('B.SC/CS-1')))
check('rejects a leading punctuation mark', () => assert.ok(!CODE_PATTERN.test('-CS')))
check('rejects 17 characters', () =>
  assert.ok(!CODE_PATTERN.test('A'.repeat(17))))
check('accepts 16 characters', () => assert.ok(CODE_PATTERN.test('A'.repeat(16))))

console.log('\nvalidateStreamDraft')
check('a name is required', () =>
  assert.match(validateStreamDraft({ name: '  ' }, streams).errors.name, /name/i))
check('a valid new name passes', () =>
  assert.equal(validateStreamDraft({ name: 'Vocational' }, streams).ok, true))
check('a duplicate is caught regardless of case and spacing', () =>
  assert.match(
    validateStreamDraft({ name: '  science ' }, streams).errors.name,
    /already a stream/i,
  ))
check('renaming a stream to its own name is not a duplicate', () =>
  assert.equal(
    validateStreamDraft({ name: 'Science' }, streams, { ignoreId: 'st-sci' }).ok,
    true,
  ))
check('the normalised name is returned for the write', () =>
  assert.equal(
    validateStreamDraft({ name: '  New   Stream ' }, streams).value.name,
    'New Stream',
  ))

console.log('\nvalidateDepartmentDraft')
const newDept = { streamId: 'st-sci', name: 'Zoology', code: 'ZOO' }
check('a valid draft passes', () =>
  assert.equal(validateDepartmentDraft(newDept, departments).ok, true))
check('a stream is required', () =>
  assert.match(
    validateDepartmentDraft({ ...newDept, streamId: '' }, departments).errors.streamId,
    /stream/i,
  ))
check('a name is required', () =>
  assert.match(
    validateDepartmentDraft({ ...newDept, name: ' ' }, departments).errors.name,
    /name/i,
  ))
check('a duplicate within the stream is caught', () =>
  assert.match(
    validateDepartmentDraft(
      { streamId: 'st-sci', name: 'computer   science' },
      departments,
    ).errors.name,
    /already has a department/i,
  ))
check('the SAME name in a DIFFERENT stream is allowed — Psychology is both', () =>
  assert.equal(
    validateDepartmentDraft({ streamId: 'st-com', name: 'Psychology' }, departments).ok,
    true,
  ))
check('a duplicate code within the stream is caught', () =>
  assert.match(
    validateDepartmentDraft({ streamId: 'st-sci', name: 'Cyber Security', code: 'cs' }, departments)
      .errors.code,
    /already used/i,
  ))
check('the same code in a different stream is allowed', () =>
  assert.equal(
    validateDepartmentDraft(
      { streamId: 'st-com', name: 'Corporate Studies', code: 'CS' },
      departments,
    ).ok,
    true,
  ))
check('a malformed code is rejected', () =>
  assert.match(
    validateDepartmentDraft({ ...newDept, code: '-nope' }, departments).errors.code,
    /invalid short code/i,
  ))
check('an archived sibling still blocks the name — it can be restored', () =>
  assert.match(
    validateDepartmentDraft({ streamId: 'st-sci', name: 'Home Science' }, departments)
      .errors.name,
    /already has a department/i,
  ))
check('editing a department in place is not a self-collision', () =>
  assert.equal(
    validateDepartmentDraft(
      { streamId: 'st-sci', name: 'Computer Science', code: 'CS' },
      departments,
      { ignoreId: 'd-cs' },
    ).ok,
    true,
  ))
check('a cleared code normalises to null rather than ""', () =>
  assert.equal(
    validateDepartmentDraft({ ...newDept, code: '' }, departments).value.code,
    null,
  ))

console.log('\ndepartmentRequiredFor — FR-46')
check('a student needs one', () => assert.equal(departmentRequiredFor('student'), true))
check('faculty need one', () => assert.equal(departmentRequiredFor('faculty'), true))
check('an employer does not', () => assert.equal(departmentRequiredFor('employer'), false))
check('an alumnus does not', () => assert.equal(departmentRequiredFor('alumni'), false))
check('an academic peer does not', () =>
  assert.equal(departmentRequiredFor('academic_peer'), false))
check('an admin does not', () => assert.equal(departmentRequiredFor('admin'), false))
check('an unknown or absent role does not', () => {
  assert.equal(departmentRequiredFor(undefined), false)
  assert.equal(departmentRequiredFor('principal'), false)
})
check('exactly two roles require one', () =>
  assert.equal(DEPARTMENT_REQUIRED_ROLES.size, 2))

console.log('\ndescribeDepartment')
check('appends the code when there is one', () =>
  assert.equal(describeDepartment(departments[0]), 'Computer Science (CS)'))
check('omits empty brackets when there is none', () =>
  assert.equal(describeDepartment({ name: 'Sociology', code: null }), 'Sociology'))
check('a missing department is the empty string, not "undefined"', () =>
  assert.equal(describeDepartment(undefined), ''))

console.log('\nresolveDepartment — FR-47')
check('an exact pair resolves', () =>
  assert.deepEqual(
    resolveDepartment({ stream: 'Science', department: 'Computer Science' }, departments, streams),
    { ok: true, id: 'd-cs' },
  ))
check('case and spacing do not matter', () =>
  assert.deepEqual(
    resolveDepartment(
      { stream: ' science ', department: 'computer   SCIENCE' },
      departments,
      streams,
    ),
    { ok: true, id: 'd-cs' },
  ))
check('a short code resolves too — a spreadsheet is as likely to say CS', () =>
  assert.deepEqual(
    resolveDepartment({ stream: 'Science', department: 'cs' }, departments, streams),
    { ok: true, id: 'd-cs' },
  ))
check('both blank means "no department", not an error', () =>
  assert.deepEqual(resolveDepartment({}, departments, streams), { ok: true, id: null }))
check('a unique name needs no stream', () =>
  assert.deepEqual(
    resolveDepartment({ department: 'Accounting & Finance' }, departments, streams),
    { ok: true, id: 'd-af' },
  ))
check('a name in two streams is refused rather than guessed', () => {
  const result = resolveDepartment({ department: 'Psychology' }, departments, streams)
  assert.equal(result.ok, false)
  assert.match(result.reason, /Science and Arts|Arts and Science/)
  assert.match(result.reason, /stream column/i)
})
check('a stream disambiguates that same name', () =>
  assert.deepEqual(
    resolveDepartment({ stream: 'Arts', department: 'Psychology' }, departments, streams),
    { ok: true, id: 'd-psy-art' },
  ))
check('an unknown stream is named in the reason', () => {
  const result = resolveDepartment({ stream: 'Enginering', department: 'CS' }, departments, streams)
  assert.equal(result.ok, false)
  assert.match(result.reason, /unknown stream "Enginering"/i)
})
check('an unknown department is named in the reason', () => {
  const result = resolveDepartment({ department: 'Astrophysics' }, departments, streams)
  assert.equal(result.ok, false)
  assert.match(result.reason, /unknown department "Astrophysics"/i)
})
check('a real department paired with the wrong stream says where it actually is', () => {
  const result = resolveDepartment(
    { stream: 'Commerce', department: 'Computer Science' },
    departments,
    streams,
  )
  assert.equal(result.ok, false)
  assert.match(result.reason, /not in Commerce/i)
  assert.match(result.reason, /it is in Science/i)
})
check('a stream with no department is an error, not a silent drop', () => {
  const result = resolveDepartment({ stream: 'Science' }, departments, streams)
  assert.equal(result.ok, false)
  assert.match(result.reason, /without a department/i)
})
check('an archived department still resolves — the caller decides policy', () =>
  assert.deepEqual(
    resolveDepartment({ stream: 'Science', department: 'Home Science' }, departments, streams),
    { ok: true, id: 'd-retired' },
  ))

console.log('\nsortDepartmentRows')
const sortable = departments.map((row) => ({
  ...row,
  stream_name: streams.find((s) => s.id === row.stream_id).name,
  user_count: row.id === 'd-af' ? 12 : row.id === 'd-cs' ? 5 : 0,
}))
const ids = (rows) => rows.map((row) => row.id)

check('default groups by stream, then display order', () =>
  assert.deepEqual(ids(sortDepartmentRows(sortable)), [
    'd-psy-art',
    'd-af',
    'd-cs',
    'd-psy-sci',
    'd-retired',
  ]))
check('name_asc ignores the stream', () =>
  assert.equal(ids(sortDepartmentRows(sortable, 'name_asc'))[0], 'd-af'))
check('name_desc reverses it', () =>
  assert.equal(ids(sortDepartmentRows(sortable, 'name_desc'))[0], 'd-psy-sci'))
check('users puts the busiest department first', () =>
  assert.deepEqual(ids(sortDepartmentRows(sortable, 'users')).slice(0, 2), ['d-af', 'd-cs']))
check('recent is newest-first', () =>
  assert.equal(ids(sortDepartmentRows(sortable, 'recent'))[0], 'd-retired'))
check('oldest is the reverse of recent', () =>
  assert.equal(ids(sortDepartmentRows(sortable, 'oldest'))[0], 'd-cs'))
check('the input array is not mutated', () => {
  const before = ids(sortable)
  sortDepartmentRows(sortable, 'name_desc')
  assert.deepEqual(ids(sortable), before)
})
check('missing joined fields do not throw', () =>
  assert.equal(sortDepartmentRows([{ id: 'x' }, { id: 'y' }], 'users').length, 2))
check('an empty or absent list is safe', () => {
  assert.deepEqual(sortDepartmentRows([]), [])
  assert.deepEqual(sortDepartmentRows(undefined), [])
})

// ============================================================
// CSV import with departments (FR-47)
// ============================================================
console.log('\nmapHeaders — the new columns')
check('maps stream and department', () => {
  const map = mapHeaders(['email', 'role', 'stream', 'department'])
  assert.equal(map.stream, 2)
  assert.equal(map.department, 3)
})
check('"program" is accepted as the department column', () =>
  assert.equal(mapHeaders(['email', 'role', 'program']).department, 2))
check('"dept" and "branch" are accepted too', () => {
  assert.equal(mapHeaders(['email', 'role', 'dept']).department, 2)
  assert.equal(mapHeaders(['email', 'role', 'Branch']).department, 2)
})

console.log('\nvalidateCsvRows — without a department list (the old contract)')
const plain = ['email', 'full_name', 'role']
check('a student row with no department is still valid', () => {
  const result = validateCsvRows([plain, ['a@x.com', 'Asha', 'student']])
  assert.equal(result.valid.length, 1)
  assert.equal(result.valid[0].department_id, null)
})

console.log('\nvalidateCsvRows — with a department list')
const header = ['email', 'full_name', 'role', 'stream', 'department']

check('a resolved department rides along on the valid row', () => {
  const result = validateCsvRows(
    [header, ['a@x.com', 'Asha', 'student', 'Science', 'Computer Science']],
    {},
    tree,
  )
  assert.equal(result.invalid.length, 0)
  assert.equal(result.valid[0].department_id, 'd-cs')
})
check('a student without one is skipped with a reason that says what to add', () => {
  const result = validateCsvRows([header, ['a@x.com', 'Asha', 'student', '', '']], {}, tree)
  assert.equal(result.valid.length, 0)
  assert.match(result.invalid[0].reason, /students and faculty need a department/i)
  assert.equal(result.invalid[0].line, 2)
})
check('faculty are held to the same rule', () => {
  const result = validateCsvRows([header, ['a@x.com', 'R', 'faculty', '', '']], {}, tree)
  assert.match(result.invalid[0].reason, /department/i)
})
check('an employer without one is fine', () => {
  const result = validateCsvRows([header, ['hr@acme.com', 'HR', 'employer', '', '']], {}, tree)
  assert.equal(result.valid.length, 1)
  assert.equal(result.valid[0].department_id, null)
})
check('a misspelled department skips only that row', () => {
  const result = validateCsvRows(
    [
      header,
      ['a@x.com', 'Asha', 'student', 'Science', 'Compter Science'],
      ['b@x.com', 'Ben', 'student', 'Science', 'Computer Science'],
    ],
    {},
    tree,
  )
  assert.equal(result.valid.length, 1)
  assert.equal(result.valid[0].email, 'b@x.com')
  assert.equal(result.invalid.length, 1)
  assert.match(result.invalid[0].reason, /unknown department/i)
})
check('an archived department is refused by name, not reported as unknown', () => {
  const result = validateCsvRows(
    [header, ['a@x.com', 'Asha', 'student', 'Science', 'Home Science']],
    {},
    tree,
  )
  assert.equal(result.valid.length, 0)
  assert.match(result.invalid[0].reason, /"Home Science" is archived/i)
})
check('an ambiguous name is reported per row', () => {
  const result = validateCsvRows(
    [header, ['a@x.com', 'Asha', 'student', '', 'Psychology']],
    {},
    tree,
  )
  assert.equal(result.valid.length, 0)
  assert.match(result.invalid[0].reason, /stream column/i)
})
check('a "program" column resolves the same way', () => {
  const result = validateCsvRows(
    [['email', 'role', 'program'], ['a@x.com', 'student', 'AF']],
    {},
    tree,
  )
  assert.equal(result.valid[0].department_id, 'd-af')
})
check('the template parses back into a valid import against a real tree', () => {
  const rows = CSV_TEMPLATE.trim()
    .split('\n')
    .map((line) => line.split(','))
  const result = validateCsvRows(rows, {}, tree)
  assert.equal(result.headerError, null)
  assert.equal(result.invalid.length, 0)
  assert.equal(result.valid.length, 3)
  assert.equal(result.valid[0].department_id, 'd-cs')
  assert.equal(result.valid[1].department_id, 'd-af')
  assert.equal(result.valid[2].department_id, null)
})

console.log(`\n${passed} department checks passed\n`)



