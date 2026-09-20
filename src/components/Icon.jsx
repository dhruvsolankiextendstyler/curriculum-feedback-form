import { MorphIcon } from 'morphicons/react'

/**
 * App-wide icon (morphicons + lucide data).
 *
 * Icons are lucide stroke paths and inherit `currentColor`, so they follow the
 * surrounding text colour — muted, accent, dark mode — with no per-icon colour.
 * Changing the `icon` prop animates the morph between shapes; `reducedMotion`
 * is "user" so a morph degrades to an instant swap when the OS asks for it.
 *
 * Usage: import the shape data from lucide and pass it in.
 *   import { Users } from 'lucide'
 *   <Icon icon={Users} />
 *   <Icon icon={open ? X : Menu} />   // morphs on toggle
 */
export default function Icon({ size = 18, strokeWidth = 2, ...rest }) {
  return (
    <MorphIcon size={size} strokeWidth={strokeWidth} reducedMotion="user" {...rest} />
  )
}
