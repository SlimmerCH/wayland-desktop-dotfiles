import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import Notifd from "gi://AstalNotifd"
import { For, createState, createBinding, createComputed, onCleanup } from "ags"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"
import Pango from "gi://Pango"
import Cairo from "gi://cairo"

import { conf } from "../config"

const DEFAULT_TIMEOUT = 5000
const NOTIF_WIDTH = 360
const APP_ICON_SIZE = 38
const IMAGE_SIZE = 42
const MAX_HISTORY = 50

const EXIT_SLIDE_MS = 250
const EXIT_COLLAPSE_MS = 200
const EXIT_TOTAL_MS = EXIT_SLIDE_MS + EXIT_COLLAPSE_MS

const notifd = Notifd.get_default()

const NC_SLIDE_MS = 300

export const [ncOpen, setNcOpen] = createState(false)

// keeps the window alive (and fullscreen-anchored) until the close slide-out
// animation has finished
const [ncClosing, setNcClosing] = createState(false)
let ncCloseTimer: ReturnType<typeof setTimeout> | null = null

// State update order matters in here: window visibility is computed from
// (ncOpen || ncClosing) and each set() re-evaluates it synchronously. The
// window must never see both false mid-transition, or it unmaps for a tick
// and GTK skips the slide animation.
export function closeNc() {
    if (!ncOpen()) return
    setNcClosing(true)
    setNcOpen(false)
    if (ncCloseTimer) clearTimeout(ncCloseTimer)
    ncCloseTimer = setTimeout(() => {
        ncCloseTimer = null
        setNcClosing(false)
    }, NC_SLIDE_MS + 300)
}

export function toggleNc() {
    if (ncOpen()) {
        closeNc()
    } else {
        // reopening mid slide-out just reverses the animation
        if (ncCloseTimer) {
            clearTimeout(ncCloseTimer)
            ncCloseTimer = null
        }
        setNcOpen(true)
        setNcClosing(false)
        // active banners fold into the history list (macOS-style) so animated
        // banners and the static list never mix while the center is open
        flushActiveToHistory()
    }
}

function flushActiveToHistory() {
    const current = notifState()
    const next = new Map(current)
    let changed = false
    for (const [id, phase] of current) {
        if (phase !== "active" && phase !== "closing") continue
        clearExpiryTimer(id)
        next.set(id, "expired")
        changed = true
    }
    if (changed) {
        setNotifState(next)
        trimHistory()
    }
}

// active: banner on screen, closing: banner playing its exit animation,
// expired: only listed in the notification center history
type Phase = "active" | "closing" | "expired"

const animatedIds = new Set<number>()
const expiryTimers = new Map<number, ReturnType<typeof setTimeout>>()

// Notifications the daemon kept from a previous shell instance go straight
// to history, newest first.
function seedExisting(): Map<number, Phase> {
    try {
        const existing = [...(notifd.get_notifications() ?? [])]
        existing.sort((a, b) => b.time - a.time)
        for (const n of existing) animatedIds.add(n.id)
        return new Map(existing.map(n => [n.id, "expired" as const]))
    } catch {
        return new Map()
    }
}

const [notifState, setNotifState] = createState<Map<number, Phase>>(seedExisting())

function clearExpiryTimer(id: number) {
    const timer = expiryTimers.get(id)
    if (timer !== undefined) {
        clearTimeout(timer)
        expiryTimers.delete(id)
    }
}

function scheduleExpiry(id: number) {
    const n = notifd.get_notification(id)
    if (!n) return
    // Critical notifications stay until acted upon, like macOS alerts.
    if (n.urgency === Notifd.Urgency.CRITICAL) return
    const ms = n.expireTimeout > 0 ? n.expireTimeout : DEFAULT_TIMEOUT
    expiryTimers.set(id, setTimeout(() => {
        expiryTimers.delete(id)
        beginClose(id)
    }, ms))
}

function beginClose(id: number) {
    setNotifState(m =>
        m.get(id) === "active" ? new Map(m).set(id, "closing") : m
    )
    setTimeout(() => {
        const n = notifd.get_notification(id)
        if (n?.transient) {
            // transient hint: excluded from persistence
            n.dismiss()
            return
        }
        setNotifState(m =>
            m.get(id) === "closing" ? new Map(m).set(id, "expired") : m
        )
        trimHistory()
    }, EXIT_TOTAL_MS)
}

function trimHistory() {
    const expired = [...notifState()].filter(([, p]) => p === "expired")
    for (const [id] of expired.slice(MAX_HISTORY)) {
        const n = notifd.get_notification(id)
        if (n) {
            n.dismiss()
        } else {
            setNotifState(m => {
                const next = new Map(m)
                next.delete(id)
                return next
            })
        }
    }
}

function clearHistory() {
    for (const [id, p] of notifState()) {
        if (p !== "expired") continue
        notifd.get_notification(id)?.dismiss()
    }
    setNotifState(m => new Map([...m].filter(([, p]) => p !== "expired")))
}

notifd.connect("notified", (_, id) => {
    // also fires for replacements: reset phase and expiry, move to the top
    clearExpiryTimer(id)
    if (ncOpen()) {
        // center is open: skip the banner phase, land at the top of the list
        setNotifState(m => {
            const next = new Map(m)
            next.delete(id)
            return new Map([[id, "expired" as const], ...next])
        })
        trimHistory()
    } else {
        setNotifState(m => {
            const next = new Map(m)
            next.delete(id)
            return new Map([[id, "active" as const], ...next])
        })
        scheduleExpiry(id)
    }
})

notifd.connect("resolved", (_, id) => {
    clearExpiryTimer(id)
    animatedIds.delete(id)
    setNotifState(m => {
        const next = new Map(m)
        next.delete(id)
        return next
    })
})

const activeNotifs = createComputed(get =>
    [...get(notifState).entries()]
        .filter(([, p]) => p === "active" || p === "closing")
        .map(([id]) => notifd.get_notification(id))
        .filter(Boolean) as Notifd.Notification[]
)

const expiredNotifs = createComputed(get =>
    [...get(notifState).entries()]
        .filter(([, p]) => p === "expired")
        .map(([id]) => notifd.get_notification(id))
        .filter(Boolean) as Notifd.Notification[]
)

// bumped whenever a card changes size on its own (e.g. body expand/collapse)
// so the window can shrink back to its natural size
const [resizeTick, setResizeTick] = createState(0)
function requestNcResize() {
    setResizeTick(resizeTick() + 1)
}

// clock for the relative timestamps
const [nowSec, setNowSec] = createState(Math.floor(Date.now() / 1000))
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
    setNowSec(Math.floor(Date.now() / 1000))
    return GLib.SOURCE_CONTINUE
})

function formatRelativeTime(time: number, now: number): string {
    const diff = Math.max(0, now - time)
    if (diff < 60) return "now"
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return GLib.DateTime.new_from_unix_local(time)?.format("%b %e") ?? ""
}

export default function NotificationCenter({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const { TOP, RIGHT, BOTTOM, LEFT } = Astal.WindowAnchor

    const dnd = createBinding(notifd, "dont-disturb")

    const showActive = createComputed(get =>
        get(activeNotifs).length > 0 && (get(ncOpen) || !get(dnd))
    )

    // While the center is open (or flying out) the window covers the whole
    // usable screen: the transparent area acts as a backdrop so a click
    // anywhere else closes it (input is released the moment closing starts via
    // the input region below). With banners only, it hugs the top-right corner.
    const ncShown = createComputed(get => get(ncOpen) || get(ncClosing))

    let panelRef: Gtk.Widget | null = null

    // Scroll once the list would leave the viewport: cap the scrolled window at
    // monitor height minus the bar and, when it reserves space, the dock.
    const maxListHeight = conf.as(c => {
        const dockAllowance = c.dock === "default" ? (c.dock_icon_size ?? 56) + 46 : 0
        return Math.max(200, gdkmonitor.get_geometry().height - 48 - dockAllowance)
    })

    return (
        <window
            css={conf.as(conf => `--primary: ${conf.primary_color};`)}
            visible={createComputed(get => get(showActive) || get(ncOpen) || get(ncClosing))}
            name="ags-notification-center"
            class={conf.as(conf => `Notifications theme-${conf.theme}`)}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={ncShown.as(shown => shown ? TOP | RIGHT | BOTTOM | LEFT : TOP | RIGHT)}
            keymode={ncOpen.as(open => open ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE)}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                const shrinkToFit = () => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        self.set_default_size(-1, -1)
                        self.queue_resize()
                        return GLib.SOURCE_REMOVE
                    })
                }
                const unsub = notifState.subscribe(shrinkToFit)
                const unsubResize = resizeTick.subscribe(shrinkToFit)

                // backdrop: any click outside the panel closes the center
                const click = new Gtk.GestureClick()
                click.set_button(0)
                click.connect("released", (_gesture, _nPress, x, y) => {
                    if (!ncOpen() || !panelRef) return
                    const [ok, bounds] = panelRef.compute_bounds(self)
                    if (!ok) return
                    const inside =
                        x >= bounds.get_x() && x <= bounds.get_x() + bounds.get_width() &&
                        y >= bounds.get_y() && y <= bounds.get_y() + bounds.get_height()
                    if (!inside) closeNc()
                })
                self.add_controller(click)

                const key = new Gtk.EventControllerKey()
                key.connect("key-pressed", (_controller, keyval) => {
                    if (keyval === Gdk.KEY_Escape && ncOpen()) {
                        closeNc()
                        return true
                    }
                    return false
                })
                self.add_controller(key)

                // while sliding out, the still-fullscreen backdrop should not
                // eat clicks anymore — make it click-through
                const updateInputRegion = () => {
                    const surface = self.get_surface()
                    if (!surface) return
                    if (ncClosing() && !ncOpen()) {
                        surface.set_input_region(new Cairo.Region())
                    } else {
                        surface.set_input_region(null)
                    }
                }
                const unsubOpen = ncOpen.subscribe(updateInputRegion)
                const unsubClosing = ncClosing.subscribe(updateInputRegion)

                onCleanup(() => {
                    unsub()
                    unsubResize()
                    unsubOpen()
                    unsubClosing()
                    self.destroy()
                })
            }}
        >
            <scrolledwindow
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
                vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                propagateNaturalHeight
                propagateNaturalWidth
                maxContentHeight={maxListHeight}
                halign={Gtk.Align.END}
                valign={Gtk.Align.START}
                $={(self) => { panelRef = self }}
            >
            <box class="notifications" orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <box
                    class="active-notifications"
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    visible={showActive}
                >
                    <For each={activeNotifs}>
                        {(n) => <Notification n={n} />}
                    </For>
                </box>
                <box
                    class="expired-notifications nc-panel slide-out"
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    visible={ncShown}
                    $={(self) => {
                        // plain CSS transform slide (like the dock): the viewport
                        // clips the panel, so translating it moves it out of view.
                        // Slide in one idle-tick after mapping, otherwise the
                        // transition is skipped and the panel just pops in.
                        const unsub = ncOpen.subscribe(() => {
                            if (ncOpen()) {
                                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                                    // re-check: the toggle may have been spammed
                                    // before this idle ran
                                    if (ncOpen()) self.remove_css_class("slide-out")
                                    return GLib.SOURCE_REMOVE
                                })
                            } else {
                                self.add_css_class("slide-out")
                            }
                        })
                        onCleanup(unsub)
                    }}
                >
                    <box
                        orientation={Gtk.Orientation.VERTICAL}
                        class="no-notifications"
                        halign={Gtk.Align.CENTER}
                        visible={notifState(m => m.size === 0)}
                    >
                        <Gtk.Image
                            iconName="notification-alert-symbolic"
                            pixelSize={32}
                            class="no-notifications-icon"
                        />
                        <box class="no-notifications-text" halign={Gtk.Align.CENTER}>
                            No notifications
                        </box>
                    </box>
                    <box class="nc-header" visible={expiredNotifs(l => l.length > 0)}>
                        <label class="nc-title" label="Notifications" hexpand xalign={0} />
                        <button class="clear-all-button" onClicked={clearHistory}>
                            <box spacing={4}>
                                <Gtk.Image iconName="edit-clear-all-symbolic" pixelSize={12} />
                                <label label="Clear All" />
                            </box>
                        </button>
                    </box>
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                        <For each={expiredNotifs}>
                            {(n) => <Notification n={n} />}
                        </For>
                    </box>
                </box>
            </box>
            </scrolledwindow>
        </window>
    )
}

function Notification({ n }: { n: Notifd.Notification }) {
    const isNew = !animatedIds.has(n.id)
    if (isNew) animatedIds.add(n.id)

    const phase = createComputed(get => get(notifState).get(n.id))
    const summary = createBinding(n, "summary")
    const body = createBinding(n, "body")
    const timeLabel = nowSec(now => formatRelativeTime(n.time, now))

    // long bodies are clamped to 4 lines; when the text actually gets
    // ellipsized a more/less control expands the card downwards
    const [expanded, setExpanded] = createState(false)
    const [clipped, setClipped] = createState(false)
    const expandable = createComputed(get => get(clipped) || get(expanded))

    const { icon, image } = notifVisuals(n)
    const actionButtons = (n.actions ?? []).filter(a => a.id !== "default")

    let wrap: Gtk.Widget | null = null

    // macOS behavior: clicking opens the source (default action if the app
    // provides one, otherwise focus its window) and the notification is gone
    // for good, including from the center.
    const activate = () => {
        if ((n.actions ?? []).some(a => a.id === "default")) {
            n.invoke("default")
        } else {
            focusApp(n)
        }
        n.dismiss()
    }

    return (
        <revealer
            transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
            transitionDuration={EXIT_COLLAPSE_MS}
            revealChild={!isNew}
            $={(self) => {
                if (isNew) {
                    // start collapsed so neighbors get pushed smoothly, then reveal
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        self.set_reveal_child(true)
                        return GLib.SOURCE_REMOVE
                    })
                }
                const unsub = phase.subscribe(() => {
                    if (phase() === "closing") {
                        wrap?.add_css_class("offscreen")
                        setTimeout(() => {
                            if (notifState().get(n.id) === "closing")
                                self.set_reveal_child(false)
                        }, EXIT_SLIDE_MS)
                    } else if (phase() === "active") {
                        // replaced while closing: bring it back
                        wrap?.remove_css_class("offscreen")
                        self.set_reveal_child(true)
                    }
                })
                onCleanup(unsub)
            }}
        >
            <overlay
                class="notification-wrap"
                $={(self) => {
                    wrap = self
                    // enter/exit use a transition between .offscreen and resting
                    // state instead of a CSS animation: transitions only run on
                    // state changes, so a surface remap (e.g. the center's
                    // anchor flip) can never replay them
                    if (isNew) {
                        self.add_css_class("offscreen")
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            if (notifState().get(n.id) !== "closing") {
                                self.remove_css_class("offscreen")
                            }
                            return GLib.SOURCE_REMOVE
                        })
                    }
                }}
            >
                <box
                    class="notification"
                    widthRequest={NOTIF_WIDTH}
                    $={(self) => {
                        if (n.urgency === Notifd.Urgency.CRITICAL) {
                            self.add_css_class("critical")
                        }
                        // a plain gesture instead of a button: clicks on nested
                        // buttons/links must not fall through to the card action
                        const click = new Gtk.GestureClick()
                        click.set_button(1)
                        click.connect("released", (_gesture, _nPress, x, y) => {
                            const target = self.pick(x, y, Gtk.PickFlags.DEFAULT)
                            for (let w: Gtk.Widget | null = target; w && w !== self; w = w.get_parent()) {
                                if (w instanceof Gtk.Button) return
                                if (w instanceof Gtk.Label && w.get_current_uri()) return
                            }
                            activate()
                        })
                        self.add_controller(click)
                    }}
                >
                    <box class="notification-content" spacing={10} hexpand>
                        {icon}
                        <box orientation={Gtk.Orientation.VERTICAL} hexpand valign={Gtk.Align.CENTER}>
                            <box class="header" spacing={6}>
                                <label
                                    class="app-name"
                                    label={n.appName.toUpperCase()}
                                    ellipsize={Pango.EllipsizeMode.END}
                                    maxWidthChars={1}
                                    hexpand
                                    xalign={0}
                                />
                                <label class="notif-time" label={timeLabel} halign={Gtk.Align.END} />
                            </box>
                            <label
                                class="summary"
                                label={summary.as(s => String(s ?? ""))}
                                ellipsize={Pango.EllipsizeMode.END}
                                maxWidthChars={1}
                                hexpand
                                xalign={0}
                            />
                            <label
                                class="body"
                                useMarkup
                                label={body.as(b => sanitizeBody(String(b ?? "")))}
                                visible={body.as(b => String(b ?? "").trim() !== "")}
                                wrap
                                wrapMode={Pango.WrapMode.WORD_CHAR}
                                ellipsize={expanded.as(e =>
                                    e ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END
                                )}
                                lines={expanded.as(e => (e ? -1 : 4))}
                                maxWidthChars={1}
                                hexpand
                                xalign={0}
                                $={(self) => {
                                    self.connect("activate-link", (_label, uri: string) => {
                                        openUri(uri)
                                        return true
                                    })
                                    // the layout only knows whether it ellipsized
                                    // after it has been laid out once
                                    const checkClipped = () => {
                                        if (!self.get_mapped() || expanded()) return
                                        setClipped(self.get_layout()?.is_ellipsized() ?? false)
                                    }
                                    self.connect("map", () => {
                                        self.add_tick_callback(() => {
                                            checkClipped()
                                            return GLib.SOURCE_REMOVE
                                        })
                                    })
                                    const unsubBody = body.subscribe(() => {
                                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                                            checkClipped()
                                            return GLib.SOURCE_REMOVE
                                        })
                                    })
                                    onCleanup(unsubBody)
                                }}
                            />
                            <button
                                class="expand-button"
                                visible={expandable}
                                halign={Gtk.Align.START}
                                onClicked={() => {
                                    setExpanded(!expanded())
                                    requestNcResize()
                                }}
                            >
                                <box spacing={2}>
                                    <label label={expanded.as(e => (e ? "less" : "more"))} />
                                    <Gtk.Image
                                        iconName={expanded.as(e =>
                                            e ? "pan-up-symbolic" : "pan-down-symbolic"
                                        )}
                                        pixelSize={10}
                                    />
                                </box>
                            </button>
                            {actionButtons.length > 0 && (
                                <box class="actions" spacing={6} halign={Gtk.Align.END}>
                                    {actionButtons.map(action => (
                                        <button
                                            class="action-button"
                                            onClicked={() => {
                                                n.invoke(action.id)
                                                if (!n.resident) n.dismiss()
                                            }}
                                        >
                                            {n.actionIcons
                                                ? <Gtk.Image iconName={action.id} pixelSize={14} />
                                                : <label
                                                    label={action.label}
                                                    ellipsize={Pango.EllipsizeMode.END}
                                                    maxWidthChars={16}
                                                />}
                                        </button>
                                    ))}
                                </box>
                            )}
                        </box>
                        {image}
                    </box>
                </box>
                <button
                    $type="overlay"
                    class="close-button"
                    halign={Gtk.Align.START}
                    valign={Gtk.Align.START}
                    onClicked={() => n.dismiss()}
                >
                    <Gtk.Image iconName="window-close-symbolic" pixelSize={9} />
                </button>
            </overlay>
        </revealer>
    )
}

// ─── Icons / images ───────────────────────────────────────────────────────────

function filePathOf(str: string | null | undefined): string | null {
    if (!str) return null
    const path = str.startsWith("file://") ? str.slice("file://".length) : str
    if (!path.startsWith("/")) return null
    return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null
}

function desktopEntryIcon(n: Notifd.Notification): string | null {
    const de = n.desktopEntry
    if (!de) return null
    const base = de.endsWith(".desktop") ? de.slice(0, -".desktop".length) : de
    for (const candidate of [base, base.toLowerCase()]) {
        const info = GioUnix.DesktopAppInfo.new(candidate + ".desktop")
        const iconName = info?.get_string("Icon")
        if (iconName) return iconName
    }
    return null
}

// A Gtk.Picture's natural size is the image's full size, which would blow up
// the card for large images. An overlay only measures its main child, so a
// fixed-size box dictates the size and the picture just fills it (cover-crop).
function roundedImage(path: string, size: number): Gtk.Widget {
    return (
        <overlay
            class="notif-image"
            overflow={Gtk.Overflow.HIDDEN}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.CENTER}
        >
            <box widthRequest={size} heightRequest={size} />
            <Gtk.Picture
                $type="overlay"
                $={(self: Gtk.Picture) => {
                    self.set_filename(path)
                    self.set_content_fit(Gtk.ContentFit.COVER)
                    self.set_can_shrink(true)
                }}
            />
        </overlay>
    ) as Gtk.Widget
}

// App icon on the left, content image (image-path / image-data hint) on the
// right — like macOS. If there is no app icon, the content image is promoted
// to the app-icon slot instead of showing a generic fallback.
function notifVisuals(n: Notifd.Notification): { icon: Gtk.Widget, image: Gtk.Widget | null } {
    const themedIcon = desktopEntryIcon(n)
        ?? (n.appIcon && !filePathOf(n.appIcon) ? n.appIcon : null)
    const appIconPath = filePathOf(n.appIcon)
    const imagePath = filePathOf(n.image)
    const imageIconName = !imagePath && n.image ? n.image : null

    const iconImage = (iconName: string) => (
        <Gtk.Image
            iconName={iconName}
            pixelSize={APP_ICON_SIZE}
            class="notif-app-icon"
            valign={Gtk.Align.CENTER}
        />
    ) as Gtk.Widget

    const icon =
        themedIcon ? iconImage(themedIcon)
        : appIconPath ? roundedImage(appIconPath, APP_ICON_SIZE)
        : imagePath ? roundedImage(imagePath, APP_ICON_SIZE)
        : imageIconName ? iconImage(imageIconName)
        : iconImage("dialog-information-symbolic")

    const imageUsedAsIcon = !themedIcon && !appIconPath
    const image = imageUsedAsIcon ? null
        : imagePath ? roundedImage(imagePath, IMAGE_SIZE)
        : imageIconName ? (
            <Gtk.Image
                iconName={imageIconName}
                pixelSize={IMAGE_SIZE}
                class="notif-image-icon"
                valign={Gtk.Align.CENTER}
            />
        ) as Gtk.Widget
        : null

    return { icon, image }
}

// ─── Body markup ──────────────────────────────────────────────────────────────

// The spec allows a small HTML subset in the body (<b>, <i>, <u>, <a>, <img>),
// but arbitrary text is common too. Escape everything, then re-allow tags that
// GtkLabel's Pango markup understands, so stray '<', '>' and '&' can't break
// rendering. Falls back to plain text when tags don't balance.
function sanitizeBody(rawBody: string): string {
    const stripped = rawBody
        .replace(/<img[^>]*>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")

    let s = GLib.markup_escape_text(stripped, -1)
    s = s.replace(/&lt;(\/?)(b|i|u|s|tt|big|small|sub|sup)&gt;/gi, "<$1$2>")
    s = s.replace(
        /&lt;a\s+href=(&quot;|&apos;)([\s\S]*?)\1&gt;/gi,
        (_match, _quote, href) => `<a href="${href.replace(/&apos;/g, "&#39;")}">`,
    )
    s = s.replace(/&lt;\/a&gt;/gi, "</a>")

    if (!tagsBalanced(s)) {
        return GLib.markup_escape_text(stripped.replace(/<[^>]*>/g, ""), -1)
    }
    return s
}

function tagsBalanced(markup: string): boolean {
    const stack: string[] = []
    const tagRe = /<(\/?)([a-z]+)(?:\s[^>]*)?>/gi
    let match: RegExpExecArray | null
    while ((match = tagRe.exec(markup)) !== null) {
        if (match[1]) {
            if (stack.pop() !== match[2].toLowerCase()) return false
        } else {
            stack.push(match[2].toLowerCase())
        }
    }
    return stack.length === 0
}

// Focus an existing window of the sending app, if there is one. Deliberately
// conservative (exact class match only) — never launches anything.
function focusApp(n: Notifd.Notification) {
    const targets = [
        n.desktopEntry?.replace(/\.desktop$/i, ""),
        n.appName,
    ].filter(Boolean).map(s => String(s).toLowerCase())
    if (targets.length === 0) return

    try {
        const client = Hyprland.get_default().get_clients().find((c: any) => {
            const initialClass = (c["initial-class"] ?? "").toLowerCase()
            const cls = (c["class"] ?? "").toLowerCase()
            return targets.some(t => t === initialClass || t === cls)
        })
        client?.focus()
    } catch (error) {
        console.error("Failed to focus app for notification:", error)
    }
}

function openUri(uri: string) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null)
    } catch (error) {
        console.error("Failed to open link:", error)
    }
}
