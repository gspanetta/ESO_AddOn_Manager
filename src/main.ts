import * as Neutralino from '@neutralinojs/lib'
import { devtools } from '@vue/devtools'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'

// Initialize the Neutralino native bridge (opens the WebSocket to the server).
// Must happen before any filesystem/os/net call. API calls made before the
// connection is ready are queued automatically.
Neutralino.init()

// Close the app cleanly when the window is closed.
Neutralino.events.on('windowClose', () => Neutralino.app.exit())

if (process.env.NODE_ENV === 'development') {
  devtools.connect('http://localhost', 8098)
}

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.mount('#app')