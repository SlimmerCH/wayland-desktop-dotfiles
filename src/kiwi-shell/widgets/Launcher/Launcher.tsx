import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, For, Accessor } from "ags"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import Apps from "gi://AstalApps"
import Hyprland from "gi://AstalHyprland"
import { conf } from "../config"
import { mapVersion } from "../desktopEntries"
import { popupGdkMonitor } from "../monitors"

// Spotlight-style launcher: a centered glass search panel on Super+Space.
// Type to fuzzy-search applications, arrows/Tab to select, Enter to launch,
// Escape or a click on the backdrop to dismiss.

const hyprland = Hyprland.get_default()
const apps = new Apps.Apps()

// desktopEntries already watches the application dirs — piggyback on it to
// keep the search index fresh
mapVersion.subscribe(() => apps.reload())

const MAX_RESULTS = 7

export const [isVisible, setVisibility] = createState(false)
const [query, setQuery] = createState("")
const [selectedIdx, setSelectedIdx] = createState(0)

const results = createComputed(get => {
    const text = get(query).trim()
    if (!text) return [] as Apps.Application[]
    return apps.fuzzy_query(text).slice(0, MAX_RESULTS)
})

// ─── Super+Space keybind ──────────────────────────────────────────────────────
// Same scheme as the alt-tab/super-tab registration: bind dynamically so the
// launcher works out of the box, but leave the keyboard alone if the user's
// config already binds SUPER+space to something else. Dynamic keywords are
// wiped on config reload, so this re-runs on config-reloaded.

const SUPER_MODMASK = 64

async function registerLauncherBind() {
    try {
        const binds = JSON.parse(await execAsync(["hyprctl", "binds", "-j"]))
        const ours = (b: any) =>
            b.dispatcher === "exec" && b.arg.includes("kiwictl launcher")
        const foreign = binds.some((b: any) =>
            b.key.toLowerCase() === "space" &&
            b.modmask === SUPER_MODMASK && b.submap === "" && !ours(b))
        if (foreign) return
    } catch (e) {
        console.error("Launcher: failed to query binds, skipping setup:", e)
        return
    }

    execAsync(["hyprctl", "--batch", [
        "keyword unbind SUPER, space",
        "keyword bind SUPER, space, exec, kiwictl launcher toggle",
    ].join(" ; ")]).catch(e =>
        console.error("Launcher: failed to register bind:", e))
}

registerLauncherBind()
hyprland.connect("config-reloaded", registerLauncherBind)

// ─── Public API ───────────────────────────────────────────────────────────────
export function toggleLauncher(cmd: string) {
    switch (cmd) {
        case "open":
            showLauncher()
            break
        case "close":
            hideLauncher()
            break
        case "toggle":
        default:
            if (isVisible()) hideLauncher()
            else showLauncher()
    }
}

let entryRef: Gtk.Entry | null = null

function showLauncher() {
    setSelectedIdx(0)
    setQuery("")
    entryRef?.set_text("")
    setVisibility(true)
    // the entry can only take focus once the surface is mapped
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        entryRef?.grab_focus()
        return GLib.SOURCE_REMOVE
    })
}

function hideLauncher() {
    setVisibility(false)
}

function moveSelection(step: number) {
    const count = results().length
    if (count === 0) return
    setSelectedIdx(((selectedIdx() + step) % count + count) % count)
}

function launchSelected() {
    const list = results()
    const target = list[Math.min(selectedIdx(), list.length - 1)]
    if (!target) return
    hideLauncher()
    target.launch()
}

// ─── UI ───────────────────────────────────────────────────────────────────────
function ResultRow({ application, index }: {
    application: Apps.Application
    index: Accessor<number>
}) {
    const rowClass = createComputed(get =>
        get(selectedIdx) === get(index) ? "launcher-row selected" : "launcher-row")
    const description = application.get_description()

    return (
        <box
            class={rowClass}
            spacing={12}
            $={(self) => {
                const click = new Gtk.GestureClick()
                click.connect("released", () => {
                    hideLauncher()
                    application.launch()
                })
                self.add_controller(click)
            }}
        >
            <Gtk.Image
                iconName={application.get_icon_name() || "application-x-executable"}
                pixelSize={30}
                class="launcher-row-icon"
            />
            <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                <label
                    class="launcher-row-name"
                    label={application.get_name()}
                    ellipsize={Pango.EllipsizeMode.END}
                    maxWidthChars={1}
                    hexpand
                    xalign={0}
                />
                {description && (
                    <label
                        class="launcher-row-desc"
                        label={description}
                        ellipsize={Pango.EllipsizeMode.END}
                        maxWidthChars={1}
                        hexpand
                        xalign={0}
                    />
                )}
            </box>
        </box>
    )
}

export default function Launcher({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    // spotlight sits in the upper part of the screen, top edge fixed so the
    // panel only ever grows downwards while results appear
    const marginTop = createComputed(get =>
        Math.round((get(popupGdkMonitor) ?? gdkmonitor).get_geometry().height * 0.22))
    let panelRef: Gtk.Box

    return (
        <window
            css={conf.as((conf: any) => `--primary: ${conf.primary_color};`)}
            visible={isVisible}
            name="ags-launcher"
            class={conf.as((conf: any) => `Launcher theme-${conf.theme}`)}
            gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.EXCLUSIVE}
            $={(self) => {
                const keys = new Gtk.EventControllerKey()
                keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
                keys.connect("key-pressed", (_controller, keyval) => {
                    if (keyval === Gdk.KEY_Escape) {
                        hideLauncher()
                        return Gdk.EVENT_STOP
                    }
                    if (keyval === Gdk.KEY_Down || keyval === Gdk.KEY_Tab) {
                        moveSelection(1)
                        return Gdk.EVENT_STOP
                    }
                    if (keyval === Gdk.KEY_Up || keyval === Gdk.KEY_ISO_Left_Tab) {
                        moveSelection(-1)
                        return Gdk.EVENT_STOP
                    }
                    return Gdk.EVENT_PROPAGATE
                })
                self.add_controller(keys)
            }}
        >
            <box
                class="launcher-backdrop"
                orientation={Gtk.Orientation.VERTICAL}
                $={(self) => {
                    // click anywhere outside the panel dismisses
                    const click = new Gtk.GestureClick()
                    click.connect("pressed", (_gesture, _n, x, y) => {
                        const target = self.pick(x, y, Gtk.PickFlags.DEFAULT)
                        for (let w: Gtk.Widget | null = target; w; w = w.get_parent()) {
                            if (w === panelRef) return
                        }
                        hideLauncher()
                    })
                    self.add_controller(click)
                }}
            >
                <box
                    class="launcher-panel"
                    orientation={Gtk.Orientation.VERTICAL}
                    halign={Gtk.Align.CENTER}
                    valign={Gtk.Align.START}
                    marginTop={marginTop}
                    widthRequest={620}
                    $={(self) => { panelRef = self }}
                >
                    <box class="launcher-search-row" spacing={10}>
                        <Gtk.Image
                            iconName="system-search-symbolic"
                            pixelSize={20}
                            class="launcher-search-icon"
                        />
                        <entry
                            class="launcher-entry"
                            hexpand
                            placeholderText="Search"
                            onChanged={(self) => {
                                setSelectedIdx(0)
                                setQuery(self.text)
                            }}
                            onActivate={() => launchSelected()}
                            $={(self) => { entryRef = self }}
                        />
                    </box>
                    <box
                        class="launcher-results"
                        orientation={Gtk.Orientation.VERTICAL}
                        visible={results.as(r => r.length > 0)}
                    >
                        <For each={results}>
                            {(application: Apps.Application, index: Accessor<number>) => (
                                <ResultRow application={application} index={index} />
                            )}
                        </For>
                    </box>
                </box>
            </box>
        </window>
    )
}
