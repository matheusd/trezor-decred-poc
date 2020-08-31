import * as services from "./dcrwallet-api/api_grpc_pb";
import * as wallet from "./helpers/wallet";
import * as networks from "./helpers/networks";
import * as ui from "./ui";
import * as trezorHelpers from "./helpers/trezor";
import * as fs from "fs";
import * as homescreens from "./helpers/homescreens";

import { InitService, WalletCredentials } from "./helpers/services";
import { rawToHex, rawHashToHex, reverseHash, str2hex, hex2b64, str2utf8hex } from "./helpers/bytes";
import { sprintf } from "sprintf-js";
import { globalCryptoShim } from "./helpers/random";

const session = require('trezor-connect').default;
const { TRANSPORT_EVENT, UI, UI_EVENT, DEVICE_EVENT, DEVICE, CONNECT } = require('trezor-connect');

// app constants
const CHANGE = 'device-changed'
const DISCONNECT = 'device-disconnect'
const AQUIRED = 'acquired'
const NOBACKUP = 'no-backup'
const coin = "Decred Testnet";
const coinNetwork = networks.decred;
const walletCredentials = WalletCredentials("127.0.0.1", 19111,
    "/home/joe/.dcrwallet/rpc.cert");
// const walletCredentials = WalletCredentials("127.0.0.1", 19121,
    // "/home/user/.config/decrediton/wallets/testnet/trezor/rpc.cert");
const debug = true;
const firmwareV1Location = "../trezor-mcu/build/trezor-ddc51a3.bin";

// helpers
var log = ui.log;
var debugLog = ui.debugLog;
console.log = ui.debugLog;
console.warn = ui.debugLog;
console.error = ui.debugLog;

// this is needed because trezor.js does not recognize the node crypto module
global.crypto = globalCryptoShim;

// app state
const devices = {}
var publishTxs = false;


function onChange (features) {
  if (features == null) throw "no features on connect"
  devices[features.device_id] = features
}

function onDisconnect (id) {
  delete devices[id]
}

function noDevice () {
  if (Object.keys(devices).length == 0) {
    log("No devices.");
    return true
  }
  return false
}

function initTrezor() {
  session.init({
    connectSrc: 'https://localhost:8088/',
    lazyLoad: true,
    popup: false,
    manifest: {
      email: 'joegruffins@gmail.com',
      appUrl: 'https://github.com/decred/decrediton',
    },
    webusb: true
  })
  .then(
    log('TrezorConnect init ok')
  )
  .then( async () => {
    let res = await session.getFeatures()
    onChange(res.payload)
  })
  .then(
    setDeviceListeners()
  )
  .catch(error => {
      log('TrezorConnect init error', error)
  })
}

const uiActions = {
    // actions done on a specific (connected/current) device
    getAddress: async () => {
      if (noDevice()) return
      let res = await ui.queryInput("index [branch]");
      const args = res.split(" ");
      if (args.length < 1) return;

      const address_n = trezorHelpers.addressPath(args[0], args[1]);
      const resp = await session.getAddress({
        path: address_n,
        coin: coin,
        showOnTrezor: false
      });
      const addr = resp.payload.address;
      log("Address: %s", addr);
    },

    getMasterPubKey: async () =>  {
      if (noDevice()) return
      const account = parseInt(await ui.queryInput("Account #"));

      const path = trezorHelpers.accountPath(account);

      const res = await session.getPublicKey({
        path: path,
        coin: coin,
        showOnTrezor: false
      })
      log("Extended PubKey of account %d: %s", account, res.payload.xpub);
    },

    togglePinProtection: async () => {
      if (noDevice()) return
      const features = await session.getFeatures();
      const newVal = !!features.payload.pin_protection;
      log("%s pin protection", newVal ? "Disabling" : "Enabling");
      await session.changePin({ remove: newVal });
    },

    togglePassphraseProtection: async () => {
      if (noDevice()) return
      const features = await session.getFeatures();
      const newVal = !!features.payload.passphrase_protection;
      log("%s passphrase protection", newVal ? "Disabling" : "Enabling");
      let res = await session.applySettings({ use_passphrase: !newVal });
    },

    wipeDevice: async () => {
      if (noDevice()) return
      log("Trying to wipe device");
      await session.wipeDevice();
    },

    recoverDevice: async () => {
      if (noDevice()) return
      log("Starting recover procedure");
      const wordCount = parseInt(await ui.queryInput("Number of recovery words (12, 18 or 24)"));
      if ([12, 18, 24].indexOf(wordCount) === -1) {
          throw "Not a valid word count";
      }

      const settings = {
          word_count: wordCount,
          passphrase_protection: false,
          pin_protection: false,
          label: "New DCR Trezor",
          dry_run: false,
      };

      let res = await session.recoveryDevice(settings);
      log(res.payload)
    },

    changeLabel: async () => {
      if (noDevice()) return
      log("Changing device label");
      const label = await ui.queryInput("New Label");
      await session.applySettings({ label: label });
    },

    signMessage: async () => {
      if (noDevice()) return
      const testMessage = await ui.queryInput("Message to Sign");
      if (!testMessage) return;

      let addrInput = await ui.queryInput("Address to use (index [branch])");
      const args = addrInput.split(" ");
      if (args.length < 1) return;

      const address_n = trezorHelpers.addressPath(args[0], args[1]);

      log("Signging message '%s'", testMessage);
      const signedMsg = await session.signMessage({
        path: address_n,
        coin: coin,
        message: str2utf8hex(testMessage),
        hex: true
      });

      const addr = signedMsg.payload.address
      const sig = signedMsg.payload.signature
      debugLog("Signed Message", signedMsg);
      log("Signed using address", addr);

      log("Decrediton verifiable sig", sig);

      const wsvcMsg = await InitService(services.MessageVerificationServiceClient, walletCredentials);
      debugLog("Got message verification svc from wallet");

      const verifyResp = await wallet.verifyMessage(wsvcMsg, addr,
          testMessage, sig)
      debugLog("Verification response", verifyResp.toObject());
      verifyResp.getValid() ? log("Verification PASSED!") : log("Verification FAILED!");
    },

    signTransaction: async () => {
      if (noDevice()) return
      const destAddress = await ui.queryInput("Destination Address", "TsaT2QRgtJe5DnSzHfMEu65qzpfMEVGABmd");
      if (!destAddress) return;

      const destAmount = await ui.queryInput("Amount (in DCR)");
      if (!destAmount) return;

      const wsvc = await InitService(services.WalletServiceClient, walletCredentials);
      const decodeSvc = await InitService(services.DecodeMessageServiceClient, walletCredentials);
      debugLog("Got wallet services");

      const output = { destination: destAddress, amount: Math.floor(destAmount * 1e8)}

      const rawUnsigTxResp = await wallet.constructTransaction(wsvc, 0, 0, [output])
      log("Got raw unsiged tx");
      const rawUnsigTx = rawToHex(rawUnsigTxResp.res.getUnsignedTransaction());
      debugLog("Raw unsigned tx hex follows");
      debugLog(rawUnsigTx);

      const decodedUnsigTx = await wallet.decodeTransaction(decodeSvc, rawUnsigTx)
      log("Decoded unsigned tx");
      // decodedUnsigTx.getInputsList().forEach((t, i) => log("input", i, t.toObject()))
      // decodedUnsigTx.getOutputsList().forEach((t, i) => log("output", i, t.toObject()))

      const inputTxs = await wallet.getInputTransactions(wsvc, decodeSvc, decodedUnsigTx);
      log("Got input transactions (to extract pkscripts)");

      const txInfo = await trezorHelpers.walletTxToBtcjsTx(decodedUnsigTx,
          rawUnsigTxResp.res.getChangeIndex(), inputTxs, wsvc);
      const refTxs = inputTxs.map(trezorHelpers.walletTxToRefTx);
      log("Going to sign tx on trezor");
      const signedResp = await session.signTransaction({
        coin: coin,
        inputs: txInfo.inputs,
        outputs: txInfo.outputs,
        refTxs: refTxs,
        timestamp: 0
      });
      const signedRaw = signedResp.payload.serializedTx;
      log("Successfully signed tx");

      if (!publishTxs) {
          log("Raw signed hex tx follows.");
          log(signedRaw);
          return;
      }

      const txHash = await wallet.publishTransaction(wsvc, signedRaw);
      log("Published tx", txHash);
    },

    initDevice: async () => {
      if (noDevice()) return
      const settings = {
          strength: 256,
          passphrase_protection: false,
          pin_protection: false,
          label: "New DCR Trezor",
      };
      log("Initializing device. You must choose to backup for some commands to work.");
      await session.resetDevice(settings);
      log("Device initialized with new seed");
    },

    backupDevice: async () => {
      if (noDevice()) return
      let res = await session.getFeatures();
      if (res.payload.unfinished_backup) {
        log("Backup in unrecoverable state.")
        return
      }
      if (!res.payload.needs_backup) {
        log("Already backed up.")
        return
      }
      log("Attempting to backup device.");
      res = await session.backupDevice()
    },

    changeHomeScreen: async () => {
      if (noDevice()) return
      log("Changing home screen to DCR");
      await session.applySettings({ homescreen: homescreens.decred })
    },

    // ui/informational/state actions
    listDevices: () => {
      if (noDevice()) return
      log("Listing devices");
      log(JSON.stringify(devices, null, 2));
      log("End of device list");
    },

    showFeatures: async () => {
      if (noDevice()) return
      const features = await session.getFeatures();
      log("Features of current device");
      log(JSON.stringify(features, null, 2));
    },

    validateAddress: async () => {
      const addr = await ui.queryInput("Address to validate");
      if (!addr) return;

      const wsvc = await InitService(services.WalletServiceClient, walletCredentials);
      const resp = await wallet.validateAddress(wsvc, addr);

      const bool = b => b ? "true" : "false"
      log("Validating %s", addr);
      log("Valid=%s  Mine=%s  Script=%s  Account=%d  Internal=%s  Index=%d",
          bool(resp.getIsValid()), bool(resp.getIsMine()), bool(resp.getIsScript()),
          resp.getAccountNumber(), bool(resp.getIsInternal()), resp.getIndex());
      log("PubKeyAddress: %s", resp.getPubKeyAddr());
      log("PubKey: %s", rawToHex(resp.getPubKey()));
    },

    importScript: async () => {
      const script = await ui.queryInput("Hex raw script");
      if (!script) return;

      const wsvc = await InitService(services.WalletServiceClient, walletCredentials);
      const resp = await wallet.importScript(wsvc, "", script, false, 0);
      log("");
      log(resp.toObject());
      log("Resulting P2SH Address: %s", resp.getP2shAddress());
    },

    togglePublishTxs: () => {
      publishTxs = !publishTxs;
      ui.setPublishTxsState(publishTxs);
    },
};

function setDeviceListeners() {
  session.on(DEVICE_EVENT, (event) => {
    const type = event.type
    switch (type) {
      case CHANGE:
        if (event.payload.type == AQUIRED) {
          onChange(event.payload.features);
        }
        break;
      case DISCONNECT:
        onDisconnect(event.payload.features.device_id);
        break;
    }
  })
  session.on(UI_EVENT, async (event) => {
    const type = event.type
    switch (type) {
      case UI.REQUEST_CONFIRMATION:
        if (event.payload.view == NOBACKUP) {
        log("Device must be backed up to perform this operation.")
          session.uiResponse({
            type: UI.RECEIVE_CONFIRMATION,
            payload: False,
          })
        }
      break;
      case UI.REQUEST_PASSPHRASE:
        log("passphrase requested")
        try {
          const inp = await ui.queryInput("Type the passphrase")
          session.uiResponse({
            type: UI.RECEIVE_PASSPHRASE,
            payload: {
              value: inp,
              save: true
            }
          })
        } catch (error) {
          log("Error waiting for passphrase: %s", error)
          session.uiResponse({
            type: UI.RECEIVE_PASSPHRASE,
            payload: {
              value: '',
              passphraseOnDevice: true,
              save: true
            }
          })
        }
      break;
    }
  })
}

// start of main procedure
ui.buildUI(uiActions);
ui.runUI();
setTimeout(initTrezor(), 1000);
