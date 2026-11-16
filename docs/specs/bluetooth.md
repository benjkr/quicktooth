# Bluetooth: finding the headset, connecting, battery

Part of the specs (index in `AGENTS.md`). What the app does now. Keep it current in the same
change, and lean. Windows side: `BluetoothAudio`, `Native/CoreAudio.cs`, `Native/PnpEndpoints.cs`,
`Battery.cs`, behind `IDeviceBackend` (`WindowsDevices`).

## Finding devices

- Render endpoints: Core Audio's `EnumAudioEndpoints(eRender, all states)` plus the PnP
  `SWD\MMDEVAPI\{0.0.0.*}` devnodes (present or not) opened with `GetDevice`. Recent Windows 11
  hides a connected headset's hands-free (HFP) render endpoint from the enumeration.
- Each endpoint's topology: connector → connected part → its topology object's device ID. IDs
  starting `{2}.\\?\bth` are Bluetooth KS filters (`bthenum` = A2DP, `bthhfenum` = HFP).
- Endpoints are grouped into devices by `PKEY_Device_ContainerId`. The name comes from the A2DP
  interface name and the MAC from the `bthenum` ID.
- Connected means any endpoint is ACTIVE. The state signature (`A2DP=…, HFP=…`) is logged on change.

## Connect and disconnect

- `BluetoothAudio.SendOneShot` is the only code that sends anything to a device. It takes one
  container ID and sends `KSPROPSETID_BtAudio` {7FA06C40-B8F6-4C7E-8556-E8C33A12E54D} through
  `IKsControl::KsProperty` (Id 0 = reconnect, 1 = disconnect, flags GET, 24-byte `KSPROPERTY`) to
  every KS control of that container: A2DP first, then HFP. Each result is logged.
- Both controls are needed: Windows brings up A2DP only once HFP is up
  ([decisions](../working/decisions.md)).
- The link flag (PnP property {83DA6326-97A6-4088-9453-A1923F573B29} 15 on `BTHENUM\DEV_<MAC>`)
  says whether the Bluetooth link is up; the connect's teardown wait reads it.
- COM goes through source-generated wrappers. Every interface received is a unique instance, and
  each enumeration or send releases them with `FinalRelease`, so KS filter handles never wait for
  a garbage collection.
- Endpoint notifications (`IMMNotificationClient`: state, added, removed) trigger a refresh.
  Hidden endpoints may not notify, hence the fast polling while an action is pending.

## Battery

- Headsets that report battery to Windows: PnP property
  {104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2 (not AirPods).
- AirPods: a passive BLE scan (`BluetoothLEAdvertisementWatcher`) for Apple's status advert
  (company 0x004C, type 0x07) whose model matches the device's Bluetooth PID (e.g. 0x2027).
  - Levels are nibbles × 10%; bit 0x20 of the status byte flips left and right. The shown level
    is the emptier bud.
  - The scan stops at the first advert with RSSI ≥ −70 (it ignores < −85), otherwise after 12 s.
  - It never connects to anything, and logs `battery scan: N adverts, M Apple, K handler errors, …`.
