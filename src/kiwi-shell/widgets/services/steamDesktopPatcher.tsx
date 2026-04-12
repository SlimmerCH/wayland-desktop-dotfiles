import GLib from "gi://GLib"
import Gio from "gi://Gio"

const APPLICATIONS_DIR = `${GLib.get_home_dir()}/.local/share/applications`
const RUNGAMEID_REGEX = /Exec=steam steam:\/\/rungameid\/(\d+)/

function patchDesktopFile(path: string): void {
    const file = Gio.File.new_for_path(path)

    let contents: string
    try {
        const [, bytes] = file.load_contents(null)
        contents = new TextDecoder().decode(bytes)
    } catch (e) {
        console.error(`[SteamPatcher] Failed to read ${path}:`, e)
        return
    }

    const match = RUNGAMEID_REGEX.exec(contents)
    if (!match) return

    if (contents.includes("StartupWMClass=")) return

    const appId = match[1]
    const wmClass = `steam_app_${appId}`

    const patched = contents.replace(
        /(\[Desktop Entry\]\r?\n)/,
        `$1StartupWMClass=${wmClass}\n`,
    )

    if (patched === contents) {
        console.warn(`[SteamPatcher] Could not find [Desktop Entry] in ${path}`)
        return
    }

    try {
        file.replace_contents(
            new TextEncoder().encode(patched),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
        )
        console.log(`[SteamPatcher] Patched ${path} → StartupWMClass=${wmClass}`)
    } catch (e) {
        console.error(`[SteamPatcher] Failed to write ${path}:`, e)
    }
}

function handleFileEvent(
    _monitor: Gio.FileMonitor,
    file: Gio.File,
    _otherFile: Gio.File | null,
    eventType: Gio.FileMonitorEvent,
): void {
    if (
        eventType !== Gio.FileMonitorEvent.CREATED &&
        eventType !== Gio.FileMonitorEvent.CHANGED
    ) return

    const path = file.get_path()
    if (!path?.endsWith(".desktop")) return

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        patchDesktopFile(path)
        return GLib.SOURCE_REMOVE
    })
}

export function initSteamDesktopPatcher(): void {
    const dir = Gio.File.new_for_path(APPLICATIONS_DIR)

    try {
        const enumerator = dir.enumerate_children(
            "standard::name",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        let info: Gio.FileInfo | null
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name()
            if (name.endsWith(".desktop")) {
                patchDesktopFile(`${APPLICATIONS_DIR}/${name}`)
            }
        }
    } catch (e) {
        console.warn("[SteamPatcher] Could not enumerate applications dir:", e)
    }

    const monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", handleFileEvent)
    ;(globalThis as any).__steamDesktopMonitor = monitor

    console.log("[SteamPatcher] Watching", APPLICATIONS_DIR)
}