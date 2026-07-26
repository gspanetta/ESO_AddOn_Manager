import { filesystem } from '@neutralinojs/lib'
import { appDataDirPath, joinPath } from './paths'

const CONFIG_FILE = 'config.json'

export interface AppConfig {
  /** User-chosen addon target directory, or null until configured. */
  addonPath: string | null
  /** Whether to automatically install `## DependsOn:` libraries. */
  installDeps: boolean
}

const DEFAULT_CONFIG: AppConfig = {
  addonPath: null,
  installDeps: true,
}

let cachedConfigPath: string | null = null

/** Absolute path to the config file inside the app data dir (cached). */
async function configPath(): Promise<string> {
  if (!cachedConfigPath) {
    cachedConfigPath = await joinPath(await appDataDirPath(), CONFIG_FILE)
  }
  return cachedConfigPath
}

/**
 * Load the full config, falling back to defaults for missing keys.
 * Stored as a plain JSON file (replaces the old `tauri-plugin-store`).
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const text = await filesystem.readFile(await configPath())
    const parsed = JSON.parse(text) as Partial<AppConfig>
    return {
      addonPath: parsed.addonPath ?? DEFAULT_CONFIG.addonPath,
      installDeps: parsed.installDeps ?? DEFAULT_CONFIG.installDeps,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** Persist the whole config object. */
async function saveConfig(config: AppConfig): Promise<void> {
  await filesystem.createDirectory(await appDataDirPath())
  await filesystem.writeFile(await configPath(), JSON.stringify(config, null, 2))
}

/** Persist the addon target directory. */
export async function saveAddonPath(path: string | null): Promise<void> {
  const config = await loadConfig()
  config.addonPath = path
  await saveConfig(config)
}

/** Persist the auto-install-dependencies toggle. */
export async function saveInstallDeps(value: boolean): Promise<void> {
  const config = await loadConfig()
  config.installDeps = value
  await saveConfig(config)
}