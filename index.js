import { InitService, WalletCredentials } from "./helpers/services";
import * as services from "./dcrwallet-api/api_grpc_pb";
import * as wallet from "./helpers/wallet";
import * as networks from "./helpers/networks";
import { rawToHex, rawHashToHex, reverseHash } from "./helpers/bytes";
import { sprintf } from "sprintf-js";
import { queryInput } from "./helpers/input";

var log = console.log;

var trezor = require("trezor.js");
var debug = false;

var devList = new trezor.DeviceList({ debug });

const coin = "Decred Testnet";
const coinNetwork = networks.decred;
const hardeningConstant = 0x80000000;
const cointype = 0; // 0 = bitcoin, 42 = decred
const walletCredentials = WalletCredentials("127.0.0.1", 19121,
    "/home/user/.config/decrediton/wallets/testnet/trezor/rpc.cert");

function addressPath(index, branch) {
    return [
        (44 | hardeningConstant) >>> 0, // purpose
        (cointype | hardeningConstant) >>> 0, // coin type
        (0 | hardeningConstant) >>> 0, // account
        (branch || 0) >>> 0, // branch
        index >>> 0  // index
    ]
}

function exitSoon() {
    // setTimeout(() => {
    //     log("exiting");
    //     process.exit();
    // }, 10000);
}

function main(device) {
    const feat = device.features;
    const devVersion = feat.major_version + "." + feat.minor_version + "." + feat.patch_version;
    log("testing device", feat.device_id)
    log("features:", "imported=", feat.imported, "  initialized=", feat.initialized,
        "  needs_backup=", feat.needs_backup);

    device.on("pin", async (str, cb) => {
        const inp = await queryInput("Asking for pin " + str + " > ");
        cb(null, inp.trim());
    });

    device.on("passphrase", async (cb) => {
        const inp = await queryInput("Asking for passphrase > ");
        cb(null, inp.trim());
    });

    device.waitForSessionAndRun(async session => {
        log("got session");
        session.debug = debug;
        // await testGetAddress(session);
        // await testGetMasterPubKey(session);
        // await testSignMessage(session);
        await testSignTransaction(session);
        // await testEnablePin(session);
        // await testDisablePin(session);
        // await testDisablePassphrase(session);
        // await testEnablePassphrase(session);
        log("================= done =====================");
    }).catch(err => log("Error in async main: ", err));
}

async function testGetAddress(session) {
    const addr = await session.getAddress(addressPath(0), coin, false);
    log("got addr", addr);
}

async function testGetMasterPubKey(session) {
    const path = [
        (44 | hardeningConstant) >>> 0, // purpose
        (cointype | hardeningConstant) >>> 0, // coin type
        (0 | hardeningConstant) >>> 0, // account
    ];
    const addr = await session.getPublicKey(path, coin, false);
    log("got masterPubKey addr", addr.message.xpub);
}

async function testSignMessage(session) {
    const testMessage = "Help me obi-wan kenobi. You're my last hope!"

    const signedMsg = await session.signMessage(addressPath(0),
        testMessage.hexEncode(), coin, false);

    log("Signed Message", signedMsg);

    const wsvcMsg = await InitService(services.MessageVerificationServiceClient, walletCredentials);
    log("got message verification svc from wallet", wsvcMsg);

    const verifyResp = await wallet.verifyMessage(wsvcMsg, signedMsg.message.address,
        testMessage, signedMsg.message.signature)
    log("got verify response", verifyResp.toObject());
}

async function testSignTransaction(session) {
    const wsvc = await InitService(services.WalletServiceClient, walletCredentials);
    const decodeSvc = await InitService(services.DecodeMessageServiceClient, walletCredentials);
    log("got wallet services");

    const output = { destination: "TseH9wPe4bfRqS2qwceAyjzNGFrMAPgzkvB", amount: 1e7}

    const rawUnsigTxResp = await wallet.constructTransaction(wsvc, 0, 1, [output])
    log("got raw unsig tx");
    const rawUnsigTx = rawToHex(rawUnsigTxResp.res.getUnsignedTransaction());
    // const rawUnsigTx = "0100000001313eac6b551840d8f5a15c137cbeccd444fa524bbb7ce18c7691a196e3b0f2280100000000ffffffff02acc8520b0000000000001976a914d40271e5720b1fb9118fa496309d0f5d84419fc788ac809698000000000000001976a914917118753f286996d98295e578167e09f270bd6888ac000000000000000001ffffffffffffffff00000000ffffffff00"

    const decodedUnsigTx = await wallet.decodeTransaction(decodeSvc, rawUnsigTx)
    log("got decoded unsigned tx");
    // decodedUnsigTx.getInputsList().forEach((t, i) => log("input", i, t.toObject()))
    // decodedUnsigTx.getOutputsList().forEach((t, i) => log("output", i, t.toObject()))

    const inputTxs = await wallet.getInputTransactions(wsvc, decodeSvc, decodedUnsigTx);
    log("got input txs");

    const txInfo = await walletTxToBtcjsTx(decodedUnsigTx,
        rawUnsigTxResp.res.getChangeIndex(), inputTxs, wsvc);
    const refTxs = inputTxs.map(walletTxToRefTx);
    const signedResp = await session.signTx(txInfo.inputs, txInfo.outputs, refTxs, coin, 0);
    const signedRaw = signedResp.message.serialized.serialized_tx;
    log("got successful signed response. Raw signed tx follows");
    log(signedRaw);
    log("");
    log("unsinged tx")
    log(rawUnsigTx);
    log("");
}

async function testEnablePin(session) {
    await session.changePin(false);
}

async function testDisablePin(session) {
    await session.changePin(true);
}

async function testEnablePassphrase(session) {
    await session.togglePassphrase(true);
}

async function testDisablePassphrase(session) {
    await session.togglePassphrase(false);
}

String.prototype.hexEncode = function(){
    var hex, i;

    var result = "";
    for (i=0; i<this.length; i++) {
        hex = this.charCodeAt(i).toString(16);
        result += ("000"+hex).slice(-4);
    }

    return result
}

// walletTxToBtcjsTx converts a tx decoded by the decred wallet (ie,
// returned from the decodeRawTransaction call) into a bitcoinjs-compatible
// transaction (to be used in trezor)
async function walletTxToBtcjsTx(tx, changeIndex, inputTxs, walletSvc) {
    const inputTxsMap = inputTxs.reduce((m, tx) => {
        m[rawHashToHex(tx.getTransactionHash())] = tx;
        return m;
    }, {});

    const inputs = [];
    for (const inp of tx.getInputsList()) {
        const inputTx = inputTxsMap[rawHashToHex(inp.getPreviousTransactionHash())];
        if (!inputTx) throw "Cannot sign transaction without knowing source tx " +
            rawHashToHex(inp.getPreviousTransactionHash());

        const inputTxOut = inputTx.getOutputsList()[inp.getPreviousTransactionIndex()];
        if (!inputTxOut) throw sprintf("Trying to use unknown outpoint %s:%d as input",
            rawHashToHex(inp.getPreviousTransactionHash()), inp.getPreviousTransactionIndex());

        const addr = inputTxOut.getAddressesList()[0];
        if (!addr) throw sprintf("Outpoint %s:%d does not have addresses.",
            rawHashToHex(inp.getPreviousTransactionHash()), inp.getPreviousTransactionIndex());

        const addrValidResp = await wallet.validateAddress(walletSvc, addr);
        if (!addrValidResp.getIsValid()) throw "Input has an invalid address " + addr;

        // Trezor firmware (mcu) currently (2018-06-25) only support signing
        // when all inputs of the transaction are from the wallet. This happens
        // due to the fact that trezor firmware re-calculates the source
        // pkscript given the address_n of the input, instead of using it (the
        // pkscript) directly when hashing the tx prior to signing. This needs
        // to be changed so that we can perform more advanced types of
        // transactions.
        if (!addrValidResp.getIsMine()) throw "Trezor only supports signing when all inputs are from the wallet.";

        const addrIndex = addrValidResp.getIndex();
        const addrBranch = addrValidResp.getIsInternal() ? 1 : 0;
        inputs.push({
            prev_hash: rawHashToHex(inp.getPreviousTransactionHash()),
            prev_index: inp.getPreviousTransactionIndex(),
            amount: inp.getAmountIn(),
            sequence: inp.getSequence(),
            address_n: addressPath(addrIndex, addrBranch),

            // FIXME: this needs to be supported on trezor.js.
            // decredTree: inp.getTree(),
            // decredScriptVersion: 0,
        });
    }

    const outputs = [];
    for (const outp of tx.getOutputsList()) {
        if (outp.getAddressesList().length != 1) {
            // TODO: this will be true on OP_RETURNs. Support those.
            throw "Output has different number of addresses than expected";
        }

        const addr = outp.getAddressesList()[0];
        const addrValidResp = await wallet.validateAddress(walletSvc, addr);
        if (!addrValidResp.getIsValid()) throw "Not a valid address: " + addr;
        let address_n = null;

        if (outp.getIndex() === changeIndex) {
            const addrIndex = addrValidResp.getIndex();
            const addrBranch = addrValidResp.getIsInternal() ? 1 : 0;
            address_n = addressPath(addrIndex, addrBranch);
            addr = null;
        }

        outputs.push({
            amount: outp.getValue(),
            script_type: "PAYTOADDRESS", // needs to change on OP_RETURNs
            address: addr,
            address_n: address_n,
        });
    }

    const txInfo = {
        lock_time: tx.getLockTime(),
        version: tx.getVersion(),
        expiry: tx.getExpiry(),
        inputs,
        outputs
    };
    return txInfo;
}

// walletTxToRefTx converts a tx decoded by the decred wallet into a trezor
// RefTransaction object to be used with SignTx.
function walletTxToRefTx(tx) {
    const inputs = tx.getInputsList().map(inp => ({
        amount: inp.getAmountIn(),
        prev_hash: rawHashToHex(inp.getPreviousTransactionHash()),
        prev_index: inp.getPreviousTransactionIndex(),

        // TODO: this needs to be supported on trezor.js
        // decredTree: inp.getTree(),
        // decredScriptVersion: 0,
    }));

    const bin_outputs = tx.getOutputsList().map(outp => ({
        amount: outp.getValue(),
        script_pubkey: rawToHex(outp.getScript()),
    }));
    const txInfo = {
        hash: rawHashToHex(tx.getTransactionHash()),
        lock_time: tx.getLockTime(),
        version: tx.getVersion(),
        expiry: tx.getExpiry(),
        inputs,
        bin_outputs,
    };
    return txInfo;
}

log("got device list");
devList.on("connect", device => {
    log("device connected", device.features.device_id);
    setTimeout(() => main(device), 1000);
});
devList.on("error", err => log("EEEERRRRORRR", err));
devList.on("connectUnacquired", () => log("connectUnaquired"));
devList.on("disconnectUnacquired", () => log("disconnectUnaquired"));
devList.on("disconnect", device => log("device disconnected", device.features.device_id));
devList.on("transport", t => {
    log("transport obtained", t.activeName, t.version);
    exitSoon();
});
