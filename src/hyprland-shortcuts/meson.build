project('kiwi-shortcuts', 'c',
  version: '1.0.0',
  default_options: ['c_std=c11'],
)

gnome = import('gnome')

glib_dep    = dependency('glib-2.0')
gobject_dep = dependency('gobject-2.0')
wayland_dep = dependency('wayland-client')

wayland_scanner = find_program('wayland-scanner')

proto_xml = files('protocols/hyprland-global-shortcuts-v1.xml')

# Generate Wayland protocol bindings from the XML
proto_header = custom_target('proto-header',
  input:   proto_xml,
  output:  'hyprland-global-shortcuts-v1-protocol.h',
  command: [wayland_scanner, 'client-header', '@INPUT@', '@OUTPUT@'],
)

proto_code = custom_target('proto-code',
  input:   proto_xml,
  output:  'hyprland-global-shortcuts-v1-protocol.c',
  command: [wayland_scanner, 'private-code', '@INPUT@', '@OUTPUT@'],
)

lib = shared_library('kiwi-shortcuts',
  'kiwi-shortcuts.c',
  proto_code,
  proto_header,
  include_directories: include_directories('.'),
  dependencies: [glib_dep, gobject_dep, wayland_dep],
  install: true,
)

install_headers('kiwi-shortcuts.h')

# Generate GObject introspection data so GJS can import the library
# gnome.generate_gir produces both the .gir and the .typelib
gnome.generate_gir(lib,
  sources:     ['kiwi-shortcuts.c', 'kiwi-shortcuts.h'],
  namespace:   'KiwiShortcuts',
  nsversion:   '1.0',
  includes:    ['GObject-2.0', 'GLib-2.0'],
  dependencies: [glib_dep, gobject_dep, wayland_dep],
  install:     true,
)
