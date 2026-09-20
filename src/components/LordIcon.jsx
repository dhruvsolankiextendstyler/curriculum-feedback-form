import { useEffect, useRef } from 'react'

/**
 * Lordicon <lord-icon> web component (loaded in index.html).
 *
 * For single-state, decorative spots — nav tabs, sign-out — where morphicons has
 * no second shape to morph into. Two-state toggles use morphicons instead.
 *
 * `target` is a CSS selector for an ancestor: Lordicon then fires the hover
 * animation when the whole ancestor is hovered, not just the small icon. We also
 * replay on that ancestor's click. Motion stays user-initiated, so nothing
 * animates on load.
 *
 * Decorative: aria-hidden, so the visible text label carries the meaning.
 * `colors` takes literal values (no CSS variables), so a single mid-slate tint
 * is used that reads on both the light and dark sidebar.
 */
const ICON_TINT = 'primary:#5f7793,secondary:#5f7793'

export default function LordIcon({ src, size = 20, trigger = 'hover', target }) {
  const ref = useRef(null)

  // Lordicon's `target` covers hover on the ancestor; add click to replay.
  useEffect(() => {
    const el = ref.current
    if (!el || !target) return
    const parent = el.closest(target)
    if (!parent) return
    const replay = () => {
      const player = el.playerInstance
      if (player?.playFromBeginning) player.playFromBeginning()
      else player?.play?.()
    }
    parent.addEventListener('click', replay)
    return () => parent.removeEventListener('click', replay)
  }, [target])

  if (!src) return null
  return (
    <lord-icon
      ref={ref}
      src={src}
      trigger={trigger}
      target={target}
      colors={ICON_TINT}
      style={{ width: `${size}px`, height: `${size}px`, flexShrink: 0 }}
      aria-hidden="true"
    />
  )
}
