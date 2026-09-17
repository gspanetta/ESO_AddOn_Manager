<script setup lang="ts">
import { open } from '@tauri-apps/plugin-dialog'
import type { BackupExportResult, BackupImportResult } from '@/lib/backup'

const store = useAddonsStore()

const lastRefreshed = computed(() => {
  if (!store.filelistLoadedAt) return null
  return new Date(store.filelistLoadedAt).toLocaleString()
})

// --- AddOn folder popup ---
const showFolderDialog = ref(false)
const pathInput = ref('')

function openFolderDialog() {
  pathInput.value = store.addonPath ?? ''
  store.clearError()
  showFolderDialog.value = true
}

function closeFolderDialog() {
  showFolderDialog.value = false
}

async function browse() {
  const selected = await open({ directory: true, multiple: false })
  if (typeof selected === 'string' && selected) {
    pathInput.value = selected
  }
}

/** Save sets the folder and reconciles the installed list with its contents. */
async function savePath() {
  const trimmed = pathInput.value.trim()
  if (!trimmed) return
  await store.setAddonDir(trimmed)
  // keep the popup open if something went wrong so the error is visible
  if (!store.error) closeFolderDialog()
}

// --- Settings backup (export / import) ---
const importSummary = ref<(BackupImportResult & { installFailures: { name: string; error: string }[] }) | null>(null)
const exportSummary = ref<BackupExportResult | null>(null)

async function onExport() {
  store.clearError()
  const result = await store.exportSettings()
  if (result) exportSummary.value = result
}

/** Import flow: step 1 — pick + validate the backup; the confirm dialog renders from store.pendingImport. */
function openImportConfirm() {
  store.clearError()
  void store.previewImport()
}

/** Import flow: step 2 — wipe the folder, reinstall addons, restore settings. */
async function confirmImport() {
  const result = await store.confirmImport()
  if (result) importSummary.value = result
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3 px-5 py-3">
    <div class="flex items-center gap-2">
      <button class="btn !my-0" @click="openFolderDialog">
        {{ store.addonPath ? 'Change AddOn folder…' : 'Set AddOn folder…' }}
      </button>
      <span v-if="!store.addonPath" class="text-blood-bright text-sm italic">not configured</span>
    </div>

    <div class="flex items-center gap-2">
      <button class="btn !my-0" :disabled="store.loading || !store.addonPath" @click="store.refreshFilelist">
        <span
          v-if="store.loading"
          class="inline-block w-3 h-3 border-2 border-gold border-t-transparent rounded-full animate-spin align-middle mr-1"
        />
        Refresh filelist
      </button>
      <span v-if="lastRefreshed" class="text-parchment-faint text-xs italic">updated {{ lastRefreshed }}</span>
    </div>

    <label class="flex items-center gap-2 ml-auto text-sm text-parchment-dim cursor-pointer select-auto">
      <input
        type="checkbox"
        class="my-0 w-4 h-4 align-middle"
        :checked="store.installDeps"
        @change="store.setInstallDeps(($event.target as HTMLInputElement).checked)"
      />
      Auto-install dependencies
    </label>

    <div class="flex items-center gap-2">
      <button class="btn !my-0" :disabled="store.loading || !store.addonPath" @click="onExport">
        Export settings…
      </button>
      <button class="btn !my-0" :disabled="store.loading || !store.addonPath" @click="openImportConfirm">
        Import settings…
      </button>
    </div>

    <!-- Set AddOn folder popup -->
    <div
      v-if="showFolderDialog"
      class="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      @click.self="closeFolderDialog"
    >
      <div class="eso-card rounded-sm p-5 w-full max-w-lg">
        <h3 class="!text-lg !my-0 mb-3 text-gold-bright">AddOn folder</h3>
        <p class="text-sm text-parchment-dim mb-3 -mt-1">Paste the path to your ESO AddOns folder, or browse for it.</p>
        <div class="flex items-center gap-2">
          <input
            v-model="pathInput"
            type="text"
            placeholder="e.g. /home/user/Elder Scrolls Online/live/AddOns"
            class="flex-1 !my-0"
            @keydown.enter="savePath"
          />
          <button class="btn !my-0 shrink-0" @click="browse">Browse…</button>
        </div>
        <p class="text-xs text-parchment-faint italic mt-2">
          Saving scans the folder: addons already present are added to your list, and tracked addons no longer in the
          folder are removed.
        </p>

        <p v-if="store.error" class="text-sm text-blood-bright mt-3">
          {{ store.error }}
          <button class="underline ml-1" @click="store.clearError">dismiss</button>
        </p>

        <div class="flex justify-end gap-2 mt-4">
          <button class="btn !my-0" @click="closeFolderDialog">Cancel</button>
          <button class="btn btn-primary !my-0" :disabled="store.loading || !pathInput.trim()" @click="savePath">
            <span
              v-if="store.loading"
              class="inline-block w-3 h-3 border-2 border-eso-bg border-t-transparent rounded-full animate-spin align-middle mr-1"
            />
            Save
          </button>
        </div>
      </div>
    </div>

    <!-- Import settings: confirm — shows once a backup zip has been picked & validated -->
    <div
      v-if="store.pendingImport"
      class="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      @click.self="store.cancelImport"
    >
      <div class="eso-card rounded-sm p-5 w-full max-w-lg">
        <h3 class="!text-lg !my-0 mb-3 text-gold-bright">Import settings</h3>
        <p class="text-sm text-parchment-dim mb-2 -mt-1">
          This backup contains <strong>{{ store.pendingImport.addons.length }}</strong> addon(s). Importing will:
        </p>
        <ul class="text-sm text-parchment-dim list-disc pl-5 space-y-1 mb-3">
          <li>
            <strong>Wipe the AddOns folder</strong> — every addon currently there will be deleted, including untracked
            ones.
          </li>
          <li>Re-download and install each addon from the backup.</li>
          <li>Overwrite <code class="text-xs">SavedVariables</code> files with the backup's versions.</li>
          <li>Overwrite <code class="text-xs">UserSettings.txt</code> if the backup contains it.</li>
        </ul>

        <div v-if="store.pendingImport.addons.length > 0" class="max-h-40 overflow-y-auto mb-3">
          <p class="text-xs text-parchment-faint italic mb-1">Addons to install:</p>
          <ul class="text-xs text-parchment-dim columns-2 gap-4">
            <li v-for="a in store.pendingImport.addons" :key="a.uid" class="truncate" :title="a.name">
              {{ a.name }}
            </li>
          </ul>
        </div>

        <p class="text-xs text-parchment-faint italic">
          Existing SavedVariables that would be overwritten are moved to a timestamped
          <code class="text-xs">SavedVariables.bak-*</code> folder first, so nothing is lost. The AddOns folder itself
          is <em>not</em> backed up — addons are re-downloaded from ESOUI.
        </p>

        <p v-if="store.error" class="text-sm text-blood-bright mt-3">
          {{ store.error }}
          <button class="underline ml-1" @click="store.clearError">dismiss</button>
        </p>

        <div class="flex justify-end gap-2 mt-4">
          <button class="btn !my-0" @click="store.cancelImport">Cancel</button>
          <button class="btn btn-primary !my-0" :disabled="store.loading" @click="confirmImport">
            Wipe &amp; import
          </button>
        </div>
      </div>
    </div>

    <!-- Import settings: progress while wiping + reinstalling -->
    <div v-if="store.importProgress" class="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div class="eso-card rounded-sm p-5 w-full max-w-lg">
        <h3 class="!text-lg !my-0 mb-3 text-gold-bright">Importing settings…</h3>
        <p class="text-sm text-parchment-dim mb-3">
          Installing addon {{ store.importProgress.done }} of {{ store.importProgress.total }}
        </p>
        <div class="h-2 w-full bg-eso-bg rounded-sm overflow-hidden">
          <div
            class="h-full bg-gold rounded-sm transition-all"
            :style="{ width: `${(store.importProgress.done / Math.max(store.importProgress.total, 1)) * 100}%` }"
          />
        </div>
      </div>
    </div>

    <!-- Import settings: result summary -->
    <div
      v-if="importSummary"
      class="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      @click.self="importSummary = null"
    >
      <div class="eso-card rounded-sm p-5 w-full max-w-lg">
        <h3 class="!text-lg !my-0 mb-3 text-gold-bright">Settings imported</h3>
        <ul class="text-sm text-parchment-dim list-disc pl-5 space-y-1 mb-3">
          <li>{{ importSummary.addonCount }} addon(s) installed from the backup.</li>
          <li>{{ importSummary.restoredSavedVariables }} SavedVariables file(s) restored.</li>
          <li>
            {{
              importSummary.restoredUserSettings ? 'UserSettings.txt restored.' : 'No UserSettings.txt in the backup.'
            }}
          </li>
          <li v-if="importSummary.backupDir">
            Previous settings backed up to <code class="text-xs break-all">{{ importSummary.backupDir }}</code>
          </li>
        </ul>

        <div v-if="importSummary.installFailures.length > 0" class="mb-3">
          <p class="text-sm text-blood-bright mb-1">
            {{ importSummary.installFailures.length }} addon(s) failed to install:
          </p>
          <ul class="text-xs text-parchment-dim list-disc pl-5 space-y-0.5 max-h-32 overflow-y-auto">
            <li v-for="f in importSummary.installFailures" :key="f.name">
              <strong>{{ f.name }}</strong> — {{ f.error }}
            </li>
          </ul>
        </div>

        <div class="flex justify-end gap-2 mt-4">
          <button class="btn btn-primary !my-0" @click="importSummary = null">OK</button>
        </div>
      </div>
    </div>

    <!-- Export settings: result summary -->
    <div
      v-if="exportSummary"
      class="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      @click.self="exportSummary = null"
    >
      <div class="eso-card rounded-sm p-5 w-full max-w-lg">
        <h3 class="!text-lg !my-0 mb-3 text-gold-bright">Settings exported</h3>
        <ul class="text-sm text-parchment-dim list-disc pl-5 space-y-1 mb-3">
          <li>{{ exportSummary.savedVariableFiles }} SavedVariables file(s) included.</li>
          <li>
            {{
              exportSummary.includesUserSettings ? 'UserSettings.txt included.' : 'No UserSettings.txt found — skipped.'
            }}
          </li>
          <li>{{ exportSummary.addonCount }} tracked addon(s) recorded.</li>
        </ul>
        <div class="flex justify-end gap-2 mt-4">
          <button class="btn btn-primary !my-0" @click="exportSummary = null">OK</button>
        </div>
      </div>
    </div>
  </div>
</template>
