import { logger } from "../../log"
const log = logger("dock")
import { conf } from "../config"
import GLib from "gi://GLib"
import { Icon } from "../iconNames"

const FILE_MANAGERS = [
    { bin: "nautilus", flag: "" },
    { bin: "dolphin",  flag: "" },
    { bin: "nemo",     flag: "" },
    { bin: "thunar",   flag: "" },
    { bin: "pcmanfm",  flag: "" },
]

export function resolveFileManager(): { bin: string; flag: string } {
    const configured: string = conf().file_manager
    if (configured && configured !== "auto") {
        const flag = FILE_MANAGERS.find(f => f.bin === configured)?.flag ?? ""
        return { bin: configured, flag }
    }
    return FILE_MANAGERS.find(fm => !!GLib.find_program_in_path(fm.bin))
        ?? { bin: "xdg-open", flag: "" }
}

export function openUri(uri: string) {
    const { bin, flag } = resolveFileManager()
    // shell-quote: paths/uris may contain spaces
    GLib.spawn_command_line_async(
        [bin, flag, GLib.shell_quote(uri)].filter(Boolean).join(" "))
}

export function openPath(path: string) {
    const { bin, flag } = resolveFileManager()
    GLib.spawn_command_line_async(
        [bin, flag, GLib.shell_quote(path)].filter(Boolean).join(" "))
}

export function emptyTrash() {
    try {
        GLib.spawn_command_line_async("gio trash --empty")
    } catch (error) {
        log.error("Failed to empty trash:", error)
    }
}

export function DockContextIcon({ icon }: { icon: string }) {
    return (
        <Icon
            class="dock-context-icon"
            iconName={icon}
            pixelSize={20}
        />
    )
}