import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileListEntry, InstalledAddon } from '@/lib/types'

const existsMock = vi.fn()
const readDirMock = vi.fn()
const removeMock = vi.fn()
const downloadAndExtractZipMock = vi.fn()
const extractDependenciesMock = vi.fn()
const upsertInstalledMock = vi.fn()
const removeInstalledRecordMock = vi.fn()
const sepMock = vi.fn(() => '/')

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: existsMock,
  readDir: readDirMock,
  remove: removeMock,
}))

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(),
  join: vi.fn(),
  sep: sepMock,
}))

vi.mock('@/lib/zip', () => ({
  downloadAndExtractZip: downloadAndExtractZipMock,
  extractDependencies: extractDependenciesMock,
}))

vi.mock('@/lib/installed', () => ({
  upsertInstalled: upsertInstalledMock,
  removeInstalledRecord: removeInstalledRecordMock,
}))

function fileEntry(overrides: Partial<FileListEntry> = {}): FileListEntry {
  return {
    UID: 1,
    UIVersion: '1.0.0',
    UIDate: 1,
    UIName: 'Addon One',
    UIAuthorName: 'Author',
    UIDownloadTotal: 0,
    UIIMG_Thumbs: ['thumb.jpg'],
    ...overrides,
  }
}

function installed(overrides: Partial<InstalledAddon> = {}): InstalledAddon {
  return {
    uid: 1,
    name: 'Addon One',
    author: 'Author',
    version: '1.0.0',
    date: 1,
    downloads: 0,
    directory: 'AddonOne',
    thumbnail: 'thumb.jpg',
    ...overrides,
  }
}

describe('addon manager', () => {
  beforeEach(() => {
    vi.resetModules()
    existsMock.mockReset()
    readDirMock.mockReset()
    removeMock.mockReset()
    downloadAndExtractZipMock.mockReset()
    extractDependenciesMock.mockReset()
    upsertInstalledMock.mockReset()
    removeInstalledRecordMock.mockReset()
    sepMock.mockReset()
    sepMock.mockReturnValue('/')
  })

  it('installs an addon and records dependencies that need installation', async () => {
    const { installAddon } = await import('@/lib/addonManager')
    const primary = fileEntry({ UID: 1, UIName: 'Addon One' })
    const dependency = fileEntry({ UID: 2, UIName: 'LibFoo', UIVersion: '2.0.0' })
    downloadAndExtractZipMock.mockResolvedValueOnce('AddonOne').mockResolvedValueOnce('LibFoo')
    extractDependenciesMock.mockResolvedValue(['LibFoo'])
    existsMock.mockResolvedValue(false)
    const resolveDependency = vi.fn().mockResolvedValue(dependency)

    await expect(
      installAddon(primary, {
        addonPath: '/addons',
        installDeps: true,
        filelist: [primary, dependency],
        resolveDependency,
      })
    ).resolves.toEqual([
      installed({ uid: 1, name: 'Addon One', directory: 'AddonOne' }),
      installed({ uid: 2, name: 'LibFoo', version: '2.0.0', directory: 'LibFoo' }),
    ])

    expect(downloadAndExtractZipMock).toHaveBeenCalledWith(1, '/addons')
    expect(downloadAndExtractZipMock).toHaveBeenCalledWith(2, '/addons')
    expect(resolveDependency).toHaveBeenCalledWith('LibFoo')
    expect(upsertInstalledMock).toHaveBeenCalledTimes(2)
  })

  it('skips dependency work when disabled or already present on disk', async () => {
    const { installAddon } = await import('@/lib/addonManager')
    const primary = fileEntry()
    downloadAndExtractZipMock.mockResolvedValue('AddonOne')
    extractDependenciesMock.mockResolvedValue(['LibFoo'])

    await installAddon(primary, {
      addonPath: '/addons',
      installDeps: false,
      filelist: [primary],
      resolveDependency: vi.fn(),
    })
    expect(extractDependenciesMock).not.toHaveBeenCalled()

    existsMock.mockResolvedValueOnce(true)
    await installAddon(primary, {
      addonPath: '/addons',
      installDeps: true,
      filelist: [primary],
      resolveDependency: vi.fn(),
    })
    expect(downloadAndExtractZipMock).toHaveBeenCalledTimes(2)
  })

  it('removes an addon folder when present and always removes its DB record', async () => {
    const { removeAddon } = await import('@/lib/addonManager')
    existsMock.mockResolvedValueOnce(true)

    await removeAddon(installed(), '/addons')

    expect(removeMock).toHaveBeenCalledWith('/addons/AddonOne', { recursive: true })
    expect(removeInstalledRecordMock).toHaveBeenCalledWith(1)
  })

  it('detects, updates, and bulk-updates newer addons', async () => {
    const { checkUpdates, updateAddon, updateAll } = await import('@/lib/addonManager')
    const oldAddon = installed({ uid: 1, date: 1 })
    const currentAddon = installed({ uid: 2, date: 10 })
    const filelist = [fileEntry({ UID: 1, UIDate: 2, UIVersion: '2.0.0' }), fileEntry({ UID: 2, UIDate: 10 })]
    downloadAndExtractZipMock.mockResolvedValue('AddonOne')

    expect(checkUpdates([oldAddon, currentAddon], filelist)).toEqual({ 1: true })
    await expect(updateAddon(oldAddon, '/addons', filelist)).resolves.toEqual(
      installed({ uid: 1, version: '2.0.0', date: 2, directory: 'AddonOne' })
    )
    await expect(updateAddon(installed({ uid: 99 }), '/addons', filelist)).resolves.toBeNull()
    await expect(updateAll([oldAddon, currentAddon], '/addons', filelist)).resolves.toEqual([
      installed({ uid: 1, version: '2.0.0', date: 2, directory: 'AddonOne' }),
    ])
  })

  describe('reinstallAddons (folder wipe for settings import)', () => {
    it('wipes the addon folder, re-installs every record, and reports progress', async () => {
      const { reinstallAddons } = await import('@/lib/addonManager')
      const records = [installed({ uid: 1, name: 'Addon One' }), installed({ uid: 2, name: 'Addon Two' })]
      const filelist = [
        fileEntry({ UID: 1, UIName: 'Addon One' }),
        fileEntry({ UID: 2, UIName: 'Addon Two', UIVersion: '2.0.0' }),
      ]
      existsMock.mockResolvedValue(true)
      readDirMock.mockResolvedValue([
        { name: 'AddonOne', isDirectory: true },
        { name: 'OldUntracked', isDirectory: true },
        { name: 'stray.txt', isDirectory: false },
      ])
      downloadAndExtractZipMock.mockResolvedValueOnce('AddonOne').mockResolvedValueOnce('AddonTwo')
      const onProgress = vi.fn()

      const result = await reinstallAddons(records, '/addons', filelist, onProgress)

      // folder was wiped first (everything currently there, untracked included)
      expect(removeMock).toHaveBeenCalledWith('/addons/AddonOne', { recursive: true })
      expect(removeMock).toHaveBeenCalledWith('/addons/OldUntracked', { recursive: true })
      expect(removeMock).toHaveBeenCalledWith('/addons/stray.txt', { recursive: true })

      // both reinstalled with fresh metadata from the filelist
      expect(result.installed).toEqual([
        installed({ uid: 1, name: 'Addon One', directory: 'AddonOne' }),
        installed({ uid: 2, name: 'Addon Two', version: '2.0.0', directory: 'AddonTwo' }),
      ])
      expect(result.failures).toEqual([])

      // progress fired once per record, in order, with running counts
      expect(onProgress).toHaveBeenCalledTimes(2)
      expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2, records[0])
      expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2, records[1])
    })

    it('reports records missing from the filelist or failing to download as failures and keeps going', async () => {
      const { reinstallAddons } = await import('@/lib/addonManager')
      const records = [
        installed({ uid: 1, name: 'Good One' }),
        installed({ uid: 99, name: 'Gone From Site' }),
        installed({ uid: 2, name: 'Broken Download' }),
      ]
      const filelist = [fileEntry({ UID: 1 }), fileEntry({ UID: 2 })]
      existsMock.mockResolvedValue(true)
      readDirMock.mockResolvedValue([])
      downloadAndExtractZipMock.mockResolvedValueOnce('GoodOne').mockRejectedValueOnce(new Error('HTTP 500'))

      const result = await reinstallAddons(records, '/addons', filelist)

      // record metadata is refreshed from the filelist (authoritative), not the backup
      expect(result.installed).toEqual([installed({ uid: 1, name: 'Addon One', directory: 'GoodOne' })])
      expect(result.failures).toEqual([
        { addon: records[1], error: 'no matching addon in the current filelist' },
        { addon: records[2], error: 'HTTP 500' },
      ])
    })

    it('still installs when the addon folder does not exist yet', async () => {
      const { reinstallAddons } = await import('@/lib/addonManager')
      const records = [installed({ uid: 1 })]
      existsMock.mockResolvedValue(false)
      downloadAndExtractZipMock.mockResolvedValue('AddonOne')

      const result = await reinstallAddons(records, '/addons', [fileEntry()])

      expect(removeMock).not.toHaveBeenCalled()
      expect(result.installed).toHaveLength(1)
    })
  })
})
