import { readFile, writeFileAsync, monitorFile } from "ags/file"
import { createState } from "ags"
import { exec } from "ags/process"
import { Gdk } from "ags/gtk4"
import App from "ags/app"
import GLib from "gi://GLib"

const HOME = GLib.getenv("HOME")
const CONFIG_FOLDER = `${HOME}/.config/kiwi-shell`
const CONFIG_FILE = `${CONFIG_FOLDER}/config.json`
const HYPR_FILE = `${CONFIG_FOLDER}/hypr.conf`

const ROOT = typeof SRC !== "undefined" ? SRC : App.configDir
const DEFAULT_CONFIG_FILE = `${ROOT}/defaultConfig.json`
const NIX_CONFIG_FILE = `${CONFIG_FOLDER}/nix-config.json`

exec(`mkdir -p ${CONFIG_FOLDER}`)

const borderOpacity = 0.7

function nixConfigExists(): boolean {
    try { readFile(NIX_CONFIG_FILE); return true }
    catch { return false }
}

function deepMerge(defaults: Record<string, any>, overrides: Record<string, any>): Record<string, any> {
    const result = { ...defaults }
    for (const key in overrides) {
        if (
            overrides[key] !== null &&
            typeof overrides[key] === "object" &&
            !Array.isArray(overrides[key]) &&
            typeof defaults[key] === "object" &&
            defaults[key] !== null &&
            !Array.isArray(defaults[key])
        ) {
            result[key] = deepMerge(defaults[key], overrides[key])
        } else {
            result[key] = overrides[key]
        }
    }
    return result
}

function loadConfig() {
    const defaultContent = readFile(DEFAULT_CONFIG_FILE)
    const defaultConfig = JSON.parse(defaultContent)

    if (nixConfigExists()) {
        exec(`cp --no-preserve=mode ${NIX_CONFIG_FILE} ${CONFIG_FILE}`)
    } else {
        try { readFile(CONFIG_FILE) }
        catch {
            exec(`cp --no-preserve=mode ${DEFAULT_CONFIG_FILE} ${CONFIG_FILE}`)
        }
    }

    const content = readFile(CONFIG_FILE)
    return deepMerge(defaultConfig, JSON.parse(content))
}

async function writeHypr(primaryColor: string) {
    try {
        const rgba = new Gdk.RGBA()
        rgba.parse(primaryColor)

        const kiwiColor = rgba.to_string()
        rgba.alpha = borderOpacity
        const kiwiColorTransparent = rgba.to_string()

        const hyprString = `$kiwiColor = ${kiwiColor}\n$kiwiColorLight = ${kiwiColorTransparent}`
        await writeFileAsync(HYPR_FILE, hyprString)
    } catch (error) {
        console.error("Failed to save hypr colors:", error)
    }
}

const initialConfig = loadConfig()

export const [conf, setConf] = createState(initialConfig)

if (nixConfigExists()) {
    writeHypr(initialConfig.primary_color)
}

monitorFile(CONFIG_FILE, () => {
    try {
        const content = readFile(CONFIG_FILE)
        if (!content.trim()) return
        const defaultContent = readFile(DEFAULT_CONFIG_FILE)
        const defaultConfig = JSON.parse(defaultContent)
        setConf(deepMerge(defaultConfig, JSON.parse(content)))
    } catch (error) {
        console.error("Failed to reload config:", error)
    }
})

export async function writeConf() {
    const currentConf = conf()
    const jsonString = JSON.stringify(currentConf, null, 2)

    try {
        await writeFileAsync(CONFIG_FILE, jsonString)
    } catch (error) {
        console.error("Failed to save config:", error)
    }

    await writeHypr(currentConf.primary_color)
}