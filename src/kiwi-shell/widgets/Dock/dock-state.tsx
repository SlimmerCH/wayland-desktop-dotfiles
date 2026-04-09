import { createState, createComputed, createBinding } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { conf } from "../config"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"
import { classToEntry as _classToEntry, entryToClass as _entryToClass } from "../desktopEntries"

// Apps where the actual Hyprland initial-class doesn't match StartupWMClass.
// entry -> wmClass (for AppIcon dot tracking & focus)
// wmClass -> entry (for unpinned list, best-effort — ambiguous when multiple electron apps run)
const ELECTRON_OVERRIDES: [string, string][] = [
    ["obsidian.desktop", "electron"],
    // Add more as needed, e.g. ["cursor.desktop", "electron"]
]

export const entryToClass = new Map([..._entryToClass, ...ELECTRON_OVERRIDES])

// For classToEntry we only add the override if the class isn't already mapped,
// so a more specific mapping from desktopEntries always wins.
export const classToEntry = new Map([
    ...ELECTRON_OVERRIDES.map(([entry, cls]) => [cls, entry] as [string, string]),
    ..._classToEntry, // desktopEntries wins on conflict
])

export const DOCK_HIDE_TIMEOUT = 300
export const DOCK_HIDE_TIMEOUT_EDGE = 600
export const JUMP_ANIMATION_CLASS_TIMEOUT = 500

export const hyprland = Hyprland.get_default()

export const HOME = GLib.getenv("HOME")
const APPLIST_FILE = `${HOME}/.config/kiwi-shell/dock-apps.json`

export const isNixManaged = !!conf().dock_apps

const initialAppList: string[] = conf().dock_apps ?? (() => {
    try {
        return JSON.parse(readFile(APPLIST_FILE))
    } catch {
        return []
    }
})()

export const [list, setList] = createState<string[]>(initialAppList)

export async function saveList() {
    if (isNixManaged) return
    try {
        await writeFileAsync(APPLIST_FILE, JSON.stringify(list(), null, 2))
    } catch (error) {
        console.error("Failed to save dock apps:", error)
    }
}

export function isValidClient(client: any): boolean {
    const cls = (client["initial-class"] ?? "").trim()
    const title = (client.title ?? "").trim()
    return cls !== "" || title !== ""
}

export const unpinnedList = createComputed(get => {
    const clients = get(createBinding(hyprland, "clients"))
    const pinned = new Set(get(list))

    const seen = new Set<string>()
    return clients.reduce((acc, client) => {
        if (!isValidClient(client)) return acc
        const entry = classToEntry.get(client["initial-class"].toLowerCase())
            ?? (client["initial-class"] + ".desktop")
        if (pinned.has(entry) || seen.has(entry)) return acc
        seen.add(entry)
        acc.push(entry)
        return acc
    }, [] as string[])
})