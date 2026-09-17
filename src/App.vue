<script setup lang="ts">
const store = useAddonsStore()

onMounted(() => {
  store.initApp()
})
</script>

<template>
  <!-- fixed-height shell: the page itself never scrolls, only the two columns do -->
  <main class="h-screen flex flex-col overflow-hidden">
    <header class="eso-panel border-b border-eso-edge-bright shrink-0">
      <div class="flex items-center gap-3 px-5 pt-4">
        <h1 class="!text-xl !my-0 text-gold-bright">Chaotic Addon Manager</h1>
        <span v-if="store.error" class="ml-auto text-sm text-blood-bright truncate max-w-[50%]" :title="store.error">
          {{ store.error }}
          <button class="text-parchment-dim underline ml-1" @click="store.clearError">dismiss</button>
        </span>
      </div>
      <div class="eso-divider mx-5 mt-3" />
      <SettingsBar />
    </header>

    <section class="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 lg:grid-rows-1 gap-6 p-5 overflow-y-auto lg:overflow-hidden">
      <div class="flex flex-col lg:min-h-0">
        <h2 class="!text-base !my-0 mb-3 text-gold shrink-0">Installed</h2>
        <div class="flex-1 lg:min-h-0 overflow-y-auto pr-1">
          <InstalledList />
        </div>
      </div>

      <div class="flex flex-col lg:min-h-0">
        <h2 class="!text-base !my-0 mb-3 text-gold shrink-0">Search &amp; Install</h2>
        <div class="flex-1 lg:min-h-0 overflow-y-auto pr-1">
          <SearchPanel />
        </div>
      </div>
    </section>
  </main>
</template>