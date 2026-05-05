import { conf } from "../config";
import GLib from "gi://GLib";
import { execAsync } from "ags/process";
import { nightShift, setNightShift } from "../Bar/SystemMenu/tabs/SystemTab";
import type { Accessor } from "ags";

function timeToMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
}

function isWithinTimeframe(start: string, end: string): boolean {
    const now = GLib.DateTime.new_now_local();
    const current = now.get_hour() * 60 + now.get_minute();
    const s = timeToMinutes(start);
    const e = timeToMinutes(end);

    return s <= e
        ? current >= s && current < e          // same-day range
        : current >= s || current < e;         // wraps past midnight
}

function subscribeChanged<T>(accessor: Accessor<T>, callback: () => void) {
    let prev = accessor.get();
    return accessor.subscribe(() => {
        const current = accessor.get();
        if (current === prev) return;
        prev = current;
        callback();
    });
}

function updateNightShift() {
    const config = conf();

    if (isWithinTimeframe(config.nightshift_start, config.nightshift_end) && config.auto_nightshift) {
        if (!nightShift()) {
            execAsync(`hyprsunset -t ${config.nightshift_intensity}`);
            setNightShift(true);
        }
    } else {
        if (nightShift()) {
            execAsync("killall hyprsunset");
            setNightShift(false);
        }
    }
}

export default function nightShiftService() {
    updateNightShift();

    subscribeChanged(conf.as(c => c.auto_nightshift), updateNightShift);
    subscribeChanged(conf.as(c => c.nightshift_start), updateNightShift);
    subscribeChanged(conf.as(c => c.nightshift_end), updateNightShift);

    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
        updateNightShift();
        return GLib.SOURCE_CONTINUE;
    });
}