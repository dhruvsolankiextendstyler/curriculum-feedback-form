/**
 * What a sign-in identifier may be, and what a SAP ID may contain (FR-1).
 *
 * A user signs in with EITHER their email address or their SAP ID, and the two
 * are told apart by the '@'. That is why a SAP ID is forbidden from containing
 * one: it is not a style rule, it is what makes the single login field
 * unambiguous rather than a guess. The same restriction is enforced in the
 * database (`profiles_sap_id_format` in 0007_sap_id.sql) and in the Edge
 * Functions (`supabase/functions/_shared/sapId.ts`), because there is no build
 * step shared between the browser bundle, Deno and Postgres. Change one, change
 * all three.
 */

/** Starts alphanumeric, then alphanumerics and . _ - / — no '@', no spaces. */
export const SAP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,31}$/

export const SAP_ID_HINT =
  '3-32 characters: letters, digits and . _ - / ' +
  '(no spaces, and no "@" — that is reserved for email addresses)'

export const isEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? '').trim())

/**
 * The stored form: trimmed and upper-cased, so "ab12" and "AB12" can never
 * become two different people. The database applies the same normalisation in a
 * trigger, so this is a convenience for the UI, not the guarantee.
 */
export const normaliseSapId = (raw) => String(raw ?? '').trim().toUpperCase()

export const isValidSapId = (raw) => SAP_ID_PATTERN.test(normaliseSapId(raw))

/**
 * Validates an OPTIONAL SAP ID. Blank is a success with a null value: an
 * account without a SAP ID is normal and signs in by email as before.
 *
 * @returns {{ ok: true, value: string|null } | { ok: false, value: null, reason: string }}
 */
export function validateSapId(raw) {
  const value = normaliseSapId(raw)
  if (value === '') return { ok: true, value: null }

  if (value.includes('@')) {
    return {
      ok: false,
      value: null,
      reason:
        'A SAP ID cannot contain "@" — sign-in reads an identifier with one as an email address.',
    }
  }
  if (!SAP_ID_PATTERN.test(value)) {
    return { ok: false, value: null, reason: `Invalid SAP ID. Use ${SAP_ID_HINT}.` }
  }
  return { ok: true, value }
}

/**
 * Decides how the login screen's single field should be read.
 *
 * `valid` is advisory — it lets the form reject obvious typos before spending a
 * network round trip. Authentication itself never trusts it.
 *
 * @returns {{ kind: 'empty'|'email'|'sap_id', value: string, valid: boolean }}
 */
export function classifyIdentifier(raw) {
  const entered = String(raw ?? '').trim()
  if (entered === '') return { kind: 'empty', value: '', valid: false }

  if (entered.includes('@')) {
    return { kind: 'email', value: entered.toLowerCase(), valid: isEmail(entered) }
  }

  const sapId = normaliseSapId(entered)
  return { kind: 'sap_id', value: sapId, valid: SAP_ID_PATTERN.test(sapId) }
}
