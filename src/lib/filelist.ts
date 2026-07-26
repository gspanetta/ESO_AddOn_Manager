import { filesystem } from '@neutralinojs/lib'
import { filelistCachePath } from './paths'
import type { FileListEntry } from './types'

/** Load the cached filelist from the app data dir, or null if not cached. */
export async function loadFilelist(): Promise<FileListEntry[] | null> {
  try {
    const text = await filesystem.readFile(await filelistCachePath())
    return JSON.parse(text) as FileListEntry[]
  } catch {
    return null
  }
}

/**
 * Case-insensitive substring search over the filelist by UIName.
 *
 * TODO (ported from the original tool): ignore spaces and apostrophes so that
 * e.g. "Elm's Markers" is found by "elmsmarkers" and "ExecuteNow" by
 * "execute now". For now this is a plain substring match.
 */
export function searchAddons(filelist: FileListEntry[], text: string): FileListEntry[] {
  const q = text.trim().toLowerCase()
  if (!q) return []
  return filelist.filter((entry) => entry.UIName.toLowerCase().includes(q))
}

/** Find a single filelist entry by UID, or undefined. */
export function getEntryByUid(filelist: FileListEntry[], uid: number): FileListEntry | undefined {
  return filelist.find((entry) => entry.UID === uid)
}

/** Return the first thumbnail URL for an entry, or null if it has none. */
export function getThumbUrl(entry: FileListEntry): string | null {
  const thumb = entry.UIIMG_Thumbs?.[0]
  return typeof thumb === 'string' && thumb ? thumb : null
}