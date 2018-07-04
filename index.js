import * as services from "./dcrwallet-api/api_grpc_pb";
import * as wallet from "./helpers/wallet";
import * as networks from "./helpers/networks";
import * as ui from "./ui";
import * as trezor from "trezor.js";
import * as trezorHelpers from "./helpers/trezor";

import { InitService, WalletCredentials } from "./helpers/services";
import { rawToHex, rawHashToHex, reverseHash, str2hex, hex2b64 } from "./helpers/bytes";
import { sprintf } from "sprintf-js";

// app constants
const coin = "Decred Testnet";
const coinNetwork = networks.decred;
const walletCredentials = WalletCredentials("127.0.0.1", 19121,
    "/home/user/.config/decrediton/wallets/testnet/trezor/rpc.cert");
const debug = true;

// helpers
var log = ui.log;
var debugLog = ui.debugLog;
console.log = ui.debugLog;
console.warn = ui.debugLog;
console.error = ui.debuglog;

// app state
var devList;
var devices = [];
var currentDeviceIndex = 0;

function currentDevice() {
    if (!devices[currentDeviceIndex]) {
        throw "Selected device not available";
    }
    if (devices[currentDeviceIndex].state !== "connected") {
        throw "Selected device not connected";
    }
    return devices[currentDeviceIndex].device;
}

const uiActions = {
    // actions done on a specific (connected/current) device
    getAddress: () => currentDevice().run(async session => {
        let res = await ui.queryInput("index [branch]");
        const args = res.split(" ");
        if (args.length < 1) return;

        const address_n = trezorHelpers.addressPath(args[0], args[1]);
        const resp = await session.getAddress(address_n, coin, false);
        const addr = resp.message.address;
        log("Address: %s", addr);
    }),

    getMasterPubKey: () => currentDevice().run(async session => {
        const account = parseInt(await ui.queryInput("Account #"));

        const path = trezorHelpers.accountPath(account);

        const res = await session.getPublicKey(path, coin, false);
        log("Extended PubKey of account %d: %s", account, res.message.xpub);
    }),

    togglePinProtection: () => currentDevice().run(async session => {
        const newVal = !!currentDevice().features.pin_protection;
        log("%s pin protection", newVal ? "Disabling" : "Enabling");
        await session.changePin(newVal);
    }),

    togglePassphraseProtection: () => currentDevice().run(async session => {
        const newVal = !currentDevice().features.passphrase_protection;
        log("%s passphrase protection", !newVal ? "Disabling" : "Enabling");
        await session.togglePassphrase(newVal);
    }),

    wipeDevice: () => currentDevice().run(async session => {
        log("Trying to wipe device");
        await session.wipeDevice();
    }),

    clearSession: () => currentDevice().run(async session => {
        log("Clearing device session");
        await session.clearSession();
    }),

    recoverDevice: () => currentDevice().run(async session => {
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

        await session.recoverDevice(settings);
    }),

    changeLabel: () => currentDevice().run(async session => {
        log("Changing device label");
        const label = await ui.queryInput("New Label");
        await session.changeLabel(label);
    }),

    signMessage: () => currentDevice().run(async session => {
        const testMessage = await ui.queryInput("Message to Sign");
        if (!testMessage) return;

        let addrInput = await ui.queryInput("Address to use (index [branch])");
        const args = addrInput.split(" ");
        if (args.length < 1) return;

        const address_n = trezorHelpers.addressPath(args[0], args[1]);

        log("Signging message '%s'", testMessage);
        const signedMsg = await session.signMessage(address_n,
            str2hex(testMessage), coin, false);

        debugLog("Signed Message", signedMsg);
        log("Signed using address", signedMsg.message.address);

        const sig = hex2b64(signedMsg.message.signature);
        log("Decrediton verifiable sig", sig);

        const wsvcMsg = await InitService(services.MessageVerificationServiceClient, walletCredentials);
        debugLog("Got message verification svc from wallet");

        const verifyResp = await wallet.verifyMessage(wsvcMsg, signedMsg.message.address,
            testMessage, sig)
        debugLog("Verification response", verifyResp.toObject());
        verifyResp.getValid() ? log("Verification PASSED!") : log("Verification FAILED!");
    }),

    signTransaction: () => currentDevice().run(async session => {
        const destAddress = await ui.queryInput("Destination Address");
        if (!destAddress) return;

        const destAmount = await ui.queryInput("Amount (in DCR)");
        if (!destAmount) return;

        const wsvc = await InitService(services.WalletServiceClient, walletCredentials);
        const decodeSvc = await InitService(services.DecodeMessageServiceClient, walletCredentials);
        debugLog("Got wallet services");

        const output = { destination: destAddress, amount: Math.floor(destAmount * 1e8)}

        const rawUnsigTxResp = await wallet.constructTransaction(wsvc, 0, 1, [output])
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
        const signedResp = await session.signTx(txInfo.inputs, txInfo.outputs, refTxs, coin, 0);
        const signedRaw = signedResp.message.serialized.serialized_tx;
        log("Successfully signed tx. Raw hex tx follows.");
        log(signedRaw);
    }),

    stealDevice: async () => {
        log("Trying to steal device connection");
        await devices[currentDeviceIndex].device.steal();
        debugLog("Steal response", resp);
        log("Device connection stolen and previous action cancelled");
    },

    // ui/informational actions
    listDevices: () => {
        if (!devices.length) {
            log("No devices found.");
            return
        }
        log("Listing devices");
        devices.map((d, i) => {
            const feat = d.device.features;
            if (d.state === "connected") {
                log("Device %d (%s): %s (%s)", i, d.state, feat.device_id, feat.label);
            } else {
                log("Device %d (%s)", i, d.state);
            }
        });
        log("End of device list");
    },

    showFeatures: () => {
        log("Features of current device");
        log(JSON.stringify(currentDevice().features, null, 2));
    }
};

function setDeviceListeners(device) {

    device.on("pin", async (str, cb) => {
        try {
            const inp = await ui.queryForPin();
            debugLog("Got pin %s", inp);
            cb(null, inp.trim());
        } catch (error) {
            log("Error waiting for pin: %s", error);
            cb(error, "");
        }
    });

    device.on("passphrase", async (cb) => {
        try {
            const inp = await ui.queryInput("Type the passphrase");
            cb(null, inp.trim());
        } catch (error) {
            log("Error waiting for passphrase: %s", error);
            cb(error, "");
        }
    });

    device.on("word", async cb => {
        try {
            const inp = await ui.queryInput("Type the requested word");
            cb(null, inp.trim());
        } catch (error) {
            log("Error waiting for word: %s", error);
            cb(error, "");
        }
    });

}

// start of main procedure

ui.buildUI(uiActions);
ui.runUI();

devList = new trezor.DeviceList({ debug });

log("Got device list");
devList.on("connect", device => {
    log("Device connected", device.features.device_id);
    devices.push({ state: "connected", device });
    setDeviceListeners(device);
    // setTimeout(() => main(device), 1000);
});
devList.on("error", err => log("EEEERRRRORRR", err));
devList.on("connectUnacquired", device => {
    log("Detected device in use");
    devices.push({ state: "unacquired", device });
});
devList.on("disconnectUnacquired", () => log("disconnectUnaquired"));
devList.on("disconnect", device => log("device disconnected", device.features.device_id));
devList.on("transport", t => {
    log("transport obtained", t.activeName, t.version);
    exitSoon();
});
