import { Gtk } from "ags/gtk4"
import GioUnix from "gi://GioUnix"
import { classToEntry } from "./desktopEntries"
import { Binding } from "ags";

export function entryForClient(client: any): string {
    const cls = client.get_class()
    const clsLower = cls.toLowerCase()
    
    return classToEntry.get(clsLower)
        ?? classToEntry.get(cls)
        ?? (GioUnix.DesktopAppInfo.new(cls + ".desktop") ? cls + ".desktop" : clsLower + ".desktop")
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