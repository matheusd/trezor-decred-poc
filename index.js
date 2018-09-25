import * as services from "./dcrwallet-api/api_grpc_pb";
import * as wallet from "./helpers/wallet";
import * as networks from "./helpers/networks";
import * as ui from "./ui";
import * as trezor from "trezor.js";
import * as trezorHelpers from "./helpers/trezor";
import * as fs from "fs";
import * as homescreens from "./helpers/homescreens";

import { InitService, WalletCredentials } from "./helpers/services";
import { rawToHex, rawHashToHex, reverseHash, str2hex, hex2b64, str2utf8hex } from "./helpers/bytes";
import { sprintf } from "sprintf-js";
import { globalCryptoShim } from "./helpers/random";

// app constants
const coin = "Decred Testnet";
const coinNetwork = networks.decred;
const walletCredentials = WalletCredentials("127.0.0.1", 19121,
    "/home/user/.config/decrediton/wallets/testnet/trezor/rpc.cert");
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
var devList;
var devices = [];
var currentDeviceIndex = 0;
var publishTxs = false;

function currentDevice() {
    if (!devices[currentDeviceIndex]) {
        throw "Selected device not available";
    }
    if (devices[currentDeviceIndex].state !== "connected") {
        throw "Selected device not connected";
    }
    return devices[currentDeviceIndex].device;
}

function replaceDevice(path, newDevice) {
    const idx = devices.findIndex(d => d.device.originalDescriptor.path === path)
    if ((idx === -1) && !newDevice) {
        // nothing to do, as we're trying to remove a device that never existed
    } else if ((idx > -1) && !newDevice) {
        // just remove the existing device
        devices.splice(idx, 1);
    } else if (idx === -1) {
        // new device. Add to list.
        devices.push(newDevice);
    } else {
        // existing device. Replace.
        devices.splice(idx, 1, newDevice);
    }

    if (currentDeviceIndex >= devices.length) {
        currentDeviceIndex = Math.max(devices.length -1, 0);
        uiActions.changeActiveDevice(currentDeviceIndex);
    } else if (currentDeviceIndex === idx) {
        uiActions.changeActiveDevice(currentDeviceIndex);
    } else if ((idx > -1) && (idx < currentDeviceIndex)) {
        currentDeviceIndex--;
        uiActions.changeActiveDevice(currentDeviceIndex);
    }
}

function loadDeviceList() {
    devList = new trezor.DeviceList({ debug });

    log("Got device list");
    devList.on("connect", device => {
        log("Device connected", device.features.device_id);
        replaceDevice(device.originalDescriptor.path, { state: "connected", device })
        setDeviceListeners(device);
        if (devices.length === 1) {
            ui.setActiveDeviceLabel(sprintf("0 '%s'", device.features.label));
        }
    });
    devList.on("error", err => {
        if (err instanceof Error) {
            log("Error:", err.message);
            debugLog(err.stack);
        } else {
            log("Error:", err);
        }
    });
    devList.on("connectUnacquired", device => {
        log("Detected device in use");
        replaceDevice(device.originalDescriptor.path, { state: "unacquired", device })
    });
    devList.on("disconnectUnacquired", device => {
        log("Unacquired device disconnected");
        replaceDevice(device.originalDescriptor.path, null);
    });
    devList.on("disconnect", device => {
        log("Device disconnected", device.features.device_id);
        replaceDevice(device.originalDescriptor.path, null);
    });
    devList.on("transport", t => {
        log("Transport obtained", t.activeName, t.version);
    });
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

    getHDPath: () => currentDevice().run(async session => {
        let input = await ui.queryInput("HD Path (use ' for hardened)")
        input = input.split(" ").filter(v => v.length > 0)
        const path = trezorHelpers.pathDefinition2path(input);

        const res = await session.getPublicKey(path, coin, false);
        log("Extended PubKey %s", res.message.xpub);

        const resp = await session.getAddress(path, coin, false);
        log("Address: %s", resp.message.address);
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
            str2utf8hex(testMessage), coin, false);

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
        const destAddress = await ui.queryInput("Destination Address", "TsfDLrRkk9ciUuwfp2b8PawwnukYD7yAjGd");
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
            inputTxs, wsvc);
        const refTxs = inputTxs.map(trezorHelpers.walletTxToRefTx);
        log("Going to sign tx on trezor");
        const signedResp = await session.signTx(txInfo.inputs, txInfo.outputs, refTxs, coin, 0);
        const signedRaw = signedResp.message.serialized.serialized_tx;
        log("Successfully signed tx");

        if (!publishTxs) {
            log("Raw signed hex tx follows.");
            log(signedRaw);
            return;
        }

        const txHash = await wallet.publishTransaction(wsvc, signedRaw);
        log("Published tx", txHash);
    }),

    stealDevice: async () => {
        log("Trying to steal device connection");
        await devices[currentDeviceIndex].device.steal();
        debugLog("Steal response", resp);
        log("Device connection stolen and previous action cancelled");
    },

    installFirmware: () => currentDevice().run(async session => {
        if (currentDevice().features.major_version != 1) {
            throw "Unsupported model for firmware upgrade";
        }

        const firmwarePath = firmwareV1Location;

        log("Installing firmware from %s", firmwarePath);
        const rawFirmware = fs.readFileSync(firmwarePath);
        log("Read firmware. Size: %f KB", rawFirmware.length / 1000);
        const hexFirmware = rawToHex(rawFirmware);
        debugLog("got hex", hexFirmware);
        await session.updateFirmware(hexFirmware);
        log("Firmware installed");
    }),

    initDevice: () => currentDevice().run(async session => {
        const settings = {
            strength: 256,
            passphrase_protection: false,
            pin_protection: false,
            label: "New DCR Trezor",
        };
        log("Initializing device");
        await session.resetDevice(settings);
        log("Device initialized with new seed");
    }),

    changeHomeScreen: () => currentDevice().run(async session => {
        log("Changing home screen to DCR");
        await session.changeHomescreen(homescreens.decred);
    }),

    reloadDeviceList: () => {
        devices.splice(0, devices.length);
        currentDeviceIndex = 0;
        log("Reloading device list");
        loadDeviceList();
    },

    // ui/informational/state actions
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
    },

    changeActiveDevice: index => {
        if (!devices[index]) throw sprintf("Device %d does not exist", index);

        currentDeviceIndex = index;
        log("Changed active device to", index);

        if (devices[index].state !== "connected") {
            log("Current device NOT connected");
            ui.setActiveDeviceLabel(sprintf("%d (unconnected)", index));
            return;
        }

        const bool = b => b ? "true" : "false"
        const feat = currentDevice().features;
        const version = feat.major_version + "." + feat.minor_version + "." +
            feat.patch_version;
        log("id=%s  label='%s'   model=%d   version=%s", feat.device_id,
            feat.label, feat.model, version);
        log("initialized=%s   pin_protection=%s    passphrase_protection=%s",
            bool(feat.initialized), bool(feat.pin_protection), bool(feat.passphrase_protection));
        log("imported=%s   needs_backup=%s   unfinished_backup=%s",
            bool(feat.imported), bool(feat.needs_backup), bool(feat.unfinished_backup));
        ui.setActiveDeviceLabel(sprintf("%d '%s'", index, feat.label));
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
        debugLog(resp.toObject());
        log("Resulting P2SH Address: %s", resp.getP2shAddress());
    },

    purchaseTickets: () => currentDevice().run(async session => {

        const numTickets = parseInt(await ui.queryInput("Number of Tickets"));
        if (!numTickets) return;

        const wsvc = await InitService(services.WalletServiceClient, walletCredentials);
        const decodeSvc = await InitService(services.DecodeMessageServiceClient, walletCredentials);

        const bestBlock = await wallet.bestBlock(wsvc);

        const passphrase = "";
        const accountNum = 0;
        const spendLimit = 21e15;
        const requiredConf = 1;
        const expiry = bestBlock.getHeight() + 16;
        const ticketFee = 1e5;
        const txFee = 1e5;
        const stakepool = {
            TicketAddress: "TcdKvojDtivHbWyVUff8R8qJ56mnUSDUypz",
            PoolAddress: "TseWciFBQa2Ra5jtXuyg8CBNopeM133c7Uy",
            PoolFees: 7.5,
        };

        const resp = await wallet.purchaseTickets(wsvc, passphrase, accountNum,
            spendLimit, requiredConf, numTickets, expiry, ticketFee, txFee,
            stakepool);

        debugLog("Got tickets from wallet");
        debugLog(resp.toObject());

        const signSplitTx = async rawUnsigTx => {
            const decodedUnsigTx = await wallet.decodeTransaction(decodeSvc, rawUnsigTx)
            const inputTxs = await wallet.getInputTransactions(wsvc, decodeSvc, decodedUnsigTx);
            const txInfo = await trezorHelpers.walletTxToBtcjsTx(decodedUnsigTx, inputTxs, wsvc);
            const refTxs = inputTxs.map(trezorHelpers.walletTxToRefTx);
            const signedResp = await session.signTx(txInfo.inputs, txInfo.outputs, refTxs, coin, 0);
            const signedRaw = signedResp.message.serialized.serialized_tx;
            return signedRaw
        };

        const signTicketTx = async (rawUnsigTx, decodedSplit, splitRefTx) => {
            const decodedUnsigTx = await wallet.decodeTransaction(decodeSvc, rawUnsigTx)
            const txInfo = await trezorHelpers.walletTxToBtcjsTx(decodedUnsigTx, [decodedSplit], wsvc);
            const signedResp = await session.signTx(txInfo.inputs, txInfo.outputs, [splitRefTx], coin, 0);
            const signedRaw = signedResp.message.serialized.serialized_tx;
            return signedRaw
        };

        const signedSplit = await signSplitTx(resp.getSplitBytes());
        const decodedSplit = await wallet.decodeTransaction(decodeSvc, signedSplit);
        const splitRefTx = trezorHelpers.walletTxToRefTx(decodedSplit);
        log("Signed Split Transaction");
        log(signedSplit);

        const unsignedTickets = resp.getTicketsBytesList();
        for (let i = 0; i < unsignedTickets.length; i++) {
            const signed = await signTicketTx(unsignedTickets[i], decodedSplit, splitRefTx);
            log("Signed Ticket %d", i);
            log(signed);
        }
    }),

    togglePublishTxs: () => {
        publishTxs = !publishTxs;
        ui.setPublishTxsState(publishTxs);
    },
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
setTimeout(loadDeviceList, 1000);
