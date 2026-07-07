import app from "ags/gtk4/app"
import { Gdk } from "ags/gtk4"
import { Accessor, createBinding, createComputed } from "ags"
import Hyprland from "gi://AstalHyprland"
import { conf } from "./config"

const hyprland = Hyprland.get_default()

// The monitor that popups — switchers, launcher, OSD, notifications,
// prompts — appear on. macOS-inspired: the currently active monitor by
// default, pinned to the main (first) monitor via popup_monitor="primary".
// Undefined only while no monitor exists; callers fall back to their
// mount monitor.
export const popupGdkMonitor: Accessor<Gdk.Monitor | undefined> = createComputed(get => {
    const monitors = get(createBinding(app, "monitors"))
    const primary = monitors[0]
    if (get(conf).popup_monitor === "primary") return primary
    const focused = get(createBinding(hyprland, "focusedMonitor"))
    return monitors.find(m => m.get_connector() === focused?.name) ?? primary
})
