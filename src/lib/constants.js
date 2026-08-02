// Mirrors the `user_role` enum in supabase/migrations/0001_schema.sql.
export const ROLES = {
  ADMIN: 'admin',
  ACADEMIC_PEER: 'academic_peer',
  STUDENT: 'student',
  EMPLOYER: 'employer',
  ALUMNI: 'alumni',
  FACULTY: 'faculty',
}

export const ROLE_LABELS = {
  [ROLES.ADMIN]: 'Administrator',
  [ROLES.ACADEMIC_PEER]: 'Academic Peer',
  [ROLES.STUDENT]: 'Student',
  [ROLES.EMPLOYER]: 'Employer / Industry Expert',
  [ROLES.ALUMNI]: 'Alumni',
  [ROLES.FACULTY]: 'Faculty',
}

export const RESPONDENT_ROLES = [
  ROLES.ACADEMIC_PEER,
  ROLES.STUDENT,
  ROLES.EMPLOYER,
  ROLES.ALUMNI,
  ROLES.FACULTY,
]

export const isAdmin = (role) => role === ROLES.ADMIN
export const isRespondent = (role) => RESPONDENT_ROLES.includes(role)

// FR-7: where a user lands after signing in.
export const homePathFor = (role) => (isAdmin(role) ? '/admin' : '/feedback')

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
