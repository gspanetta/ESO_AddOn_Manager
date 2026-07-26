/// <reference types="vite/client" />

/**
 * Ambient declarations for the runtime globals Neutralinojs injects via
 * `__neutralino_globals.js` (before app code runs). Only the ones we touch are
 * declared; the full set is documented in the Neutralinojs "Global variables"
 * reference.
 */
interface Window {
  /** Operating system name, e.g. "Windows" | "Linux" | "Darwin" (see NL_OS). */
  NL_OS?: string
  /** Port the Neutralino server is listening on. */
  NL_PORT?: number
  /** Access token for the native WebSocket bridge. */
  NL_TOKEN?: string
  /** Command-line args passed to the app. */
  NL_ARGS?: string[]
  /** Application id from neutralino.config.json. */
  NL_APPID?: string
  /** Application root path (where the binary lives). */
  NL_PATH?: string
  /** App data directory (appPath or systemDataPath, per dataLocation). */
  NL_DATAPATH?: string
  /** Current execution mode ("window" | "browser" | "cloud" | "chrome"). */
  NL_MODE?: string
  /** Neutralino client library version. */
  NL_CVERSION?: string
}