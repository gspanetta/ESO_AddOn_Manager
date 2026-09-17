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
const showImportConfirm = ref(false)
const importSummary = ref<BackupImportResult | null>(null)
const exportSummary = ref<BackupExportResult | null>(null)

async function onExport() {
  store.clearError()
  const result = await store.exportSettings()
  if (result) exportSummary.value = result
}

function openImportConfirm() {
  store.clearError()
  showImportConfirm.value = true
}

async function confirmImport() {
  showImportConfirm.value = false
  const result = await store.importSettings()
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

    <!-- Import settings: confirm overwrite -->
    <div
      v-if="showImportConfirm"
      class="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      @click.self="showImportConfirm = false"
    >
      <div class="eso-card rounded-sm p-5 w-full max-w-lg">
        <h3 class="!text-lg !my-0 mb-3 text-gold-bright">Import settings</h3>
        <p class="text-sm text-parchment-dim mb-2 -mt-1">Pick a backup zip to restore. This will:</p>
        <ul class="text-sm text-parchment-dim list-disc pl-5 space-y-1 mb-3">
          <li>Replace the tracked-addons list with the one from the backup.</li>
          <li>Overwrite <code class="text-xs">SavedVariables</code> files with the backup's versions.</li>
          <li>Overwrite <code class="text-xs">UserSettings.txt</code> if the backup contains it.</li>
        </ul>
        <p class="text-xs text-parchment-faint italic">
          Existing settings that would be overwritten are moved to a timestamped
          <code class="text-xs">SavedVariables.bak-*</code> folder first, so nothing is lost.
        </p>

        <p v-if="store.error" class="text-sm text-blood-bright mt-3">
          {{ store.error }}
          <button class="underline ml-1" @click="store.clearError">dismiss</button>
        </p>

        <div class="flex justify-end gap-2 mt-4">
          <button class="btn !my-0" @click="showImportConfirm = false">Cancel</button>
          <button class="btn btn-primary !my-0" :disabled="store.loading" @click="confirmImport">Choose backup…</button>
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
          <li>{{ importSummary.restoredSavedVariables }} SavedVariables file(s) restored.</li>
          <li>
            {{
              importSummary.restoredUserSettings ? 'UserSettings.txt restored.' : 'No UserSettings.txt in the backup.'
            }}
          </li>
          <li>{{ importSummary.addonCount }} addon(s) now tracked.</li>
          <li v-if="importSummary.backupDir">
            Previous settings backed up to <code class="text-xs break-all">{{ importSummary.backupDir }}</code>
          </li>
        </ul>
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
