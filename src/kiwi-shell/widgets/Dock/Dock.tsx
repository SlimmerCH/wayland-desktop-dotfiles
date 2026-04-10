import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding, onCleanup } from "ags"
import { conf } from "../config"
import { hyprland, list, unpinnedList, DOCK_HIDE_TIMEOUT, DOCK_HIDE_TIMEOUT_EDGE, JUMP_ANIMATION_CLASS_TIMEOUT } from "./dock-state"
import { AppIcon } from "./AppIcon"
import { HomeFolderButton, TrashButton } from "./DockButtons"
import { KeyedList } from "./KeyedList"
import Cairo from "cairo"
import GLib from "gi://GLib"

const clients = createBinding(hyprland, "clients")
const activeWorkspace = createBinding(hyprland, "focusedWorkspace")

const lengths = createComputed(get => [
    get(list).length,
    get(unpinnedList).length,
    get(conf).dock_home,
    get(conf).dock_trash,
    get(conf).dock_icon_size,
    get(conf).dock_margin
])

// ─── Cascade animation ────────────────────────────────────────────────────────

// Delay between each icon in the left-to-right cascade on shell launch.
const STAGGER_MS = 40

const dockBarRoots = new Set<Gtk.Widget>()

export function cascadeDockIcons(scope?: Gtk.Widget) {
    const roots = scope ? [scope] : [...dockBarRoots]

    for (const dockBarRoot of roots) {
        const icons: Gtk.Widget[] = []

        const walk = (widget: Gtk.Widget) => {
            if (!widget.get_visible()) return
            if (widget.has_css_class("app-icon-container")) {
                icons.push(widget)
                return
            }
            let child = (widget as any).get_first_child?.()
            while (child) {
                walk(child)
                child = child.get_next_sibling?.()
            }
        }
        walk(dockBarRoot)
        if (icons.length === 0) continue

        icons.forEach(w => w.remove_css_class("fade-in"))
        icons.forEach((w, i) => {
            setTimeout(() => w.add_css_class("fade-in"), i * STAGGER_MS)
        })
    }
}

// ─── Dock ─────────────────────────────────────────────────────────────────────

export default function Dock({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const [dockTrigger, setDockTrigger] = createState(false)
    const [dockHovered, setDockHovered] = createState(false)
    const [menuOpen, setMenuOpen] = createState(false)
    let hideTimeout: number | null = null
    let leaveTimeout: number | null = null

    const showDock = createComputed(get => {
        const config = get(conf)
        if (get(list).length + get(unpinnedList).length == 0)
            return false

        const mode = config.dock
        const trigger = get(dockTrigger)
        const hovered = get(dockHovered)
        const hasMenu = get(menuOpen)

        if (mode == "disabled") return false
        if (mode != "auto-hide") return true
        if (trigger || hovered || hasMenu) return true

        get(activeWorkspace)

        const activeId = hyprland.get_monitors()
            .find(m => m.name === gdkmonitor.get_connector())
            ?.activeWorkspace?.id

        const hastiledWindow = get(clients).some(client =>
            client.workspace.id === activeId
        )

        return !hastiledWindow
    })

    return [(
        <window
            css={conf.as(conf =>
                `
                --primary: ${conf.primary_color};
                --dock-margin: ${conf.dock_margin}px;
                --jumptime: ${JUMP_ANIMATION_CLASS_TIMEOUT}ms;
                `
            )}
            name="ags-dock"
            class={conf.as(conf => `Dock theme-${conf.theme}`)}
            gdkmonitor={gdkmonitor}
            visible={true}
            exclusivity={conf.as(conf =>
                conf.dock == "auto-hide" ? Astal.Exclusivity.NORMAL : Astal.Exclusivity.EXCLUSIVE
            )}
            anchor={Astal.WindowAnchor.BOTTOM}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                onCleanup(() => self.destroy())

                const motionController = new Gtk.EventControllerMotion()
                motionController.connect("enter", () => {
                    if (leaveTimeout) { clearTimeout(leaveTimeout); leaveTimeout = null }
                    setDockHovered(true)
                })
                motionController.connect("leave", () => {
                    leaveTimeout = setTimeout(() => {
                        setDockHovered(false)
                        leaveTimeout = null
                    }, DOCK_HIDE_TIMEOUT)
                })
                self.add_controller(motionController)

                const dragMotion = new Gtk.DropControllerMotion()
                dragMotion.connect("enter", () => {
                    if (leaveTimeout) { clearTimeout(leaveTimeout); leaveTimeout = null }
                    setDockHovered(true)
                })
                dragMotion.connect("leave", () => {
                    leaveTimeout = setTimeout(() => {
                        setDockHovered(false)
                        leaveTimeout = null
                    }, DOCK_HIDE_TIMEOUT)
                })
                self.add_controller(dragMotion)

                showDock.subscribe(() => {
                    const surface = self.get_surface()
                    if (!surface) return
                    if (showDock()) {
                        surface.set_input_region(null)
                    } else {
                        surface.set_input_region(new Cairo.Region())
                    }
                })

                lengths()
                lengths.subscribe(() => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        self.set_default_size(-1, -1)
                        self.queue_resize()
                        return GLib.SOURCE_REMOVE
                    })
                })
            }}
        >
            <DockBar setMenuOpen={setMenuOpen} showDock={showDock} />
        </window>
    ), <EdgeSensor gdkmonitor={gdkmonitor} hideTimeout={hideTimeout} setDockTrigger={setDockTrigger} />]
}

// ─── EdgeSensor ───────────────────────────────────────────────────────────────

function EdgeSensor({ gdkmonitor, hideTimeout, setDockTrigger }: { gdkmonitor: Gdk.Monitor }) {
    return (
        <window
            name="ags-dock-sensor"
            class="edge-sensor-bottom"
            gdkmonitor={gdkmonitor}
            anchor={Astal.WindowAnchor.LEFT | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.RIGHT}
            exclusivity={Astal.Exclusivity.NORMAL}
            layer={Astal.Layer.TOP}
            application={app}
            visible={conf.as(conf => conf.dock == "auto-hide")}
            $={(self) => {
                onCleanup(() => self.destroy())
                const motionController = new Gtk.EventControllerMotion()
                motionController.connect("enter", () => {
                    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null }
                    setDockTrigger(true)
                    hideTimeout = setTimeout(() => {
                        setDockTrigger(false)
                        hideTimeout = null
                    }, DOCK_HIDE_TIMEOUT_EDGE)
                })
                self.add_controller(motionController)

                const dragMotion = new Gtk.DropControllerMotion()
                dragMotion.connect("enter", () => {
                    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null }
                    setDockTrigger(true)
                    hideTimeout = setTimeout(() => {
                        setDockTrigger(false)
                        hideTimeout = null
                    }, DOCK_HIDE_TIMEOUT_EDGE)
                })
                self.add_controller(dragMotion)
            }}
        >
            <box css="min-height: 1px;" />
        </window>
    )
}

// ─── DockBar ──────────────────────────────────────────────────────────────────

function DockBar({ setMenuOpen, showDock }: {
    setMenuOpen: (v: boolean) => void,
    showDock: ReturnType<typeof createComputed<boolean>>
}) {
    const pinnedBinding = createComputed(get => get(list))
    const unpinnedBinding = createComputed(get => get(unpinnedList))

    let prevPinnedSnapshot = new Set(list())
    pinnedBinding.subscribe(() => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            prevPinnedSnapshot = new Set(list())
            return GLib.SOURCE_REMOVE
        })
    })

    return (
        <box
            class={createComputed(get => `dock-bar${get(showDock) ? "" : " slide-out"}`)}
            halign={Gtk.Align.CENTER}
            $={(self: Gtk.Widget) => {
                dockBarRoots.add(self)
                onCleanup(() => dockBarRoots.delete(self))
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    cascadeDockIcons(self)
                    return GLib.SOURCE_REMOVE
                })
            }}
        >
            <box $type="center" class="dock-box" orientation={Gtk.Orientation.HORIZONTAL}>
                <box>
                    <KeyedList
                        each={pinnedBinding}
                        keyFn={(entry) => entry}
                        children={(entry) => <AppIcon entry={entry} setMenuOpen={setMenuOpen} />}
                    />
                </box>
                <box
                    vexpand={true}
                    class="dock-spacer"
                    visible={createComputed(get =>
                        get(list).length > 0 && get(unpinnedList).length > 0
                    )}
                />
                <box>
                    <KeyedList
                        each={unpinnedBinding}
                        keyFn={(entry) => entry}
                        enterClass="fade-in"
                        shouldEnter={(entry) => !prevPinnedSnapshot.has(entry)}
                        children={(entry) => <AppIcon entry={entry} setMenuOpen={setMenuOpen} />}
                    />
                </box>
                <box
                    vexpand={true}
                    class="dock-spacer"
                    visible={createComputed(get =>
                        (get(list).length > 0 || get(unpinnedList).length > 0) &&
                        (get(conf).dock_home == true || get(conf).dock_trash == true)
                    )}
                />
                <HomeFolderButton setMenuOpen={setMenuOpen} />
                <TrashButton setMenuOpen={setMenuOpen} />
            </box>
        </box>
    )
}