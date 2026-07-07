import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, For, onCleanup } from "ags"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { conf } from "../config"
import { openPath } from "../Dock/dock-utils"
import { logDebug } from "../../debug"

// Desktop icons: the contents of the XDG desktop folder rendered on a
// BOTTOM-layer surface — above the wallpaper, below every window. Icons
// flow top-to-bottom into columns like a classic desktop. Double-click
// (or Enter) opens, Delete trashes, right-click offers a context menu.

type DesktopItem = {
    path: string
    name: string
    gicon: Gio.Icon | null
    isDir: boolean
    contentType: string | null
    appInfo: GioUnix.DesktopAppInfo | null
}

// FlowBox children back to their items, for selection-based actions
const itemByBox = new WeakMap<Gtk.Widget, DesktopItem>()

const DESKTOP_DIR =
    GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP)
    ?? `${GLib.get_home_dir()}/Desktop`

const [items, setItems] = createState<DesktopItem[]>([])

function readItems(): DesktopItem[] {
    const dir = Gio.File.new_for_path(DESKTOP_DIR)
    if (!dir.query_exists(null)) return []

    const out: DesktopItem[] = []
    const children = dir.enumerate_children(
        "standard::name,standard::display-name,standard::icon,standard::type,standard::is-hidden,standard::content-type",
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
                    contentType: "application/x-desktop",
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
            contentType: info.get_content_type(),
            appInfo: null,
        })
    }
    children.close(null)

    return out.sort((a, b) =>
        a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name))
}

let flowBoxRef: Gtk.FlowBox | null = null

function flowBoxChildCount(): number {
    let n = 0
    for (let c = flowBoxRef?.get_first_child(); c; c = c.get_next_sibling()) n++
    return n
}

function refresh() {
    try {
        const next = readItems()
        logDebug(`[Desktop] refresh → ${next.length} item(s)`)
        setItems(next)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            logDebug(`[Desktop] flowbox children after refresh: ${flowBoxChildCount()}`)
            return GLib.SOURCE_REMOVE
        })
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
    monitor.connect("changed", (_mon, file, _other, eventType) => {
        logDebug(`[Desktop] fs event ${eventType} on ${file?.get_basename() ?? "?"}`)
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

function openWithDialog(item: DesktopItem) {
    const file = Gio.File.new_for_path(item.path)
    const dialog = new Gtk.AppChooserDialog({ gfile: file })
    dialog.connect("response", (d: Gtk.AppChooserDialog, response: number) => {
        if (response === Gtk.ResponseType.OK) {
            const appInfo = d.get_app_info()
            try {
                appInfo?.launch([file], null)
            } catch (e) {
                console.error(`Desktop: failed to open ${item.path} with ${appInfo?.get_name()}:`, e)
            }
        }
        d.destroy()
    })
    dialog.present()
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
                itemByBox.set(self, item)

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
                    <button onclicked={() => { menu.popdown(); openWithDialog(item) }}>
                        <box spacing={6}>
                            <Gtk.Image iconName="system-run-symbolic" pixelSize={16} />
                            <label halign={Gtk.Align.START} label="Open With…" />
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
            name="ags-desktop"
            class={conf.as((conf: any) => `Desktop theme-${conf.theme}`)}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.BOTTOM}
            // on-demand: clicking the desktop focuses it (like any desktop),
            // enabling Delete-to-trash and Enter-to-open on the selection
            keymode={Astal.Keymode.ON_DEMAND}
            $={(self) => {
                // visibility is applied AFTER construction, never as a
                // constructor prop: gnim hands all props to the constructor
                // in written order, so a window that is visible at construct
                // time maps before layer/anchor are set and stays on the
                // default TOP layer — fullscreen, above the dock, eating its
                // input. Verified live: identical window lands on bottom vs
                // top purely by prop order.
                const visible = conf.as((c: any) => !!c.desktop_icons)
                self.visible = visible()
                const dispose = visible.subscribe(() => { self.visible = visible() })
                onCleanup(dispose)
            }}
        >
            <overlay>
            {/* 1×1 near-invisible node: with the last icon removed the window's
                render tree would be empty and GTK never commits the final
                cleared frame — the compositor keeps showing the stale icon
                (verified: 0 flowbox children while the icon stayed on screen) */}
            <box
                $type="overlay"
                class="desktop-damage-anchor"
                halign={Gtk.Align.START}
                valign={Gtk.Align.END}
                widthRequest={1}
                heightRequest={1}
                canTarget={false}
            />
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
                    flowBoxRef = self

                    // clicking empty desktop space clears the selection
                    const click = new Gtk.GestureClick()
                    click.connect("pressed", (_gesture, _n, x, y) => {
                        if (!self.get_child_at_pos(x, y)) self.unselect_all()
                    })
                    self.add_controller(click)

                    // Enter opens the selected item (keyboard counterpart of
                    // the double click)
                    self.connect("child-activated", (_fb, child: Gtk.FlowBoxChild) => {
                        const inner = child.get_child()
                        const item = inner ? itemByBox.get(inner) : undefined
                        if (item) openItem(item)
                    })

                    // Delete moves the selected item to trash
                    const keys = new Gtk.EventControllerKey()
                    keys.connect("key-pressed", (_controller, keyval) => {
                        if (keyval !== Gdk.KEY_Delete && keyval !== Gdk.KEY_KP_Delete)
                            return Gdk.EVENT_PROPAGATE
                        const child = self.get_selected_children()[0]
                        const inner = child?.get_child()
                        const item = inner ? itemByBox.get(inner) : undefined
                        if (!item) return Gdk.EVENT_PROPAGATE
                        trashItem(item)
                        return Gdk.EVENT_STOP
                    })
                    self.add_controller(keys)
                }}
            >
                <For each={items}>
                    {(item: DesktopItem) => <DesktopIcon item={item} />}
                </For>
            </Gtk.FlowBox>
            </overlay>
        </window>
    )
}
