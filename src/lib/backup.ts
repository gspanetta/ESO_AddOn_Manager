import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { exists, mkdir, readDir, readFile, rename, writeFile } from '@tauri-apps/plugin-fs'
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
 * Restore a backup zip:
 *  1. Parse and validate the manifest (format version).
 *  2. Back up any existing SavedVariables / installed.json that would be
 *     overwritten into `SavedVariables.bak-<timestamp>/` (rename, i.e. move).
 *  3. Write SavedVariables files and UserSettings.txt to the live folder
 *     (rejecting absolute / `..` zip entries, same hardening as addon zips).
 *  4. Replace the installed DB with the backup's `installed.json` snapshot.
 */
export async function importSettings(bytes: Uint8Array, addonPath: string): Promise<BackupImportResult> {
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

  // Collect validated SavedVariables entries first so nothing is moved
  // or written if the zip turns out to be unusable.
  const svFiles: { rel: string; data: Uint8Array }[] = []
  let skippedUnsafe = 0
  for (const [entryPath, data] of Object.entries(entries)) {
    if (!entryPath.startsWith(SAVED_VARIABLES_PREFIX)) continue
    const rel = safeRelative(entryPath.slice(SAVED_VARIABLES_PREFIX.length))
    if (rel === null || rel === '') {
      skippedUnsafe++
      continue
    }
    svFiles.push({ rel, data })
  }
  const userSettingsData = entries[USER_SETTINGS_ENTRY] ?? null
  const installedData = entries[INSTALLED_ENTRY] ?? null

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
    await writeFile(userSettingsPath(addonPath), userSettingsData)
    restoredUserSettings = true
  }

  let addonCount = 0
  if (installedData) {
    try {
      const parsed = JSON.parse(strFromU8(installedData))
      if (Array.isArray(parsed)) {
        await saveInstalled(parsed as InstalledAddon[])
        addonCount = parsed.length
      }
    } catch {
      // corrupt installed.json inside the backup: keep the current DB
    }
  }

  return {
    restoredSavedVariables: svFiles.length,
    restoredUserSettings,
    addonCount,
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
