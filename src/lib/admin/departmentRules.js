// Explicit .js extension: Vite resolves extensionless paths, plain Node (used by
// the check scripts) does not.
import { ROLES } from '../constants.js'

/**
 * Pure rules for streams and departments (FR-44 to FR-48).
 *
 * No Supabase import, deliberately: everything here is decided before a round
 * trip, and scripts/check-departments.mjs loads it in plain Node.
 *
 * The normalisers below MIRROR the database. `slug` is a generated column in
 * 0008_departments.sql and `code` is rewritten by a trigger, so a duplicate would
 * be caught anyway — but as a constraint-name error rather than a sentence, and
 * only after the round trip.
 */

/** The JS mirror of the generated `slug` column. Keep the two in step. */
export const slugifyName = (raw) =>
  String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/** What the normalise trigger stores in `name`. */
export const normaliseName = (raw) => String(raw ?? '').replace(/\s+/g, ' ').trim()

/** What the normalise trigger stores in `code`: trimmed, upper-cased, or null. */
export const normaliseCode = (raw) => String(raw ?? '').trim().toUpperCase() || null

/** Mirrors the departments_code_shape check constraint. */
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._&/-]{0,15}$/
export const CODE_HINT =
  'up to 16 characters, starting with a letter or digit; . _ & / - allowed'

/**
 * FR-46, FR-50: which roles must be given a department.
 *
 * Students and faculty belong to one and their feedback is only meaningful when
 * attributed to it. An HOD *is* the administrator of one, so an HOD without a
 * department has no scope at all — `hod_department()` returns NULL and every HOD
 * policy in 0011_hod_scope.sql is keyed on it, so they would silently have no
 * extra rights. Employers, alumni and academic peers are external to the college's
 * structure, and forcing a value on them would mean inventing placeholder
 * departments that then clutter every filter dropdown.
 *
 * One definition, imported by the add-user form, the edit panel, the CSV
 * validator and the Edge Function's mirror of this rule.
 */
export const DEPARTMENT_REQUIRED_ROLES = new Set([
  ROLES.STUDENT,
  ROLES.FACULTY,
  ROLES.HOD,
])

export const departmentRequiredFor = (role) => DEPARTMENT_REQUIRED_ROLES.has(role)

/**
 * Whether a department is available as a new account-assignment target.
 * Existing assignments remain valid so archived rows can still be edited.
 */
export function departmentIsAssignable(department, streams = []) {
  if (!department?.is_active) return false
  const stream = streams.find((row) => row.id === department.stream_id)
  return !stream || stream.is_active !== false
}

/** "Computer Science (CS)", or just the name when it has no code. */
export const describeDepartment = (dept) =>
  !dept ? '' : dept.code ? `${dept.name} (${dept.code})` : dept.name

export function validateStreamDraft({ name } = {}, existing = [], { ignoreId = null } = {}) {
  const errors = {}
  const clean = normaliseName(name)

  if (!clean) {
    errors.name = 'Give the stream a name, e.g. "Science".'
  } else if (
    existing.some((row) => row.id !== ignoreId && slugifyName(row.name) === slugifyName(clean))
  ) {
    errors.name = `There is already a stream called "${clean}".`
  }

  return { ok: Object.keys(errors).length === 0, errors, value: { name: clean } }
}

/**
 * Collisions are checked WITHIN the stream only, matching the unique indexes.
 * Psychology is genuinely a Science department and an Arts one.
 */
export function validateDepartmentDraft(
  { name, code, streamId } = {},
  existing = [],
  { ignoreId = null } = {},
) {
  const errors = {}
  const clean = normaliseName(name)
  const cleanCode = normaliseCode(code)

  if (!streamId) errors.streamId = 'Choose the stream this department belongs to.'

  const siblings = existing.filter(
    (row) => row.id !== ignoreId && row.stream_id === streamId,
  )

  if (!clean) {
    errors.name = 'Give the department a name, e.g. "Computer Science".'
  } else if (siblings.some((row) => slugifyName(row.name) === slugifyName(clean))) {
    errors.name = `This stream already has a department called "${clean}".`
  }

  if (cleanCode && !CODE_PATTERN.test(cleanCode)) {
    errors.code = `Invalid short code. Use ${CODE_HINT}.`
  } else if (cleanCode && /\s\s/.test(cleanCode)) {
    // The database check constraint permits it and the normalise trigger keeps
    // it, so this is the only gate. A run of spaces is invisible: HTML collapses
    // it in the table, the code search substring-matches the stored string, and
    // a spreadsheet cell will practically never reproduce it.
    errors.code = 'Use single spaces in a short code.'
  } else if (cleanCode && siblings.some((row) => normaliseCode(row.code) === cleanCode)) {
    errors.code = `The code ${cleanCode} is already used in this stream.`
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { name: clean, code: cleanCode, stream_id: streamId },
  }
}

/**
 * Turns the free text in a CSV's `stream` and `department` columns into a
 * department id (FR-47).
 *
 * Matching is by normalised name first and short code second, because a college
 * spreadsheet is as likely to say "CS" as "Computer Science". The stream column
 * is optional and acts as a disambiguator: without it, a name that exists in two
 * streams is rejected rather than silently resolved to whichever came first —
 * Psychology would otherwise land in Science or Arts by row order.
 *
 * @returns {{ok: true, id: string|null}|{ok: false, reason: string}}
 */
export function resolveDepartment(
  { stream = '', department = '' } = {},
  departments = [],
  streams = [],
) {
  const streamText = normaliseName(stream)
  const deptText = normaliseName(department)

  if (!deptText && !streamText) return { ok: true, id: null }

  let streamId = null
  if (streamText) {
    const match = streams.find((row) => slugifyName(row.name) === slugifyName(streamText))
    if (!match) return { ok: false, reason: `Unknown stream "${streamText}".` }
    streamId = match.id
  }

  // A stream on its own does not identify a department, so say so rather than
  // quietly dropping the column.
  if (!deptText) {
    return { ok: false, reason: 'A stream was given without a department.' }
  }

  const inScope = streamId
    ? departments.filter((row) => row.stream_id === streamId)
    : departments

  const wanted = slugifyName(deptText)
  // The code is derived from the RAW cell, not from the whitespace-collapsed
  // name. `normaliseCode` mirrors the database trigger (`upper(btrim(code))`),
  // which keeps internal runs, so a stored code of "B  SC" is unmatchable by any
  // cell — including a byte-identical one — once the run has been collapsed.
  const wantedCode = normaliseCode(department)
  let matches = inScope.filter((row) => slugifyName(row.name) === wanted)
  if (matches.length === 0) {
    matches = inScope.filter((row) => row.code && normaliseCode(row.code) === wantedCode)
  }

  if (matches.length === 0) {
    // Naming the stream in the message is what makes a mis-paired row obvious:
    // "Psychology is not in Commerce" reads very differently from "unknown".
    const elsewhere = streamId
      ? departments.filter((row) => slugifyName(row.name) === wanted)
      : []
    if (elsewhere.length > 0) {
      const owner = streams.find((row) => row.id === elsewhere[0].stream_id)
      return {
        ok: false,
        reason: `"${deptText}" is not in ${streamText}${owner ? ` — it is in ${owner.name}` : ''}.`,
      }
    }
    return { ok: false, reason: `Unknown department "${deptText}".` }
  }

  if (matches.length > 1) {
    const names = matches
      .map((row) => streams.find((s) => s.id === row.stream_id)?.name)
      .filter(Boolean)
      .join(' and ')
    return {
      ok: false,
      reason: `"${deptText}" exists in ${names || 'more than one stream'}. Add a stream column to say which.`,
    }
  }

  return { ok: true, id: matches[0].id }
}

/**
 * Client-side sort for the department list. Mirrors userSort.js: the table is a
 * few dozen rows at most, so ordering here costs nothing and saves a round trip.
 *
 * `stream_name` and `user_count` are joined on by the page from data it already
 * holds, so they may be absent — every comparator tolerates that.
 */
export function sortDepartmentRows(rows, sort = 'stream') {
  const out = [...(rows ?? [])]
  const byName = (a, b) =>
    String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, {
      sensitivity: 'base',
      numeric: true,
    })
  const created = (row) => new Date(row.created_at ?? 0).getTime()

  out.sort((a, b) => {
    if (sort === 'recent') return created(b) - created(a)
    if (sort === 'oldest') return created(a) - created(b)
    if (sort === 'name_asc') return byName(a, b)
    if (sort === 'name_desc') return byName(b, a)
    if (sort === 'users') {
      const diff = (b.user_count ?? 0) - (a.user_count ?? 0)
      return diff !== 0 ? diff : byName(a, b)
    }
    // 'stream': grouped the way the page reads, stream then department.
    const stream = String(a.stream_name ?? '').localeCompare(
      String(b.stream_name ?? ''),
      undefined,
      { sensitivity: 'base' },
    )
    if (stream !== 0) return stream
    const order = (a.display_order ?? 0) - (b.display_order ?? 0)
    return order !== 0 ? order : byName(a, b)
  })

  return out
}

export const DEPARTMENT_SORTS = [
  { value: 'stream', label: 'Stream, then name' },
  { value: 'name_asc', label: 'Name A-Z' },
  { value: 'name_desc', label: 'Name Z-A' },
  { value: 'users', label: 'Most users' },
  { value: 'recent', label: 'Recently added' },
  { value: 'oldest', label: 'Oldest first' },
]
