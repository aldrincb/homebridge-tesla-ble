# homebridge-tesla-ble

A **100% local Bluetooth Low Energy (BLE)** Homebridge plugin for Tesla vehicles (Model 3, Model Y, Model S, Model X, Cybertruck) powered by Tesla's official [`vehicle-command` (`tesla-control`)](https://github.com/teslamotors/vehicle-command) CLI.

No Tesla Fleet API developer account, no third-party subscription, no cloud proxy, and zero waking of the vehicle during passive status checks.

---

## Features

- **100% Local Bluetooth LE**: Talks directly from your Raspberry Pi / Linux host (`hci0`) to your parked Tesla over encrypted VCSEC / Infotainment BLE sessions.
- **Sleep-Safe Status Polling**: Periodically queries `body-controller-state` over passive BLE without waking the car's main computer, keeping lock, trunk, and charge port states synced in Apple Home. When the vehicle is already awake (e.g., on arrival, unlock/lock, or wake transitions), it also syncs live `climate` and `closures` (`sentryModeState`, windows) state without preventing the car from sleeping.
- **Serialized BLE Command Queue**: Prevents HCI socket collisions by queuing all BLE polls and commands sequentially and caching ECDH session state on disk.
- **Explicit iOS 16+ `ConfiguredName` Support**: Properly labels every sub-switch inside multi-service Apple Home tiles.
- **Exposed HomeKit Services**:
  - **`<Name> Lock`** (`LockMechanism`): Native HomeKit Lock/Unlock tile.
  - **`Tesla`** (`Switch`): Hands-free Siri voice switch (*"Hey Siri, turn on the Tesla"* to unlock, *"Hey Siri, turn off the Tesla"* to lock) that works from HomePod without requiring an iPhone FaceID confirmation prompt.
  - **`<Name> Trunk`** (`Switch`): Stateful On/Off switch (`ON` = `trunk-open`, `OFF` = `trunk-close` for power liftgate).
  - **`<Name> Climate`** (`Switch`): Precondition cabin (`climate-on` / `climate-off`, automatically wakes vehicle if asleep).
  - **`<Name> Sentry Mode`** (`Switch`): Toggle Sentry Mode (`sentry-mode on` / `off`).
  - **`<Name> Charge Port`** (`Switch`): Open/close the charge port door (`charge-port-open` / `charge-port-close`), synced with `body-controller-state`.
  - **`<Name> Vent Windows`** (`Switch`): Vent or close all windows (`windows-vent` / `windows-close`).

---

## Prerequisites

1. **Build `tesla-control` from Tesla's [`vehicle-command`](https://github.com/teslamotors/vehicle-command) repo:**
   ```bash
   git clone --depth 1 https://github.com/teslamotors/vehicle-command.git
   cd vehicle-command
   go build -o /usr/local/bin/tesla-control ./cmd/tesla-control
   sudo setcap 'cap_net_raw,cap_net_admin+eip' /usr/local/bin/tesla-control
   ```
2. **Generate an ECDSA P-256 Keypair:**
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out /var/lib/homebridge/tesla-ble-key.pem
   openssl ec -in /var/lib/homebridge/tesla-ble-key.pem -pubout -out /var/lib/homebridge/tesla-ble-public.pem
   sudo chown homebridge:homebridge /var/lib/homebridge/tesla-ble-*.pem
   sudo chmod 600 /var/lib/homebridge/tesla-ble-key.pem
   ```
3. **Enroll the Public Key on Your Vehicle (sit inside the car with your NFC key card):**
   ```bash
   tesla-control -ble -vin YOUR_VIN add-key-request /var/lib/homebridge/tesla-ble-public.pem owner cloud_key
   ```
   *(Or set `"enablePairSwitch": true` in the plugin config and tap the **Pair BLE Key** switch in Apple Home while inside the car.)*

---

## Installation

```bash
sudo npm install -g github:aldrincb/homebridge-tesla-ble
```

## Example `config.json`

```json
{
  "platform": "TeslaBLE",
  "name": "Tesla BLE",
  "vehicles": [
    {
      "name": "Model Y",
      "model": "Model Y",
      "vin": "5YJYGDEE000000000",
      "keyFile": "/var/lib/homebridge/tesla-ble-key.pem",
      "pubKeyFile": "/var/lib/homebridge/tesla-ble-public.pem",
      "teslaControlBin": "/usr/local/bin/tesla-control",
      "pollIntervalSec": 180
    }
  ]
}
```

## License

MIT
