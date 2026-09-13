import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const migration = read(
  'supabase/migrations/20260910180050_harden_provisioning_and_hod_status.sql',
)
const invite = read('supabase/functions/invite-users/index.ts')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('\ntrusted provisioning metadata')
check('the Edge Function stamps the trusted provisioning marker', () =>
  assert.match(invite, /app_metadata:\s*\{[\s\S]*?provisioned_by:\s*'invite-users-v1'/))
check('role and department are stored in app metadata', () => {
  assert.match(invite, /app_metadata:\s*\{[\s\S]*?\n\s*role,/)
  assert.match(invite, /app_metadata:\s*\{[\s\S]*?department_id:\s*departmentId/)
})
check('display metadata does not carry role or department privileges', () => {
  const blocks = [...invite.matchAll(/user_metadata:\s*\{([\s\S]*?)\n\s*\},/g)]
  assert.ok(blocks.length >= 2)
  for (const [, body] of blocks) {
    assert.doesNotMatch(body, /\brole\b|department_id/)
  }
})
check('legacy recovery stamps the same trusted marker', () =>
  assert.match(
    invite,
    /existingUser\.app_metadata[\s\S]*?provisioned_by:\s*'invite-users-v1'/,
  ))

console.log('\nauth trigger trust boundary')
check('the trigger reads role and department only from app metadata', () => {
  assert.match(migration, /new\.raw_app_meta_data\s*->>\s*'role'/)
  assert.match(migration, /new\.raw_app_meta_data\s*->>\s*'department_id'/)
  assert.doesNotMatch(migration, /raw_user_meta_data\s*->>\s*'(?:role|department_id)'/)
})
check('the trigger requires the trusted marker', () => {
  assert.match(migration, /trusted_marker constant text := 'invite-users-v1'/)
  assert.match(migration, /provisioning_marker is distinct from trusted_marker/)
})
check('unknown roles do not create profiles', () =>
  assert.match(migration, /trusted_role not in \([\s\S]*?'admin'[\s\S]*?'faculty'[\s\S]*?return new;/))

console.log('\nprovisioning policy checks')
check('duplicate SAP IDs use a generic message', () => {
  assert.match(invite, /reason:\s*'That SAP ID is already in use\.'/)
  assert.doesNotMatch(invite, /SAP ID[\s\S]{0,100}(?:belongs to|assigned to)[\s\S]{0,40}(?:email|existing)/i)
})
check('department lookup includes parent stream status', () =>
  assert.match(invite, /streams!inner \( is_active \)/))
check('archived parent streams are rejected for admin provisioning', () =>
  assert.match(invite, /found\.department\.streams\?\.is_active === false/))
check('the profile guard refuses HOD status changes', () =>
  assert.match(
    migration,
    /hod_dept is not null[\s\S]*?new\.status is distinct from old\.status[\s\S]*?Only an administrator can change account status/,
  ))
check('security-definer functions pin their search path', () =>
  assert.equal((migration.match(/set search_path = public/g) ?? []).length, 2))
check('security-definer functions revoke direct API execution', () => {
  assert.match(
    migration,
    /revoke all on function handle_new_auth_user\(\) from public, anon, authenticated/,
  )
  assert.match(
    migration,
    /revoke all on function guard_profile_privilege_columns\(\) from public, anon, authenticated/,
  )
})

console.log(`\n${passed} provisioning security checks passed\n`)
