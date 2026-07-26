import { filesystem } from '@neutralinojs/lib'
import { toInstalledAddon, type FileListEntry, type InstalledAddon } from './types'
import { loadInstalled, saveInstalled } from './installed'

export interface ReconcileResult {
  /** Addon folders newly added to the database this run. */
  imported: InstalledAddon[]
  /** Previously-tracked records whose folder is no longer present (removed from the DB). */
  removed: number
  /** Records retained (their folders are still present). */
  kept: number
  /** Addon folder names present on disk but not matchable to a filelist entry. */
  unmatched: string[]
}

/**
 * Build a lookup from directory name -> filelist entry.
 * Matches on the API's `UIDir` (the folder name(s) an addon installs to),
 * with a fallback to `UIName`.
 */
function buildDirIndex(filelist: FileListEntry[]): Map<string, FileListEntry> {
  const index = new Map<string, FileListEntry>()
  for (const entry of filelist) {
    const dirs = Array.isArray(entry.UIDir) ? entry.UIDir : entry.UIDir ? [entry.UIDir] : []
    for (const d of dirs) {
      if (d && !index.has(d)) index.set(d, entry)
    }
    if (entry.UIName && !index.has(entry.UIName)) index.set(entry.UIName, entry)
  }
  return index
}

/**
 * Reconcile the installed database with the actual contents of the addon
 * folder:
 *  - drop tracked records whose `directory` is no longer present on disk,
 *  - import any present addon folder that matches a filelist entry but isn't
 *    tracked yet.
 *
 * `filelist` may be null (e.g. the filelist could not be downloaded); in that
 * case pruning still runs but no new addons are imported.
 */
export async function reconcileInstalledWithFolder(
  addonPath: string,
  filelist: FileListEntry[] | null,
): Promise<ReconcileResult> {
  const index = filelist ? buildDirIndex(filelist) : new Map<string, FileListEntry>()

  const entries = await filesystem.readDirectory(addonPath, { recursive: false })
  const dirNames = entries.filter((e) => e.type === 'DIRECTORY').map((e) => e.entry)
  const presentDirs = new Set(dirNames)

  const existing = await loadInstalled()
  // 1. prune: keep only records whose folder still exists
  const kept = existing.filter((a) => presentDirs.has(a.directory))
  const removed = existing.length - kept.length

  // 2. import: present folders not yet tracked
  const trackedUids = new Set(kept.map((a) => a.uid))
  const trackedDirs = new Set(kept.map((a) => a.directory))
  const imported: InstalledAddon[] = []
  const unmatched: string[] = []
  for (const dir of dirNames) {
    if (trackedDirs.has(dir)) continue
    const entry = index.get(dir)
    if (!entry) {
      unmatched.push(dir)
      continue
    }
    if (trackedUids.has(entry.UID)) continue
    const record = toInstalledAddon(entry, dir)
    kept.push(record)
    imported.push(record)
    trackedUids.add(entry.UID)
    trackedDirs.add(dir)
  }

  await saveInstalled(kept)
  return { imported, removed, kept: kept.length, unmatched }
}