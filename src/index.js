'use strict';

const { execFile } = require('child_process');
const path = require('path');

const PLUGIN_NAME = 'homebridge-tesla-ble';
const PLATFORM_NAME = 'TeslaBLE';

function setServiceConfiguredName(service, Characteristic, name) {
  service.displayName = name;
  service.setCharacteristic(Characteristic.Name, name);
  if (Characteristic.ConfiguredName) {
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    service.setCharacteristic(Characteristic.ConfiguredName, name);
  }
}

class TeslaBleAccessory {
  constructor(platform, accessory, vehicleConfig) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    this.vin = vehicleConfig.vin;
    this.name = vehicleConfig.name || 'Model Y';
    this.keyFile = vehicleConfig.keyFile || '/var/lib/homebridge/tesla-ble-key.pem';
    this.pubKeyFile = vehicleConfig.pubKeyFile || '/var/lib/homebridge/tesla-ble-public.pem';
    this.sessionCache =
      vehicleConfig.sessionCache ||
      path.join(platform.api.user.storagePath(), `tesla-ble-cache-${this.vin}.json`);
    this.teslaControlBin = vehicleConfig.teslaControlBin || '/usr/local/bin/tesla-control';
    this.pollIntervalSec = vehicleConfig.pollIntervalSec || 180;

    this.state = {
      locked: true,
      awake: false,
      climateOn: false,
      charging: false,
      chargePortOpen: false,
      sentryOn: false,
      trunkOpen: false,
      windowsVented: false,
    };

    const { Service, Characteristic } = this.platform;

    // 1. Accessory Information
    this.infoService =
      this.accessory.getService(Service.AccessoryInformation) ||
      this.accessory.addService(Service.AccessoryInformation);
    this.infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Tesla')
      .setCharacteristic(Characteristic.Model, vehicleConfig.model || 'Model Y')
      .setCharacteristic(Characteristic.SerialNumber, this.vin);

    // 2. Vehicle Lock (Primary Service.LockMechanism)
    this.lockService =
      this.accessory.getService(Service.LockMechanism) ||
      this.accessory.addService(Service.LockMechanism, `${this.name} Lock`, 'lock');
    setServiceConfiguredName(this.lockService, Characteristic, `${this.name} Lock`);

    this.lockService
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(() =>
        this.state.locked
          ? Characteristic.LockCurrentState.SECURED
          : Characteristic.LockCurrentState.UNSECURED
      );

    this.lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(() =>
        this.state.locked
          ? Characteristic.LockTargetState.SECURED
          : Characteristic.LockTargetState.UNSECURED
      )
      .onSet((value) => {
        const shouldLock = value === Characteristic.LockTargetState.SECURED;
        this._setLockState(shouldLock);
      });

    // 2b. Hands-Free Voice Switch (On = Unlocked, Off = Locked; bypasses Apple HomeKit's Lock FaceID prompt)
    const unlockSwitchName = vehicleConfig.unlockSwitchName || 'Tesla';
    this.unlockSwitchService =
      this.accessory.getServiceById(Service.Switch, 'unlock-switch') ||
      this.accessory.addService(Service.Switch, unlockSwitchName, 'unlock-switch');
    setServiceConfiguredName(this.unlockSwitchService, Characteristic, unlockSwitchName);
    this.unlockSwitchService
      .getCharacteristic(Characteristic.On)
      .onGet(() => !this.state.locked)
      .onSet((value) => {
        const shouldUnlock = Boolean(value);
        this._setLockState(!shouldUnlock);
      });

    // 3. Climate Preconditioning Switch
    this.climateService =
      this.accessory.getServiceById(Service.Switch, 'climate') ||
      this.accessory.addService(Service.Switch, `${this.name} Climate`, 'climate');
    setServiceConfiguredName(this.climateService, Characteristic, `${this.name} Climate`);
    this.climateService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state.climateOn)
      .onSet((value) => {
        const on = Boolean(value);
        this.state.climateOn = on;
        this.runCommand(on ? ['climate-on'] : ['climate-off'], true, true)
          .then(() => this.log.info(`[${this.name}] Climate ${on ? 'ON' : 'OFF'} succeeded`))
          .catch((err) => {
            this.log.warn(`[${this.name}] Climate command failed: ${err.message}`);
            this.state.climateOn = !on;
            this.climateService.updateCharacteristic(Characteristic.On, !on);
          });
      });

    // 4. Sentry Mode Switch
    this.sentryService =
      this.accessory.getServiceById(Service.Switch, 'sentry') ||
      this.accessory.addService(Service.Switch, `${this.name} Sentry Mode`, 'sentry');
    setServiceConfiguredName(this.sentryService, Characteristic, `${this.name} Sentry Mode`);
    this.sentryService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state.sentryOn)
      .onSet((value) => {
        const on = Boolean(value);
        this.state.sentryOn = on;
        this.runCommand(['sentry-mode', on ? 'on' : 'off'], true, true)
          .then(() => this.log.info(`[${this.name}] Sentry Mode ${on ? 'ON' : 'OFF'} succeeded`))
          .catch((err) => {
            this.log.warn(`[${this.name}] Sentry Mode command failed: ${err.message}`);
            this.state.sentryOn = !on;
            this.sentryService.updateCharacteristic(Characteristic.On, !on);
          });
      });

    // 5. Charge Port Switch
    this.chargePortService =
      this.accessory.getServiceById(Service.Switch, 'charge-port') ||
      this.accessory.addService(Service.Switch, `${this.name} Charge Port`, 'charge-port');
    setServiceConfiguredName(this.chargePortService, Characteristic, `${this.name} Charge Port`);
    this.chargePortService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state.chargePortOpen)
      .onSet((value) => {
        const open = Boolean(value);
        this.state.chargePortOpen = open;
        this.runCommand([open ? 'charge-port-open' : 'charge-port-close'], true)
          .then(() => this.log.info(`[${this.name}] Charge Port ${open ? 'OPEN' : 'CLOSE'} succeeded`))
          .catch((err) => {
            this.log.warn(`[${this.name}] Charge Port command failed: ${err.message}`);
            this.state.chargePortOpen = !open;
            this.chargePortService.updateCharacteristic(Characteristic.On, !open);
          });
      });

    // 6. Trunk Switch (ON = trunk-open, OFF = trunk-close)
    this.trunkService =
      this.accessory.getServiceById(Service.Switch, 'trunk') ||
      this.accessory.addService(Service.Switch, `${this.name} Trunk`, 'trunk');
    setServiceConfiguredName(this.trunkService, Characteristic, `${this.name} Trunk`);
    this.trunkService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state.trunkOpen)
      .onSet((value) => {
        const open = Boolean(value);
        this.state.trunkOpen = open;
        this.runCommand([open ? 'trunk-open' : 'trunk-close'], true)
          .then(() => this.log.info(`[${this.name}] Trunk ${open ? 'OPENED' : 'CLOSED'} via BLE`))
          .catch((err) => {
            this.log.warn(`[${this.name}] Trunk command failed: ${err.message}`);
            this.state.trunkOpen = !open;
            this.trunkService.updateCharacteristic(Characteristic.On, !open);
          });
      });

    // 7. Vent Windows Switch
    this.windowsService =
      this.accessory.getServiceById(Service.Switch, 'windows') ||
      this.accessory.addService(Service.Switch, `${this.name} Vent Windows`, 'windows');
    setServiceConfiguredName(this.windowsService, Characteristic, `${this.name} Vent Windows`);
    this.windowsService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state.windowsVented)
      .onSet((value) => {
        const vent = Boolean(value);
        this.state.windowsVented = vent;
        this.runCommand([vent ? 'windows-vent' : 'windows-close'], true)
          .then(() => this.log.info(`[${this.name}] Windows ${vent ? 'VENTED' : 'CLOSED'} succeeded`))
          .catch((err) => {
            this.log.warn(`[${this.name}] Windows command failed: ${err.message}`);
            this.state.windowsVented = !vent;
            this.windowsService.updateCharacteristic(Characteristic.On, !vent);
          });
      });

    // 8. Optional Pair BLE Key Switch (for initial NFC keycard pairing from Apple Home)
    if (vehicleConfig.enablePairSwitch) {
      this.pairService =
        this.accessory.getServiceById(Service.Switch, 'pair-key') ||
        this.accessory.addService(Service.Switch, `${this.name} Pair BLE Key`, 'pair-key');
      setServiceConfiguredName(this.pairService, Characteristic, `${this.name} Pair BLE Key`);
      this.pairService
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((value) => {
          if (!value) return;
          this.log.info(`[${this.name}] Sending BLE add-key-request... Tap NFC card on center console!`);
          this.runCommand(['add-key-request', this.pubKeyFile, 'owner', 'cloud_key'], false)
            .then(() => {
              this.log.info(`[${this.name}] Sent add-key-request! Confirm with NFC card on center console.`);
            })
            .catch((err) => {
              this.log.warn(`[${this.name}] add-key-request failed: ${err.message}`);
            })
            .finally(() => {
              setTimeout(() => {
                this.pairService.updateCharacteristic(Characteristic.On, false);
              }, 1000);
            });
        });
    } else {
      const oldPair = this.accessory.getServiceById(Service.Switch, 'pair-key');
      if (oldPair) {
        this.accessory.removeService(oldPair);
      }
    }

    // Start sleep-safe BLE body-controller-state polling
    this.pollBodyState();
    this.pollTimer = setInterval(() => this.pollBodyState(), this.pollIntervalSec * 1000);
  }

  _setLockState(shouldLock) {
    const { Characteristic } = this.platform;
    this.state.locked = shouldLock;
    this.lockService.updateCharacteristic(
      Characteristic.LockTargetState,
      shouldLock
        ? Characteristic.LockTargetState.SECURED
        : Characteristic.LockTargetState.UNSECURED
    );
    this.lockService.updateCharacteristic(
      Characteristic.LockCurrentState,
      shouldLock
        ? Characteristic.LockCurrentState.SECURED
        : Characteristic.LockCurrentState.UNSECURED
    );
    if (this.unlockSwitchService) {
      this.unlockSwitchService.updateCharacteristic(Characteristic.On, !shouldLock);
    }

    this.runCommand(shouldLock ? ['lock'] : ['unlock'], true)
      .then(() => {
        this.log.info(`[${this.name}] Vehicle ${shouldLock ? 'LOCKED' : 'UNLOCKED'} via BLE`);
      })
      .catch((err) => {
        this.log.warn(`[${this.name}] Lock/Unlock command failed: ${err.message}`);
        this.pollBodyState();
      });
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollBodyState() {
    try {
      const out = await this.runCommand(['body-controller-state'], false);
      const data = JSON.parse(out);
      const locked =
        data.vehicleLockState === 'VEHICLELOCKSTATE_LOCKED' ||
        data.vehicleLockState === 'VEHICLELOCKSTATE_SELECTIVE_UNLOCKED';
      const awake = data.vehicleSleepStatus === 'VEHICLE_SLEEP_STATUS_AWAKE';
      const trunkOpen = data.closureStatuses?.rearTrunk === 'CLOSURESTATE_OPEN';
      const chargePortOpen = data.closureStatuses?.chargePort === 'CLOSURESTATE_OPEN';

      this.state.locked = locked;
      this.state.awake = awake;
      this.state.trunkOpen = trunkOpen;
      this.state.chargePortOpen = chargePortOpen;

      const { Characteristic } = this.platform;
      this.lockService.updateCharacteristic(
        Characteristic.LockCurrentState,
        locked
          ? Characteristic.LockCurrentState.SECURED
          : Characteristic.LockCurrentState.UNSECURED
      );
      this.lockService.updateCharacteristic(
        Characteristic.LockTargetState,
        locked
          ? Characteristic.LockTargetState.SECURED
          : Characteristic.LockTargetState.UNSECURED
      );
      if (this.unlockSwitchService) {
        this.unlockSwitchService.updateCharacteristic(Characteristic.On, !locked);
      }
      if (this.trunkService) {
        this.trunkService.updateCharacteristic(Characteristic.On, trunkOpen);
      }
      if (this.chargePortService) {
        this.chargePortService.updateCharacteristic(Characteristic.On, chargePortOpen);
      }
    } catch (err) {
      this.log.debug(`[${this.name}] BLE poll skipped (out of range or busy): ${err.message}`);
    }
  }

  runCommand(cmdArgs, useKey = true, wakeIfNeeded = false) {
    return this.platform.enqueueBle(async () => {
      if (wakeIfNeeded && !this.state.awake) {
        try {
          await this._execTeslaControl(['wake'], true);
          await new Promise((r) => setTimeout(r, 3000));
        } catch {
          // ignore wake error and try command anyway
        }
      }
      return this._execTeslaControl(cmdArgs, useKey);
    });
  }

  _execTeslaControl(cmdArgs, useKey) {
    return new Promise((resolve, reject) => {
      const args = ['-ble', '-vin', this.vin, '-connect-timeout', '15s', '-command-timeout', '10s'];
      if (useKey) {
        args.push('-key-file', this.keyFile, '-session-cache', this.sessionCache);
      }
      args.push(...cmdArgs);

      this.log.debug(`[${this.name}] Running: tesla-control ${args.join(' ')}`);
      execFile(this.teslaControlBin, args, { timeout: 25000 }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error((stderr || err.message || '').trim()));
        }
        resolve((stdout || '').trim());
      });
    });
  }
}

class TeslaBlePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.accessories = new Map();
    this.vehicles = [];
    this._bleQueue = Promise.resolve();

    api.on('didFinishLaunching', () => {
      this.setupVehicles();
    });

    api.on('shutdown', () => {
      for (const v of this.vehicles) {
        v.stop();
      }
    });
  }

  enqueueBle(fn) {
    const next = this._bleQueue.then(fn, fn);
    this._bleQueue = next.catch(() => {});
    return next;
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  setupVehicles() {
    const list = Array.isArray(this.config.vehicles) ? this.config.vehicles : [];
    const activeUuids = new Set();

    for (const vCfg of list) {
      if (!vCfg || !vCfg.vin) continue;
      const uuid = this.api.hap.uuid.generate(`tesla-ble-v2-${vCfg.vin}`);
      activeUuids.add(uuid);

      let accessory = this.accessories.get(uuid);
      if (accessory) {
        this.log.info(`Restoring Tesla BLE accessory: ${vCfg.name || 'Model Y'} (${vCfg.vin})`);
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info(`Adding new Tesla BLE accessory: ${vCfg.name || 'Model Y'} (${vCfg.vin})`);
        accessory = new this.api.platformAccessory(vCfg.name || 'Model Y', uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }
      this.vehicles.push(new TeslaBleAccessory(this, accessory, vCfg));
    }

    // Remove stale v1 cached accessories that lacked ConfiguredName
    for (const [uuid, acc] of this.accessories.entries()) {
      if (!activeUuids.has(uuid)) {
        this.log.info(`Removing old cached Tesla accessory: ${acc.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.delete(uuid);
      }
    }
  }
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TeslaBlePlatform);
};
