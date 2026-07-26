import { filesystem } from '@neutralinojs/lib'
import { dirname, installedDbPath } from './paths'
import type { InstalledAddon } from './types'

/** Load the installed-addon database, or an empty list if missing/corrupt. */
export async function loadInstalled(): Promise<InstalledAddon[]> {
  try {
    const text = await filesystem.readFile(await installedDbPath())
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as InstalledAddon[]) : []
  } catch {
    return []
  }
}

/** Persist the full installed-addon database. */
export async function saveInstalled(list: InstalledAddon[]): Promise<void> {
  const dbPath = await installedDbPath()
  await filesystem.createDirectory(dirname(dbPath))
  await filesystem.writeFile(dbPath, JSON.stringify(list, null, 2))
}

/**
 * Upsert an addon record by uid: replace any existing entry with the same uid,
 * otherwise append. Returns the resulting list (also persisted).
 */
export async function upsertInstalled(addon: InstalledAddon): Promise<InstalledAddon[]> {
  const list = await loadInstalled()
  const idx = list.findIndex((a) => a.uid === addon.uid)
  if (idx >= 0) {
    list[idx] = addon
  } else {
    list.push(addon)
  }
  await saveInstalled(list)
  return list
}

/** Remove an addon record by uid. Returns the resulting list (also persisted). */
export async function removeInstalledRecord(uid: number): Promise<InstalledAddon[]> {
  const list = await loadInstalled()
  const filtered = list.filter((a) => a.uid !== uid)
  await saveInstalled(filtered)
  return filtered
}

/** Find an installed addon by uid, or undefined. */
export function findInstalled(list: InstalledAddon[], uid: number): InstalledAddon | undefined {
  return list.find((a) => a.uid === uid)
}