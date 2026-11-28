export type ThemePref = 'light' | 'dark' | 'system'

const key = 'golive.theme'
const query = '(prefers-color-scheme: dark)'

export function savedTheme(): ThemePref {
  try {
    const v = localStorage.getItem(key)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch { return 'system' }
}

export function resolveTheme(pref: ThemePref) {
  return pref === 'system' ? (window.matchMedia?.(query).matches ? 'dark' : 'light') : pref
}

/** Applies the theme to <html> (also read by daisyUI) and remembers the choice. */
export function applyTheme(pref: ThemePref) {
  const theme = resolveTheme(pref)
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1e1f22' : '#07142d')
  try { if (pref === 'system') localStorage.removeItem(key); else localStorage.setItem(key, pref) } catch { /* storage unavailable */ }
}

/** Follows the system setting while the preference is "system". */
export function watchSystemTheme(onChange: () => void) {
  const media = window.matchMedia?.(query)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}
