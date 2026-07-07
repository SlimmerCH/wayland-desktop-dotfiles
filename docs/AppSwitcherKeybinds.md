# App Switcher Keybinds

**You normally don't need to do anything.** On startup (and after every config
reload) kiwi-shell registers natural Alt+Tab keybinds automatically, using
Hyprland's [submap](https://wiki.hypr.land/Configuring/Binds/#submaps) feature —
press `Alt`+`Tab` and hold `Alt`, press `Tab` again to cycle through the
applications, release `Alt` to switch, or press `Escape` to abort.

If `ALT+TAB` (or `ALT+ALT_L`) is bound to something unrelated to the app
switcher in your Hyprland config, kiwi-shell leaves your keyboard alone and
registers nothing — custom alt-tab workflows keep working unchanged. Binds
that reference `kiwictl apps` are considered kiwi-shell's own and are
refreshed to the current scheme on startup.

## Manual setup (custom keys)

If you want different keys, bind the `kiwictl apps` commands yourself. This is
the equivalent of what kiwi-shell sets up automatically:

```bash
# Open the switcher and enter the submap
bind = ALT, TAB, exec, kiwictl apps open-next
bind = ALT, TAB, submap, app_switcher

# Capture the release of the Left Alt key using the 'rt' flags.
# IMPORTANT: these two must live OUTSIDE the submap. Hyprland matches a bind
# against the submap that was active when the key was *pressed* — and Alt goes
# down before the submap is entered, so release binds inside the submap never
# fire for it. Firing on every ordinary Alt release is fine: kiwi-shell
# ignores the confirm while the switcher is closed, and the reset is a no-op.
bindrt = ALT, ALT_L, exec, kiwictl apps confirm
bindrt = ALT, ALT_L, submap, reset

submap = app_switcher

# Allow repeating TAB while holding ALT to cycle the menu
binde = ALT, TAB, exec, kiwictl apps open-next

# Provide a failsafe to abort if you change your mind
bindr = , escape, exec, kiwictl apps close
bindr = , escape, submap, reset

bindr = ALT, escape, exec, kiwictl apps close
bindr = ALT, escape, submap, reset

# Terminate the submap declaration
submap = reset
```
If you use NixOS and you configure hyprland in a .nix file, you will likely to put this into the extraConfig string and not the settings section.

To open the menu, press `Alt`+`Tab` and hold on to `Alt`. Press `Tab` again while holding `Alt` to cycle trough the applications.
