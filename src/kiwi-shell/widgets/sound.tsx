import { exec, execAsync } from "ags/process"
import App from "ags/app"

const ROOT = typeof SRC !== "undefined" ? SRC : App.configDir

export function playSound(file: string) {
    execAsync(`pw-play ${ROOT}/assets/${file}`).catch(e =>
        console.error(`Failed to play sound ${file}:`, e)
    )
}