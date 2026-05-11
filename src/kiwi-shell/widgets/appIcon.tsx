import { Gtk } from "ags/gtk4"
import GioUnix from "gi://GioUnix"
import { Binding } from "ags"
import { classToEntry, titleMatchers } from "./desktopEntries"

/**
 * Resolves a Hyprland client to a .desktop entry ID.
 *   1. Class lookup (covers StartupWMClass and .desktop file stems).
 *   2. Title regex against entries declaring X-Kiwi-TitleMatch — for apps
 *      whose class is generic, notably protontricks-launched games
 *      which all share `steam_proton`.
 *   3. Fallback: synthesize a .desktop name from the class.
 */
export function entryForClient(client: any): string {
    const cls = (client["initial-class"] ?? "").toLowerCase()

    const byClass = classToEntry.get(cls)
    if (byClass) {
        return byClass
    }

    const title = client["initial-title"] ?? client.title ?? ""
    if (title) {
        const matched = titleMatchers.find(m => m.regex.test(title))
        if (matched) {
            return matched.entry
        }
    }

    const fallback = cls + ".desktop"
    return fallback
}

export function iconForEntry(entry: string): string {
    const appInfo = GioUnix.DesktopAppInfo.new(entry)
    return appInfo?.get_string("Icon") ?? "application-x-executable"
}

export function AppIconImage({ entry, pixelSize = 56, cssClass = "dock-app-icon" }: {
    entry: string
    pixelSize?: number | Binding<number>
    cssClass?: string
}) {
    return (
        <Gtk.Image
            iconName={iconForEntry(entry)}
            pixelSize={pixelSize}
            class={cssClass}
        />
    )
}