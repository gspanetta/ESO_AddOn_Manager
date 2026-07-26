import { unzipSync } from 'fflate'
import { filesystem } from '@neutralinojs/lib'
import { fetchZip } from './http'
import { dirname, joinSync, pathExists, safeRelative } from './paths'

/**
 * Download and extract an addon zip into the target addon directory.
 *
 * Hardens the original Python `extractall` by rejecting zip entries that are
 * absolute or contain `..` segments (path traversal). No temp zip is written
 * to disk — bytes are decompressed in memory and written entry by entry.
 *
 * Returns the top-level directory name extracted from the archive (the first
 * entry's first path segment), matching the Python tool's behavior.
 */
export async function downloadAndExtractZip(id: number, addonPath: string): Promise<string> {
  const bytes = await fetchZip(id)
  const entries = unzipSync(bytes)

  let topLevelDir = ''
  const dirsToCreate = new Set<string>()

  // First pass: validate, collect dirs, find the top-level folder.
  const files: { target: string; data: Uint8Array }[] = []
  for (const [entryPath, data] of Object.entries(entries)) {
    const rel = safeRelative(entryPath)
    if (rel === null) {
      // skip unsafe entries rather than aborting the whole install
      continue
    }
    const target = joinSync(addonPath, rel)
    if (!topLevelDir) {
      topLevelDir = rel.split(/[/\\]/)[0]
    }
    if (entryPath.endsWith('/')) {
      // explicit directory entry
      dirsToCreate.add(target)
    } else {
      dirsToCreate.add(dirname(target))
      files.push({ target, data })
    }
  }

  if (!topLevelDir) {
    throw new Error('The downloaded zip is empty or contains no valid entries.')
  }

  // If the addon folder already exists (re-install / upgrade), remove it first
  // so stale files from a previous version don't linger.
  const addonDir = joinSync(addonPath, topLevelDir)
  if (await pathExists(addonDir)) {
    await filesystem.remove(addonDir)
  }

  for (const dir of dirsToCreate) {
    if (dir && dir !== addonPath) {
      await filesystem.createDirectory(dir)
    }
  }
  for (const { target, data } of files) {
    // writeBinaryFile expects an ArrayBuffer; copy the Uint8Array's bytes into a
    // clean ArrayBuffer to avoid offset/length issues with shared buffers.
    await filesystem.writeBinaryFile(target, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  }

  return topLevelDir
}

/**
 * Extract the `## DependsOn:` libraries from an installed addon's metadata file.
 *
 * Mirrors the Python tool: try `<dir>/<dir>.addon` first, then fall back to
 * `<dir>/<dir>.txt`. Parses the first `## DependsOn:` line, splits on spaces,
 * keeps tokens starting with `Lib`, and strips a trailing `>...` version pin.
 * Returns an empty list if no metadata file is found.
 */
export async function extractDependencies(addonPath: string, directory: string): Promise<string[]> {
  const basePath = joinSync(addonPath, directory, directory)
  let text: string | null = null
  try {
    text = await filesystem.readFile(`${basePath}.addon`)
  } catch {
    try {
      text = await filesystem.readFile(`${basePath}.txt`)
    } catch {
      // No metadata file found; nothing to depend on.
      return []
    }
  }

  const dependencies: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('## DependsOn:')) {
      const rest = line.slice('## DependsOn:'.length).trim()
      for (let token of rest.split(/\s+/)) {
        token = token.trim()
        if (!token) continue
        if (token.startsWith('Lib')) {
          // strip a trailing ">version" pin if present
          dependencies.push(token.split('>')[0])
        }
      }
      break
    }
  }
  return dependencies
}