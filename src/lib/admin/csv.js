// Explicit .js extension: Vite resolves extensionless paths, plain Node (used by
// the check scripts) does not.
import { ROLES } from '../constants.js'

/**
 * CSV parsing and validation for bulk user import (FR-23).
 *
 * Pure so it is unit-testable: the whole point of this file is catching bad
 * rows before any of them reach the account-provisioning endpoint.
 */

export const VALID_ROLES = new Set(Object.values(ROLES))

/** Header aliases, so a spreadsheet exported from anywhere stands a chance. */
const HEADER_ALIASES = {
  email: ['email', 'email address', 'e-mail', 'mail'],
  full_name: ['full_name', 'full name', 'name', 'fullname'],
  role: ['role', 'user role', 'type', 'stakeholder', 'stakeholder type'],
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

export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)

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
 * @param {string[]} existingEmails already-registered addresses, lowercased
 * @returns {{ valid: object[], invalid: object[], headerError: string|null }}
 */
export function validateCsvRows(rows, existingEmails = []) {
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
        'No "email" column found. Expected headers: email, full_name, role, temporary_password (optional).',
    }
  }
  if (columns.role === undefined) {
    return {
      valid: [],
      invalid: [],
      headerError:
        'No "role" column found. Expected headers: email, full_name, role, temporary_password (optional).',
    }
  }

  const taken = new Set(existingEmails.map((e) => e.toLowerCase()))
  const seen = new Set()
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
    if (seen.has(email)) {
      invalid.push({ line: lineNo, email, reason: 'Duplicate row in this file.' })
      return
    }
    if (taken.has(email)) {
      invalid.push({ line: lineNo, email, reason: 'Already registered.' })
      return
    }

    seen.add(email)
    valid.push({
      line: lineNo,
      email,
      full_name: fullName,
      role,
      temporary_password: temporaryPassword,
    })
  })

  return { valid, invalid, headerError: null }
}

/**
 * Splits an account list into bounded Edge Function requests.
 */
export function chunk(items, size = 25) {
  if (size < 1) throw new Error('Batch size must be at least 1.')
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export const CSV_TEMPLATE = 'email,full_name,role,temporary_password\n' +
  'student1@college.edu,Asha Rao,student,\n' +
  'prof@college.edu,R. Menon,faculty,ChangeMe123!\n' +
  'hr@acme.com,Industry Contact,employer,\n'
