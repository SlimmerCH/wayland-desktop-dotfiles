import { Gtk } from "ags/gtk4"
import { createComputed, createRoot, onCleanup } from "ags"

export function KeyedList<T>({
    each,
    keyFn,
    children,
    enterClass,
    enterDuration = 700,
    shouldEnter,
    appendOnly,
}: {
    each: ReturnType<typeof createComputed<T[]>>
    keyFn: (item: T) => string
    children: (item: T) => Gtk.Widget
    enterClass?: string
    enterDuration?: number
    shouldEnter?: (item: T) => boolean
    appendOnly?: boolean
}) {
    return (
        <box
            $={(self: Gtk.Box) => {
                const widgetMap = new Map<string, Gtk.Widget>()
                const disposeMap = new Map<string, () => void>()
                let prevKeys: string[] = []
                let initialized = false

                const sync = (items: T[]) => {
                    if (!items) return

                    const nextKeys = items.map(keyFn)
                    const nextKeySet = new Set(nextKeys)

                    // 1. Remove widgets whose entries disappeared
                    for (const k of prevKeys) {
                        if (!nextKeySet.has(k)) {
                            const w = widgetMap.get(k)!
                            self.remove(w)
                            disposeMap.get(k)?.()
                            disposeMap.delete(k)
                            widgetMap.delete(k)
                        }
                    }

                    // 2. Create widgets for new entries inside a reactive root so that
                    //    onCleanup / createState inside children have a tracking context.
                    for (const item of items) {
                        const k = keyFn(item)
                        if (!widgetMap.has(k)) {
                            createRoot(dispose => {
                                const w = children(item)
                                widgetMap.set(k, w)
                                disposeMap.set(k, dispose)
                                self.append(w)
                                if (initialized) {
                                    if (enterClass) {
                                        const animate = shouldEnter ? shouldEnter(item) : true
                                        if (animate) {
                                            w.add_css_class(enterClass)
                                            // settle to .shown once the enter animation is
                                            // done, so it can never replay on this widget
                                            setTimeout(() => {
                                                if (!w.get_parent()) return
                                                w.remove_css_class(enterClass)
                                                w.add_css_class("shown")
                                            }, enterDuration)
                                        } else {
                                            w.add_css_class("shown")
                                        }
                                    } else {
                                        w.add_css_class("shown")
                                    }
                                }
                            })
                        }
                    }

                    // 3. Reorder forward to match array order without touching widget state.
                    //    Skipped when appendOnly is set — new widgets are always appended at
                    //    the end so existing widgets are never shuffled (which would restart
                    //    their CSS animations).
                    if (!appendOnly) {
                        let prev: Gtk.Widget | null = null
                        for (let i = 0; i < nextKeys.length; i++) {
                            const w = widgetMap.get(nextKeys[i])
                            if (!w) continue
                            self.reorder_child_after(w, prev)
                            prev = w
                        }
                    }

                    prevKeys = nextKeys
                    initialized = true
                }

                sync(each.get() ?? [])

                const unsub = each.subscribe(() => sync(each.get() ?? []))

                onCleanup(() => {
                    unsub()
                    for (const dispose of disposeMap.values()) dispose()
                    disposeMap.clear()
                    widgetMap.clear()
                })
            }}
        />
    )
}