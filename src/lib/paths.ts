import { filesystem, os } from '@neutralinojs/lib'

/**
 * Subfolder of the platform data directory where the app keeps its data.
 * Matches the old Tauri identifier so existing users keep their config/DB/cache.
 */
const APP_SUBDIR = 'com.eso.addonmanager'

/** Names of the app-managed data files (stored in the app data directory). */
const FILELIST_CACHE = 'filelist.json'
const INSTALLED_DB = 'installed.json'

let cachedAppDataDir: string | null = null

/** Absolute path to the app data directory (cached after first call). */
export async function appDataDirPath(): Promise<string> {
  if (!cachedAppDataDir) {
    const base = await os.getPath('data')
    cachedAppDataDir = await filesystem.getJoinedPath(base, APP_SUBDIR)
  }
  return cachedAppDataDir
}

/** Absolute path to the cached filelist inside the app data dir. */
export async function filelistCachePath(): Promise<string> {
  return filesystem.getJoinedPath(await appDataDirPath(), FILELIST_CACHE)
}

/** Absolute path to the installed-addon database inside the app data dir. */
export async function installedDbPath(): Promise<string> {
  return filesystem.getJoinedPath(await appDataDirPath(), INSTALLED_DB)
}

/**
 * Join an arbitrary number of path segments using the platform separator.
 * Async wrapper around Neutralino's `filesystem.getJoinedPath`.
 */
export async function joinPath(...segments: string[]): Promise<string> {
  return filesystem.getJoinedPath(...segments)
}

/**
 * The OS path separator, resolved once from the runtime `NL_OS` global that
 * Neutralino injects before app code runs. Used by the synchronous path helpers.
 */
function getSep(): string {
  const osName = typeof window !== 'undefined' && window.NL_OS ? String(window.NL_OS) : ''
  return osName.toLowerCase().includes('win') ? '\\' : '/'
}

/**
 * Synchronous path join using the platform separator. Used in hot loops
 * (e.g. zip extraction) where awaiting an async join per entry is wasteful.
 * Leading separators are stripped from all but the first segment.
 */
export function joinSync(...segments: string[]): string {
  const sepStr = getSep()
  const parts: string[] = []
  for (let i = 0; i < segments.length; i++) {
    let s = segments[i]
    if (s === '') continue
    if (i > 0) {
      // strip leading separators on subsequent segments
      while (s.startsWith(sepStr)) s = s.slice(sepStr.length)
    }
    if (i < segments.length - 1) {
      // strip trailing separators on non-final segments
      while (s.endsWith(sepStr)) s = s.slice(0, -sepStr.length)
    }
    parts.push(s)
  }
  return parts.join(sepStr)
}

/** Return the parent directory of a path (synchronous, platform-aware). */
export function dirname(p: string): string {
  const sepStr = getSep()
  const idx = p.lastIndexOf(sepStr)
  if (idx <= 0) return p.startsWith(sepStr) ? sepStr : '.'
  return p.slice(0, idx)
}

/** Return the final segment of a path. */
export function basename(p: string): string {
  const sepStr = getSep()
  const idx = p.lastIndexOf(sepStr)
  return idx === -1 ? p : p.slice(idx + sepStr.length)
}

/**
 * Normalize a zip entry path to a safe relative path.
 * Returns null if the entry is absolute or escapes via `..` (path traversal).
 * Also strips any leading `./` and backslashes (zips use `/`).
 */
export function safeRelative(entryPath: string): string | null {
  // zip separators are always '/'; convert any stray backslashes
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.startsWith('/')) return null
  const segments = normalized.split('/')
  for (const seg of segments) {
    if (seg === '..') return null
  }
  // convert to platform separators
  return segments.join(getSep())
}

/**
 * Check whether a path exists (file or directory).
 * Neutralino has no `exists`; this wraps `getStats` in a try/catch.
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await filesystem.getStats(p)
    return true
  } catch {
    return false
  }
}