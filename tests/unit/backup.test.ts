import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { InstalledAddon } from '@/lib/types'

const existsMock = vi.fn()
const mkdirMock = vi.fn()
const readDirMock = vi.fn()
const readFileMock = vi.fn()
const readTextFileMock = vi.fn()
const renameMock = vi.fn()
const writeFileMock = vi.fn()
const writeTextFileMock = vi.fn()
const loadInstalledMock = vi.fn()
const saveInstalledMock = vi.fn()
const sepMock = vi.fn(() => '/')

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: existsMock,
  mkdir: mkdirMock,
  readDir: readDirMock,
  readFile: readFileMock,
  readTextFile: readTextFileMock,
  rename: renameMock,
  writeFile: writeFileMock,
  writeTextFile: writeTextFileMock,
}))

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(),
  join: vi.fn(),
  sep: sepMock,
}))

vi.mock('@/lib/installed', () => ({
  loadInstalled: loadInstalledMock,
  saveInstalled: saveInstalledMock,
}))

function installed(overrides: Partial<InstalledAddon> = {}): InstalledAddon {
  return {
    uid: 1,
    name: 'Addon One',
    author: 'Author',
    version: '1.0.0',
    date: 1,
    downloads: 0,
    directory: 'AddonOne',
    thumbnail: null,
    ...overrides,
  }
}

/** Build a backup zip the way exportSettings does, for import tests. */
function makeBackupZip(
  overrides: {
    manifest?: object
    svFiles?: Record<string, Uint8Array>
    userSettings?: Uint8Array | null
    installedJson?: string | null
  } = {}
): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(
      JSON.stringify(overrides.manifest ?? { formatVersion: 1, appVersion: '1.0.0', exportedAt: 0, addons: [] })
    ),
  }
  if (overrides.installedJson !== null) {
    entries['installed.json'] = strToU8(overrides.installedJson ?? JSON.stringify([installed()]))
  }
  if (overrides.userSettings !== null) {
    entries['UserSettings.txt'] = overrides.userSettings ?? strToU8('user settings')
  }
  for (const [k, v] of Object.entries(overrides.svFiles ?? {})) {
    entries[`SavedVariables/${k}`] = v
  }
  return zipSync(entries)
}

describe('settings backup', () => {
  beforeEach(() => {
    vi.resetModules()
    existsMock.mockReset()
    mkdirMock.mockReset()
    readDirMock.mockReset()
    readFileMock.mockReset()
    readTextFileMock.mockReset()
    renameMock.mockReset()
    writeFileMock.mockReset()
    writeTextFileMock.mockReset()
    loadInstalledMock.mockReset()
    saveInstalledMock.mockReset()
    sepMock.mockReset()
    sepMock.mockReturnValue('/')
  })

  describe('export', () => {
    it('zips the manifest, installed DB, SavedVariables and UserSettings.txt', async () => {
      const { exportSettings } = await import('@/lib/backup')
      loadInstalledMock.mockResolvedValue([installed()])
      existsMock.mockResolvedValue(true)
      // SavedVariables contains a flat file and a nested folder with one file
      readDirMock.mockImplementation(async (p: string) => {
        if (p === '/eso/live/SavedVariables') {
          return [
            { name: 'AddonOne.lua', isDirectory: false, isFile: true },
            { name: 'Sub', isDirectory: true, isFile: false },
          ]
        }
        if (p === '/eso/live/SavedVariables/Sub') {
          return [{ name: 'Deep.lua', isDirectory: false, isFile: true }]
        }
        return []
      })
      readFileMock.mockImplementation(async (p: string) => strToU8(`bytes:${p}`))

      const { bytes, result } = await exportSettings('/eso/live/AddOns')

      expect(result.savedVariableFiles).toBe(2)
      expect(result.includesUserSettings).toBe(true)
      expect(result.addonCount).toBe(1)

      const entries = unzipSync(bytes)
      expect(Object.keys(entries).sort()).toEqual([
        'SavedVariables/AddonOne.lua',
        'SavedVariables/Sub/Deep.lua',
        'UserSettings.txt',
        'installed.json',
        'manifest.json',
      ])
      const manifest = JSON.parse(strFromU8(entries['manifest.json']))
      expect(manifest.formatVersion).toBe(1)
      expect(manifest.addons).toHaveLength(1)
      expect(strFromU8(entries['SavedVariables/AddonOne.lua'])).toBe('bytes:/eso/live/SavedVariables/AddonOne.lua')
      // UserSettings.txt lives next to AddOns (i.e. in live/)
      expect(readFileMock).toHaveBeenCalledWith('/eso/live/UserSettings.txt')
    })

    it('omits UserSettings.txt and SavedVariables when they do not exist', async () => {
      const { exportSettings } = await import('@/lib/backup')
      loadInstalledMock.mockResolvedValue([])
      existsMock.mockResolvedValue(false)

      const { bytes, result } = await exportSettings('/eso/live/AddOns')

      expect(result.savedVariableFiles).toBe(0)
      expect(result.includesUserSettings).toBe(false)
      const names = Object.keys(unzipSync(bytes)).sort()
      expect(names).toEqual(['installed.json', 'manifest.json'])
    })
  })

  describe('readBackup (parse + validate, no filesystem side effects)', () => {
    it('parses the manifest, addons, SavedVariables and UserSettings', async () => {
      const { readBackup } = await import('@/lib/backup')
      const bytes = makeBackupZip({
        svFiles: { 'AddonOne.lua': strToU8('sv') },
        installedJson: JSON.stringify([installed(), installed({ uid: 2, name: 'Two' })]),
      })

      const parsed = readBackup(bytes)

      expect(parsed.manifest.formatVersion).toBe(1)
      expect(parsed.addons).toHaveLength(2)
      expect(parsed.savedVariables).toHaveLength(1)
      expect(parsed.savedVariables[0].rel).toBe('AddonOne.lua')
      expect(parsed.userSettings).not.toBeNull()
      expect(parsed.skippedUnsafe).toBe(0)
      // no filesystem was touched
      expect(existsMock).not.toHaveBeenCalled()
      expect(writeFileMock).not.toHaveBeenCalled()
    })

    it('rejects zips without a manifest or with a newer format version', async () => {
      const { readBackup } = await import('@/lib/backup')

      const noManifest = zipSync({ 'foo.txt': strToU8('nope') })
      expect(() => readBackup(noManifest)).toThrow('manifest')

      const tooNew = makeBackupZip({ manifest: { formatVersion: 999, appVersion: 'x', exportedAt: 0, addons: [] } })
      expect(() => readBackup(tooNew)).toThrow('format version')
    })

    it('skips unsafe SavedVariables entries (path traversal)', async () => {
      const { readBackup } = await import('@/lib/backup')
      const bytes = makeBackupZip({
        svFiles: { '../evil.lua': strToU8('bad'), 'good.lua': strToU8('good') },
      })

      const parsed = readBackup(bytes)

      expect(parsed.savedVariables).toHaveLength(1)
      expect(parsed.savedVariables[0].rel).toBe('good.lua')
      expect(parsed.skippedUnsafe).toBe(1)
    })
  })

  describe('restoreSettings (write to disk)', () => {
    it('backs up existing SavedVariables, writes restored files and saves the addon list', async () => {
      const { readBackup, restoreSettings } = await import('@/lib/backup')

      // SavedVariables exists with two files (one overlaps the backup, one is stale)
      existsMock.mockImplementation(async (p: string) => {
        return (
          p === '/eso/live/SavedVariables' ||
          p === '/eso/live/SavedVariables/AddonOne.lua' ||
          p === '/eso/live/SavedVariables/Old.lua'
        )
      })
      readDirMock.mockImplementation(async (p: string) => {
        if (p === '/eso/live/SavedVariables') {
          return [
            { name: 'AddonOne.lua', isDirectory: false, isFile: true },
            { name: 'Old.lua', isDirectory: false, isFile: true },
          ]
        }
        return []
      })

      const parsed = readBackup(
        makeBackupZip({
          svFiles: { 'AddonOne.lua': strToU8('new sv'), 'New.lua': strToU8('brand new') },
        })
      )
      const result = await restoreSettings(parsed, '/eso/live/AddOns')

      expect(result.restoredSavedVariables).toBe(2)
      expect(result.restoredUserSettings).toBe(true)
      expect(result.addonCount).toBe(1)
      expect(result.backupDir).toMatch(/^\/eso\/live\/SavedVariables\.bak-/)

      // files written to live SavedVariables
      const written = writeFileMock.mock.calls.map(([p]) => p as string).sort()
      expect(written).toEqual(['/eso/live/SavedVariables/AddonOne.lua', '/eso/live/SavedVariables/New.lua'])
      // UserSettings.txt goes through the merge path (writeTextFile)
      expect(writeTextFileMock).toHaveBeenCalledWith('/eso/live/UserSettings.txt', expect.any(String))
      // both pre-existing files were backed up (AddonOne.lua because it would be
      // overwritten, Old.lua because it is not part of the import)
      const renamed = renameMock.mock.calls.map(([src]) => src as string).sort()
      expect(renamed).toEqual(['/eso/live/SavedVariables/AddonOne.lua', '/eso/live/SavedVariables/Old.lua'])

      expect(saveInstalledMock).toHaveBeenCalledWith(parsed.addons)
    })

    it('persists the caller-provided addon list instead of the backup snapshot when given', async () => {
      const { readBackup, restoreSettings } = await import('@/lib/backup')
      existsMock.mockResolvedValue(false)
      const parsed = readBackup(
        makeBackupZip({ installedJson: JSON.stringify([installed(), installed({ uid: 2, name: 'Two' })]) })
      )

      // simulate: one of the two addons failed to reinstall, so only one is on disk
      const actuallyInstalled = [installed()]
      const result = await restoreSettings(parsed, '/eso/live/AddOns', { addons: actuallyInstalled })

      expect(saveInstalledMock).toHaveBeenCalledWith(actuallyInstalled)
      expect(result.addonCount).toBe(1)
    })

    it('handles backups without UserSettings.txt or SavedVariables', async () => {
      const { readBackup, restoreSettings } = await import('@/lib/backup')
      existsMock.mockResolvedValue(false)
      const parsed = readBackup(
        makeBackupZip({ svFiles: {}, userSettings: null, installedJson: JSON.stringify([installed()]) })
      )

      const result = await restoreSettings(parsed, '/eso/live/AddOns')

      expect(result.restoredSavedVariables).toBe(0)
      expect(result.restoredUserSettings).toBe(false)
      expect(result.backupDir).toBeNull()
      expect(saveInstalledMock).toHaveBeenCalledWith([installed()])
    })

    describe('UserSettings.txt display-settings merge', () => {
      const BACKUP_USER_SETTINGS = [
        'SET PreferMaximizedWindow "0"',
        'SET PreferExclusiveFullscreen "0"',
        'SET FULLSCREEN "1"',
        'SET ACTIVE_DISPLAY "0"',
        'SET FullscreenHeight "1080"',
        'SET FullscreenWidth "1920"',
        'SET WindowedHeight "1000"',
        'SET WindowedWidth "1920"',
        'SET MinFrameTime.2 "0.01000000"',
        'SET CAMERA_FOV "60"',
      ].join('\n')

      const CURRENT_USER_SETTINGS = [
        'SET PreferMaximizedWindow "1"',
        'SET PreferExclusiveFullscreen "1"',
        'SET FULLSCREEN "0"',
        'SET ACTIVE_DISPLAY "1"',
        'SET FullscreenHeight "2160"',
        'SET FullscreenWidth "3840"',
        'SET WindowedHeight "1440"',
        'SET WindowedWidth "2560"',
        'SET MinFrameTime.2 "0.00500000"',
        'SET CAMERA_FOV "70"',
      ].join('\n')

      it('keeps display settings from the current file and takes the rest from the backup when overwrite is off', async () => {
        const { readBackup, restoreSettings } = await import('@/lib/backup')
        existsMock.mockResolvedValue(false)
        readTextFileMock.mockResolvedValue(CURRENT_USER_SETTINGS)

        const parsed = readBackup(
          makeBackupZip({ userSettings: strToU8(BACKUP_USER_SETTINGS), svFiles: {}, installedJson: '[]' })
        )
        await restoreSettings(parsed, '/eso/live/AddOns', { overwriteDisplaySettings: false })

        expect(writeTextFileMock).toHaveBeenCalledTimes(1)
        const written = writeTextFileMock.mock.calls[0][1] as string
        const lines = written.split('\n')

        // display settings come from the current file
        expect(lines).toContain('SET FULLSCREEN "0"')
        expect(lines).toContain('SET FullscreenHeight "2160"')
        expect(lines).toContain('SET FullscreenWidth "3840"')
        expect(lines).toContain('SET WindowedHeight "1440"')
        expect(lines).toContain('SET WindowedWidth "2560"')
        expect(lines).toContain('SET PreferMaximizedWindow "1"')
        expect(lines).toContain('SET PreferExclusiveFullscreen "1"')
        expect(lines).toContain('SET ACTIVE_DISPLAY "1"')

        // non-display settings come from the backup
        expect(lines).toContain('SET MinFrameTime.2 "0.01000000"')
        expect(lines).toContain('SET CAMERA_FOV "60"')

        // backup's display values must not leak in
        expect(lines).not.toContain('SET FULLSCREEN "1"')
        expect(lines).not.toContain('SET FullscreenHeight "1080"')
      })

      it('fully replaces with the backup bytes when overwrite is on', async () => {
        const { readBackup, restoreSettings } = await import('@/lib/backup')
        existsMock.mockResolvedValue(false)
        readTextFileMock.mockResolvedValue(CURRENT_USER_SETTINGS)

        const backupBytes = strToU8(BACKUP_USER_SETTINGS)
        const parsed = readBackup(makeBackupZip({ userSettings: backupBytes, svFiles: {}, installedJson: '[]' }))
        await restoreSettings(parsed, '/eso/live/AddOns', { overwriteDisplaySettings: true })

        expect(writeFileMock).toHaveBeenCalledWith('/eso/live/UserSettings.txt', backupBytes)
        // no merge read attempted
        expect(readTextFileMock).not.toHaveBeenCalled()
      })

      it('uses the backup file as-is when there is no current UserSettings.txt', async () => {
        const { readBackup, restoreSettings } = await import('@/lib/backup')
        existsMock.mockResolvedValue(false)
        readTextFileMock.mockRejectedValue(new Error('missing'))

        const parsed = readBackup(
          makeBackupZip({ userSettings: strToU8(BACKUP_USER_SETTINGS), svFiles: {}, installedJson: '[]' })
        )
        await restoreSettings(parsed, '/eso/live/AddOns', { overwriteDisplaySettings: false })

        const written = writeTextFileMock.mock.calls[0][1] as string
        expect(written).toBe(BACKUP_USER_SETTINGS)
      })
    })
  })
})
