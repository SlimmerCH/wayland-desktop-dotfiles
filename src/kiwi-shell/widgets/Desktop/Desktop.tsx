import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, For } from "ags"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { conf } from "../config"
import { openPath } from "../Dock/dock-utils"

// Desktop icons: the contents of the XDG desktop folder rendered on a
// BOTTOM-layer surface — above the wallpaper, below every window. Icons
// flow top-to-bottom into columns like a classic desktop. Double-click
// opens, right-click offers a small context menu.

type DesktopItem = {
    path: string
    name: string
    gicon: Gio.Icon | null
    isDir: boolean
    appInfo: GioUnix.DesktopAppInfo | null
}

const DESKTOP_DIR =
    GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP)
    ?? `${GLib.get_home_dir()}/Desktop`

const [items, setItems] = createState<DesktopItem[]>([])

function readItems(): DesktopItem[] {
    const dir = Gio.File.new_for_path(DESKTOP_DIR)
    if (!dir.query_exists(null)) return []

    const out: DesktopItem[] = []
    const children = dir.enumerate_children(
        "standard::name,standard::display-name,standard::icon,standard::type,standard::is-hidden",
        Gio.FileQueryInfoFlags.NONE,
        null,
    )
    let info: Gio.FileInfo | null
    while ((info = children.next_file(null)) !== null) {
        const name = info.get_name()
        if (info.get_is_hidden() || name.startsWith(".")) continue

        const path = `${DESKTOP_DIR}/${name}`

        // .desktop launchers show as their application, not as a text file
        if (name.endsWith(".desktop")) {
            const appInfo = GioUnix.DesktopAppInfo.new_from_filename(path)
            if (appInfo) {
                out.push({
                    path,
                    name: appInfo.get_display_name() ?? name,
                    gicon: appInfo.get_icon(),
                    isDir: false,
                    appInfo,
                })
                continue
            }
        }

        out.push({
            path,
            name: info.get_display_name() ?? name,
            gicon: info.get_icon(),
            isDir: info.get_file_type() === Gio.FileType.DIRECTORY,
            appInfo: null,
        })
    }
    children.close(null)

    return out.sort((a, b) =>
        a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name))
}

function refresh() {
    try {
        setItems(readItems())
    } catch (e) {
        console.error(`Desktop: failed to list ${DESKTOP_DIR}:`, e)
        setItems([])
    }
}

let refreshTimeout: number | null = null

function watchDesktopDir() {
    const dir = Gio.File.new_for_path(DESKTOP_DIR)
    if (!dir.query_exists(null)) return

    const monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
    monitor.connect("changed", () => {
        if (refreshTimeout !== null) GLib.source_remove(refreshTimeout)
        refreshTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            refreshTimeout = null
            refresh()
            return GLib.SOURCE_REMOVE
        })
    })
    // keep the monitor from being garbage collected
    ;(globalThis as any).__desktopDirMonitor = monitor
}

watchDesktopDir()
refresh()

function openItem(item: DesktopItem) {
    if (item.appInfo) {
        item.appInfo.launch([], null)
        return
    }
    if (item.isDir) {
        openPath(item.path)
        return
    }
    try {
        Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(item.path, null), null)
    } catch (e) {
        console.error(`Desktop: failed to open ${item.path}:`, e)
    }
}

function trashItem(item: DesktopItem) {
    try {
        Gio.File.new_for_path(item.path).trash(null)
    } catch (e) {
        console.error(`Desktop: failed to trash ${item.path}:`, e)
    }
}

function DesktopIcon({ item }: { item: DesktopItem }) {
    let menu: Gtk.Popover

    return (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            class="desktop-item"
            widthRequest={90}
            $={(self) => {
                const click = new Gtk.GestureClick()
                click.set_button(Gdk.BUTTON_PRIMARY)
                click.connect("pressed", (_gesture, nPress) => {
                    if (nPress === 2) openItem(item)
                })
                self.add_controller(click)

                const rightClick = new Gtk.GestureClick()
                rightClick.set_button(Gdk.BUTTON_SECONDARY)
                rightClick.connect("released", () => menu.popup())
                self.add_controller(rightClick)
            }}
        >
            <popover
                autohide={true}
                hasArrow={false}
                hexpand={false}
                vexpand={false}
                class="desktop-menu"
                $={(self) => { menu = self }}
            >
                <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
                    <button onclicked={() => { menu.popdown(); openItem(item) }}>
                        <box spacing={6}>
                            <Gtk.Image iconName="document-open-symbolic" pixelSize={16} />
                            <label halign={Gtk.Align.START} label="Open" />
                        </box>
                    </button>
                    <button onclicked={() => { menu.popdown(); openPath(DESKTOP_DIR) }}>
                        <box spacing={6}>
                            <Gtk.Image iconName="folder-symbolic" pixelSize={16} />
                            <label halign={Gtk.Align.START} label="Show in Files" />
                        </box>
                    </button>
                    <button onclicked={() => { menu.popdown(); trashItem(item) }}>
                        <box spacing={6}>
                            <Gtk.Image iconName="user-trash-symbolic" pixelSize={16} />
                            <label halign={Gtk.Align.START} label="Move to Trash" />
                        </box>
                    </button>
                </box>
            </popover>

            {item.gicon
                ? <Gtk.Image gicon={item.gicon} pixelSize={48} class="desktop-item-icon" halign={Gtk.Align.CENTER} />
                : <Gtk.Image iconName="text-x-generic" pixelSize={48} class="desktop-item-icon" halign={Gtk.Align.CENTER} />}
            <label
                class="desktop-item-label"
                label={item.name}
                justify={Gtk.Justification.CENTER}
                ellipsize={Pango.EllipsizeMode.END}
                lines={2}
                wrap={true}
                wrapMode={Pango.WrapMode.WORD_CHAR}
                maxWidthChars={12}
                halign={Gtk.Align.CENTER}
            />
        </box>
    )
}

export default function Desktop({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    return (
        <window
            visible={conf.as((conf: any) => conf.desktop_icons)}
            name="ags-desktop"
            class={conf.as((conf: any) => `Desktop theme-${conf.theme}`)}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.BOTTOM}
            keymode={Astal.Keymode.NONE}
        >
            <Gtk.FlowBox
                class="desktop-icons"
                orientation={Gtk.Orientation.VERTICAL}
                selectionMode={Gtk.SelectionMode.SINGLE}
                activateOnSingleClick={false}
                homogeneous={true}
                rowSpacing={4}
                columnSpacing={4}
                maxChildrenPerLine={999}
                halign={Gtk.Align.START}
                valign={Gtk.Align.FILL}
                $={(self) => {
                    // clicking empty desktop space clears the selection
                    const click = new Gtk.GestureClick()
                    click.connect("pressed", (_gesture, _n, x, y) => {
                        if (!self.get_child_at_pos(x, y)) self.unselect_all()
                    })
                    self.add_controller(click)
                }}
            >
                <For each={items}>
                    {(item: DesktopItem) => <DesktopIcon item={item} />}
                </For>
            </Gtk.FlowBox>
        </window>
    )
}
