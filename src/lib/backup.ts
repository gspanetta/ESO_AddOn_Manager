import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { exists, mkdir, readDir, readFile, readTextFile, rename, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { dirname, joinSync, safeRelative } from './paths'
import { loadInstalled, saveInstalled } from './installed'
import type { InstalledAddon } from './types'

/** Current backup format version (bump when the zip layout changes). */
const BACKUP_FORMAT_VERSION = 1

/** Name of the JSON manifest entry inside the backup zip. */
const MANIFEST_ENTRY = 'manifest.json'
/** Name of the installed-DB entry inside the backup zip. */
const INSTALLED_ENTRY = 'installed.json'
/** Name of the ESO-wide settings file, stored at the zip root. */
const USER_SETTINGS_ENTRY = 'UserSettings.txt'
/** Zip prefix for all SavedVariables files. */
const SAVED_VARIABLES_PREFIX = 'SavedVariables/'

/**
 * `UserSettings.txt` keys that control *display* (resolution, fullscreen,
 * window geometry). When importing without "overwrite display settings",
 * lines starting with one of these keys are taken from the *current* file
 * instead of the backup, so a backup from another machine/monitor does not
 * break the display configuration. All other lines (graphics quality,
 * camera, audio, min frame time, ...) are restored from the backup.
 */
const DISPLAY_KEY_PATTERNS: RegExp[] = [
  /^SET\s+PreferMaximizedWindow\b/i,
  /^SET\s+PreferExclusiveFullscreen\b/i,
  /^SET\s+FULLSCREEN\b/i,
  /^SET\s+FULLSCREENRES/i, // FULLSCREENRESHEIGHT / FULLSCREENRESWIDTH (legacy)
  /^SET\s+FullscreenHeight\b/i,
  /^SET\s+FullscreenWidth\b/i,
  /^SET\s+WindowedHeight\b/i,
  /^SET\s+WindowedWidth\b/i,
  /^SET\s+ACTIVE_DISPLAY\b/i,
]

/** True if a `SET …` line in UserSettings.txt is a display setting we preserve on import. */
export function isDisplaySettingLine(line: string): boolean {
  return DISPLAY_KEY_PATTERNS.some(re => re.test(line))
}

/**
 * Merge a backup UserSettings.txt with the current one: all non-display
 * lines come from the backup; display lines come from the current file.
 * If the current file is missing or a display key exists only in the backup,
 * the backup's version is used.
 *
 * Operates on decoded UTF-8 text; the caller is responsible for reading and
 * writing bytes (see `restoreSettings`).
 */
export function mergeUserSettings(backupText: string, currentText: string | null): string {
  if (currentText === null) return backupText

  const currentDisplayByKey = new Map<string, string>()
  for (const line of currentText.split(/\r?\n/)) {
    if (!isDisplaySettingLine(line)) continue
    // key = everything up to the first quote-delimited value; normalize
    // whitespace so `SET  FULLSCREEN` and `SET FULLSCREEN` map together.
    const key = line.replace(/^SET\s+/i, 'SET ').replace(/\s+".*$/, '')
    currentDisplayByKey.set(key, line)
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const line of backupText.split(/\r?\n/)) {
    if (isDisplaySettingLine(line)) {
      const key = line.replace(/^SET\s+/i, 'SET ').replace(/\s+".*$/, '')
      const current = currentDisplayByKey.get(key)
      if (current !== undefined) {
        out.push(current)
        seen.add(key)
        continue
      }
    }
    out.push(line)
  }

  // preserve display keys that exist only in the current file (backup lacks them)
  for (const [key, line] of currentDisplayByKey) {
    if (!seen.has(key)) out.push(line)
  }
  return out.join('\n')
}

/** Manifest stored in every backup zip; also the parsed result on import. */
export interface BackupManifest {
  /** Backup layout version, for forward-compatibility checks on import. */
  formatVersion: number
  /** App version that created the backup (informational only). */
  appVersion: string
  /** Epoch ms when the backup was created. */
  exportedAt: number
  /** Installed-addon records snapshot at export time. */
  addons: InstalledAddon[]
}

/** Summary returned by a successful export. */
export interface BackupExportResult {
  /** Number of SavedVariables files included in the zip. */
  savedVariableFiles: number
  /** Whether UserSettings.txt was found and included. */
  includesUserSettings: boolean
  /** Number of tracked addons recorded in the manifest. */
  addonCount: number
}

/** Summary returned by a successful import. */
export interface BackupImportResult {
  /** Number of SavedVariables files restored to disk. */
  restoredSavedVariables: number
  /** Whether UserSettings.txt was restored. */
  restoredUserSettings: boolean
  /** Number of addon records now in the installed DB. */
  addonCount: number
  /** Absolute path of the pre-import backup folder, if anything needed moving. */
  backupDir: string | null
  /** Files whose existing versions were backed up before being overwritten. */
  backedUp: string[]
  /** Zip entries that were skipped as unsafe (absolute / path-traversal). */
  skippedUnsafe: number
}

/** A parsed, validated backup — no filesystem side effects yet. */
export interface ParsedBackup {
  /** Manifest metadata from manifest.json. */
  manifest: BackupManifest
  /** Addon records from installed.json (empty if missing/corrupt). */
  addons: InstalledAddon[]
  /** SavedVariables files as { rel path under SavedVariables, raw bytes }. */
  savedVariables: { rel: string; data: Uint8Array }[]
  /** Raw UserSettings.txt bytes, or null if the backup has none. */
  userSettings: Uint8Array | null
  /** Zip entries skipped as unsafe (absolute / path-traversal). */
  skippedUnsafe: number
}

/** Absolute path to the SavedVariables folder (sibling of the AddOns folder). */
export function savedVariablesPath(addonPath: string): string {
  return joinSync(dirname(addonPath), 'SavedVariables')
}

/** Absolute path to the ESO-wide UserSettings.txt (sibling of the AddOns folder). */
export function userSettingsPath(addonPath: string): string {
  return joinSync(dirname(addonPath), 'UserSettings.txt')
}

/** Recursively collect file paths under `dir`, returned relative to `dir`. */
async function collectFilesRecursive(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readDir(dir)
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory) {
      files.push(...(await collectFilesRecursive(joinSync(dir, entry.name), rel)))
    } else if (entry.isFile) {
      files.push(rel)
    }
  }
  return files
}

/**
 * Build the backup zip in memory:
 *  - `manifest.json` — format version + snapshot of the installed-addon DB,
 *  - `installed.json` — the raw installed DB (restored verbatim on import),
 *  - `UserSettings.txt` — ESO-wide settings (optional; skipped if absent),
 *  - `SavedVariables/**` — every per-addon lua settings file.
 *
 * Everything is read as raw bytes so encoding (UTF-8/UTF-16 lua files) is
 * preserved losslessly.
 */
export async function exportSettings(addonPath: string): Promise<{ bytes: Uint8Array; result: BackupExportResult }> {
  const addons = await loadInstalled()
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: import.meta.env.VITE_APP_VERSION ?? 'unknown',
    exportedAt: Date.now(),
    addons,
  }

  const entries: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest, null, 2)),
    [INSTALLED_ENTRY]: strToU8(JSON.stringify(addons, null, 2)),
  }

  let includesUserSettings = false
  const settingsPath = userSettingsPath(addonPath)
  if (await exists(settingsPath)) {
    entries[USER_SETTINGS_ENTRY] = await readFile(settingsPath)
    includesUserSettings = true
  }

  let savedVariableFiles = 0
  const svPath = savedVariablesPath(addonPath)
  if (await exists(svPath)) {
    const relFiles = await collectFilesRecursive(svPath)
    for (const rel of relFiles) {
      entries[SAVED_VARIABLES_PREFIX + rel] = await readFile(joinSync(svPath, rel))
      savedVariableFiles++
    }
  }

  const bytes = zipSync(entries, { level: 6 })
  return { bytes, result: { savedVariableFiles, includesUserSettings, addonCount: addons.length } }
}

/**
 * Parse and validate a backup zip **without touching the filesystem**.
 * Returns everything needed for (a) a confirmation dialog (how many addons,
 * which names) and (b) the actual restore (`restoreSettings`).
 */
export function readBackup(bytes: Uint8Array): ParsedBackup {
  const entries = unzipSync(bytes)

  const manifestBytes = entries[MANIFEST_ENTRY]
  if (!manifestBytes) {
    throw new Error('Not a valid backup file: manifest.json is missing.')
  }
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as BackupManifest
  } catch {
    throw new Error('Not a valid backup file: manifest.json is corrupt.')
  }
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup format version ${manifest.formatVersion}. Please update the app to import this backup.`
    )
  }

  const savedVariables: { rel: string; data: Uint8Array }[] = []
  let skippedUnsafe = 0
  for (const [entryPath, data] of Object.entries(entries)) {
    if (!entryPath.startsWith(SAVED_VARIABLES_PREFIX)) continue
    const rel = safeRelative(entryPath.slice(SAVED_VARIABLES_PREFIX.length))
    if (rel === null || rel === '') {
      skippedUnsafe++
      continue
    }
    savedVariables.push({ rel, data })
  }

  let addons: InstalledAddon[] = []
  const installedData = entries[INSTALLED_ENTRY]
  if (installedData) {
    try {
      const parsed = JSON.parse(strFromU8(installedData))
      if (Array.isArray(parsed)) addons = parsed as InstalledAddon[]
    } catch {
      // corrupt installed.json inside the backup: treat as "no addons"
    }
  }

  return {
    manifest,
    addons,
    savedVariables,
    userSettings: entries[USER_SETTINGS_ENTRY] ?? null,
    skippedUnsafe,
  }
}

/**
 * Restore a parsed backup:
 *  1. Back up any existing SavedVariables that would be overwritten (or that
 *     are not part of the backup and would otherwise linger) into
 *     `SavedVariables.bak-<timestamp>/` (rename, i.e. move).
 *  2. Write SavedVariables files to the live folder (entries were already
 *     validated by `readBackup`).
 *  3. Restore UserSettings.txt from the backup — fully when
 *     `options.overwriteDisplaySettings` is true, otherwise as a merge that
 *     keeps the *current* file's display settings (resolution, fullscreen,
 *     window geometry) so an import from another machine doesn't break them.
 *  4. Replace the installed DB with the backup's `installed.json` snapshot —
 *     or, if `options.addons` is given (e.g. after a folder wipe + reinstall),
 *     with that final list instead, so the DB matches what is actually on disk.
 */
export async function restoreSettings(
  backup: ParsedBackup,
  addonPath: string,
  options: { addons?: InstalledAddon[]; overwriteDisplaySettings?: boolean } = {}
): Promise<BackupImportResult> {
  const { savedVariables: svFiles, userSettings: userSettingsData, skippedUnsafe } = backup
  // The DB state to persist: caller's final list if provided (post-reinstall),
  // otherwise the backup's snapshot verbatim.
  const addonsToSave = options.addons ?? backup.addons

  // Back up whatever would be overwritten.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const backupDir = joinSync(dirname(addonPath), `SavedVariables.bak-${stamp}`)
  const backedUp: string[] = []

  const svPath = savedVariablesPath(addonPath)
  const existingSvFiles = (await exists(svPath)) ? new Set(await collectFilesRecursive(svPath)) : new Set<string>()
  const svTargets = new Set(svFiles.map(f => f.rel))
  // Also back up files that exist on disk but are not in the import —
  // they would otherwise linger and mix old settings into the restored state.
  const svToBackUp = new Set<string>([...svTargets, ...existingSvFiles])

  if (svToBackUp.size > 0) {
    await mkdir(backupDir, { recursive: true })
    for (const rel of svToBackUp) {
      const src = joinSync(svPath, rel)
      if (!(await exists(src))) continue
      const dst = joinSync(backupDir, rel)
      await mkdir(dirname(dst), { recursive: true })
      await rename(src, dst)
      backedUp.push(`SavedVariables/${rel}`)
    }
  }

  // Write the restored files.
  for (const { rel, data } of svFiles) {
    const target = joinSync(svPath, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
  }

  let restoredUserSettings = false
  if (userSettingsData) {
    const targetPath = userSettingsPath(addonPath)
    if (options.overwriteDisplaySettings) {
      // full replace: write the backup bytes as-is (encoding preserved)
      await writeFile(targetPath, userSettingsData)
    } else {
      // merge: backup lines for everything except display settings
      const backupText = strFromU8(userSettingsData)
      let currentText: string | null = null
      try {
        currentText = await readTextFile(targetPath)
      } catch {
        // no current file, or unreadable: backup text is used as-is
      }
      const merged = mergeUserSettings(backupText, currentText ?? null)
      await writeTextFile(targetPath, merged)
    }
    restoredUserSettings = true
  }

  await saveInstalled(addonsToSave)

  return {
    restoredSavedVariables: svFiles.length,
    restoredUserSettings,
    addonCount: addonsToSave.length,
    backupDir: backedUp.length > 0 ? backupDir : null,
    backedUp,
    skippedUnsafe,
  }
}

/** Human-readable default file name for a new backup. */
export function defaultBackupFileName(): string {
  const date = new Date().toISOString().slice(0, 10)
  return `eso-addon-backup-${date}.zip`
}
