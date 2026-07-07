import { createState } from "ags"

// runtime debug switch, enabled via `kiwictl debug`
const [debug, setDebug] = createState(false)
export { debug, setDebug }

// chatty diagnostics go through here so ~/.cache/kiwi-shell.log stays
// readable — visible only after `kiwictl debug`
export function logDebug(...args: any[]) {
    if (debug()) console.log(...args)
}
