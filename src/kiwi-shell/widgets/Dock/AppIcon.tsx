import { Gtk } from "ags/gtk4"
import { createState, createComputed, createBinding, For } from "ags"
import { hyprland, list, setList, saveList, isNixManaged, entryToClass, JUMP_ANIMATION_CLASS_TIMEOUT } from "./dock-state"
import { DockContextIcon } from "./dock-utils"
import { iconForEntry, AppIconImage } from "../appIcon"

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

    const clientsBinding = createComputed(get => {
        const allClients = get(createBinding(hyprland, "clients"))
        return allClients.filter(client =>
            wmClasses.includes(client["initial-class"].toLowerCase())
        )
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

    return (
        <button
            onclicked={() => {
                const client = clientsBinding()[0]
                if (client) {
                    client.focus()
                } else {
                    setJumping(true)
                    setTimeout(() => setJumping(false), JUMP_ANIMATION_CLASS_TIMEOUT + 100)
                    application.launch([], null)
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
                <overlay>
                    <AppIconImage entry={entry} pixelSize={56} />
                    <box $type="overlay" class="dots-container" orientation={Gtk.Orientation.VERTICAL}>
                        <box vexpand={true}></box>
                        <box class="client-dots" halign={Gtk.Align.CENTER} spacing={3}>
                            <For each={clientsBinding}>
                                {(_client) => <ActiveClientDot />}
                            </For>
                        </box>
                    </box>
                </overlay>
            </box>
        </button>
    )
}

function ActiveClientDot() {
    return (
        <box class="active-client-dot" />
    )
}

function AppContextMenu(entry, clientsBinding, application, icon, name, pinned, onPinChange, setMenuOpen) {
    let popover: Gtk.Popover

    return (
        <popover
            autohide={true}
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
