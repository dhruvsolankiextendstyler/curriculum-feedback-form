// Mirrors the `user_role` enum in supabase/migrations/0001_schema.sql, plus `hod`
// from 0010_hod_role.sql.
export const ROLES = {
  ADMIN: 'admin',
  HOD: 'hod',
  ACADEMIC_PEER: 'academic_peer',
  STUDENT: 'student',
  EMPLOYER: 'employer',
  ALUMNI: 'alumni',
  FACULTY: 'faculty',
}

export const ROLE_LABELS = {
  [ROLES.ADMIN]: 'Administrator',
  [ROLES.HOD]: 'Head of Department',
  [ROLES.ACADEMIC_PEER]: 'Academic Peer',
  [ROLES.STUDENT]: 'Student',
  [ROLES.EMPLOYER]: 'Employer / Industry Expert',
  [ROLES.ALUMNI]: 'Alumni',
  [ROLES.FACULTY]: 'Faculty',
}

/**
 * The five roles that have a feedback form. Staff do not — `forms_respondent_only`
 * in 0011_hod_scope.sql refuses a form for `admin` or `hod` at the database level.
 */
export const RESPONDENT_ROLES = [
  ROLES.ACADEMIC_PEER,
  ROLES.STUDENT,
  ROLES.EMPLOYER,
  ROLES.ALUMNI,
  ROLES.FACULTY,
]

/** Everything an administrator may assign, in the order the pickers show it. */
export const ASSIGNABLE_ROLES = [ROLES.ADMIN, ROLES.HOD, ...RESPONDENT_ROLES]

/**
 * What an HOD may create (FR-51). Narrower than ASSIGNABLE_ROLES on purpose: an
 * HOD administers the people who belong to their department, and cannot appoint a
 * peer or a superior. Mirrored in supabase/functions/invite-users/index.ts and in
 * the profile guard, so the browser is not the thing enforcing it.
 */
export const HOD_CREATABLE_ROLES = [ROLES.STUDENT, ROLES.FACULTY]

/** Global administrator. An HOD is deliberately NOT one. */
export const isAdmin = (role) => role === ROLES.ADMIN
/** Administrator of one department. */
export const isHod = (role) => role === ROLES.HOD
/** May reach the admin panel at all — an admin or an HOD. */
export const isStaff = (role) => isAdmin(role) || isHod(role)

// FR-7: where a user lands after signing in.
export const homePathFor = (role) => (isStaff(role) ? '/admin' : '/feedback')

/**
 * Sanitise a post-login redirect target.
 *
 * The "return to where you were" path comes from router state, which a crafted
 * link can influence. Anything that could leave the origin — an absolute URL,
 * a scheme, or a protocol-relative `//evil.com` — is discarded in favour of the
 * user's own home path. This is the open-redirect class of bug that React
 * Router 6 was advisory-flagged for; we do not rely on the library for it.
 */
export function safeRedirect(path, role) {
  const fallback = homePathFor(role)
  if (typeof path !== 'string' || path === '') return fallback
  // Must be a single-slash-rooted relative path.
  if (!path.startsWith('/') || path.startsWith('//')) return fallback
  if (path.includes('://') || path.includes('\\')) return fallback
  // Never bounce back to the auth screens; that would loop.
  if (path === '/login' || path === '/set-password') return fallback
  return path
}
