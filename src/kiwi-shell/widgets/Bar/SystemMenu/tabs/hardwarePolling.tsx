import { createState } from "ags"
import { readFile } from "ags/file"
import { exec } from "ags/process"
import GLib from "gi://GLib"

// Hardware gauges for the performance tab. Two rules keep this cheap:
//  - pollers are OFF by default and only run while the system menu is open
//    (SystemMenu calls setHardwarePolling) — the shell must not burn cycles
//    on gauges nobody is looking at
//  - sources are detected ONCE at startup and then read straight from
//    /proc and /sys with no process spawns (nvidia-smi being the only
//    exception, as sysfs has no NVIDIA utilization)

type Poller = { intervalMs: number; tick: () => void; id: number | null }
const pollers: Poller[] = []

function poll<T>(initial: T, intervalMs: number, read: () => T) {
    const [state, setState] = createState(initial)
    pollers.push({
        intervalMs,
        tick: () => {
            try {
                setState(read())
            } catch {}
        },
        id: null,
    })
    return state
}

export function setHardwarePolling(active: boolean) {
    for (const p of pollers) {
        if (active && p.id === null) {
            p.tick() // fresh values the moment the menu opens
            p.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, p.intervalMs, () => {
                p.tick()
                return GLib.SOURCE_CONTINUE
            })
        } else if (!active && p.id !== null) {
            GLib.source_remove(p.id)
            p.id = null
        }
    }
}

function listDir(path: string): string[] {
    const out: string[] = []
    try {
        const dir = GLib.Dir.open(path, 0)
        let name: string | null
        while ((name = dir.read_name()) !== null) out.push(name)
        dir.close()
    } catch {}
    return out
}

const readable = (path: string) => {
    try {
        readFile(path)
        return true
    } catch {
        return false
    }
}

// ─── GPU ──────────────────────────────────────────────────────────────────────

function detectGpuReader(): () => number {
    // AMD: gpu_busy_percent straight from sysfs (vendor 0x1002)
    for (const card of listDir("/sys/class/drm")) {
        if (!/^card\d+$/.test(card)) continue
        const base = `/sys/class/drm/${card}/device`
        try {
            if (readFile(`${base}/vendor`).trim() !== "0x1002") continue
        } catch {
            continue
        }
        const busy = `${base}/gpu_busy_percent`
        if (readable(busy)) return () => Number(readFile(busy).trim()) / 100
    }
    // NVIDIA: no sysfs equivalent — spawn, but only while the menu is open
    if (GLib.find_program_in_path("nvidia-smi")) {
        return () =>
            parseInt(exec(
                "nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits",
            ).trim()) / 100
    }
    return () => 0
}

const readGpu = detectGpuReader()
export const gpuUsage = poll(0, 1000, readGpu)

// ─── RAM ──────────────────────────────────────────────────────────────────────

export const ramUsage = poll(0, 2000, () => {
    const out = readFile("/proc/meminfo")
    const get = (key: string) => {
        const line = out.split("\n").find((l) => l.startsWith(key))!
        return parseInt(line.split(/\s+/)[1])
    }
    const total = get("MemTotal:")
    const available = get("MemAvailable:")
    return (total - available) / total
})

// ─── CPU temperature ──────────────────────────────────────────────────────────

// Same priority as the old shell script: AMD k10temp (Tdie, then Tctl),
// Intel coretemp, x86_pkg_temp thermal zone, any cpu/pkg/core zone.
function detectCpuTempFile(): string | null {
    let coretemp: string | null = null
    for (const h of listDir("/sys/class/hwmon")) {
        const base = `/sys/class/hwmon/${h}`
        let name = ""
        try {
            name = readFile(`${base}/name`).trim()
        } catch {
            continue
        }
        if (name === "k10temp") {
            if (readable(`${base}/temp2_input`)) return `${base}/temp2_input`
            if (readable(`${base}/temp1_input`)) return `${base}/temp1_input`
        }
        if (name === "coretemp" && !coretemp && readable(`${base}/temp1_input`))
            coretemp = `${base}/temp1_input`
    }
    if (coretemp) return coretemp
    let generic: string | null = null
    for (const z of listDir("/sys/class/thermal")) {
        if (!z.startsWith("thermal_zone")) continue
        const base = `/sys/class/thermal/${z}`
        let type = ""
        try {
            type = readFile(`${base}/type`).trim().toLowerCase()
        } catch {
            continue
        }
        if (!readable(`${base}/temp`)) continue
        if (type === "x86_pkg_temp") return `${base}/temp`
        if (!generic && /cpu|pkg|core/.test(type)) generic = `${base}/temp`
    }
    return generic
}

const cpuTempFile = detectCpuTempFile()

// degrees Celsius as a plain number, e.g. 54, 72
export const cpuTemp = poll(0, 2000, () =>
    cpuTempFile ? Number(readFile(cpuTempFile).trim()) / 1000 : 0)

// ─── CPU usage ────────────────────────────────────────────────────────────────

function readCpuTicks(): [number, number] {
    const line = readFile("/proc/stat").split("\n")[0]
    const parts = line.trim().split(/\s+/).slice(1).map(Number)
    const idle = parts[3] + parts[4]
    const total = parts.reduce((a, b) => a + b, 0)
    return [idle, total]
}

let [prevIdle, prevTotal] = readCpuTicks()

export const cpuUsage = poll(0, 1000, () => {
    const [idle, total] = readCpuTicks()
    const diffIdle = idle - prevIdle
    const diffTotal = total - prevTotal
    ;[prevIdle, prevTotal] = [idle, total]
    return diffTotal === 0 ? 0 : 1 - diffIdle / diffTotal
})
