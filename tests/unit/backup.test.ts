import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { InstalledAddon } from '@/lib/types'

const existsMock = vi.fn()
const mkdirMock = vi.fn()
const readDirMock = vi.fn()
const readFileMock = vi.fn()
const renameMock = vi.fn()
const writeFileMock = vi.fn()
const loadInstalledMock = vi.fn()
const saveInstalledMock = vi.fn()
const sepMock = vi.fn(() => '/')

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: existsMock,
  mkdir: mkdirMock,
  readDir: readDirMock,
  readFile: readFileMock,
  rename: renameMock,
  writeFile: writeFileMock,
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

describe('settings backup', () => {
  beforeEach(() => {
    vi.resetModules()
    existsMock.mockReset()
    mkdirMock.mockReset()
    readDirMock.mockReset()
    readFileMock.mockReset()
    renameMock.mockReset()
    writeFileMock.mockReset()
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

  describe('import', () => {
    function makeBackup(
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
        'installed.json': strToU8(overrides.installedJson ?? JSON.stringify([installed()])),
      }
      if (overrides.userSettings !== null) {
        entries['UserSettings.txt'] = overrides.userSettings ?? strToU8('user settings')
      }
      for (const [k, v] of Object.entries(overrides.svFiles ?? {})) {
        entries[`SavedVariables/${k}`] = v
      }
      return zipSync(entries)
    }

    it('restores SavedVariables + UserSettings and replaces the installed DB, backing up existing files', async () => {
      const { importSettings } = await import('@/lib/backup')

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

      const bytes = makeBackup({
        svFiles: { 'AddonOne.lua': strToU8('new sv'), 'New.lua': strToU8('brand new') },
        installedJson: JSON.stringify([installed()]),
      })
      const result = await importSettings(bytes, '/eso/live/AddOns')

      expect(result.restoredSavedVariables).toBe(2)
      expect(result.restoredUserSettings).toBe(true)
      expect(result.addonCount).toBe(1)
      expect(result.backupDir).toMatch(/^\/eso\/live\/SavedVariables\.bak-/)

      // files written to live SavedVariables
      const written = writeFileMock.mock.calls.map(([p]) => p as string).sort()
      expect(written).toEqual([
        '/eso/live/SavedVariables/AddonOne.lua',
        '/eso/live/SavedVariables/New.lua',
        '/eso/live/UserSettings.txt',
      ])
      // both pre-existing files were backed up (AddonOne.lua because it would be
      // overwritten, Old.lua because it is not part of the import)
      const renamed = renameMock.mock.calls.map(([src]) => src as string).sort()
      expect(renamed).toEqual(['/eso/live/SavedVariables/AddonOne.lua', '/eso/live/SavedVariables/Old.lua'])

      expect(saveInstalledMock).toHaveBeenCalledWith([installed()])
    })

    it('rejects zips without a manifest', async () => {
      const { importSettings } = await import('@/lib/backup')
      const bytes = zipSync({ 'foo.txt': strToU8('nope') })
      await expect(importSettings(bytes, '/eso/live/AddOns')).rejects.toThrow('manifest')
    })

    it('rejects backups from a newer format version', async () => {
      const { importSettings } = await import('@/lib/backup')
      const bytes = makeBackup({ manifest: { formatVersion: 999, appVersion: 'x', exportedAt: 0, addons: [] } })
      await expect(importSettings(bytes, '/eso/live/AddOns')).rejects.toThrow('format version')
    })

    it('skips unsafe SavedVariables entries (path traversal)', async () => {
      const { importSettings } = await import('@/lib/backup')
      existsMock.mockResolvedValue(false)
      const bytes = makeBackup({
        svFiles: {
          '../evil.lua': strToU8('bad'),
          'good.lua': strToU8('good'),
        },
        userSettings: null,
        installedJson: null,
      })
      const result = await importSettings(bytes, '/eso/live/AddOns')

      expect(result.restoredSavedVariables).toBe(1)
      expect(result.skippedUnsafe).toBe(1)
      const written = writeFileMock.mock.calls.map(([p]) => p as string)
      expect(written).toEqual(['/eso/live/SavedVariables/good.lua'])
    })

    it('keeps the current installed DB when the backup has none', async () => {
      const { importSettings } = await import('@/lib/backup')
      existsMock.mockResolvedValue(false)
      const bytes = makeBackup({ svFiles: {}, userSettings: null, installedJson: null })
      // remove the default installed.json entry
      const entries = unzipSync(bytes)
      delete entries['installed.json']
      const bare = zipSync(entries)

      const result = await importSettings(bare, '/eso/live/AddOns')
      expect(result.addonCount).toBe(0)
      expect(saveInstalledMock).not.toHaveBeenCalled()
    })
  })
})
