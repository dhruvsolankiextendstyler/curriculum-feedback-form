/**
 * SAP ID rules for the Edge Functions.
 *
 * Mirrors `src/lib/identifier.js` (browser) and the `profiles_sap_id_format`
 * check constraint in `supabase/migrations/0007_sap_id.sql` (database). There is
 * no build step shared between the three runtimes, so the rule is written out in
 * each — as `VALID_ROLES` already is. Change one, change all three.
 */

/** Starts alphanumeric, then alphanumerics and . _ - / — no '@', no spaces. */
export const SAP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,31}$/

export const SAP_ID_HINT =
  '3-32 characters: letters, digits and . _ - / (no spaces, and no "@" — that ' +
  'is reserved for email addresses)'

export const isEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())

/** The stored form. The database applies the same normalisation in a trigger. */
export const normaliseSapId = (raw: unknown) =>
  String(raw ?? '').trim().toUpperCase()

export type SapIdCheck =
  | { ok: true; value: string | null }
  | { ok: false; value: null; reason: string }

/** Validates an OPTIONAL SAP ID. Blank succeeds with a null value. */
export function validateSapId(raw: unknown): SapIdCheck {
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

/** True when a Postgres/PostgREST error means migration 0007 has not run yet. */
export const isMissingSapIdColumn = (message = '') =>
  /sap_id/i.test(message) && /(does not exist|could not find|schema cache)/i.test(message)
