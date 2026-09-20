import { useState } from 'react'
import { Moon, Sun } from 'lucide'
import Icon from './Icon'

/**
 * Light/dark toggle. The initial theme is set on <html> before paint by the
 * inline script in index.html; this just flips and persists it. The Sun/Moon
 * icon morphs on each switch (morphicons).
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute('data-theme') || 'light',
  )

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    const root = document.documentElement
    // Only animate colours during a deliberate switch. The class is what carries
    // the transition (see styles.css) so the pre-paint theme on load never fades
    // in, and it is pulled once the switch has settled.
    root.classList.add('theme-transition')
    root.setAttribute('data-theme', next)
    window.clearTimeout(toggle.timer)
    toggle.timer = window.setTimeout(() => root.classList.remove('theme-transition'), 400)
    try {
      localStorage.setItem('theme', next)
    } catch (e) {
      // Private mode / storage disabled: the theme still applies for this session.
    }
    setTheme(next)
  }

  const dark = theme === 'dark'
  return (
    <button
      type="button"
      className="secondary icon-only"
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <Icon icon={dark ? Sun : Moon} size={18} />
    </button>
  )
}
