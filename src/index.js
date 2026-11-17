'use strict';

const { execFile } = require('child_process');
const path = require('path');

const PLUGIN_NAME = 'homebridge-tesla-ble';
const PLATFORM_NAME = 'TeslaBLE';

const BLE_COOLDOWN_MS = 1500;
const TRANSIENT_BLE_ERR_RE =
  /ATT request failed|input channel closed|closed pipe|failed to enumerate device services|failed to dial|connection reset|transport endpoint is not connected|EOF/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonOutput(raw) {
  const trimmed = (raw || '').trim();
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace === -1) {
    throw new Error(`Unexpected non-JSON output: ${trimmed}`);
  }
  // Strip any leading logxi JSON lines if present on stdout before main JSON object
  const lines = trimmed.split('\n').filter((line) => !line.includes('"__logxi"'));
  return JSON.parse(lines.join('\n'));
}

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
    this.storagePath = platform.api.user.storagePath();
    this.keyFile = vehicleConfig.keyFile || '/var/lib/homebridge/tesla-ble-key.pem';
    this.pubKeyFile = vehicleConfig.pubKeyFile || '/var/lib/homebridge/tesla-ble-public.pem';
    this.sessionCache =
      vehicleConfig.sessionCache ||
      path.join(this.storagePath, `tesla-ble-cache-${this.vin}.json`);
    this.teslaControlBin = vehicleConfig.teslaControlBin || '/usr/local/bin/tesla-control';
    this.pollIntervalSec = vehicleConfig.pollIntervalSec || 180;

    this.inBleRange = false;
    this._missedPolls = 0;
    this._hasSyncedInfotainment = false;
    this._pendingFollowUpSync = false;
    this._lastInfotainmentSyncMs = 0;
    this._lastBodyPollMs = 0;
    this._polling = false;
    this._pendingCommands = 0;

    this.state = {
      locked: true,
      awake: false,
      asleep: false,
      userPresent: false,
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
    this.state.climateOn = Boolean(this.climateService.getCharacteristic(Characteristic.On).value);
    this.climateService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state.climateOn)
      .onSet((value) => {
        const on = Boolean(value);
        const prev = this.state.climateOn;
        this.state.climateOn = on;
        this._pendingCommands++;
        this.runCommand(on ? ['climate-on'] : ['climate-off'], true, {
          wakeIfNeeded: on,
          skipIfAsleep: !on,
        })
          .then((res) => {
            if (res && res.skippedBecauseAsleep) {
              this.log.info(`[${this.name}] Vehicle is asleep; Climate is already OFF`);
            } else {
              this.log.info(`[${this.name}] Climate ${on ? 'ON' : 'OFF'} succeeded`);
            }
          })
          .catch((err) => {
            this.log.warn(`[${this.name}] Climate command failed: ${err.message}`);
            this._revertSwitch(this.climateService, 'climateOn', prev);
          })
          .finally(() => {
            this._pendingCommands--;
          });
      });

    // 4. Sentry Mode Switch
    this.sentryService =
      this.accessory.getServiceById(Service.Switch, 'sentry') ||
      this.accessory.addService(Service.Switch, `${this.name} Sentry Mode`, 'sentry');
    setServiceConfiguredName(this.sentryService, Characteristic, `${this.name} Sentry Mode`);
    this.state.sentryOn = Boolean(this.sentryService.getCharacteristic(Characteristic.On).value);
    this.sentryService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state.sentryOn)
      .onSet((value) => {
        const on = Boolean(value);
        const prev = this.state.sentryOn;
        this.state.sentryOn = on;
        this._pendingCommands++;
        this.runCommand(['sentry-mode', on ? 'on' : 'off'], true, {
          wakeIfNeeded: on,
          skipIfAsleep: !on,
        })
          .then((res) => {
            if (res && res.skippedBecauseAsleep) {
              this.log.info(`[${this.name}] Vehicle is asleep; Sentry Mode is already OFF`);
            } else {
              this.log.info(`[${this.name}] Sentry Mode ${on ? 'ON' : 'OFF'} succeeded`);
            }
          })
          .catch((err) => {
            this.log.warn(`[${this.name}] Sentry Mode command failed: ${err.message}`);
            this._revertSwitch(this.sentryService, 'sentryOn', prev);
          })
          .finally(() => {
            this._pendingCommands--;
          });
      });

    // 5. Charge Port Switch
    this.chargePortService =
      this.accessory.getServiceById(Service.Switch, 'charge-port') ||
      this.accessory.addService(Service.Switch, `${this.name} Charge Port`, 'charge-port');
    setServiceConfiguredName(this.chargePortService, Characteristic, `${this.name} Charge Port`);
    this.state.chargePortOpen = Boolean(
      this.chargePortService.getCharacteristic(Characteristic.On).value
    );
    this.chargePortService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state.chargePortOpen)
      .onSet((value) => {
        const open = Boolean(value);
        const prev = this.state.chargePortOpen;
        this.state.chargePortOpen = open;
        this._pendingCommands++;
        this.runCommand([open ? 'charge-port-open' : 'charge-port-close'], true)
          .then(() =>
            this.log.info(`[${this.name}] Charge Port ${open ? 'OPEN' : 'CLOSE'} succeeded`)
          )
          .catch((err) => {
            this.log.warn(`[${this.name}] Charge Port command failed: ${err.message}`);
            this._revertSwitch(this.chargePortService, 'chargePortOpen', prev);
          })
          .finally(() => {
            this._pendingCommands--;
          });
      });

    // 6. Trunk Switch (ON = trunk-open, OFF = trunk-close)
    this.trunkService =
      this.accessory.getServiceById(Service.Switch, 'trunk') ||
      this.accessory.addService(Service.Switch, `${this.name} Trunk`, 'trunk');
    setServiceConfiguredName(this.trunkService, Characteristic, `${this.name} Trunk`);
    this.state.trunkOpen = Boolean(this.trunkService.getCharacteristic(Characteristic.On).value);
    this.trunkService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state.trunkOpen)
      .onSet((value) => {
        const open = Boolean(value);
        const prev = this.state.trunkOpen;
        this.state.trunkOpen = open;
        this._pendingCommands++;
        this.runCommand([open ? 'trunk-open' : 'trunk-close'], true)
          .then(() => this.log.info(`[${this.name}] Trunk ${open ? 'OPENED' : 'CLOSED'} via BLE`))
          .catch((err) => {
            this.log.warn(`[${this.name}] Trunk command failed: ${err.message}`);
            this._revertSwitch(this.trunkService, 'trunkOpen', prev);
          })
          .finally(() => {
            this._pendingCommands--;
          });
      });

    // 7. Vent Windows Switch
    this.windowsService =
      this.accessory.getServiceById(Service.Switch, 'windows') ||
      this.accessory.addService(Service.Switch, `${this.name} Vent Windows`, 'windows');
    setServiceConfiguredName(this.windowsService, Characteristic, `${this.name} Vent Windows`);
    this.state.windowsVented = Boolean(
      this.windowsService.getCharacteristic(Characteristic.On).value
    );
    this.windowsService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.state.windowsVented)
      .onSet((value) => {
        const vent = Boolean(value);
        const prev = this.state.windowsVented;
        this.state.windowsVented = vent;
        this._pendingCommands++;
        this.runCommand([vent ? 'windows-vent' : 'windows-close'], true)
          .then(() =>
            this.log.info(`[${this.name}] Windows ${vent ? 'VENTED' : 'CLOSED'} succeeded`)
          )
          .catch((err) => {
            this.log.warn(`[${this.name}] Windows command failed: ${err.message}`);
            this._revertSwitch(this.windowsService, 'windowsVented', prev);
          })
          .finally(() => {
            this._pendingCommands--;
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
          this.log.info(
            `[${this.name}] Sending BLE add-key-request... Tap NFC card on center console!`
          );
          this.runCommand(['add-key-request', this.pubKeyFile, 'owner', 'cloud_key'], false)
            .then(() => {
              this.log.info(
                `[${this.name}] Sent add-key-request! Confirm with NFC card on center console.`
              );
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

  _revertSwitch(service, stateKey, prevValue) {
    const { Characteristic } = this.platform;
    this.state[stateKey] = prevValue;
    setTimeout(() => {
      service.updateCharacteristic(Characteristic.On, prevValue);
      this.pollBodyState(true);
    }, 250);
  }

  _setLockState(shouldLock) {
    const { Characteristic } = this.platform;
    const prevLocked = this.state.locked;
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

    this._pendingCommands++;
    this.runCommand(shouldLock ? ['lock'] : ['unlock'], true)
      .then(() => {
        this.log.info(`[${this.name}] Vehicle ${shouldLock ? 'LOCKED' : 'UNLOCKED'} via BLE`);
      })
      .catch((err) => {
        this.log.warn(`[${this.name}] Lock/Unlock command failed: ${err.message}`);
        this.state.locked = prevLocked;
        setTimeout(() => {
          this.lockService.updateCharacteristic(
            Characteristic.LockTargetState,
            prevLocked
              ? Characteristic.LockTargetState.SECURED
              : Characteristic.LockTargetState.UNSECURED
          );
          this.lockService.updateCharacteristic(
            Characteristic.LockCurrentState,
            prevLocked
              ? Characteristic.LockCurrentState.SECURED
              : Characteristic.LockCurrentState.UNSECURED
          );
          if (this.unlockSwitchService) {
            this.unlockSwitchService.updateCharacteristic(Characteristic.On, !prevLocked);
          }
          this.pollBodyState(true);
        }, 250);
      })
      .finally(() => {
        this._pendingCommands--;
      });
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _applyBodyStateData(data) {
    const locked =
      data.vehicleLockState === 'VEHICLELOCKSTATE_LOCKED' ||
      data.vehicleLockState === 'VEHICLELOCKSTATE_INTERNAL_LOCKED' ||
      data.vehicleLockState === 'VEHICLELOCKSTATE_SELECTIVE_UNLOCKED';
    const sleepStatus = data.vehicleSleepStatus || 'VEHICLE_SLEEP_STATUS_UNKNOWN';
    const awake = sleepStatus === 'VEHICLE_SLEEP_STATUS_AWAKE';
    const asleep = sleepStatus === 'VEHICLE_SLEEP_STATUS_ASLEEP';
    const userPresent = data.userPresence === 'VEHICLE_USER_PRESENCE_PRESENT';
    const trunkOpen = data.closureStatuses?.rearTrunk === 'CLOSURESTATE_OPEN';
    const chargePortOpen = data.closureStatuses?.chargePort === 'CLOSURESTATE_OPEN';

    this._lastBodyPollMs = Date.now();
    return { locked, awake, asleep, userPresent, trunkOpen, chargePortOpen };
  }

  async pollBodyState(forceInfotainmentSync = false) {
    if (this._polling && !forceInfotainmentSync) return;
    this._polling = true;
    try {
      const out = await this.runCommand(['body-controller-state'], false, {
        retries: this.inBleRange ? 1 : 0,
      });
      const data = parseJsonOutput(out);

      const wasInRange = this.inBleRange;
      const wasAwake = this.state.awake;
      const wasLocked = this.state.locked;
      const wasPresent = this.state.userPresent;

      this._missedPolls = 0;
      this.inBleRange = true;

      const { locked, awake, asleep, userPresent, trunkOpen, chargePortOpen } =
        this._applyBodyStateData(data);

      this.state.awake = awake;
      this.state.asleep = asleep;
      this.state.userPresent = userPresent;

      if (this._pendingCommands > 0) {
        return;
      }

      this.state.locked = locked;
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

      // When the car's main computer is asleep, neither Climate nor Sentry Mode can be active.
      if (asleep) {
        if (this.state.climateOn || this.state.sentryOn || !this._hasSyncedInfotainment) {
          this.state.climateOn = false;
          this.state.sentryOn = false;
          this.climateService.updateCharacteristic(Characteristic.On, false);
          this.sentryService.updateCharacteristic(Characteristic.On, false);
          this._hasSyncedInfotainment = true;
        }
        this._pendingFollowUpSync = false;
        return;
      }

      if (awake) {
        const arrivedHome = !wasInRange;
        const wokeUp = !wasAwake;
        const lockChanged = wasLocked !== locked;
        const presenceChanged = wasPresent !== userPresent;
        const transition = arrivedHome || wokeUp || lockChanged || presenceChanged;
        const followUpNow = !transition && this._pendingFollowUpSync;

        if (transition) {
          this._pendingFollowUpSync = true;
        } else if (followUpNow) {
          this._pendingFollowUpSync = false;
        }

        // Only poll infotainment periodically while Climate or Sentry is actively ON
        // (both keep the car awake on their own), so an idle parked car can fall asleep normally.
        const now = Date.now();
        const activeRefreshMs = this.state.climateOn
          ? 180_000
          : this.state.sentryOn
            ? 300_000
            : Infinity;
        const dueForActiveRefresh = now - this._lastInfotainmentSyncMs >= activeRefreshMs;

        if (
          forceInfotainmentSync ||
          !this._hasSyncedInfotainment ||
          transition ||
          followUpNow ||
          dueForActiveRefresh
        ) {
          await this._syncInfotainmentState();
        }
      }
    } catch (err) {
      this._missedPolls++;
      if (this._missedPolls >= 2) {
        this.inBleRange = false;
      }
      this.log.debug(`[${this.name}] BLE poll skipped (out of range or busy): ${err.message}`);
    } finally {
      this._polling = false;
    }
  }

  async _syncInfotainmentState() {
    const { Characteristic } = this.platform;
    try {
      const climateOut = await this.runCommand(['state', 'climate'], true, { retries: 1 });
      const climateJson = parseJsonOutput(climateOut);
      const cl = climateJson?.climateState;
      if (cl && this._pendingCommands === 0) {
        const climateOn = Boolean(
          cl.isClimateOn || cl.isPreconditioning || cl.isAutoConditioningOn
        );
        if (this.state.climateOn !== climateOn || !this._hasSyncedInfotainment) {
          this.log.info(`[${this.name}] Synced Climate state via BLE: ${climateOn ? 'ON' : 'OFF'}`);
        }
        this.state.climateOn = climateOn;
        this.climateService.updateCharacteristic(Characteristic.On, climateOn);
      }

      const closuresOut = await this.runCommand(['state', 'closures'], true, { retries: 1 });
      const closuresJson = parseJsonOutput(closuresOut);
      const cs = closuresJson?.closuresState;
      if (cs && this._pendingCommands === 0) {
        const sentryObj = cs.sentryModeState;
        const sentryOn =
          sentryObj && typeof sentryObj === 'object'
            ? Object.keys(sentryObj).length > 0 && !('Off' in sentryObj)
            : false;
        const windowsVented = Boolean(
          cs.windowOpenDriverFront ||
            cs.windowOpenPassengerFront ||
            cs.windowOpenDriverRear ||
            cs.windowOpenPassengerRear
        );

        if (this.state.sentryOn !== sentryOn || !this._hasSyncedInfotainment) {
          this.log.info(
            `[${this.name}] Synced Sentry Mode state via BLE: ${sentryOn ? 'ON' : 'OFF'}`
          );
        }
        this.state.sentryOn = sentryOn;
        this.state.windowsVented = windowsVented;
        this.sentryService.updateCharacteristic(Characteristic.On, sentryOn);
        if (this.windowsService) {
          this.windowsService.updateCharacteristic(Characteristic.On, windowsVented);
        }
        if (typeof cs.doorOpenTrunkRear === 'boolean' && this.trunkService) {
          this.state.trunkOpen = cs.doorOpenTrunkRear;
          this.trunkService.updateCharacteristic(Characteristic.On, cs.doorOpenTrunkRear);
        }
      }

      this._hasSyncedInfotainment = true;
      this._lastInfotainmentSyncMs = Date.now();
    } catch (err) {
      this.log.debug(`[${this.name}] Infotainment BLE state sync skipped: ${err.message}`);
    }
  }

  runCommand(cmdArgs, useKey = true, options = {}) {
    const opts =
      typeof options === 'boolean'
        ? { wakeIfNeeded: options, skipIfAsleep: false, retries: 2 }
        : { wakeIfNeeded: false, skipIfAsleep: false, retries: 2, ...options };

    return this.platform.enqueueBle(async () => {
      if (opts.wakeIfNeeded || opts.skipIfAsleep) {
        // Check live VCSEC sleep state if our cached sleep status is stale (>15s) or not awake
        const bodyStale = Date.now() - this._lastBodyPollMs > 15_000;
        if (bodyStale || !this.state.awake) {
          try {
            const bodyOut = await this._execWithRetry(['body-controller-state'], false, 1);
            const bodyData = parseJsonOutput(bodyOut);
            const parsed = this._applyBodyStateData(bodyData);
            this.state.awake = parsed.awake;
            this.state.asleep = parsed.asleep;
            await sleep(BLE_COOLDOWN_MS);
          } catch {
            // Fall through and attempt command directly
          }
        }

        if (opts.skipIfAsleep && this.state.asleep) {
          return { skippedBecauseAsleep: true };
        }

        if (opts.wakeIfNeeded && !this.state.awake) {
          try {
            await this._execWithRetry(['wake'], true, 1);
            this.state.awake = true;
            this.state.asleep = false;
            await sleep(5000);
          } catch {
            await sleep(BLE_COOLDOWN_MS);
          }
        }
      }

      return this._execWithRetry(cmdArgs, useKey, opts.retries);
    });
  }

  async _execWithRetry(cmdArgs, useKey, maxRetries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this._execTeslaControl(cmdArgs, useKey);
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries && TRANSIENT_BLE_ERR_RE.test(err.message || '')) {
          const delayMs = 2000 + attempt * 1500;
          this.log.debug(
            `[${this.name}] Transient BLE error on '${cmdArgs.join(' ')}' (attempt ${
              attempt + 1
            }/${maxRetries + 1}), retrying in ${delayMs}ms: ${err.message}`
          );
          await sleep(delayMs);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  _execTeslaControl(cmdArgs, useKey) {
    return new Promise((resolve, reject) => {
      const args = ['-ble', '-vin', this.vin, '-connect-timeout', '15s', '-command-timeout', '10s'];
      if (useKey) {
        args.push('-key-file', this.keyFile, '-session-cache', this.sessionCache);
      }
      args.push(...cmdArgs);

      this.log.debug(`[${this.name}] Running: tesla-control ${args.join(' ')}`);
      execFile(
        this.teslaControlBin,
        args,
        { timeout: 25000, cwd: this.storagePath },
        (err, stdout, stderr) => {
          if (err) {
            return reject(new Error((stderr || err.message || '').trim()));
          }
          resolve((stdout || '').trim());
        }
      );
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
    this._lastBleFinishMs = 0;

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
    const run = async () => {
      const elapsed = Date.now() - this._lastBleFinishMs;
      if (this._lastBleFinishMs > 0 && elapsed < BLE_COOLDOWN_MS) {
        await sleep(BLE_COOLDOWN_MS - elapsed);
      }
      try {
        return await fn();
      } finally {
        this._lastBleFinishMs = Date.now();
      }
    };
    const next = this._bleQueue.then(run, run);
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
