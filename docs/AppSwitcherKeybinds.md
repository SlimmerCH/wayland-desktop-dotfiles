# App Switcher Keybinds

**You normally don't need to do anything.** On startup (and after every config
reload) kiwi-shell registers natural Alt+Tab keybinds automatically, using
Hyprland's [submap](https://wiki.hypr.land/Configuring/Binds/#submaps) feature —
press `Alt`+`Tab` and hold `Alt`, press `Tab` again to cycle through the
applications, release `Alt` to switch, or press `Escape` to abort.

If **any** `ALT+TAB` bind already exists in your Hyprland config, kiwi-shell
leaves your keyboard alone and registers nothing — so existing manual setups
and custom alt-tab workflows keep working unchanged.

## Manual setup (custom keys)

If you want different keys, bind the `kiwictl apps` commands yourself. This is
the equivalent of what kiwi-shell sets up automatically:

```bash
submap = app_switcher

# Allow repeating TAB while holding ALT to cycle the menu
binde = ALT, TAB, exec, kiwictl apps open-next

# Capture the exact release of the Left Alt key using the 'rt' flags
bindrt = ALT, ALT_L, exec, kiwictl apps confirm
bindrt = ALT, ALT_L, submap, reset

# Provide a failsafe to abort if you change your mind
bindr = , escape, exec, kiwictl apps close
bindr = , escape, submap, reset

bindr = ALT, escape, exec, kiwictl apps close
bindr = ALT, escape, submap, reset

# Terminate the submap declaration
submap = reset
```
If you use NixOS and you configure hyprland in a .nix file, you will likely to put this into the extraConfig string and not the settings section.

Add the keybind to enter open the app switcher and enter the submap:
```hyprland
bind = ALT, TAB, exec, kiwictl apps open-next
bind = ALT, TAB, submap, app_switcher
```
