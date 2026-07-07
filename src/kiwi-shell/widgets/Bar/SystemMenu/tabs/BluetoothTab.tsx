import { Gtk } from "ags/gtk4"
import AstalBluetooth from "gi://AstalBluetooth"
import GLib from "gi://GLib"
import { createBinding, createComputed, createState } from "ags"
import { exec } from "ags/process"

import { Icon, BluetoothDeviceIcon } from "../../../iconNames"
import { KeyedList } from "../../../KeyedList"
import { logDebug } from "../../../../debug"
import { bluetoothTabOpen } from "../SystemMenu"

function hasBluetoothAdapter(): boolean {
  try {
    const dir = GLib.Dir.open("/sys/class/bluetooth", 0)
    return dir.read_name() !== null
  } catch {
    return false
  }
}

let bluetooth: ReturnType<typeof AstalBluetooth.get_default> | null = null
let adapter: AstalBluetooth.Adapter | undefined = undefined

if (hasBluetoothAdapter()) {
  bluetooth = AstalBluetooth.get_default()
  adapter = bluetooth.adapter ?? undefined
}

adapter?.connect("notify::powered", () => {
  if (bluetoothEnabledBinding()) {
    adapter!.set_discoverable(true)
    if (bluetoothTabOpen()) {
      startBluetoothDiscovery()
    }
  }
})

const bluetoothEnabledRaw = adapter ? createBinding(adapter, "powered") : null
const devicesBinding = bluetooth ? createBinding(bluetooth, "devices") : null

// A device's address is stable while names resolve during discovery; keying on
// it lets KeyedList keep existing rows untouched (For re-appends every child on
// each list emission, which drops hover state and flickers).
const deviceKey = (device: AstalBluetooth.Device) =>
  device.address ?? device.get_object_path?.() ?? String(device)

const [btFrozen, setBtFrozen] = createState(false)
const [btFrozenValue, setBtFrozenValue] = createState(adapter?.powered ?? false)

const bluetoothEnabledBinding = createComputed((get) => {
  if (get(btFrozen)) return get(btFrozenValue)
  if (!bluetoothEnabledRaw) return false
  return get(bluetoothEnabledRaw)
})

export function startBluetoothDiscovery() {
  try {
    adapter?.start_discovery()
  } catch (e) {
    // Already discovering, ignore
  }
}

export function stopBluetoothDiscovery() {
  adapter?.stop_discovery()
}

export default function BluetoothTab({ visible }) {
  return (
    <box
      class="tab-content"
      visible={visible}
      orientation={Gtk.Orientation.VERTICAL}
    >
      <box class="section-header">
        <box halign={Gtk.Align.START}>Bluetooth</box>
        <box hexpand={true} />
        <switch
          sensitive={adapter !== undefined}
          active={bluetoothEnabledBinding}
          onStateSet={(self, state) => {
            if (state !== adapter?.powered) {
              adapter?.set_powered(state)
            }
            setBtFrozen(true)
            setBtFrozenValue(state)
            setTimeout(() => setBtFrozen(false), 2000)
          }}
        />
      </box>
      <box
        class="paired-devices"
        orientation={Gtk.Orientation.VERTICAL}
        spacing={4}
        vexpand={true}
      >
        {devicesBinding && (
          <KeyedList
            each={devicesBinding}
            keyFn={deviceKey}
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            children={(device) => <Device device={device} paired={true} />}
          />
        )}
      </box>

      <box class="section-header mt">
        <box halign={Gtk.Align.START}>Other Devices</box>
        <box hexpand={true} />
      </box>

      <box
        class="unkown-devices"
        orientation={Gtk.Orientation.VERTICAL}
        spacing={4}
        vexpand={true}
      >
        {devicesBinding && (
          <KeyedList
            each={devicesBinding}
            keyFn={deviceKey}
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            children={(device) => <Device device={device} paired={false} />}
          />
        )}
      </box>
    </box>
  )
}

function Device({ device, paired }) {
  const iconBinding = createBinding(device, "icon")
  const connectedBinding = createBinding(device, "connected")
  const deviceName = createBinding(device, "name")
  const pairedBinding = createBinding(device, "paired")

  const visibility = createComputed((get) => {
    const name = get(deviceName)
    const isMac = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(name)
    return get(pairedBinding) == paired && name && !isMac
  })

  const hasIcon = iconBinding.as((s) => !!s)

  const menu = DeviceContextMenu(device, connectedBinding, pairedBinding)

  return (
    <button
      visible={visibility}
      class={connectedBinding.as((b) =>
        b ? "bluetooth-item active" : "bluetooth-item",
      )}
      onClicked={() => {
        handleDeviceClick(device)
      }}
      $={(self) => {
        const gesture = new Gtk.GestureClick()
        gesture.set_button(3)
        gesture.connect("released", () => {
          menu.popup()
        })
        self.add_controller(gesture)
      }}
    >
      <box spacing={6}>
        {menu}
        <Icon
          pixelSize={16}
          visible={hasIcon}
          iconName={iconBinding.as((s) => BluetoothDeviceIcon(s))}
        />
        <label
          label={deviceName.as((n) => n || "Unknown Device")}
          hexpand={true}
          halign={Gtk.Align.START}
        />
        <label label="Connected" visible={connectedBinding} />
      </box>
    </button>
  )
}

function DeviceContextMenu(device, connectedBinding, pairedBinding) {
  let popover: Gtk.Popover

  const item = (label: string, icon: string, onClicked: () => void, visible) => (
    <button
      visible={visible}
      onClicked={() => {
        popover.popdown()
        onClicked()
      }}
    >
      <box>
        <Icon class="dock-context-icon" iconName={icon} pixelSize={20} />
        <label halign={Gtk.Align.START} label={label} />
      </box>
    </button>
  )

  return (
    <popover
      autohide={true}
      class="app-context-menu bt-context-menu"
      $={(self) => {
        popover = self
      }}
    >
      <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
        {item("Connect", "bluetooth-active-symbolic", () => connectDevice(device),
          createComputed((get) => get(pairedBinding) && !get(connectedBinding)))}
        {item("Pair & Connect", "bluetooth-active-symbolic", () => pairDevice(device),
          pairedBinding.as((p) => !p))}
        {item("Disconnect", "bluetooth-disabled-symbolic", () => disconnectDevice(device),
          connectedBinding)}
        {item("Forget Device", "user-trash-symbolic", () => forgetDevice(device),
          pairedBinding)}
      </box>
    </popover>
  )
}

function connectDevice(device) {
  logDebug("Connecting to", device.name)
  device.connect_device((source, result) => {
    try {
      device.connect_device_finish(result)
      logDebug("Connected successfully!")
    } catch (err) {
      console.error("Connect failed:", err)
    }
  })
}

function disconnectDevice(device) {
  logDebug("Disconnecting from", device.name)
  device.disconnect_device((source, result) => {
    try {
      device.disconnect_device_finish(result)
      logDebug("Disconnected successfully!")
    } catch (err) {
      console.error("Disconnect failed:", err)
    }
  })
}

function pairDevice(device) {
  logDebug("Pairing with", device.name)
  device.pair()
  device.trusted = true
  connectDevice(device)
}

function forgetDevice(device) {
  try {
    logDebug("Removing device", device.name)
    adapter?.remove_device(device)
  } catch (error) {
    console.error("Failed to remove device:", error)
  }
}

async function handleDeviceClick(device) {
  try {
    if (!device.paired) {
      pairDevice(device)
    } else if (!device.connected) {
      connectDevice(device)
    } else {
      disconnectDevice(device)
    }
  } catch (error) {
    console.error("Bluetooth operation failed:", error)
  }
}