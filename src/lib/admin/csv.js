// Explicit .js extension: Vite resolves extensionless paths, plain Node (used by
// the check scripts) does not.
import { ROLES } from '../constants.js'
import { isEmail, validateSapId } from '../identifier.js'
import { departmentRequiredFor, resolveDepartment } from './departmentRules.js'

/**
 * CSV parsing and validation for bulk user import (FR-23).
 *
 * Pure so it is unit-testable: the whole point of this file is catching bad
 * rows before any of them reach the account-provisioning endpoint.
 */

export const VALID_ROLES = new Set(Object.values(ROLES))

export { isEmail }

/** Header aliases, so a spreadsheet exported from anywhere stands a chance. */
const HEADER_ALIASES = {
  email: ['email', 'email address', 'e-mail', 'mail'],
  full_name: ['full_name', 'full name', 'name', 'fullname'],
  role: ['role', 'user role', 'type', 'stakeholder', 'stakeholder type'],
  sap_id: [
    'sap_id',
    'sap id',
    'sapid',
    'sap',
    'sap no',
    'sap number',
    'sap_number',
    'sap id number',
  ],
  stream: ['stream', 'stream name', 'faculty stream'],
  // `program` is here because that is what a college spreadsheet calls this
  // column, and because it is the word the department list was built from.
  department: [
    'department',
    'dept',
    'department name',
    'branch',
    'program',
    'programme',
    'program/department',
  ],
  temporary_password: ['temporary_password', 'temporary password', 'password'],
}

/** Human labels accepted in the role column, alongside the raw enum values. */
const ROLE_ALIASES = {
  admin: ROLES.ADMIN,
  administrator: ROLES.ADMIN,
  academic_peer: ROLES.ACADEMIC_PEER,
  'academic peer': ROLES.ACADEMIC_PEER,
  peer: ROLES.ACADEMIC_PEER,
  student: ROLES.STUDENT,
  employer: ROLES.EMPLOYER,
  'industry expert': ROLES.EMPLOYER,
  'employer / industry expert': ROLES.EMPLOYER,
  alumni: ROLES.ALUMNI,
  alumnus: ROLES.ALUMNI,
  faculty: ROLES.FACULTY,
  teacher: ROLES.FACULTY,
}

export function normaliseRole(raw) {
  const key = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (VALID_ROLES.has(key)) return key
  return ROLE_ALIASES[key] ?? null
}

/** Maps a parsed CSV header row onto our three fields. */
export function mapHeaders(headers) {
  const found = {}
  headers.forEach((raw, index) => {
    const key = String(raw ?? '').trim().toLowerCase()
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(key) && found[field] === undefined) found[field] = index
    }
  })
  return found
}

/**
 * Validates parsed CSV rows.
 *
 * @param {string[][]} rows including the header row
 * @param {string[]|{emails?: string[], sapIds?: string[]}} existing already-registered
 *   identifiers. A bare array is read as emails, which is what it used to be.
 * @param {{streams?: object[], departments?: object[]}|null} tree the department
 *   list to resolve the `stream` and `department` columns against (FR-47).
 *   `null` means "no department data available" — the columns are ignored and the
 *   student/faculty requirement is not applied. That is what keeps a caller from
 *   before departments existed working, and it is also the honest answer in the
 *   window before migration 0008 reaches a project.
 * @returns {{ valid: object[], invalid: object[], headerError: string|null }}
 */
export function validateCsvRows(rows, existing = {}, tree = null) {
  const nonEmpty = rows.filter((r) => r.some((cell) => String(cell ?? '').trim() !== ''))
  if (nonEmpty.length === 0) {
    return { valid: [], invalid: [], headerError: 'The file is empty.' }
  }

  const columns = mapHeaders(nonEmpty[0])
  if (columns.email === undefined) {
    return {
      valid: [],
      invalid: [],
      headerError:
        'No "email" column found. Expected headers: email, full_name, role, sap_id (optional), temporary_password (optional).',
    }
  }
  if (columns.role === undefined) {
    return {
      valid: [],
      invalid: [],
      headerError:
        'No "role" column found. Expected headers: email, full_name, role, sap_id (optional), temporary_password (optional).',
    }
  }

  const { emails: existingEmails, sapIds: existingSapIds } = splitExisting(existing)
  const taken = new Set(existingEmails.map((e) => e.toLowerCase()))
  const takenSapIds = new Set(existingSapIds.map((id) => String(id).toUpperCase()))
  const streams = tree?.streams ?? []
  const departments = tree?.departments ?? []
  const seen = new Set()
  const seenSapIds = new Set()
  const valid = []
  const invalid = []

  nonEmpty.slice(1).forEach((row, i) => {
    const lineNo = i + 2 // 1-based, and the header occupies line 1
    const email = String(row[columns.email] ?? '').trim().toLowerCase()
    const fullName =
      columns.full_name !== undefined
        ? String(row[columns.full_name] ?? '').trim()
        : ''
    const rawRole = String(row[columns.role] ?? '').trim()
    const role = normaliseRole(rawRole)
    const temporaryPassword =
      columns.temporary_password !== undefined
        ? String(row[columns.temporary_password] ?? '')
        : ''

    if (!isEmail(email)) {
      invalid.push({ line: lineNo, email, reason: 'Invalid email address.' })
      return
    }
    if (!role) {
      invalid.push({
        line: lineNo,
        email,
        reason: rawRole ? `Unknown role "${rawRole}".` : 'Role is missing.',
      })
      return
    }
    if (
      temporaryPassword &&
      (temporaryPassword.length < 8 || temporaryPassword.length > 72)
    ) {
      invalid.push({
        line: lineNo,
        email,
        reason: 'Temporary password must be between 8 and 72 characters.',
      })
      return
    }

    // FR-47. Skipped entirely when no department list was supplied, so a caller
    // that predates departments behaves exactly as it used to.
    let departmentId = null
    if (tree) {
      const check = checkDepartmentCell(
        {
          stream: columns.stream !== undefined ? row[columns.stream] : '',
          department: columns.department !== undefined ? row[columns.department] : '',
        },
        role,
        { streams, departments },
      )
      if (!check.ok) {
        invalid.push({ line: lineNo, email, reason: check.reason })
        return
      }
      departmentId = check.id
    }

    // Optional, and blank in most rows: only the people who have a SAP ID need one.
    const sapCheck = validateSapId(
      columns.sap_id !== undefined ? row[columns.sap_id] : '',
    )
    if (!sapCheck.ok) {
      invalid.push({ line: lineNo, email, reason: sapCheck.reason })
      return
    }
    const sapId = sapCheck.value

    if (seen.has(email)) {
      invalid.push({ line: lineNo, email, reason: 'Duplicate row in this file.' })
      return
    }
    if (taken.has(email)) {
      invalid.push({ line: lineNo, email, reason: 'Already registered.' })
      return
    }
    if (sapId && seenSapIds.has(sapId)) {
      invalid.push({
        line: lineNo,
        email,
        reason: `SAP ID ${sapId} appears twice in this file.`,
      })
      return
    }
    if (sapId && takenSapIds.has(sapId)) {
      invalid.push({
        line: lineNo,
        email,
        reason: `SAP ID ${sapId} is already assigned to another user.`,
      })
      return
    }

    seen.add(email)
    if (sapId) seenSapIds.add(sapId)
    valid.push({
      line: lineNo,
      email,
      full_name: fullName,
      sap_id: sapId ?? '',
      role,
      department_id: departmentId,
      temporary_password: temporaryPassword,
    })
  })

  return { valid, invalid, headerError: null }
}

/**
 * Resolves one row's stream/department pair and applies the role requirement.
 *
 * An archived department is refused by name rather than reported as unknown: the
 * admin chose a real department, and "it is archived" tells them what to do about
 * it while "unknown" sends them looking for a typo.
 */
function checkDepartmentCell(cells, role, { streams, departments }) {
  const resolved = resolveDepartment(cells, departments, streams)
  if (!resolved.ok) return { ok: false, reason: resolved.reason }

  if (!resolved.id) {
    if (departmentRequiredFor(role)) {
      return {
        ok: false,
        reason: 'Students and faculty need a department. Add a "department" column.',
      }
    }
    return { ok: true, id: null }
  }

  const department = departments.find((row) => row.id === resolved.id)
  if (department && department.is_active === false) {
    return {
      ok: false,
      reason: `"${department.name}" is archived. Restore it on the Departments page, or name another.`,
    }
  }

  return { ok: true, id: resolved.id }
}

const splitExisting = (existing) =>
  Array.isArray(existing)
    ? { emails: existing, sapIds: [] }
    : { emails: existing?.emails ?? [], sapIds: existing?.sapIds ?? [] }

/**
 * Splits an account list into bounded Edge Function requests.
 */
export function chunk(items, size = 25) {
  if (size < 1) throw new Error('Batch size must be at least 1.')
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export const CSV_TEMPLATE =
  'email,full_name,sap_id,role,stream,department,temporary_password\n' +
  'student1@college.edu,Asha Rao,70011234567,student,Science,Computer Science,\n' +
  'prof@college.edu,R. Menon,,faculty,Commerce,Accounting & Finance,ChangeMe123!\n' +
  'hr@acme.com,Industry Contact,,employer,,,\n'
