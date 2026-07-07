import { Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding, createEffect, For } from "ags"
import Pango from "gi://Pango"
import { hyprland, list, setList, saveList, isNixManaged, entryToClass, JUMP_ANIMATION_CLASS_TIMEOUT, MINIMIZED_WS, isMinimized, isClientVisible, minimizeClient, restoreClient } from "./dock-state"
import Hyprland from "gi://AstalHyprland"
import { DockContextIcon } from "./dock-utils"
import { iconForEntry, AppIconImage } from "../appIcon"
import { captureWindowToTexture } from "../AppSwitcher/clientCachingService"
import { conf } from "../config"

export function AppIcon({ entry, setMenuOpen }: { entry: string, setMenuOpen: (v: boolean) => void }) {
    const icon = iconForEntry(entry)
    const application = (() => {
        const GioUnix = imports.gi.GioUnix
        return GioUnix.DesktopAppInfo.new(entry)
    })()
    const name = application?.get_name() ?? entry.replace(/\.desktop$/, "")

    const wmClasses = [
        entryToClass.get(entry),
        application?.get_string("StartupWMClass")?.toLowerCase(),
        entry.replace(/\.desktop$/, "").toLowerCase(),
    ].filter(Boolean) as string[]

    const [pinned, setPinned] = createState(list().includes(entry))
    const [jumping, setJumping] = createState(false)

    const titleMatchRaw = application?.get_string("X-Kiwi-TitleMatch")
    const titleMatch = titleMatchRaw ? new RegExp(titleMatchRaw, "i") : null

    const clientsBinding = createComputed(get => {
        const allClients = get(createBinding(hyprland, "clients"))
        return allClients.filter(client => {
            // both properties can be null while a client is being created
            const byClass = wmClasses.includes((client["initial-class"] ?? "").toLowerCase())
            const byTitle = titleMatch?.test(client["initial-title"] ?? "") ?? false
            return byClass || byTitle
        })
    })

    const onPinChange = (newPinned: boolean) => {
        setPinned(newPinned)
        if (newPinned) {
            setList([...list(), entry])
        } else {
            setList(list().filter(e => e !== entry))
        }
        saveList()
    }

    const menu = AppContextMenu(entry, clientsBinding, application, icon, name, pinned, onPinChange, setMenuOpen)
    const previews = WindowPreviews(clientsBinding, setMenuOpen)

    return (
        <box class="app-icon-container">
            <button
                onclicked={() => {
                    const clients = clientsBinding()
                    if (clients.length === 0) {
                        setJumping(true)
                        setTimeout(() => setJumping(false), JUMP_ANIMATION_CLASS_TIMEOUT + 100)
                        application.launch([], null)
                        return
                    }
                    // several windows → window picker with previews,
                    // taskbar style
                    if (clients.length > 1) {
                        previews.popup()
                        return
                    }
                    const client = clients[0]
                    if (isClientVisible(client)) {
                        // visible → stash in the minimized scratchpad
                        minimizeClient(client)
                    } else if (isMinimized(client)) {
                        // bring it back to the current workspace
                        restoreClient(client)
                    } else {
                        // running on another (non-visible) workspace → jump to it
                        client.focus()
                    }
                }}
                $={(self) => {
                    const gesture = new Gtk.GestureClick()
                    gesture.set_button(3)
                    gesture.connect("released", () => {
                        menu.popup()
                    })
                    self.add_controller(gesture)
                }}
                class={jumping.as(isJumping => isJumping ? "app-launch-button jumping" : "app-launch-button")}
            >
                <box orientation={Gtk.Orientation.VERTICAL}>
                    {menu}
                    {previews}
                    <overlay>
                        <AppIconImage entry={entry} pixelSize={
                            conf.as(conf => conf.dock_icon_size)
                        } />
                        <box $type="overlay" class="dots-container" orientation={Gtk.Orientation.VERTICAL}>
                            <box vexpand={true}></box>
                            <box class="client-dots" halign={Gtk.Align.CENTER} spacing={3}>
                                <For each={clientsBinding}>
                                    {(client) => <ActiveClientDot client={client} />}
                                </For>
                            </box>
                        </box>
                    </overlay>
                </box>
            </button>
        </box>
    )
}

// Windows-taskbar-style window picker: one live thumbnail per window of the
// app, click to focus (or restore, if minimized), ✕ to close.
function WindowPreviews(
    clientsBinding: ReturnType<typeof createComputed<Hyprland.Client[]>>,
    setMenuOpen: (v: boolean) => void,
) {
    let popover: Gtk.Popover
    const [open, setOpen] = createState(false)

    return (
        <popover
            autohide={true}
            hasArrow={false}
            class="dock-previews"
            $={(self) => {
                popover = self
                self.connect("notify::visible", () => {
                    setOpen(self.visible)
                    setMenuOpen(self.visible)
                })
                // closing the last window from the picker leaves nothing
                // to show — dismiss instead of floating an empty pill
                createEffect(() => {
                    if (clientsBinding().length === 0 && popover.visible)
                        popover.popdown()
                })
            }}
        >
            <box spacing={4}>
                <For each={clientsBinding}>
                    {(client) => (
                        <WindowPreviewItem
                            client={client}
                            pickerOpen={open}
                            popdown={() => popover.popdown()}
                        />
                    )}
                </For>
            </box>
        </popover>
    ) as Gtk.Popover
}

function WindowPreviewItem({ client, pickerOpen, popdown }: {
    client: Hyprland.Client,
    pickerOpen: ReturnType<typeof createState<boolean>>[0],
    popdown: () => void,
}) {
    const address = client.get_address()
    const [texture, setTexture] = createState<Gdk.Texture | null>(null)
    const title = createBinding(client, "title")
    const workspace = createBinding(client, "workspace")

    createEffect(() => {
        if (!pickerOpen()) return
        captureWindowToTexture(address).then(t => {
            if (t) setTexture(t)
        })
    })

    return (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            class={workspace.as(ws =>
                ws?.name === MINIMIZED_WS ? "dock-preview-item minimized" : "dock-preview-item"
            )}
            $={(self) => {
                // a plain gesture instead of a button: the close button is
                // nested inside, and its clicks must not activate the window
                const click = new Gtk.GestureClick()
                click.set_button(1)
                click.connect("released", (_gesture, _nPress, x, y) => {
                    const target = self.pick(x, y, Gtk.PickFlags.DEFAULT)
                    for (let w: Gtk.Widget | null = target; w && w !== self; w = w.get_parent()) {
                        if (w instanceof Gtk.Button) return
                    }
                    popdown()
                    if (isMinimized(client)) restoreClient(client)
                    else client.focus()
                })
                self.add_controller(click)
            }}
        >
            <box class="dock-preview-header" spacing={6}>
                <label
                    class="dock-preview-title"
                    label={title}
                    ellipsize={Pango.EllipsizeMode.END}
                    maxWidthChars={1}
                    hexpand
                    xalign={0}
                />
                <button
                    class="dock-preview-close"
                    onclicked={() => client.kill()}
                >
                    <Gtk.Image iconName="window-close-symbolic" pixelSize={10} />
                </button>
            </box>
            {/* fixed-size scroll-less viewport: a Picture's natural size is
                the full screenshot, so it must sit in a scrollable to be
                capped at thumbnail size. Unlike the app switcher there is no
                fullscreen window constraining the cards, so the width must be
                fixed too — natural width would blow up to the screenshot's */}
            <Gtk.ScrolledWindow
                class="dock-preview-shot"
                overflow={Gtk.Overflow.HIDDEN}
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
                vscrollbarPolicy={Gtk.PolicyType.NEVER}
                widthRequest={192}
                heightRequest={112}
            >
                <Gtk.Picture
                    canShrink={true}
                    contentFit={Gtk.ContentFit.CONTAIN}
                    widthRequest={-1}
                    paintable={texture}
                />
            </Gtk.ScrolledWindow>
        </box>
    )
}

function ActiveClientDot({ client }: { client: Hyprland.Client }) {
    const workspace = createBinding(client, "workspace")
    return (
        <box class={workspace.as(ws =>
            ws?.name === MINIMIZED_WS ? "active-client-dot minimized" : "active-client-dot"
        )} />
    )
}

function AppContextMenu(entry, clientsBinding, application, icon, name, pinned, onPinChange, setMenuOpen) {
    let popover: Gtk.Popover

    return (
        <popover
            autohide={true}
            hasArrow={false}
            class="app-context-menu"
            $={(self) => {
                popover = self
                self.connect("notify::visible", () => {
                    setMenuOpen(self.visible)
                })
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
                <button
                    onclicked={() => {
                        popover.popdown()
                        application.launch([], null)
                    }}
                >
                    <box>
                        <DockContextIcon icon={icon} />
                        <label halign={Gtk.Align.START} label={name} />
                    </box>
                </button>

                <button
                    visible={pinned.as(p => p === true && !isNixManaged)}
                    onclicked={() => {
                        popover.popdown()
                        onPinChange(false)
                    }}
                >
                    <box>
                        <DockContextIcon icon="unpin-symbolic" />
                        <label halign={Gtk.Align.START} label="Unpin from Dock" />
                    </box>
                </button>

                <button
                    visible={pinned.as(p => p === false && !isNixManaged)}
                    onclicked={() => {
                        popover.popdown()
                        onPinChange(true)
                    }}
                >
                    <box>
                        <DockContextIcon icon="pin-symbolic" />
                        <label halign={Gtk.Align.START} label="Pin to Dock" />
                    </box>
                </button>

                <button
                    onclicked={() => {
                        popover.popdown()
                        for (const client of clientsBinding()) {
                            client.kill()
                        }
                    }}
                    visible={clientsBinding.as(clients => clients.length > 0)}
                >
                    <box>
                        <DockContextIcon icon="window-close-symbolic" />
                        <label halign={Gtk.Align.START} label="Close Window" />
                    </box>
                </button>
            </box>
        </popover>
    )
}