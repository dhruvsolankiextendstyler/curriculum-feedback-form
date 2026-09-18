// Explicit .js extension: Vite resolves extensionless paths, plain Node (used by
// scripts/check-prefill.mjs) does not.

/**
 * Identity answers taken from the signed-in account rather than typed again.
 *
 * Every form opens with a short "About you" block, and the first few questions of
 * it ask for things the platform already knows: the respondent's name, their SAP
 * number, the department they belong to. Asking again invites three problems at
 * once — a typo makes two accounts look like two people in analytics, a name
 * typed differently each cycle breaks year-over-year comparison, and nothing
 * stops someone submitting feedback under another person's name.
 *
 * So those fields are filled from the profile and locked. The rest of the form,
 * including the course and program a respondent is giving feedback ON, stays
 * theirs to fill in: a course is a property of the submission, not of the account.
 *
 * Two rules keep this from blocking anyone:
 *
 *  1. A field is only locked when the account actually HAS the value. A student
 *     whose profile carries no SAP number must still be able to answer a required
 *     SAP question, so an empty account value leaves the field ordinary.
 *
 *  2. Only text questions are touched. `department` is seeded as short_text, but
 *     an admin can retype a question as a dropdown, and forcing an account string
 *     into a select would produce a value its own option list rejects.
 *
 * Pure and dependency-free so scripts/check-prefill.mjs can exercise it in Node.
 */

/** Question key -> the identity field that answers it. */
export const IDENTITY_FIELD_BY_KEY = {
  name: 'fullName',
  sap_number: 'sapId',
  sap_id: 'sapId',
  department: 'departmentName',
}

/** Question types that can carry a prefilled string. */
const TEXT_TYPES = new Set(['short_text', 'long_text'])

const clean = (value) => (typeof value === 'string' ? value.trim() : '') || null

/**
 * The account values a form may be filled from.
 *
 * `departmentName` is not on the profile — the profile holds a department id —
 * so the caller passes the resolved name alongside it.
 */
export function accountIdentity(profile, departmentName = null) {
  return {
    fullName: clean(profile?.full_name),
    sapId: clean(profile?.sap_id),
    departmentName: clean(departmentName),
  }
}

/**
 * Which questions this account answers for itself.
 *
 * @param {object[]} questions form questions, each with `key`, `type`, `versionId`
 * @param {ReturnType<typeof accountIdentity>} identity
 * @returns {{values: Record<string,string>, locked: Set<string>, fields: Record<string,string>}}
 *          `values` merges into the form's value map; `locked` holds the version
 *          ids to render read-only; `fields` names the source of each, for the hint.
 */
export function prefillIdentity(questions, identity) {
  const values = {}
  const locked = new Set()
  const fields = {}

  for (const question of questions ?? []) {
    const field = IDENTITY_FIELD_BY_KEY[question?.key]
    if (!field) continue
    if (!TEXT_TYPES.has(question.type)) continue

    const value = identity?.[field] ?? null
    if (!value) continue

    values[question.versionId] = value
    locked.add(question.versionId)
    fields[question.versionId] = field
  }

  return { values, locked, fields }
}

/** What the read-only hint under a locked field says. */
export const PREFILL_HINTS = {
  fullName: 'Taken from your account. Ask an administrator to change it.',
  sapId: 'Taken from your account. Ask an administrator to change it.',
  departmentName: 'The department your account belongs to.',
}
