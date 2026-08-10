import Quarrel from "gi://Quarrel"
import app from "ags/gtk4/app"
import { setLogLevel } from "./log"
import { toggleAppSwitcher } from "./widgets/AppSwitcher/AppSwitcher"
import { toggleWorkspaceSwitcher } from "./widgets/WorkspaceSwitcher/WorkspaceSwitcher"
import { toggleLauncher } from "./widgets/Launcher/Launcher"

// kiwictl command dispatch, parsed with Quarrel. Option/flag objects keep
// their parsed state, so the command tree is rebuilt for every request —
// a handful of GObjects, nothing worth caching.

const SWITCHER_ACTIONS = ["open", "open-next", "next", "previous", "confirm", "close", "toggle"]
const LAUNCHER_ACTIONS = ["open", "close", "toggle"]

function buildCli() {
    const help = Quarrel.SpecialFlag.new("help", "h".charCodeAt(0), "Print help")

    const apps = Quarrel.Command.new("apps")
        .about("Control the Alt+Tab app switcher")
        .required_arg("ACTION", SWITCHER_ACTIONS.join(" | "))
        .opt(help)

    const workspaces = Quarrel.Command.new("workspaces")
        .about("Control the Super+Tab workspace switcher")
        .required_arg("ACTION", SWITCHER_ACTIONS.join(" | "))
        .opt(help)

    const launcher = Quarrel.Command.new("launcher")
        .about("Control the Super+Space app launcher")
        .arg("ACTION", `${LAUNCHER_ACTIONS.join(" | ")} [default: toggle]`)
        .opt(help)

    const quit = Quarrel.Command.new("quit")
        .about("Quit the shell")
        .opt(help)

    const debug = Quarrel.Command.new("debug")
        .about("Enable debug logging for this shell instance")
        .opt(help)

    const cli = Quarrel.Command.new("kiwictl")
        .about("Control a running Kiwi Shell")
        .example("kiwictl launcher")
        .example("kiwictl apps open-next")
        .subcommand(apps)
        .subcommand(workspaces)
        .subcommand(launcher)
        .subcommand(quit)
        .subcommand(debug)
        .opt(help)

    return { cli, help, apps, workspaces, launcher, quit, debug }
}

export function handleCliRequest(argv: string[], respond: (response: string) => void) {
    const c = buildCli()

    let matched: Quarrel.Command
    try {
        // argv[0] is expected to be the program name and skipped by parse
        matched = c.cli.parse(["kiwictl", ...argv])
    } catch (e: any) {
        const failed = Quarrel.Command.throwing() ?? c.cli
        respond(`${e.message ?? e}\n\n${Quarrel.help(failed)}`)
        return
    }

    // bare `kiwictl` and any --help print usage
    if (c.help.enabled || matched === c.cli) {
        respond(Quarrel.help(matched))
        return
    }

    const action = matched.args[0]

    if (matched === c.apps || matched === c.workspaces) {
        if (!SWITCHER_ACTIONS.includes(action)) {
            respond(`unknown action: ${action}\n\n${Quarrel.help(matched)}`)
            return
        }
        if (matched === c.apps) toggleAppSwitcher(action)
        else toggleWorkspaceSwitcher(action)
        respond("")
        return
    }

    if (matched === c.launcher) {
        const launcherAction = action ?? "toggle"
        if (!LAUNCHER_ACTIONS.includes(launcherAction)) {
            respond(`unknown action: ${launcherAction}\n\n${Quarrel.help(matched)}`)
            return
        }
        toggleLauncher(launcherAction)
        respond("")
        return
    }

    if (matched === c.debug) {
        setLogLevel("debug")
        respond("debug logging enabled")
        return
    }

    if (matched === c.quit) {
        // reply before quitting so the client is not left hanging
        respond("")
        app.quit()
    }
}
