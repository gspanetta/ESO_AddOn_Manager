import { acceptHMRUpdate, defineStore } from 'pinia'
import { loadConfig, saveAddonPath, saveInstallDeps, type AppConfig } from '@/lib/config'
import { downloadFilelist } from '@/lib/http'
import { loadFilelist, searchAddons, type FileListEntry } from '@/lib/filelist'
import { loadInstalled } from '@/lib/installed'
import { reconcileInstalledWithFolder, type ReconcileResult } from '@/lib/import'
import {
  exportSettings as exportSettingsLib,
  readBackup,
  restoreSettings,
  defaultBackupFileName,
  type BackupExportResult,
  type BackupImportResult,
  type ParsedBackup,
} from '@/lib/backup'
import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import {
  checkUpdates as checkUpdatesLib,
  installAddon as installAddonLib,
  reinstallAddons as reinstallAddonsLib,
  removeAddon as removeAddonLib,
  updateAddon as updateAddonLib,
  updateAll as updateAllLib,
} from '@/lib/addonManager'
import type { InstalledAddon } from '@/lib/types'

/** A pending dependency choice that needs the user to pick a candidate. */
interface PendingDepChoice {
  dep: string
  candidates: FileListEntry[]
  resolve: (entry: FileListEntry | null) => void
}

/** Progress state for an in-flight settings import (drives a progress modal). */
interface ImportProgress {
  done: number
  total: number
}

export const useAddonsStore = defineStore('addons', {
  state: () => ({
    /** User-chosen addon target directory, or null until configured. */
    addonPath: null as string | null,
    /** Whether to automatically install `## DependsOn:` libraries. */
    installDeps: true as boolean,
    /** Installed addon records (loaded from the app-data DB). */
    installed: [] as InstalledAddon[],
    /** Cached filelist (loaded from app-data cache or freshly downloaded). */
    filelist: null as FileListEntry[] | null,
    /** Epoch ms of the last filelist refresh, or null if never. */
    filelistLoadedAt: null as number | null,
    /** Current search query. */
    searchQuery: '' as string,
    /** Results of the last search. */
    searchResults: [] as FileListEntry[],
    /** uid -> has-update flag, refreshed from the filelist. */
    updateMap: {} as Record<number, boolean>,
    /** True while a long-running operation is in flight. */
    loading: false as boolean,
    /** Last error message, or null. */
    error: null as string | null,
    /** A dependency choice awaiting user input (drives a modal in the UI). */
    pendingDepChoice: null as PendingDepChoice | null,
    /** Progress of an in-flight settings import, or null when not importing. */
    importProgress: null as ImportProgress | null,
    /** Parsed backup awaiting user confirmation, or null. */
    pendingImport: null as ParsedBackup | null,
  }),

  getters: {
    /** True when no addon directory has been configured yet. */
    needsSetup: state => state.addonPath === null,
    /** Has the filelist been loaded at least once this session? */
    hasFilelist: state => state.filelist !== null && state.filelist.length > 0,
    /** Resolve a thumbnail URL for an installed addon by uid (fallback for records without a stored thumbnail). */
    thumbForUid:
      state =>
      (uid: number): string | null => {
        if (!state.filelist) return null
        const entry = state.filelist.find(e => e.UID === uid)
        const thumb = entry?.UIIMG_Thumbs?.[0]
        return typeof thumb === 'string' && thumb ? thumb : null
      },
  },

  actions: {
    /** Load persisted config and, if a path is set, the installed DB + filelist cache. */
    async initApp() {
      try {
        const config: AppConfig = await loadConfig()
        this.addonPath = config.addonPath
        this.installDeps = config.installDeps
        if (this.addonPath) {
          this.installed = await loadInstalled()
          const cached = await loadFilelist()
          if (cached) {
            this.filelist = cached
            this.refreshUpdateMap()
          }
        }
      } catch (e) {
        this.setError(e)
      }
    },

    /**
     * Set the addon directory and reconcile the installed list with the
     * folder's actual contents:
     *  - persists the path,
     *  - ensures the filelist is loaded (downloading it if needed; pruning
     *    still runs if the download fails),
     *  - imports addon folders present on disk but not yet tracked,
     *  - removes tracked addons whose folder is no longer present.
     * Returns the reconcile summary (or null on failure).
     */
    async setAddonDir(path: string): Promise<ReconcileResult | null> {
      const trimmed = path.trim()
      if (!trimmed) return null
      this.loading = true
      this.error = null
      try {
        this.addonPath = trimmed
        await saveAddonPath(trimmed)

        // ensure filelist is loaded; if the download fails, reconcile prunes only
        if (!this.filelist) {
          try {
            this.filelist = await downloadFilelist()
            this.filelistLoadedAt = Date.now()
          } catch (e) {
            this.setError(e)
          }
        }

        const result = await reconcileInstalledWithFolder(trimmed, this.filelist)
        this.installed = await loadInstalled()
        this.refreshUpdateMap()
        return result
      } catch (e) {
        this.setError(e)
        return null
      } finally {
        this.loading = false
      }
    },

    /** Persist the auto-install-dependencies toggle. */
    async setInstallDeps(value: boolean) {
      this.installDeps = value
      try {
        await saveInstallDeps(value)
      } catch (e) {
        this.setError(e)
      }
    },

    /** Download a fresh filelist, cache it, and recompute update flags. */
    async refreshFilelist() {
      this.loading = true
      this.error = null
      try {
        this.filelist = await downloadFilelist()
        this.filelistLoadedAt = Date.now()
        this.refreshUpdateMap()
        if (this.searchQuery) this.runSearch(this.searchQuery)
      } catch (e) {
        this.setError(e)
      } finally {
        this.loading = false
      }
    },

    /** Run a search against the loaded filelist and store the results. */
    runSearch(query: string) {
      this.searchQuery = query
      this.searchResults = this.filelist ? searchAddons(this.filelist, query) : []
    },

    /** Install an addon from a filelist entry (and its dependencies, if enabled). */
    async installAddon(entry: FileListEntry) {
      if (!this.addonPath || !this.filelist) return
      this.loading = true
      this.error = null
      try {
        await installAddonLib(entry, {
          addonPath: this.addonPath,
          installDeps: this.installDeps,
          filelist: this.filelist,
          resolveDependency: dep => this.resolveDependency(dep),
        })
        this.installed = await loadInstalled()
        this.refreshUpdateMap()
      } catch (e) {
        this.setError(e)
      } finally {
        this.loading = false
      }
    },

    /** Delete an installed addon from disk and the database. */
    async removeAddon(addon: InstalledAddon) {
      if (!this.addonPath) return
      this.loading = true
      this.error = null
      try {
        await removeAddonLib(addon, this.addonPath)
        this.installed = await loadInstalled()
        this.refreshUpdateMap()
      } catch (e) {
        this.setError(e)
      } finally {
        this.loading = false
      }
    },

    /** Update a single addon to the latest version in the filelist. */
    async updateAddon(addon: InstalledAddon) {
      if (!this.addonPath || !this.filelist) return
      this.loading = true
      this.error = null
      try {
        await updateAddonLib(addon, this.addonPath, this.filelist)
        this.installed = await loadInstalled()
        this.refreshUpdateMap()
      } catch (e) {
        this.setError(e)
      } finally {
        this.loading = false
      }
    },

    /** Update every addon that has a newer version available. */
    async updateAll() {
      if (!this.addonPath || !this.filelist) return
      this.loading = true
      this.error = null
      try {
        await updateAllLib(this.installed, this.addonPath, this.filelist)
        this.installed = await loadInstalled()
        this.refreshUpdateMap()
      } catch (e) {
        this.setError(e)
      } finally {
        this.loading = false
      }
    },

    /** Recompute the update-available map from the installed list + filelist. */
    refreshUpdateMap() {
      if (!this.filelist) {
        this.updateMap = {}
        return
      }
      this.updateMap = checkUpdatesLib(this.installed, this.filelist)
    },

    /**
     * Export tracked addons + SavedVariables + UserSettings.txt into a single
     * zip chosen via a save dialog. Returns the export summary, or null if the
     * user cancelled or the export failed.
     */
    async exportSettings(): Promise<BackupExportResult | null> {
      if (!this.addonPath) return null
      this.loading = true
      this.error = null
      try {
        const target = await save({
          defaultPath: defaultBackupFileName(),
          filters: [{ name: 'ESO settings backup', extensions: ['zip'] }],
        })
        if (!target) return null
        const { bytes, result } = await exportSettingsLib(this.addonPath)
        await writeFile(target, bytes)
        return result
      } catch (e) {
        this.setError(e)
        return null
      } finally {
        this.loading = false
      }
    },

    /**
     * Step 1 of the import flow: pick a backup zip, parse and validate it
     * (no filesystem changes), and stash the parsed backup in `pendingImport`
     * so the UI can show a confirmation dialog listing the addons to install.
     * Returns the parsed backup, or null if the user cancelled or the file is
     * invalid (error is set in that case).
     */
    async previewImport(): Promise<ParsedBackup | null> {
      if (!this.addonPath) return null
      this.error = null
      try {
        const selected = await open({
          multiple: false,
          filters: [{ name: 'ESO settings backup', extensions: ['zip'] }],
        })
        if (typeof selected !== 'string' || !selected) return null
        const bytes = await readFile(selected)
        const backup = readBackup(bytes)
        this.pendingImport = backup
        return backup
      } catch (e) {
        this.setError(e)
        return null
      }
    },

    /**
     * Step 2 of the import flow: wipe the addon folder, re-install every addon
     * from the pending backup (with progress), then restore SavedVariables +
     * UserSettings.txt and persist the DB to the actually-installed list.
     * Returns the import summary plus any per-addon install failures, or null
     * if there is no pending import.
     */
    async confirmImport(): Promise<
      (BackupImportResult & { installFailures: { name: string; error: string }[] }) | null
    > {
      const backup = this.pendingImport
      if (!backup || !this.addonPath) return null
      const addonPath = this.addonPath
      this.loading = true
      this.error = null
      this.importProgress = backup.addons.length > 0 ? { done: 0, total: backup.addons.length } : null
      this.pendingImport = null
      try {
        // Ensure the filelist is available to resolve UIDs for re-download.
        if (!this.filelist) {
          this.filelist = await downloadFilelist()
          this.filelistLoadedAt = Date.now()
        }

        const { installed, failures } = await reinstallAddonsLib(
          backup.addons,
          addonPath,
          this.filelist,
          (done, total) => {
            this.importProgress = { done, total }
          }
        )

        const result = await restoreSettings(backup, addonPath, { addons: installed })
        this.installed = await loadInstalled()
        this.refreshUpdateMap()
        return {
          ...result,
          installFailures: failures.map(f => ({ name: f.addon.name, error: f.error })),
        }
      } catch (e) {
        this.setError(e)
        return null
      } finally {
        this.loading = false
        this.importProgress = null
      }
    },

    /** Abort the settings import at the confirmation step. */
    cancelImport() {
      this.pendingImport = null
    },

    /**
     * Resolve a dependency name to a filelist entry: auto-pick on a single
     * match, prompt the user when multiple candidates exist, skip on none.
     */
    async resolveDependency(dep: string): Promise<FileListEntry | null> {
      if (!this.filelist) return null
      const candidates = searchAddons(this.filelist, dep)
      if (candidates.length === 0) return null
      if (candidates.length === 1) return candidates[0]
      // multiple matches: ask the user via the pendingDepChoice modal
      return new Promise<FileListEntry | null>(resolve => {
        this.pendingDepChoice = { dep, candidates, resolve }
      })
    },

    /** Called by the UI when the user picks a dependency candidate (or cancels). */
    resolveDepChoice(entry: FileListEntry | null) {
      const pending = this.pendingDepChoice
      if (!pending) return
      this.pendingDepChoice = null
      pending.resolve(entry)
    },

    setError(e: unknown) {
      this.error = e instanceof Error ? e.message : String(e)
    },

    clearError() {
      this.error = null
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAddonsStore, import.meta.hot))
}
