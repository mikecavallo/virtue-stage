// Settings live in the visitor's browser only. The API key goes to sessionStorage
// by default (gone when the tab closes) and to localStorage only if they opt in.
import { MODELS } from '../ai/gemini.js'

const PREFS_KEY = 'virtuestage.prefs.v1'
const KEY_KEY = 'virtuestage.apiKey.v1'

export const DEFAULT_SETTINGS = {
  apiKey: '',
  remember: false,
  imageModel: MODELS.image,
  visionModel: MODELS.vision,
  imageSize: '2K',
}

function read(storage, key) {
  try {
    return globalThis[storage]?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(storage, key, value) {
  try {
    if (value == null || value === '') globalThis[storage]?.removeItem(key)
    else globalThis[storage]?.setItem(key, value)
  } catch {
    // Private mode or blocked storage: settings just won't persist.
  }
}

export function loadSettings() {
  let prefs = {}
  try {
    prefs = JSON.parse(read('localStorage', PREFS_KEY) || '{}') || {}
  } catch {
    prefs = {}
  }
  const apiKey = read('sessionStorage', KEY_KEY) || read('localStorage', KEY_KEY) || ''
  return { ...DEFAULT_SETTINGS, ...prefs, apiKey, remember: Boolean(read('localStorage', KEY_KEY)) || Boolean(prefs.remember) }
}

export function saveSettings(settings) {
  const { apiKey, ...prefs } = settings
  write('localStorage', PREFS_KEY, JSON.stringify(prefs))
  write('sessionStorage', KEY_KEY, apiKey)
  write('localStorage', KEY_KEY, settings.remember ? apiKey : '')
}
