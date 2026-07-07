import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createEffect, For } from "ags"
import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import { isValidClient } from "../Dock/dock-state"
import { entryForClient, AppIconImage } from "../appIcon"
import { conf } from "../config"

const hyprland = Hyprland.get_default()

const CARD_HEIGHT = 140

export const [isVisible, setVisibility] = createState(false)
const [selectedId, setSelectedId] = createState(1)
const [displayedIds, setDisplayedIds] = createState<number[]>([])
// per-workspace client snapshot, taken when the switcher opens
const [wsClients, setWsClients] = createState<Map<number, Hyprland.Client[]>>(new Map())

// ─── Super+Tab keybind ────────────────────────────────────────────────────────
// Only the cycle bind lives in the compositor. Confirm (release Super) and
// abort (Escape) are detected shell-side through the keyboard grab the
// switcher holds while open — a SUPER_L release bind would collide with
// launcher-on-super-tap setups (and with the submap-at-press-time rules).

const SUPER_MODMASK = 64

async function registerSuperTabBinds() {
    try {
        const binds = JSON.parse(await execAsync(["hyprctl", "binds", "-j"]))
        const ours = (b: any) =>
            b.dispatcher === "exec" && b.arg.includes("kiwictl workspaces")
        const foreign = binds.some((b: any) =>
            b.key === "TAB" && b.submap === "" && !ours(b) &&
            (b.modmask === SUPER_MODMASK || b.modmask === (SUPER_MODMASK | 1)))
        if (foreign) return
    } catch (e) {
        console.error("WorkspaceSwitcher: failed to query binds, skipping setup:", e)
        return
    }

    execAsync(["hyprctl", "--batch", [
        "keyword unbind SUPER, TAB",
        "keyword unbind SUPER SHIFT, TAB",
        "keyword binde SUPER, TAB, exec, kiwictl workspaces open-next",
        "keyword binde SUPER SHIFT, TAB, exec, kiwictl workspaces previous",
    ].join(" ; ")]).catch(e =>
        console.error("WorkspaceSwitcher: failed to register binds:", e))
}

registerSuperTabBinds()
hyprland.connect("config-reloaded", registerSuperTabBinds)

// ─── Public API ───────────────────────────────────────────────────────────────
export function toggleWorkspaceSwitcher(cmd: string) {
    switch (cmd) {
        case "open":
            showSwitcher()
            break
        case "open-next":
            if (!isVisible()) showSwitcher()
            cycle(1)
            break
        case "close":
            setVisibility(false)
            break
        case "toggle":
            if (isVisible()) setVisibility(false)
            else showSwitcher()
            break
        case "next":
            cycle(1)
            break
        case "previous":
            if (!isVisible()) showSwitcher()
            cycle(-1)
            break
        case "confirm":
            confirmAndClose()
            break
    }
}

function showSwitcher() {
    const byWs = new Map<number, Hyprland.Client[]>()
    for (const client of hyprland.get_clients()) {
        if (!isValidClient(client)) continue
        const id = client.get_workspace()?.get_id() ?? 0
        if (id <= 0) continue
        byWs.set(id, [...(byWs.get(id) ?? []), client])
    }
    const last = Math.max(0, ...byWs.keys())
    const current = hyprland.focusedWorkspace?.id ?? 1
    // the first workspace through the empty one just after the last
    // occupied one, so there is always a fresh workspace to jump to
    const count = Math.max(last + 1, current)
    setWsClients(byWs)
    setDisplayedIds(Array.from({ length: count }, (_, i) => i + 1))
    setSelectedId(current)
    setVisibility(true)
}

function cycle(dir: 1 | -1) {
    if (!isVisible()) return
    const ids = displayedIds()
    if (ids.length === 0) return
    const idx = ids.indexOf(selectedId())
    setSelectedId(ids[(idx + dir + ids.length) % ids.length])
}

function confirmAndClose() {
    if (!isVisible()) return
    hyprland.dispatch("workspace", `${selectedId()}`)
    setVisibility(false)
}

// ─── UI ───────────────────────────────────────────────────────────────────────
export default function WorkspaceSwitcher({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    return (
        <window
            css={conf(conf => `--primary: ${conf.primary_color};`)}
            visible={isVisible}
            name="ags-workspace-switcher"
            class={conf.as((conf: any) => `WorkspaceSwitcher theme-${conf.theme}`)}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={Astal.WindowAnchor.CENTER | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
            keymode={isVisible.as(v => v ? Astal.Keymode.EXCLUSIVE : Astal.Keymode.NONE)}
            $={(self) => {
                // Confirm on Super release, as observed by the keyboard
                // grab. GDK's cached modifier state is stale until our
                // surface has held keyboard focus at least once, so only
                // trust state that arrives through events: the focus-enter
                // snapshot (fresh from the wayland enter) and modifier
                // changes seen while focused. sawSuper gates the release so
                // a stale all-clear can never confirm mid-hold.
                let sawSuper = false

                const keys = new Gtk.EventControllerKey()
                keys.connect("key-pressed", (_ctrl, keyval) => {
                    if (keyval === Gdk.KEY_Escape) {
                        setVisibility(false)
                        return true
                    }
                    return false
                })
                keys.connect("modifiers", (_ctrl, state: number) => {
                    if (!isVisible()) return
                    if (state & Gdk.ModifierType.SUPER_MASK) {
                        sawSuper = true
                    } else if (sawSuper) {
                        confirmAndClose()
                    }
                })
                self.add_controller(keys)

                const focus = new Gtk.EventControllerFocus()
                focus.connect("enter", () => {
                    if (!isVisible()) return
                    const kb = self.get_display().get_default_seat()?.get_keyboard()
                    if (!kb) return
                    if (kb.modifier_state & Gdk.ModifierType.SUPER_MASK) {
                        sawSuper = true
                    } else {
                        // Super was gone before the grab landed (fast tap)
                        confirmAndClose()
                    }
                })
                self.add_controller(focus)

                isVisible.subscribe(() => {
                    if (!isVisible()) return
                    sawSuper = false
                    // backstop: keyboard focus never arrived, so a release
                    // can never be observed — treat it as a fast tap
                    setTimeout(() => {
                        if (isVisible() && !sawSuper) confirmAndClose()
                    }, 600)
                })
            }}
        >
            <centerbox class="ws-switch-menu">
                <box
                    $type="center"
                    class="app-switch-container"
                    spacing={8}
                    halign={Gtk.Align.CENTER}
                >
                    <For each={displayedIds}>
                        {(id) => <WorkspaceCard id={id} gdkmonitor={gdkmonitor} />}
                    </For>
                </box>
            </centerbox>
        </window>
    )
}

// A capture-free workspace preview: a miniature of the workspace's window
// layout, built from live client geometry, one rounded rect + app icon per
// window.
function WorkspaceCard({ id, gdkmonitor }: { id: number, gdkmonitor: Gdk.Monitor }) {
    const geo = gdkmonitor.get_geometry()
    const width = Math.round(CARD_HEIGHT * geo.width / geo.height)
    const [entries, setEntries] = createState<string[]>([])
    const [empty, setEmpty] = createState(true)

    const container = (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={0}
            class="window-preview"
        >
            <box class="preview-title-bar" spacing={5}>
                <label class="ws-number" label={`${id}`} xalign={0} />
                <For each={entries}>
                    {(entry) => <AppIconImage entry={entry} pixelSize={13} cssClass="ws-app-icon" />}
                </For>
            </box>
            <overlay>
                <Gtk.Fixed
                    class="ws-canvas"
                    widthRequest={width}
                    heightRequest={CARD_HEIGHT}
                    $={(self: Gtk.Fixed) => {
                        createEffect(() => {
                            if (!isVisible()) return
                            const clients = wsClients().get(id) ?? []
                            setEntries([...new Set(clients.map(entryForClient))])
                            setEmpty(clients.length === 0)

                            let child = self.get_first_child()
                            while (child) {
                                const next = child.get_next_sibling()
                                self.remove(child)
                                child = next
                            }
                            for (const c of clients) {
                                const w = Math.max(6, Math.round(c.get_width() * width / geo.width))
                                const h = Math.max(6, Math.round(c.get_height() * CARD_HEIGHT / geo.height))
                                const icon = Math.max(8, Math.min(20, Math.round(Math.min(w, h) * 0.55)))
                                self.put(
                                    (
                                        <overlay>
                                            <box class="ws-mini-window" widthRequest={w} heightRequest={h} />
                                            <box
                                                $type="overlay"
                                                halign={Gtk.Align.CENTER}
                                                valign={Gtk.Align.CENTER}
                                            >
                                                <AppIconImage
                                                    entry={entryForClient(c)}
                                                    pixelSize={icon}
                                                    cssClass="ws-mini-icon"
                                                />
                                            </box>
                                        </overlay>
                                    ) as Gtk.Widget,
                                    Math.round(c.get_x() * width / geo.width),
                                    Math.round(c.get_y() * CARD_HEIGHT / geo.height),
                                )
                            }
                        })
                    }}
                />
                <label
                    $type="overlay"
                    class="ws-plus"
                    label="＋"
                    visible={empty}
                    halign={Gtk.Align.CENTER}
                    valign={Gtk.Align.CENTER}
                />
            </overlay>
        </box>
    ) as Gtk.Box

    createEffect(() => {
        if (selectedId() === id && isVisible()) {
            container.add_css_class("selected")
        } else {
            container.remove_css_class("selected")
        }
    })

    return container
}
