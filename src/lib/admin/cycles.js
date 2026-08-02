import { supabase } from '../supabase'

/**
 * Feedback cycle management (PRD §4: feedback is organised per academic year).
 *
 * `closes_at` is the edit window from FR-16 — the RLS policies on responses and
 * answers read it directly, so changing it here changes what respondents can do
 * immediately, with no deploy.
 */

export async function loadCycles() {
  const { data, error } = await supabase
    .from('academic_cycles')
    .select('id, label, is_active, opens_at, closes_at, created_at')
    .order('opens_at', { ascending: false })

  if (error) throw new Error(error.message)
  return data ?? []
}

/** Response counts per cycle, so an admin can see what a change would affect. */
export async function loadCycleCounts() {
  const { data, error } = await supabase.from('responses').select('cycle_id')
  if (error) throw new Error(error.message)

  const counts = {}
  for (const row of data ?? []) {
    counts[row.cycle_id] = (counts[row.cycle_id] ?? 0) + 1
  }
  return counts
}

export async function createCycle({ label, opensAt, closesAt, activate }) {
  const trimmed = label.trim()
  if (!trimmed) throw new Error('Give the cycle a label, e.g. "2026-27".')
  if (new Date(closesAt) <= new Date(opensAt)) {
    throw new Error('The closing date must be after the opening date.')
  }

  // `one_active_cycle` is a partial unique index on is_active, so activating a
  // new cycle requires standing the old one down first.
  if (activate) await deactivateAll()

  const { data, error } = await supabase
    .from('academic_cycles')
    .insert({
      label: trimmed,
      opens_at: new Date(opensAt).toISOString(),
      closes_at: new Date(closesAt).toISOString(),
      is_active: Boolean(activate),
    })
    .select('id')
    .single()

  if (error) throw new Error(translateCycleError(error))
  return data.id
}

export async function updateCycle(cycleId, { label, opensAt, closesAt }) {
  const patch = {}
  if (label !== undefined) patch.label = label.trim()
  if (opensAt !== undefined) patch.opens_at = new Date(opensAt).toISOString()
  if (closesAt !== undefined) patch.closes_at = new Date(closesAt).toISOString()

  if (patch.opens_at && patch.closes_at && new Date(patch.closes_at) <= new Date(patch.opens_at)) {
    throw new Error('The closing date must be after the opening date.')
  }

  const { error } = await supabase.from('academic_cycles').update(patch).eq('id', cycleId)
  if (error) throw new Error(translateCycleError(error))
}

/** Only one cycle may be active (enforced by a partial unique index). */
export async function activateCycle(cycleId) {
  await deactivateAll()
  const { error } = await supabase
    .from('academic_cycles')
    .update({ is_active: true })
    .eq('id', cycleId)
  if (error) throw new Error(translateCycleError(error))
}

async function deactivateAll() {
  const { error } = await supabase
    .from('academic_cycles')
    .update({ is_active: false })
    .eq('is_active', true)
  if (error) throw new Error(translateCycleError(error))
}

/**
 * Closes a cycle now: sets closes_at to this instant, which makes
 * cycle_is_open() false and turns every response in it read-only.
 */
export async function closeCycleNow(cycleId) {
  const { error } = await supabase
    .from('academic_cycles')
    .update({ closes_at: new Date().toISOString() })
    .eq('id', cycleId)
  if (error) throw new Error(translateCycleError(error))
}

export function cycleState(cycle) {
  const now = Date.now()
  const opens = new Date(cycle.opens_at).getTime()
  const closes = new Date(cycle.closes_at).getTime()

  if (now < opens) return 'scheduled'
  if (now >= closes) return 'closed'
  return cycle.is_active ? 'open' : 'inactive'
}

export const CYCLE_STATE_LABELS = {
  open: 'Open',
  closed: 'Closed',
  scheduled: 'Scheduled',
  inactive: 'Not active',
}

function translateCycleError(error) {
  const message = error.message ?? 'Could not save the cycle.'
  if (error.code === '23505') {
    if (/one_active_cycle/.test(message)) {
      return 'Another cycle is still active. Stand it down first.'
    }
    return 'A cycle with that label already exists.'
  }
  if (/cycle_window_valid/.test(message)) {
    return 'The closing date must be after the opening date.'
  }
  return message
}

/** Formats a timestamptz for a datetime-local input, in the browser's zone. */
export function toLocalInput(iso) {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
