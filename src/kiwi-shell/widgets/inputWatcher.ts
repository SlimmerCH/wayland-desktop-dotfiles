import KiwiShortcuts from "gi://KiwiShortcuts"
import { brightnessAvailable, kbdAvailable } from "./brightness"
import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import { evalLua, luaBind, luaStr } from "../hypr"

const SHORTCUT_MAP: Record<string, string> = {
  'volume-up':           'volume',
  'volume-down':         'volume',
  'volume-mute':         'volume',
  'brightness-up':       'brightness',
  'brightness-down':     'brightness',
  'kbd-brightness-up':   'keyboardBrightness',
  'kbd-brightness-down': 'keyboardBrightness',
}

async function registerHyprlandBinds() {
  const KEY_TO_ID: Record<string, string> = {
    'XF86AudioRaiseVolume':   'volume-up',
    'XF86AudioLowerVolume':   'volume-down',
    'XF86AudioMute':          'volume-mute',
    'XF86MonBrightnessUp':    'brightness-up',
    'XF86MonBrightnessDown':  'brightness-down',
    'XF86KbdBrightnessUp':    'kbd-brightness-up',
    'XF86KbdBrightnessDown':  'kbd-brightness-down',
  }
  let keys = ['XF86AudioRaiseVolume', 'XF86AudioLowerVolume', 'XF86AudioMute']
  if (brightnessAvailable) keys.push('XF86MonBrightnessUp', 'XF86MonBrightnessDown')
  if (kbdAvailable) keys.push('XF86KbdBrightnessUp', 'XF86KbdBrightnessDown')

  // never unbind these keys — users bind their own volume/brightness actions
  // on them and hl.unbind clears a combo wholesale. Idempotence comes from
  // skipping keys that already carry our described bind (a shell restart
  // without a config reload leaves the previous instance's binds alive).
  try {
    const binds = JSON.parse(await execAsync(['hyprctl', 'binds', '-j']))
    const registered = new Set(binds.map((b: any) => b.description))
    keys = keys.filter(key => !registered.has(`kiwi: ${KEY_TO_ID[key]}`))
  } catch (e) {
    console.error('inputWatcher: failed to query binds:', e)
  }
  if (keys.length === 0) return

  evalLua(keys.map(key => luaBind(
    key,
    `hl.dsp.global(${luaStr(`kiwi-shell:${KEY_TO_ID[key]}`)})`,
    `kiwi: ${KEY_TO_ID[key]}`,
  )).join('\n'), 'indicator key binds')
}

let manager: KiwiShortcuts.Manager | null = null

export function watchIndicatorKeys(onKey: (type: string) => void) {
  registerHyprlandBinds()

  const hyprland = Hyprland.get_default()
  hyprland.connect('config-reloaded', registerHyprlandBinds)

  manager = new KiwiShortcuts.Manager()

  manager.register('volume-up',   'Volume Up')
  manager.register('volume-down', 'Volume Down')
  manager.register('volume-mute', 'Mute / Unmute')

  if (brightnessAvailable) {
    manager.register('brightness-up',   'Brightness Up')
    manager.register('brightness-down', 'Brightness Down')
  }

  if (kbdAvailable) {
    manager.register('kbd-brightness-up',   'Keyboard Brightness Up')
    manager.register('kbd-brightness-down', 'Keyboard Brightness Down')
  }

  manager.connect('activated', (_: unknown, id: string) => {
    const type = SHORTCUT_MAP[id]
    if (type) onKey(type)
  })
}