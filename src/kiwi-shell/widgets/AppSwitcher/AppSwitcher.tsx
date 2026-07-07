import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createEffect, For, createBinding } from "ags"
import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import { conf } from "../config"
import { playSound } from "../sound"
import { captureWindowToTexture } from "./clientCachingService"
import { isValidClient, isMinimized, restoreClient } from "../Dock/dock-state"
import { entryForClient, AppIconImage } from "../appIcon"

export const [isVisible, setVisibility] = createState(false)
export const [selectedAddress, setSelectedAddress] = createState<string | null>(null)
export const [displayedClients, setDisplayedClients] = createState<any[]>([])

const hyprland = Hyprland.get_default()

// ─── MRU tracking ─────────────────────────────────────────────────────────────
let mruAddresses: string[] = []

hyprland.connect("notify::focused-client", () => {
    const client = hyprland.get_focused_client()
    if (client && isValidClient(client)) {
        const addr = client.get_address()
        mruAddresses = [addr, ...mruAddresses.filter(a => a !== addr)]
        if (mruAddresses.length > 50) mruAddresses.length = 50
    }
})

// ─── Alt+Tab keybinds ─────────────────────────────────────────────────────────
// Registers the whole alt-tab submap dynamically so users get working binds
// out of the box (docs/AppSwitcherKeybinds.md stays the manual route). If a
// foreign ALT+TAB or ALT+ALT_L bind exists in the root submap — the user's
// own alt-tab — we leave the keyboard alone. Kiwictl-flavored binds (from a
// manual setup per our docs, or a previous shell run) are unbound and
// re-registered, so fixes to the scheme reach existing setups. Dynamic
// keywords are wiped on config reload, so this re-runs on config-reloaded.
//
// The ALT_L release binds MUST live in the root submap: Hyprland matches a
// bind against the submap that was active when the key was PRESSED
// (submapAtPress), and Alt goes down before the submap is entered. The
// shell-side isVisible guard makes the confirm exec a no-op for all the
// ordinary Alt releases this fires on.

const ALT_MODMASK = 8

async function registerAltTabBinds() {
    try {
        const binds = JSON.parse(await execAsync(["hyprctl", "binds", "-j"]))
        const ours = (b: any) =>
            (b.dispatcher === "exec" && b.arg.includes("kiwictl apps")) ||
            (b.dispatcher === "submap" && (b.arg === "app_switcher" || b.arg === "reset"))
        const foreign = binds.some((b: any) =>
            (b.key === "TAB" || b.key === "ALT_L") &&
            b.modmask === ALT_MODMASK && b.submap === "" && !ours(b))
        if (foreign) return
    } catch (e) {
        console.error("AppSwitcher: failed to query binds, skipping alt-tab setup:", e)
        return
    }

    // one --batch call: the submap keyword is stateful (it brackets which
    // submap the following binds land in), so order must be guaranteed
    execAsync(["hyprctl", "--batch", [
        // clear any previous incarnation of the scheme first
        "keyword unbind ALT, TAB",
        "keyword unbind ALT, ALT_L",
        "keyword submap app_switcher",
        "keyword unbind ALT, TAB",
        "keyword unbind ALT, ALT_L",
        "keyword unbind , escape",
        "keyword unbind ALT, escape",
        "keyword submap reset",
        // root: entry, and the Alt-release confirm (see comment above)
        "keyword bind ALT, TAB, exec, kiwictl apps open-next",
        "keyword bind ALT, TAB, submap, app_switcher",
        "keyword bindrt ALT, ALT_L, exec, kiwictl apps confirm",
        "keyword bindrt ALT, ALT_L, submap, reset",
        // submap: cycling while held, escape failsafes
        "keyword submap app_switcher",
        "keyword binde ALT, TAB, exec, kiwictl apps open-next",
        "keyword bindr , escape, exec, kiwictl apps close",
        "keyword bindr , escape, submap, reset",
        "keyword bindr ALT, escape, exec, kiwictl apps close",
        "keyword bindr ALT, escape, submap, reset",
        "keyword submap reset",
    ].join(" ; ")]).catch(e =>
        console.error("AppSwitcher: failed to register alt-tab binds:", e))
}

registerAltTabBinds()
hyprland.connect("config-reloaded", registerAltTabBinds)

// ─── Public API ───────────────────────────────────────────────────────────────
export function toggleAppSwitcher(cmd: string) {
    switch (cmd) {
        case "open":
            showAppSwitcher()
            break
        case "open-next":
            if (!isVisible()) showAppSwitcher()
            selectNextClient()
            break
        case "close":
            hideAppSwitcher()
            break
        case "toggle":
            if (isVisible()) hideAppSwitcher()
            else showAppSwitcher()
            break
        case "next":
            selectNextClient()
            break
        case "previous":
            selectPreviousClient()
            break
        case "confirm":
            executeSelectedAndClose()
            break
    }
}

function showAppSwitcher() {
    const clients = hyprland.get_clients().filter(isValidClient)

    const sortedClients = [...clients].sort((a, b) => {
        const posA = mruAddresses.indexOf(a.get_address())
        const posB = mruAddresses.indexOf(b.get_address())
        return (posA === -1 ? 9999 : posA) - (posB === -1 ? 9999 : posB)
    })

    setDisplayedClients(sortedClients)
    setSelectedAddress(sortedClients.length > 0 ? sortedClients[0].get_address() : null)
    setVisibility(true)
}

function hideAppSwitcher() {
    setVisibility(false)
}

function selectNextClient() {
    if (!isVisible()) return
    const clients = displayedClients()
    if (clients.length === 0) return
    const idx = clients.findIndex(c => c.get_address() === selectedAddress())
    setSelectedAddress(clients[(idx + 1) % clients.length].get_address())
}

function selectPreviousClient() {
    if (!isVisible()) return
    const clients = displayedClients()
    if (clients.length === 0) return
    const idx = clients.findIndex(c => c.get_address() === selectedAddress())
    setSelectedAddress(clients[(idx - 1 + clients.length) % clients.length].get_address())
}

function executeSelectedAndClose() {
    // the root-submap alt-release bind fires this on every plain Alt
    // release — only act when the switcher is actually open
    if (!isVisible()) return
    const clients = displayedClients()
    const selected = clients.find(c => c.get_address() === selectedAddress())
    if (selected) {
        // focusing a minimized window would pull the special workspace into
        // view — bring the window to the current workspace instead
        if (isMinimized(selected)) restoreClient(selected)
        else selected.focus()
    }
    setVisibility(false)
}

// ─── UI ───────────────────────────────────────────────────────────────────────
export default function AppSwitcher({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    return (
        <window
            css={conf(conf => `--primary: ${conf.primary_color};`)}
            visible={isVisible}
            name="ags-app-switcher"
            class={conf.as((conf: any) => `AppSwitcher theme-${conf.theme}`)}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={Astal.WindowAnchor.CENTER | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
        >
            <Windows />
        </window>
    )
}

function Windows() {
    return (
        <centerbox class="app-switch-menu">
            <box $type="center" class="app-switch-container" spacing={4}>
                <For each={displayedClients}>
                    {(client) => <WindowPreview client={client} />}
                </For>
            </box>
        </centerbox>
    )
}

export function WindowPreview({ client }: { client: any }) {
    if (!client) return null

    const address = client.get_address()
    const [texture, setTexture] = createState<Gdk.Texture | null>(null)

    createEffect(() => {
        if (!isVisible()) return
        captureWindowToTexture(address).then(t => {
            if (t) setTexture(t)
        })
    })

    const titleBinding = createBinding(client, "title")

    const container = (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={8}
            class="window-preview"
        >
            <scrolledwindow
                hscrollbarPolicy={Gtk.PolicyType.EXTERNAL}
                vscrollbarPolicy={Gtk.PolicyType.NEVER}
            >
                <box>
                    <AppIconImage entry={entryForClient(client)} pixelSize={24} cssClass="switcher-preview-icon" />
                    <label label={titleBinding} />
                </box>
            </scrolledwindow>

            <Gtk.ScrolledWindow
                class="window-preview-container"
                overflow={Gtk.Overflow.HIDDEN}
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
                vscrollbarPolicy={Gtk.PolicyType.NEVER}
                heightRequest={220}
                propagateNaturalWidth={true}
            >
                <Gtk.Picture
                    canShrink={true}
                    contentFit={Gtk.ContentFit.CONTAIN}
                    widthRequest={-1}
                    paintable={texture}
                />
            </Gtk.ScrolledWindow>
        </box>
    ) as Gtk.Box

    createEffect(() => {
        if (selectedAddress() === address) {
            container.add_css_class("selected")
        } else {
            container.remove_css_class("selected")
        }
    })

    return container
}
