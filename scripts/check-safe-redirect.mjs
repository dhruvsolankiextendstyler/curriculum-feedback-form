/**
 * Guards safeRedirect() — the open-redirect mitigation the react-router
 * advisory decision rests on (see README "Known advisory").
 *
 * Run: node scripts/check-safe-redirect.mjs
 */
import { safeRedirect, homePathFor, ROLES } from '../src/lib/constants.js'

const S = ROLES.STUDENT
const A = ROLES.ADMIN
const BS = String.fromCharCode(92) // backslash, built to survive shell quoting

const cases = [
  ['/feedback', S, '/feedback', 'normal relative path passes'],
  ['/admin/users', A, '/admin/users', 'nested admin path passes'],
  ['/feedback?course=Stats', S, '/feedback?course=Stats', 'query string preserved'],
  ['//evil.com', S, '/feedback', 'protocol-relative blocked'],
  ['https://evil.com', S, '/feedback', 'absolute URL blocked'],
  ['http://evil.com/x', A, '/admin', 'absolute URL blocked (admin)'],
  ['javascript:alert(1)', S, '/feedback', 'scheme injection blocked'],
  [`/${BS}${BS}evil.com`, S, '/feedback', 'backslash-escaped host blocked'],
  [`${BS}${BS}evil.com`, S, '/feedback', 'UNC-style path blocked'],
  ['feedback', S, '/feedback', 'non-rooted blocked'],
  ['', S, '/feedback', 'empty falls back'],
  [undefined, S, '/feedback', 'undefined falls back'],
  [null, A, '/admin', 'null falls back to admin home'],
  [42, S, '/feedback', 'non-string falls back'],
  ['/login', S, '/feedback', 'login loop avoided'],
  ['/set-password', A, '/admin', 'set-password loop avoided'],
]

let failed = 0
for (const [input, role, want, label] of cases) {
  const got = safeRedirect(input, role)
  const ok = got === want
  if (!ok) failed++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} in=${JSON.stringify(input)} -> ` +
      `${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
  )
}

console.log(`\nhomePathFor: admin=${homePathFor(A)} respondent=${homePathFor(S)}`)
console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`)
process.exit(failed ? 1 : 0)
