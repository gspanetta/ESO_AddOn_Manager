import tailwind from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'
import vueDevTools from 'vite-plugin-vue-devtools'
import { version as pkgVersion } from './package.json'

process.env.VITE_APP_VERSION = pkgVersion
if (process.env.NODE_ENV === 'production') {
  process.env.VITE_APP_BUILD_EPOCH = new Date().getTime().toString()
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    tailwind(),
    vue(),
    vueDevTools(),
    AutoImport({
      imports: [
        'vue',
        'vue-router',
        'pinia',
        {
          '@/stores/addons': ['useAddonsStore'],
        },
      ],
      dts: 'auto-imports.d.ts',
      vueTemplate: true,
    }),
    Components({
      dts: 'components.d.ts',
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  css: {
    preprocessorMaxWorkers: true,
  },

  clearScreen: false,
  envPrefix: ['VITE_'],
  server: {
    port: 1420,
    strictPort: true,
    // Bind IPv4 explicitly. neu's port-wait probe (and the Neutralino webview)
    // resolve `localhost` to 127.0.0.1, but Vite v8 defaults to binding IPv6
    // [::1] only — that mismatch makes `neu run` time out waiting for the port.
    host: '127.0.0.1',
    watch: {
      ignored: ['**/bin/**', '**/.tmp/**'],
    },
  },
  build: {
    outDir: './dist',
    // Neutralino uses the OS webview (WebKitGTK on Linux, WebView2 on Windows,
    // WebKit on macOS). A modern baseline target works across all of them.
    target: 'es2020',
    minify: 'esbuild',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1024,
  },
})