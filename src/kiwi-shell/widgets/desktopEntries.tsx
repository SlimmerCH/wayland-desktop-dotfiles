import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import { createState } from "ags"

export const classToEntry = new Map<string, string>()
export const entryToClass = new Map<string, string>()
export const titleMatchers: Array<{ entry: string, regex: RegExp }> = []
export const [mapVersion, setMapVersion] = createState(0)

export function buildClassMap() {
    classToEntry.clear()
    entryToClass.clear()
    titleMatchers.length = 0

    for (const appInfo of Gio.AppInfo.get_all() as GioUnix.DesktopAppInfo[]) {
        const id = appInfo.get_id()
        if (!id) continue

        const stem = id.replace(/\.desktop$/, "").toLowerCase()
        const wmClass = appInfo.get_startup_wm_class()

        if (!classToEntry.has(stem)) {
            classToEntry.set(stem, id)
            entryToClass.set(id, stem)
        }

        if (wmClass) {
            const wmClassLower = wmClass.toLowerCase()
            if (wmClassLower !== stem && !classToEntry.has(wmClassLower)) {
                classToEntry.set(wmClassLower, id)
            }
        }

        const titleMatchRaw = appInfo.get_string("X-Kiwi-TitleMatch")
        if (titleMatchRaw) {
            try {
                titleMatchers.push({ entry: id, regex: new RegExp(titleMatchRaw, "i") })
            } catch (e) {
                console.error(`[ClassMap] Invalid X-Kiwi-TitleMatch in ${id}: ${titleMatchRaw}`, e)
            }
        }
    }

    console.log(`[ClassMap] Built ${classToEntry.size} class entries, ${titleMatchers.length} title matchers`)
    setMapVersion(v => v + 1)
}

function watchDir(path: string) {
    const dir = Gio.File.new_for_path(path)
    if (!dir.query_exists(null)) {
        console.log(`[ClassMap] Skipping (does not exist): ${path}`)
        return
    }

    const monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", (_mon, _file, _other, eventType) => {
        if (
            eventType !== Gio.FileMonitorEvent.CREATED &&
            eventType !== Gio.FileMonitorEvent.CHANGED &&
            eventType !== Gio.FileMonitorEvent.DELETED
        ) return
        console.log(`[ClassMap] Detected change in ${path}, rebuilding...`)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            buildClassMap()
            return GLib.SOURCE_REMOVE
        })
    })

    ;(globalThis as any).__classMapMonitors ??= []
    ;(globalThis as any).__classMapMonitors.push(monitor)

    console.log(`[ClassMap] Watching ${path}`)
}

const dataDirs = [
    `${GLib.get_home_dir()}/.local/share/applications`,
    `/etc/profiles/per-user/${GLib.get_user_name()}/share/applications`,
    `/run/current-system/sw/share/applications`,
    `/run/current-system`,
]

for (const dir of dataDirs) watchDir(dir)

buildClassMap()