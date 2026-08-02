/**
 * Guards the Supabase URL validator — the check that turns a pasted dashboard
 * URL into a clear message instead of an opaque CORS failure at sign-in.
 *
 * Run: node scripts/check-supabase-url.mjs
 */

// Mirrors describeUrlProblem() in src/lib/supabase.js. Kept as a copy because
// that module reads import.meta.env, which plain node cannot evaluate.
function describeUrlProblem(value) {
  if (!value) return 'VITE_SUPABASE_URL is missing.'
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return `VITE_SUPABASE_URL is not a valid URL: "${value}"`
  }
  if (parsed.hostname === 'supabase.com' || parsed.hostname === 'www.supabase.com') {
    const ref = parsed.pathname.match(/\/project\/([a-z0-9]+)/i)?.[1]
    return (
      'VITE_SUPABASE_URL points at the Supabase dashboard, not your project API. ' +
      (ref
        ? `Use https://${ref}.supabase.co instead.`
        : 'Use the "Project URL" from Project Settings → API (https://<ref>.supabase.co).')
    )
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return `VITE_SUPABASE_URL should have no path. Use just https://${parsed.hostname}`
  }
  return null
}

const cases = [
  ['https://fnzmbrgtwgorcqxuvmtn.supabase.co', false, 'valid API URL accepted'],
  ['https://fnzmbrgtwgorcqxuvmtn.supabase.co/', false, 'trailing slash accepted'],
  ['http://localhost:54321', false, 'local supabase accepted'],
  [
    'https://supabase.com/dashboard/project/fnzmbrgtwgorcqxuvmtn',
    true,
    'dashboard URL rejected (the real-world mistake)',
  ],
  [
    'https://supabase.com/dashboard/project/abc123/auth/users',
    true,
    'deep dashboard URL rejected',
  ],
  ['https://www.supabase.com/dashboard/project/x1y2', true, 'www dashboard rejected'],
  ['https://myproj.supabase.co/rest/v1', true, 'URL with a path rejected'],
  ['not-a-url', true, 'malformed string rejected'],
  ['', true, 'empty rejected'],
  [undefined, true, 'missing rejected'],
]

let failed = 0
for (const [input, shouldFail, label] of cases) {
  const problem = describeUrlProblem(input)
  const ok = Boolean(problem) === shouldFail
  if (!ok) failed++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${problem ? '→ ' + problem.slice(0, 62) : '→ accepted'}`
  )
}

// The message must name the corrected URL, not just say "wrong".
const hint = describeUrlProblem('https://supabase.com/dashboard/project/fnzmbrgtwgorcqxuvmtn')
if (!hint.includes('https://fnzmbrgtwgorcqxuvmtn.supabase.co')) {
  console.log('FAIL  dashboard message does not suggest the corrected URL')
  failed++
} else {
  console.log('PASS  dashboard message suggests the corrected URL')
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`)
process.exit(failed ? 1 : 0)
