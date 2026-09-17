<script setup lang="ts">
import { debounce } from 'lodash-es'
import type { FileListEntry } from '@/lib/types'
import { getThumbUrl } from '@/lib/filelist'

const store = useAddonsStore()

const MAX_RESULTS = 50

const localQuery = ref(store.searchQuery)

const runSearch = debounce((q: string) => {
  store.runSearch(q)
}, 250)

watch(localQuery, (q) => runSearch(q))

const results = computed(() => store.searchResults.slice(0, MAX_RESULTS))
const hasMore = computed(() => store.searchResults.length > MAX_RESULTS)
const isInstalled = (uid: number) => store.installed.some((a) => a.uid === uid)

function install(entry: FileListEntry) {
  store.installAddon(entry)
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <input
      v-model="localQuery"
      type="search"
      placeholder="Search addons… (e.g. Master Merchant)"
      class="w-full !my-0 !mx-0"
      :disabled="!store.addonPath"
    />

    <p v-if="!store.addonPath" class="eso-panel rounded-sm p-4 text-center text-parchment-dim text-sm italic">
      Pick an AddOn folder above to search for addons.
    </p>
    <p v-else-if="!store.hasFilelist" class="eso-panel rounded-sm p-4 text-center text-parchment-dim text-sm italic">
      Click “Refresh filelist” to load the addon catalog first.
    </p>
    <p v-else-if="localQuery && results.length === 0" class="text-parchment-faint text-sm italic p-2">
      No addons match “{{ localQuery }}”.
    </p>

    <div v-for="entry in results" :key="entry.UID" class="eso-card rounded-sm p-3 flex items-center gap-3">
      <AddonIcon :thumb="getThumbUrl(entry)" :name="entry.UIName" />
      <div class="min-w-0 flex-1">
        <div class="font-serif text-parchment truncate text-[15px]">{{ entry.UIName }}</div>
        <div class="text-xs text-parchment-faint italic truncate">
          by {{ entry.UIAuthorName || 'unknown' }} · {{ entry.UIDownloadTotal }} downloads
        </div>
      </div>
      <button
        class="btn shrink-0"
        :class="isInstalled(entry.UID) ? '' : 'btn-primary'"
        :disabled="store.loading || isInstalled(entry.UID)"
        @click="install(entry)"
      >
        {{ isInstalled(entry.UID) ? 'Installed' : 'Install' }}
      </button>
    </div>

    <p v-if="hasMore" class="text-parchment-faint text-xs italic px-1">
      Showing {{ MAX_RESULTS }} of {{ store.searchResults.length }} matches — narrow your search for more precise results.
    </p>

    <!-- Dependency choice modal -->
    <div
      v-if="store.pendingDepChoice"
      class="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      @click.self="store.resolveDepChoice(null)"
    >
      <div class="eso-card rounded-sm p-5 w-full max-w-md">
        <h3 class="!text-lg !my-0 mb-1 text-gold-bright">Choose a dependency</h3>
        <p class="text-sm text-parchment-dim mb-3 -mt-1">
          Multiple addons match “<span class="text-parchment not-italic">{{ store.pendingDepChoice.dep }}</span>”. Pick the one to install.
        </p>
        <div class="flex flex-col gap-2 max-h-80 overflow-auto pr-1">
          <button
            v-for="entry in store.pendingDepChoice.candidates"
            :key="entry.UID"
            class="text-left eso-panel rounded-sm p-2 hover:border-gold flex items-center gap-3"
            @click="store.resolveDepChoice(entry)"
          >
            <AddonIcon :thumb="getThumbUrl(entry)" :name="entry.UIName" />
            <div class="min-w-0">
              <div class="text-parchment text-sm truncate">{{ entry.UIName }}</div>
              <div class="text-xs text-parchment-faint italic">
                by {{ entry.UIAuthorName || 'unknown' }} · {{ entry.UIDownloadTotal }} downloads
              </div>
            </div>
          </button>
        </div>
        <button class="btn !my-3" @click="store.resolveDepChoice(null)">Skip this dependency</button>
      </div>
    </div>
  </div>
</template>