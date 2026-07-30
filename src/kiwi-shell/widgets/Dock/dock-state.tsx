import { createState, createComputed, createBinding } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { conf } from "../config"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"
import { classToEntry as _classToEntry, entryToClass as _entryToClass, mapVersion } from "../desktopEntries"
import { entryForClient } from "../appIcon"

export const DOCK_HIDE_TIMEOUT = 600
export const JUMP_ANIMATION_CLASS_TIMEOUT = 500
export const DOCK_SLIDE_DURATION = 400

// Apps where the actual Hyprland initial-class doesn't match StartupWMClass.
const ELECTRON_OVERRIDES: [string, string][] = [
    ["obsidian.desktop", "electron"],
]

export const entryToClass = new Map([..._entryToClass, ...ELECTRON_OVERRIDES])

export function lookupEntry(cls: string): string | undefined {
    const fromMap = _classToEntry.get(cls)
    if (fromMap) return fromMap
    for (const [entry, wmClass] of ELECTRON_OVERRIDES) {
        if (wmClass === cls) return entry
    }
    return undefined
}

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

// ─── Minimize (special-workspace scratchpad) ──────────────────────────────────

export const MINIMIZED_WS = "special:minimized"

// Astal strips the leading 0x from client addresses, but Hyprland's
// address: window selector requires it
const addr = (client: Hyprland.Client) => `address:0x${client.address}`

export function isMinimized(client: Hyprland.Client): boolean {
    return client.workspace?.name === MINIMIZED_WS
}

// visible = on the active workspace of some monitor
export function isClientVisible(client: Hyprland.Client): boolean {
    const wsId = client.workspace?.id
    if (wsId === undefined) return false
    return hyprland.get_monitors().some(m => m.activeWorkspace?.id === wsId)
}

export function minimizeClient(client: Hyprland.Client) {
    hyprland.dispatch("movetoworkspacesilent", `${MINIMIZED_WS},${addr(client)}`)
}

// Hyprland keeps focus and stacking separate: focusing a floating window
// does not raise it above overlapping siblings, so every activation path
// raises explicitly.
export function focusClient(client: Hyprland.Client) {
    client.focus()
    hyprland.dispatch("alterzorder", `top,${addr(client)}`)
}

export function restoreClient(client: Hyprland.Client) {
    // movetoworkspace (non-silent) also focuses the window, so it lands on
    // the current workspace ready to use
    hyprland.dispatch("movetoworkspace", `${hyprland.focusedWorkspace.id},${addr(client)}`)
    hyprland.dispatch("alterzorder", `top,${addr(client)}`)
}

// ─── Focus-steal guard ────────────────────────────────────────────────────────
// With focus_on_activate, external activations (xdg-open behind the dock's
// home/trash buttons, single-instance file managers, links opening in a
// minimized browser, …) can focus a minimized window, which drags the whole
// special workspace into view. Treat any focus landing on a minimized window
// as "restore it": pull it to the last real workspace, then close the
// overlay that is left showing the remaining minimized windows.

let lastNormalWs = hyprland.focusedWorkspace?.id ?? 1
hyprland.connect("notify::focused-workspace", () => {
    const id = hyprland.focusedWorkspace?.id
    if (id !== undefined && id > 0) lastNormalWs = id
})

hyprland.connect("notify::focused-client", () => {
    const client = hyprland.focusedClient
    if (!client || !isMinimized(client)) return
    hyprland.dispatch("movetoworkspace", `${lastNormalWs},${addr(client)}`)
    hyprland.dispatch("alterzorder", `top,${addr(client)}`)
    // the overlay state settles asynchronously (socket events), so check
    // slightly later whether it is still open — it auto-closes only when
    // the restored window was the last one minimized
    setTimeout(() => {
        for (const m of hyprland.get_monitors()) {
            if (m.specialWorkspace?.name === MINIMIZED_WS)
                hyprland.dispatch("togglespecialworkspace", "minimized")
        }
    }, 150)
})

export const unpinnedList = createComputed(get => {
    get(mapVersion) // reactive dependency — re-runs when maps rebuild
    const clients = get(createBinding(hyprland, "clients"))
    const pinned = new Set(get(list))

    const seen = new Set<string>()
    return clients.reduce((acc, client) => {
        if (!isValidClient(client)) return acc
        const entry = entryForClient(client)
        if (pinned.has(entry) || seen.has(entry)) return acc
        seen.add(entry)
        acc.push(entry)
        return acc
    }, [] as string[])
})