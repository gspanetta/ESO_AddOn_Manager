import { exists, readDir, remove } from '@tauri-apps/plugin-fs'
import { downloadAndExtractZip, extractDependencies } from './zip'
import { upsertInstalled, removeInstalledRecord } from './installed'
import { getEntryByUid } from './filelist'
import { joinSync } from './paths'
import { toInstalledAddon, type FileListEntry, type InstalledAddon } from './types'

export interface InstallContext {
  addonPath: string
  installDeps: boolean
  filelist: FileListEntry[]
  /**
   * Resolve a dependency name to a single filelist entry to install.
   * Return null to skip the dependency (e.g. no match, or user cancelled).
   * The UI implements this to auto-pick on a single match or prompt the user
   * when multiple candidates exist.
   */
  resolveDependency: (dep: string) => Promise<FileListEntry | null>
}

/**
 * Install an addon: download + extract, record it, then (if enabled) process
 * its `## DependsOn:` libraries. Dependencies that already exist on disk
 * (either bundled inside the addon folder or directly under the addon path)
 * are skipped — this implements the TODO from the original Python tool.
 *
 * Returns the list of installed addon records (the primary addon plus any
 * dependencies that were installed).
 */
export async function installAddon(entry: FileListEntry, ctx: InstallContext): Promise<InstalledAddon[]> {
  const installed: InstalledAddon[] = []

  const directory = await downloadAndExtractZip(entry.UID, ctx.addonPath)
  const record = toInstalledAddon(entry, directory)
  await upsertInstalled(record)
  installed.push(record)

  if (ctx.installDeps) {
    const deps = await extractDependencies(ctx.addonPath, directory)
    for (const dep of deps) {
      // 1. bundled inside the addon folder?
      if (await exists(joinSync(ctx.addonPath, directory, dep))) continue
      // 2. already installed directly under the addon path?
      if (await exists(joinSync(ctx.addonPath, dep))) continue

      const chosen = await ctx.resolveDependency(dep)
      if (!chosen) continue

      const depDir = await downloadAndExtractZip(chosen.UID, ctx.addonPath)
      const depRecord = toInstalledAddon(chosen, depDir)
      await upsertInstalled(depRecord)
      installed.push(depRecord)
    }
  }

  return installed
}

/**
 * Remove an installed addon: delete its folder from disk (tolerating a missing
 * folder) and remove its record from the database.
 */
export async function removeAddon(addon: InstalledAddon, addonPath: string): Promise<void> {
  const dir = joinSync(addonPath, addon.directory)
  if (await exists(dir)) {
    await remove(dir, { recursive: true })
  }
  await removeInstalledRecord(addon.uid)
}

/**
 * Compare installed addons against the filelist and report which ones have a
 * newer version available (upstream UIDate greater than the installed date).
 */
export function checkUpdates(installed: InstalledAddon[], filelist: FileListEntry[]): Record<number, boolean> {
  const result: Record<number, boolean> = {}
  for (const addon of installed) {
    const entry = getEntryByUid(filelist, addon.uid)
    if (entry && Number(entry.UIDate) > Number(addon.date)) {
      result[addon.uid] = true
    }
  }
  return result
}

/**
 * Update a single addon to the latest version from the filelist: re-download +
 * extract (which replaces the old folder) and refresh the stored record.
 */
export async function updateAddon(
  addon: InstalledAddon,
  addonPath: string,
  filelist: FileListEntry[]
): Promise<InstalledAddon | null> {
  const entry = getEntryByUid(filelist, addon.uid)
  if (!entry) return null
  const directory = await downloadAndExtractZip(entry.UID, addonPath)
  const updated = toInstalledAddon(entry, directory)
  await upsertInstalled(updated)
  return updated
}

/**
 * Update every addon that has a newer version available.
 * Returns the updated records.
 */
export async function updateAll(
  installed: InstalledAddon[],
  addonPath: string,
  filelist: FileListEntry[]
): Promise<InstalledAddon[]> {
  const updated: InstalledAddon[] = []
  for (const addon of installed) {
    const entry = getEntryByUid(filelist, addon.uid)
    if (entry && Number(entry.UIDate) > Number(addon.date)) {
      const result = await updateAddon(addon, addonPath, filelist)
      if (result) updated.push(result)
    }
  }
  return updated
}

/** Progress callback fired by `reinstallAddons` after each addon install. */
export type ReinstallProgress = (done: number, total: number, current: InstalledAddon) => void

export interface ReinstallResult {
  /** Addons successfully re-downloaded and extracted. */
  installed: InstalledAddon[]
  /** Records that could not be reinstalled (no filelist match / download failed). */
  failures: { addon: InstalledAddon; error: string }[]
}

/**
 * Wipe the addon folder completely and re-install every record from a backup
 * via download + extract. Records whose UID no longer exists in the filelist,
 * or whose download fails, are skipped and reported as failures — the rest
 * still install.
 *
 * `onProgress` is invoked after each individual addon install attempt so the
 * UI can show a progress bar. Existing dependencies are *not* re-resolved:
 * the backup's installed.json is authoritative for what should be present.
 */
export async function reinstallAddons(
  records: InstalledAddon[],
  addonPath: string,
  filelist: FileListEntry[],
  onProgress?: ReinstallProgress
): Promise<ReinstallResult> {
  // Wipe: delete everything currently in the addon folder.
  if (await exists(addonPath)) {
    const entries = await readDir(addonPath)
    for (const entry of entries) {
      await remove(joinSync(addonPath, entry.name), { recursive: true })
    }
  }

  const installed: InstalledAddon[] = []
  const failures: { addon: InstalledAddon; error: string }[] = []
  const total = records.length

  for (let i = 0; i < total; i++) {
    const record = records[i]
    try {
      const entry = getEntryByUid(filelist, record.uid)
      if (!entry) {
        failures.push({ addon: record, error: 'no matching addon in the current filelist' })
        continue
      }
      const directory = await downloadAndExtractZip(entry.UID, addonPath)
      installed.push(toInstalledAddon(entry, directory))
    } catch (e) {
      failures.push({ addon: record, error: e instanceof Error ? e.message : String(e) })
    } finally {
      onProgress?.(i + 1, total, record)
    }
  }

  return { installed, failures }
}
