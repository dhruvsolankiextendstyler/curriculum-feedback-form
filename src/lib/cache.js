/**
 * TTL cache for async functions. Deduplicates in-flight requests,
 * clears failed entries so the next call retries, and shares resolved
 * values across browser tabs via BroadcastChannel.
 */

const channel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('fp-cache')
  : null

let nextId = 0

export function cached(fn, ttlMs = 30_000) {
  const id = nextId++
  const store = new Map()

  if (channel) {
    channel.addEventListener('message', (e) => {
      if (e.data?.cid !== id) return
      const hit = store.get(e.data.key)
      if (!hit || e.data.at > hit.at) {
        store.set(e.data.key, { p: Promise.resolve(e.data.value), at: e.data.at })
      }
    })
  }

  function wrapper(...args) {
    const key = JSON.stringify(args)
    const hit = store.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return hit.p
    const p = fn(...args)
    const at = Date.now()
    store.set(key, { p, at })
    p.then((value) => {
      if (channel) {
        try { channel.postMessage({ cid: id, key, value, at }) } catch {}
      }
    })
    p.catch(() => { if (store.get(key)?.p === p) store.delete(key) })
    return p
  }

  wrapper.bust = () => store.clear()
  return wrapper
}
