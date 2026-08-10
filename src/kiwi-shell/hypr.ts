// Hyprland ≥0.56 lua-config IPC. Under a lua config the socket has no legacy
// dialect left: a `dispatch` payload is a lua expression building an
// HL.Dispatcher, and `keyword` is rejected outright ("keyword can't work with
// non-legacy parsers. Use eval.") — while still exiting 0, so the reply TEXT
// is the only failure signal there is. Every request here checks it.
//
// Dynamic binds/submaps made through eval share the lifetime the old dynamic
// keywords had: wiped on config reload, so registrars re-run on
// config-reloaded.
import Hyprland from "gi://AstalHyprland"
import { logDebug } from "./debug"

const hyprland = Hyprland.get_default()

// a lua double-quoted string literal
export function luaStr(s: string): string {
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"'
}

// Astal strips the leading 0x from client addresses, but Hyprland's
// address: window selector requires it
export const clientSelector = (client: Hyprland.Client) => `address:0x${client.address}`

function send(request: string, label: string) {
    hyprland.message_async(request, (_src: any, res: any) => {
        let reply: string
        try {
            reply = hyprland.message_finish(res)
        } catch (e) {
            console.error(`hypr: ${label}:`, e)
            return
        }
        if (reply.trim() !== "ok") console.error(`hypr: ${label}: ${reply}`)
        else logDebug(`hypr: ok: ${label}`)
    })
}

// run a lua chunk in the compositor's config context. One chunk executes
// atomically and in order — the replacement for `hyprctl --batch`.
export function evalLua(code: string, label?: string) {
    send(`eval ${code}`, label ?? code.slice(0, 60))
}

// execute a single dispatcher, e.g. dispatchLua('hl.dsp.window.close()')
export function dispatchLua(dispatcher: string) {
    send(`dispatch ${dispatcher}`, dispatcher.slice(0, 60))
}

// ─── dispatch helpers ─────────────────────────────────────────────────────────

export const focusWindow = (selector: string) =>
    dispatchLua(`hl.dsp.focus({ window = ${luaStr(selector)} })`)

export const focusWorkspace = (ws: string | number) =>
    dispatchLua(`hl.dsp.focus({ workspace = ${luaStr(String(ws))} })`)

export const moveWindowToWorkspace = (
    ws: string | number,
    selector: string,
    opts: { follow?: boolean } = {},
) =>
    dispatchLua(
        `hl.dsp.window.move({ workspace = ${luaStr(String(ws))}, window = ${luaStr(selector)}` +
        (opts.follow === false ? `, follow = false` : ``) + ` })`,
    )

export const raiseWindow = (selector: string) =>
    dispatchLua(`hl.dsp.window.alter_zorder({ mode = "top", window = ${luaStr(selector)} })`)

export const toggleSpecialWorkspace = (name: string) =>
    dispatchLua(`hl.dsp.workspace.toggle_special(${luaStr(name)})`)

// ─── bind registration ────────────────────────────────────────────────────────
// Every kiwi-registered bind carries a "kiwi: ..." description: since the lua
// config reports every bind's dispatcher as "__lua" with an opaque arg,
// descriptions are the only introspectable identity `hyprctl binds -j` has
// left. isKiwiBind() is the reader side.

export type BindFlags = {
    repeating?: boolean
    release?: boolean
    transparent?: boolean
    locked?: boolean
}

// lua source for one hl.bind() call; `action` is a lua dispatcher expression
export function luaBind(keys: string, action: string, description: string, flags: BindFlags = {}): string {
    const opts = [`description = ${luaStr(description)}`]
    for (const [k, v] of Object.entries(flags)) if (v) opts.push(`${k} = true`)
    return `hl.bind(${luaStr(keys)}, ${action}, { ${opts.join(", ")} })`
}

// lua source for clearing every bind on a key combo (tolerates absence)
export const luaUnbind = (keys: string) => `hl.unbind(${luaStr(keys)})`

export const isKiwiBind = (b: any) => (b.description ?? "").startsWith("kiwi:")

// human-readable identity for a bind from `hyprctl binds -j` — under the lua
// config dispatcher/arg are an opaque __lua/index, so key, modifiers and
// description are all there is to show
export function describeBind(b: any): string {
    const desc = b.description ? ` "${b.description}"` : ""
    return `mod=${b.modmask} key=${b.key}${desc} (${b.dispatcher} ${b.arg})`
}
