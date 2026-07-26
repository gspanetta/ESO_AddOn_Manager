import { filesystem, net, os } from '@neutralinojs/lib'
import { dirname, filelistCachePath, joinPath } from './paths'
import type { FileListEntry } from './types'

const FILELIST_URL = 'https://api.mmoui.com/v3/game/ESO/filelist.json'
const DOWNLOAD_URL = 'https://www.esoui.com/downloads/getfile.php?id='

/**
 * Download the upstream filelist and cache it as JSON in the app data dir.
 * Uses Neutralino's native `net.request` (runs server-side, so CORS-free and
 * fine for the large text response). Throws on non-2xx responses.
 */
export async function downloadFilelist(): Promise<FileListEntry[]> {
  const res = await net.request(FILELIST_URL)
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to download filelist: HTTP ${res.status}`)
  }
  const text = res.body
  let data: FileListEntry[]
  try {
    data = JSON.parse(text) as FileListEntry[]
  } catch (e) {
    throw new Error(`Filelist is not valid JSON: ${(e as Error).message}`)
  }

  const cachePath = await filelistCachePath()
  await filesystem.createDirectory(dirname(cachePath))
  await filesystem.writeFile(cachePath, text)
  return data
}

/**
 * Fetch a zip archive for the given addon id and return its bytes.
 *
 * Neutralino's `net.request` is not binary-safe (its body is a UTF-8 string over
 * the WebSocket bridge), so binary downloads go through `curl` into a temp file
 * and are read back with `filesystem.readBinaryFile` (base64-decoded). `curl`
 * ships with Windows 10 1803+, macOS, and all Linux distros. The URL has no shell
 * metacharacters and the temp path is double-quoted, so `sh`/`cmd` quoting is safe.
 *
 * Instead of checking the HTTP content-type (hard to read portably from curl),
 * the result is validated by the zip magic bytes (`PK`), mirroring the intent of
 * the original Python tool's content-type check.
 */
export async function fetchZip(id: number): Promise<Uint8Array> {
  const url = `${DOWNLOAD_URL}${id}`
  const tmpDir = await os.getPath('temp')
  const dest = await joinPath(tmpDir, `eso-addon-${id}.zip`)

  // -s silent, -L follow redirects, -f fail on HTTP >=400, -o output file.
  // A browser-like User-Agent avoids anti-bot 403s from the upstream site.
  const result = await os.execCommand(
    `curl -sLf -A "Mozilla/5.0" -o "${dest}" "${url}"`,
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to download addon (id=${id}): curl exited ${result.exitCode}` +
        (result.stdErr ? ` — ${result.stdErr.trim()}` : ''),
    )
  }

  let buffer: ArrayBuffer
  try {
    buffer = await filesystem.readBinaryFile(dest)
  } finally {
    // best-effort cleanup of the temp file
    await filesystem.remove(dest).catch(() => {})
  }

  const bytes = new Uint8Array(buffer)
  // zip magic: PK\x03\x04 (normal) or PK\x05\x06 (empty archive)
  const isZip =
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05)
  if (!isZip) {
    throw new Error(`The downloaded file for addon id=${id} is not a zip.`)
  }
  return bytes
}