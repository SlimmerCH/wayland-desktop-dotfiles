import app from "ags/gtk4/app"
import App from "ags/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding, onCleanup } from "ags"
import { conf } from "../config"
import { hyprland, list, unpinnedList, DOCK_HIDE_TIMEOUT, DOCK_HIDE_TIMEOUT_EDGE, JUMP_ANIMATION_CLASS_TIMEOUT, DOCK_SLIDE_DURATION } from "./dock-state"
import { AppIcon } from "./AppIcon"
import { HomeFolderButton, TrashButton } from "./DockButtons"
import { KeyedList } from "./KeyedList"
import { playSound } from "../sound"
import Cairo from "gi://cairo"
import GLib from "gi://GLib"
import Gio from "gi://Gio"

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

// ─── Arpeggio folder ──────────────────────────────────────────────────────────

const ROOT = typeof SRC !== "undefined" ? SRC : App.configDir

function pickRandomArpeggio(): string {
    try {
        const dir = Gio.File.new_for_path(`${ROOT}/assets/arpeggios`)
        const enumerator = dir.enumerate_children(
            "standard::name,standard::type",
            Gio.FileQueryInfoFlags.NONE,
            null
        )
        const folders: string[] = []
        let info: Gio.FileInfo | null
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                folders.push(info.get_name())
            }
        }
        enumerator.close(null)
        if (folders.length === 0) return ""
        return folders[Math.floor(Math.random() * folders.length)]
    } catch (e) {
        console.error("Failed to pick arpeggio folder:", e)
        return ""
    }
}

const arpeggioFolder = pickRandomArpeggio()

function playArpeggio(index: number) {
    if (!arpeggioFolder) return
    playSound(`arpeggios/${arpeggioFolder}/${index}.wav`)
}

// ─── Cascade animation ────────────────────────────────────────────────────────

const STAGGER_MS = 40
const CASCADE_DELAY_MS = 100
export const ICON_ANIM_MS = 700

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

        icons.forEach(w => {
            w.remove_css_class("fade-in")
        })
        icons.forEach((w, i) => {
            const delay = i * STAGGER_MS + CASCADE_DELAY_MS
            setTimeout(() => {w.add_css_class("fade-in"); w.add_css_class("reserved")}, delay)
            // drop the one-shot animation classes once done, so later style
            // recomputations can't replay the animation on settled icons
            setTimeout(() => {
                if (!w.get_parent()) return
                w.remove_css_class("fade-in")
                w.remove_css_class("reserved")
                w.add_css_class("shown")
            }, delay + ICON_ANIM_MS)
        })
    }
}

// ─── Dock ─────────────────────────────────────────────────────────────────────

export default function Dock({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const [dockTrigger, setDockTrigger] = createState(false)
    const [dockHovered, setDockHovered] = createState(false)
    const [menuOpen, setMenuOpen] = createState(false)
    let leaveTimeout: number | null = null
    let selfRef: Astal.Window | null = null
    let dockBoxRef: Gtk.Widget | null = null
    let regionGen = 0
    let modeTransitioning = false

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

    // Sets input region to just the dock box bounds.
    const setNarrowRegion = () => {
        if (!selfRef || !dockBoxRef) return
        const surface = selfRef.get_surface()
        if (!surface) return
        const [ok, bounds] = dockBoxRef.compute_bounds(selfRef)
        if (!ok || bounds.get_width() <= 0) return
        const rect = new Cairo.RectangleInt()
        rect.x = Math.floor(bounds.get_x())
        rect.y = Math.floor(bounds.get_y())
        rect.width = Math.ceil(bounds.get_width())
        rect.height = Math.ceil(bounds.get_height())
        const region = new Cairo.Region()
        region.unionRectangle(rect)
        surface.set_input_region(region)
    }

    // Applies the region for the *current* state:
    // - hidden → empty region (full click-through)
    // - showing in auto-hide with travel → full window so cursor can travel up to dock
    // - otherwise showing → narrow region (dock box only)
    const applyRegion = (travel = false) => {
        if (!selfRef) return
        const surface = selfRef.get_surface()
        if (!surface) return
        if (!showDock()) {
            surface.set_input_region(new Cairo.Region())
        } else if (travel && conf().dock === "auto-hide") {
            surface.set_input_region(null)
        } else {
            setNarrowRegion()
        }
    }

    // Re-applies the region once the slide/reflow animation has settled. The
    // generation counter voids the pending callback whenever a newer region
    // change happens, so a stale timeout can never stamp a ghost region onto a
    // hidden dock (which used to freeze it).
    const applyRegionSettled = (delay = DOCK_SLIDE_DURATION + 50) => {
        const gen = ++regionGen
        setTimeout(() => {
            if (gen === regionGen && !modeTransitioning) applyRegion()
        }, delay)
    }

    return [(
        <window
            css={conf.as(conf =>
                `
                --primary: ${conf.primary_color};
                --dock-margin: ${conf.dock_margin}px;
                --jumptime: ${JUMP_ANIMATION_CLASS_TIMEOUT}ms;
                --icon-size: ${conf.dock_icon_size}px;
                --dock-slide-duration: ${DOCK_SLIDE_DURATION}ms;
                `
            )}
            name="ags-dock"
            class={conf.as(conf => `Dock theme-${conf.theme}`)}
            gdkmonitor={gdkmonitor}
            visible={true}
            exclusivity={conf.as(conf =>
                conf.dock === "default"
                    ? Astal.Exclusivity.EXCLUSIVE
                    : Astal.Exclusivity.NORMAL
            )}
            anchor={Astal.WindowAnchor.LEFT | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                selfRef = self
                onCleanup(() => self.destroy())

                const motionController = new Gtk.EventControllerMotion()
                motionController.connect("motion", (_controller, x, y) => {
                    if (!dockBoxRef) return
                    const [ok, bounds] = dockBoxRef.compute_bounds(self)
                    if (!ok) return
                    const inBounds =
                        x >= bounds.get_x() && x <= bounds.get_x() + bounds.get_width() &&
                        y >= bounds.get_y() && y <= bounds.get_y() + bounds.get_height()
                    if (inBounds) {
                        if (leaveTimeout) { clearTimeout(leaveTimeout); leaveTimeout = null }
                        setDockHovered(true)
                    }
                })
                motionController.connect("leave", () => {
                    applyRegion()
                    leaveTimeout = setTimeout(() => {
                        setDockHovered(false)
                        leaveTimeout = null
                    }, DOCK_HIDE_TIMEOUT)
                })
                self.add_controller(motionController)

                const dragMotion = new Gtk.DropControllerMotion()
                dragMotion.connect("motion", (_controller, x, y) => {
                    if (!dockBoxRef) return
                    const [ok, bounds] = dockBoxRef.compute_bounds(self)
                    if (!ok) return
                    const inBounds =
                        x >= bounds.get_x() && x <= bounds.get_x() + bounds.get_width() &&
                        y >= bounds.get_y() && y <= bounds.get_y() + bounds.get_height()
                    if (inBounds) {
                        if (leaveTimeout) { clearTimeout(leaveTimeout); leaveTimeout = null }
                        setDockHovered(true)
                    }
                })
                dragMotion.connect("leave", () => {
                    applyRegion()
                    leaveTimeout = setTimeout(() => {
                        setDockHovered(false)
                        leaveTimeout = null
                    }, DOCK_HIDE_TIMEOUT)
                })
                self.add_controller(dragMotion)

                showDock.subscribe(() => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (!modeTransitioning) {
                            applyRegion(true)
                            applyRegionSettled()
                        }
                        return GLib.SOURCE_REMOVE
                    })
                })

                let prevMode = conf().dock
                conf.subscribe(() => {
                    const mode = conf().dock
                    if (mode === prevMode) return
                    prevMode = mode
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        modeTransitioning = true
                        regionGen++
                        const surface = selfRef?.get_surface()
                        if (surface) surface.set_input_region(null)
                        setTimeout(() => {
                            modeTransitioning = false
                            regionGen++
                            applyRegion()
                        }, DOCK_SLIDE_DURATION)
                        return GLib.SOURCE_REMOVE
                    })
                })

                lengths.subscribe(() => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (!modeTransitioning) {
                            applyRegion()
                            // icon add/remove reflow animations run for ~650ms
                            applyRegionSettled(700)
                        }
                        return GLib.SOURCE_REMOVE
                    })
                })
            }}
        >
            <DockBar
                setMenuOpen={setMenuOpen}
                showDock={showDock}
                onDockBoxReady={(widget) => {
                    dockBoxRef = widget
                    let signalId: number | null = widget.connect("notify::width", () => {
                        if (widget.get_width() > 0) {
                            if (signalId !== null) {
                                widget.disconnect(signalId)
                                signalId = null
                            }
                            applyRegion()
                            applyRegionSettled()
                        }
                    })
                }}
            />
        </window>
    ), <EdgeSensor gdkmonitor={gdkmonitor} setDockTrigger={setDockTrigger} />]
}

// ─── EdgeSensor ───────────────────────────────────────────────────────────────

function EdgeSensor({ gdkmonitor, setDockTrigger }: {
    gdkmonitor: Gdk.Monitor,
    setDockTrigger: (v: boolean) => void,
}) {
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
                let triggerTimeout: number | null = null

                const motionController = new Gtk.EventControllerMotion()
                motionController.connect("enter", () => {
                    if (triggerTimeout) { clearTimeout(triggerTimeout); triggerTimeout = null }
                    setDockTrigger(true)
                })
                motionController.connect("leave", () => {
                    triggerTimeout = setTimeout(() => {
                        setDockTrigger(false)
                        triggerTimeout = null
                    }, DOCK_HIDE_TIMEOUT_EDGE)
                })
                self.add_controller(motionController)

                const dragMotion = new Gtk.DropControllerMotion()
                dragMotion.connect("enter", () => {
                    if (triggerTimeout) { clearTimeout(triggerTimeout); triggerTimeout = null }
                    setDockTrigger(true)
                })
                dragMotion.connect("leave", () => {
                    triggerTimeout = setTimeout(() => {
                        setDockTrigger(false)
                        triggerTimeout = null
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

function DockBar({ setMenuOpen, showDock, onDockBoxReady }: {
    setMenuOpen: (v: boolean) => void,
    showDock: ReturnType<typeof createComputed<boolean>>,
    onDockBoxReady: (widget: Gtk.Widget) => void,
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

    const extraOffset = createComputed(get =>
        get(list).length + get(unpinnedList).length + 1
    )

    return (
        <centerbox class="dock-bar-container">
            <box
                $type="center"
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
                <box
                    $type="center"
                    class="dock-box"
                    orientation={Gtk.Orientation.HORIZONTAL}
                    $={(self: Gtk.Widget) => onDockBoxReady(self)}
                >
                    <box>
                        <KeyedList
                            each={pinnedBinding}
                            keyFn={(entry) => entry}
                            children={(entry) => {
                                const index = createComputed(get => get(list).indexOf(entry) + 1)
                                return (
                                    <AppIcon
                                        entry={entry}
                                        setMenuOpen={setMenuOpen}
                                        $={(self) => {
                                            const motion = new Gtk.EventControllerMotion()
                                            motion.connect("enter", () => conf().dock_arpeggio && playArpeggio(index()))
                                            self.add_controller(motion)
                                        }}
                                    />
                                )
                            }}
                        />
                    </box>
                    <box
                        vexpand={true}
                        class="dock-spacer"
                        /*visible={createComputed(get =>
                            get(list).length > 0 && get(unpinnedList).length > 0
                        )}*/
                       visible={false}
                    />
                    <box>
                        <KeyedList
                            each={unpinnedBinding}
                            keyFn={(entry) => entry}
                            enterClass="fade-in"
                            shouldEnter={(entry) => !prevPinnedSnapshot.has(entry)}
                            children={(entry) => {
                                const index = createComputed(get =>
                                    get(list).length + get(unpinnedList).indexOf(entry) + 1
                                )
                                return (
                                    <AppIcon
                                        entry={entry}
                                        setMenuOpen={setMenuOpen}
                                        $={(self) => {
                                            const motion = new Gtk.EventControllerMotion()
                                            motion.connect("enter", () => conf().dock_arpeggio && playArpeggio(index()))
                                            self.add_controller(motion)
                                        }}
                                    />
                                )
                            }}
                            appendOnly
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
                    <HomeFolderButton
                        setMenuOpen={setMenuOpen}
                        $={(self) => {
                            const motion = new Gtk.EventControllerMotion()
                            motion.connect("enter", () => conf().dock_arpeggio && playArpeggio(extraOffset()))
                            self.add_controller(motion)
                        }}
                    />
                    <TrashButton
                        setMenuOpen={setMenuOpen}
                        $={(self) => {
                            const motion = new Gtk.EventControllerMotion()
                            motion.connect("enter", () =>
                                conf().dock_arpeggio && playArpeggio(extraOffset() + (conf().dock_home ? 1 : 0))
                            )
                            self.add_controller(motion)
                        }}
                    />
                </box>
            </box>
        </centerbox>
    )
}