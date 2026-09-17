import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import SettingsBar from '@/components/SettingsBar.vue'

const { openMock } = vi.hoisted(() => ({
  openMock: vi.fn(),
}))
let store: ReturnType<typeof createStore>

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openMock,
}))

vi.mock('@/stores/addons', () => ({
  useAddonsStore: () => store,
}))

function createStore() {
  return reactive({
    addonPath: null as string | null,
    loading: false,
    installDeps: true,
    filelistLoadedAt: null as number | null,
    error: null as string | null,
    pendingImport: null as import('@/lib/backup').ParsedBackup | null,
    importProgress: null as { done: number; total: number } | null,
    clearError: vi.fn(),
    refreshFilelist: vi.fn(),
    setAddonDir: vi.fn(),
    setInstallDeps: vi.fn(),
    exportSettings: vi.fn(),
    previewImport: vi.fn(),
    confirmImport: vi.fn(),
    cancelImport: vi.fn(),
  })
}

describe('SettingsBar', () => {
  beforeEach(() => {
    store = createStore()
    openMock.mockReset()
  })

  it('opens the folder dialog and saves a typed path', async () => {
    const wrapper = mount(SettingsBar)

    await wrapper
      .findAll('button')
      .find(button => button.text().includes('Set AddOn folder'))
      ?.trigger('click')
    await wrapper.get('input[type="text"]').setValue(' /addons ')
    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Save')
      ?.trigger('click')

    expect(store.clearError).toHaveBeenCalled()
    expect(store.setAddonDir).toHaveBeenCalledWith('/addons')
    expect(wrapper.find('input[type="text"]').exists()).toBe(false)
  })

  it('keeps the folder dialog open when saving reports an error', async () => {
    store.setAddonDir.mockImplementation(() => {
      store.error = 'cannot read folder'
    })
    const wrapper = mount(SettingsBar)

    await wrapper
      .findAll('button')
      .find(button => button.text().includes('Set AddOn folder'))
      ?.trigger('click')
    await wrapper.get('input[type="text"]').setValue('/bad')
    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Save')
      ?.trigger('click')

    expect(wrapper.find('input[type="text"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('cannot read folder')
  })

  it('uses the native folder picker and refreshes the filelist', async () => {
    store.addonPath = '/addons'
    openMock.mockResolvedValue('/picked')
    const wrapper = mount(SettingsBar)

    await wrapper
      .findAll('button')
      .find(button => button.text().includes('Change AddOn folder'))
      ?.trigger('click')
    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Browse…')
      ?.trigger('click')
    expect((wrapper.get('input[type="text"]').element as HTMLInputElement).value).toBe('/picked')

    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Refresh filelist')
      ?.trigger('click')
    expect(store.refreshFilelist).toHaveBeenCalled()
  })

  it('persists the auto-install dependencies toggle', async () => {
    const wrapper = mount(SettingsBar)

    await wrapper.get('input[type="checkbox"]').setValue(false)

    expect(store.setInstallDeps).toHaveBeenCalledWith(false)
  })

  it('triggers the import preview when Import settings is clicked', async () => {
    store.addonPath = '/addons'
    const wrapper = mount(SettingsBar)

    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Import settings…')
      ?.trigger('click')

    expect(store.previewImport).toHaveBeenCalled()
  })

  it('shows a confirmation dialog listing addons from a pending import and confirms', async () => {
    store.addonPath = '/addons'
    const wrapper = mount(SettingsBar)

    // simulate that previewImport picked a backup with 2 addons
    store.pendingImport = {
      manifest: { formatVersion: 1, appVersion: '1.0.0', exportedAt: 0, addons: [] },
      addons: [
        {
          uid: 1,
          name: 'Addon One',
          author: '',
          version: '1.0',
          date: 1,
          downloads: 0,
          directory: 'AddonOne',
          thumbnail: null,
        },
        {
          uid: 2,
          name: 'Addon Two',
          author: '',
          version: '1.0',
          date: 1,
          downloads: 0,
          directory: 'AddonTwo',
          thumbnail: null,
        },
      ],
      savedVariables: [],
      userSettings: null,
      skippedUnsafe: 0,
    }
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Wipe the AddOns folder')
    expect(wrapper.text()).toContain('Addon One')
    expect(wrapper.text()).toContain('Addon Two')

    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Wipe & import')
      ?.trigger('click')
    expect(store.confirmImport).toHaveBeenCalled()
  })

  it('shows a progress bar while an import is running', async () => {
    store.addonPath = '/addons'
    store.importProgress = { done: 3, total: 10 }
    const wrapper = mount(SettingsBar)

    expect(wrapper.text()).toContain('Installing addon 3 of 10')
    expect(wrapper.text()).toContain('Importing settings')
  })

  it('cancels a pending import via Cancel', async () => {
    store.addonPath = '/addons'
    const wrapper = mount(SettingsBar)
    store.pendingImport = {
      manifest: { formatVersion: 1, appVersion: '1.0.0', exportedAt: 0, addons: [] },
      addons: [],
      savedVariables: [],
      userSettings: null,
      skippedUnsafe: 0,
    }
    await wrapper.vm.$nextTick()

    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Cancel')
      ?.trigger('click')
    expect(store.cancelImport).toHaveBeenCalled()
  })
})
