import { InitService, WalletCredentials } from "./helpers/services";
import * as services from "./dcrwallet-api/api_grpc_pb";
import * as wallet from "./helpers/wallet";
import * as networks from "./helpers/networks";
import { rawToHex, rawHashToHex } from "./helpers/bytes";

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
    // "/home/user/.config/decrediton/wallets/testnet/default-wallet/rpc.cert");

function addressPath(index) {
    return [
        (44 | hardeningConstant) >>> 0, // purpose
        (cointype | hardeningConstant) >>> 0, // coin type
        (0 | hardeningConstant) >>> 0, // account
        0, // branch
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

    device.waitForSessionAndRun(async session => {
        log("got session");
        session.debug = debug;
        // await testGetAddress(session);
        // await testGetMasterPubKey(session);
        // await testSignMessage(session);
        await testSignTransaction(session);

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

    const txInfo = walletTxToBtcjsTx(decodedUnsigTx, rawUnsigTxResp.res.getChangeIndex());
    const refTxs = inputTxs.map(walletTxToRefTx);
    const signedResp = await session.signTx(txInfo.inputs, txInfo.outputs, refTxs, coin, 0);
    const signedRaw = signedResp.message.serialized.serialized_tx;
    log("got successful signed response. Raw signed tx follows");
    log(signedRaw);
    log("");
    log("unsinged tx")
    log(rawUnsigTx);
    log("");

    // let txDesc = {
    //     inputs_count: txInfo.inputs.length,
    //     outputs_count: txInfo.outputs.length,
    //     coin_name: coin.charAt(0).toUpperCase() + coin.slice(1),
    //     lock_time: 0,
    // };

    // await session.getFeatures();
    // log("got features before sign");
    // const res = await session.typedCall('SignTx', 'TxRequest', txDesc)
    // log("got res from signTx", res);
    // processTxRequest(session, res.message, serializedTx, signatures, index, inputs, outputs)
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
function walletTxToBtcjsTx(tx, changeIndex) {
    const inputs = tx.getInputsList().map(inp => ({
        prev_hash: rawHashToHex(inp.getPreviousTransactionHash()),
        prev_index: inp.getPreviousTransactionIndex(),
        amount: inp.getAmountIn(),
        // amount: 2e8,
        // amount: -,
        sequence: inp.getSequence(),
        address_n: addressPath(0), // <--- this will be tricky.
        // decredTree: inp.getTree(),
        // decredScriptVersion: 0,
    }));

    log("xxxxxxx change index", changeIndex);

    // TODO: fail if len([i].getAddressesList()) != 1
    // TODO: fail if version != 0
    const outputs = tx.getOutputsList().map((outp, idx) => ({
        amount: outp.getValue(),
        script_type: "PAYTOADDRESS",
        address: idx === changeIndex ? null : outp.getAddressesList()[0],
        address_n: idx === changeIndex ? addressPath(0) : null,
    }));
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
        // decredTree: inp.getTree(),
        // decredScriptVersion: 0,
    }));

    // TODO: fail if len([i].getAddressesList()) != 1
    // TODO: fail if version != 0
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
    log("ref tx ready", txInfo);
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
