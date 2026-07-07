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

function getClipboard(): Gdk.Clipboard {
    return Gdk.Display.get_default()!.get_clipboard()
}

function copyItem(item: DesktopItem, cut = false) {
    const uri = GLib.filename_to_uri(item.path, null)
    const enc = new TextEncoder()
    // x-gnome-copied-files carries the copy/cut verb for file managers,
    // text/uri-list is the fallback everything else understands
    getClipboard().set_content(Gdk.ContentProvider.new_union([
        Gdk.ContentProvider.new_for_bytes("application/x-gnome-copied-files",
            GLib.Bytes.new(enc.encode(`${cut ? "cut" : "copy"}\n${uri}`))),
        Gdk.ContentProvider.new_for_bytes("text/uri-list",
            GLib.Bytes.new(enc.encode(`${uri}\r\n`))),
    ]))
    logDebug(`[Desktop] ${cut ? "cut" : "copied"} ${item.path}`)
}

function clipboardHasFiles(): boolean {
    const formats = getClipboard().get_formats()
    return formats.contain_mime_type("application/x-gnome-copied-files")
        || formats.contain_mime_type("text/uri-list")
}

// first free variant of `name` in the desktop dir: name, name (2), name (3)…
function uniqueDest(name: string): Gio.File {
    const dir = Gio.File.new_for_path(DESKTOP_DIR)
    let dest = dir.get_child(name)
    if (!dest.query_exists(null)) return dest
    const dot = name.startsWith(".") ? -1 : name.lastIndexOf(".")
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ""
    for (let n = 2; ; n++) {
        dest = dir.get_child(`${stem} (${n})${ext}`)
        if (!dest.query_exists(null)) return dest
    }
}

function pasteUris(uris: string[], cut: boolean) {
    for (const uri of uris) {
        const src = Gio.File.new_for_uri(uri)
        const srcPath = src.get_path()
        const name = src.get_basename()
        if (!srcPath || !name) continue
        // cutting a desktop file onto the desktop would just rename it
        if (cut && src.get_parent()?.get_path() === DESKTOP_DIR) continue
        const dest = uniqueDest(name)
        // argv spawn (no shell quoting pitfalls); cp/mv recurse into
        // folders and keep the shell responsive on big files
        const argv = cut
            ? ["mv", "--", srcPath, dest.get_path()!]
            : ["cp", "-r", "--", srcPath, dest.get_path()!]
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE)
        } catch (e) {
            console.error(`Desktop: failed to paste ${srcPath}:`, e)
        }
    }
}

function pasteFromClipboard() {
    const cb = getClipboard()
    cb.read_async(
        ["application/x-gnome-copied-files", "text/uri-list"],
        GLib.PRIORITY_DEFAULT, null,
        (_src, res) => {
            let stream: Gio.InputStream
            let mime: string | null
            try {
                ;[stream, mime] = cb.read_finish(res)
            } catch (e) {
                logDebug("[Desktop] paste: clipboard holds no files")
                return
            }
            const out = Gio.MemoryOutputStream.new_resizable()
            out.splice_async(stream,
                Gio.OutputStreamSpliceFlags.CLOSE_SOURCE
                | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
                GLib.PRIORITY_DEFAULT, null,
                (_out, spliceRes) => {
                    try {
                        out.splice_finish(spliceRes)
                    } catch (e) {
                        console.error("Desktop: paste read failed:", e)
                        return
                    }
                    const text = new TextDecoder()
                        .decode(out.steal_as_bytes().toArray())
                    const lines = text.split(/\r?\n/)
                        .filter(l => l && !l.startsWith("#"))
                    let cut = false
                    if (mime === "application/x-gnome-copied-files")
                        cut = lines.shift() === "cut"
                    logDebug(`[Desktop] paste ${lines.length} uri(s)`
                        + ` (${cut ? "cut" : "copy"})`)
                    pasteUris(lines, cut)
                })
        })
}

function selectedItem(): DesktopItem | undefined {
    const child = flowBoxRef?.get_selected_children()[0]
    const inner = child?.get_child()
    return inner ? itemByBox.get(inner) : undefined
}

// is the picked widget at (x, y) inside a desktop icon?
function overIcon(root: Gtk.Widget, x: number, y: number): boolean {
    for (let w = root.pick(x, y, Gtk.PickFlags.DEFAULT); w && w !== root; w = w.get_parent())
        if (w instanceof Gtk.FlowBoxChild) return true
    return false
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
                    <button onclicked={() => { menu.popdown(); copyItem(item) }}>
                        <box spacing={6}>
                            <Gtk.Image iconName="edit-copy-symbolic" pixelSize={16} />
                            <label halign={Gtk.Align.START} label="Copy" />
                        </box>
                    </button>
                    <button onclicked={() => { menu.popdown(); copyItem(item, true) }}>
                        <box spacing={6}>
                            <Gtk.Image iconName="edit-cut-symbolic" pixelSize={16} />
                            <label halign={Gtk.Align.START} label="Cut" />
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
    let pasteBtn: Gtk.Button

    // context menu for empty desktop space; parented onto the overlay below
    const pasteMenu = (
        <popover
            autohide={true}
            hasArrow={false}
            hexpand={false}
            vexpand={false}
            class="desktop-menu"
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
                <button
                    $={(self) => { pasteBtn = self }}
                    onclicked={() => { pasteMenu.popdown(); pasteFromClipboard() }}
                >
                    <box spacing={6}>
                        <Gtk.Image iconName="edit-paste-symbolic" pixelSize={16} />
                        <label halign={Gtk.Align.START} label="Paste" />
                    </box>
                </button>
                <button onclicked={() => { pasteMenu.popdown(); openPath(DESKTOP_DIR) }}>
                    <box spacing={6}>
                        <Gtk.Image iconName="folder-symbolic" pixelSize={16} />
                        <label halign={Gtk.Align.START} label="Open in Files" />
                    </box>
                </button>
            </box>
        </popover>
    ) as Gtk.Popover

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

                // a window taking focus (click into an app) clears the
                // desktop selection, like every OS desktop
                self.connect("notify::is-active", () => {
                    if (!self.isActive) flowBoxRef?.unselect_all()
                })

                const keys = new Gtk.EventControllerKey()
                keys.connect("key-pressed", (_controller, keyval, _code, state) => {
                    const ctrl = !!(state & Gdk.ModifierType.CONTROL_MASK)
                    if (ctrl && (keyval === Gdk.KEY_v || keyval === Gdk.KEY_V)) {
                        pasteFromClipboard()
                        return Gdk.EVENT_STOP
                    }
                    if (ctrl && (keyval === Gdk.KEY_c || keyval === Gdk.KEY_C)) {
                        const item = selectedItem()
                        if (item) { copyItem(item); return Gdk.EVENT_STOP }
                        return Gdk.EVENT_PROPAGATE
                    }
                    if (ctrl && (keyval === Gdk.KEY_x || keyval === Gdk.KEY_X)) {
                        const item = selectedItem()
                        if (item) { copyItem(item, true); return Gdk.EVENT_STOP }
                        return Gdk.EVENT_PROPAGATE
                    }
                    // Delete moves the selected item to trash
                    if (keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_KP_Delete) {
                        const item = selectedItem()
                        if (item) { trashItem(item); return Gdk.EVENT_STOP }
                    }
                    return Gdk.EVENT_PROPAGATE
                })
                self.add_controller(keys)
            }}
        >
            <overlay
                $={(self) => {
                    pasteMenu.set_parent(self)
                    onCleanup(() => pasteMenu.unparent())

                    // clicking empty desktop space clears the selection
                    // (CAPTURE: the flowbox would claim clicks in its column)
                    const click = new Gtk.GestureClick()
                    click.set_button(Gdk.BUTTON_PRIMARY)
                    click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
                    click.connect("pressed", (_gesture, _n, x, y) => {
                        if (!overIcon(self, x, y)) flowBoxRef?.unselect_all()
                    })
                    self.add_controller(click)

                    // right-click on empty space: paste menu at the pointer
                    const rightClick = new Gtk.GestureClick()
                    rightClick.set_button(Gdk.BUTTON_SECONDARY)
                    rightClick.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
                    rightClick.connect("pressed", (_gesture, _n, x, y) => {
                        if (overIcon(self, x, y)) return // icon menu handles it
                        pasteBtn.sensitive = clipboardHasFiles()
                        pasteMenu.set_pointing_to(new Gdk.Rectangle({
                            x: Math.round(x), y: Math.round(y), width: 1, height: 1,
                        }))
                        pasteMenu.popup()
                    })
                    self.add_controller(rightClick)
                }}
            >
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

                    // Enter opens the selected item (keyboard counterpart of
                    // the double click)
                    self.connect("child-activated", (_fb, child: Gtk.FlowBoxChild) => {
                        const inner = child.get_child()
                        const item = inner ? itemByBox.get(inner) : undefined
                        if (item) openItem(item)
                    })
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
