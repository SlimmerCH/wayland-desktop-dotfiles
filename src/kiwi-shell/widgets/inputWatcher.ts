import KiwiShortcuts from "gi://KiwiShortcuts"
import { brightnessAvailable, kbdAvailable } from "./brightness"
import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"

const SHORTCUT_MAP: Record<string, string> = {
  'volume-up':           'volume',
  'volume-down':         'volume',
  'volume-mute':         'volume',
  'brightness-up':       'brightness',
  'brightness-down':     'brightness',
  'kbd-brightness-up':   'keyboardBrightness',
  'kbd-brightness-down': 'keyboardBrightness',
}

function registerHyprlandBinds() {
  const binds = [
    ['bind', ',', 'XF86AudioRaiseVolume,',  'global,', 'kiwi-shell:volume-up'],
    ['bind', ',', 'XF86AudioLowerVolume,',  'global,', 'kiwi-shell:volume-down'],
    ['bind', ',', 'XF86AudioMute,',         'global,', 'kiwi-shell:volume-mute'],
  ]
  if (brightnessAvailable) {
    binds.push(['bind', ',', 'XF86MonBrightnessUp,',   'global,', 'kiwi-shell:brightness-up'])
    binds.push(['bind', ',', 'XF86MonBrightnessDown,', 'global,', 'kiwi-shell:brightness-down'])
  }
  if (kbdAvailable) {
    binds.push(['bind', ',', 'XF86KbdBrightnessUp,',   'global,', 'kiwi-shell:kbd-brightness-up'])
    binds.push(['bind', ',', 'XF86KbdBrightnessDown,', 'global,', 'kiwi-shell:kbd-brightness-down'])
  }
  for (const args of binds) {
    execAsync(['hyprctl', 'keyword', ...args]).catch(() => {})
  }
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