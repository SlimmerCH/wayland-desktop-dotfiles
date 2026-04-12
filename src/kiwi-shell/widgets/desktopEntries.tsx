import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"

export const classToEntry = new Map<string, string>()
export const entryToClass = new Map<string, string>()

for (const appInfo of Gio.AppInfo.get_all() as GioUnix.DesktopAppInfo[]) {
    const id = appInfo.get_id()
    if (!id) continue

    const stem = id.replace(/\.desktop$/, "").toLowerCase()
    const wmClass = appInfo.get_startup_wm_class()

    // Always register the stem
    if (!classToEntry.has(stem)) {
        classToEntry.set(stem, id)
        entryToClass.set(id, stem)
    }

    // Also register StartupWMClass if different from stem
    if (wmClass) {
        const wmClassLower = wmClass.toLowerCase()
        if (wmClassLower !== stem && !classToEntry.has(wmClassLower)) {
            classToEntry.set(wmClassLower, id)
        }
    }
}