import * as wallet from "./wallet";
import { rawHashToHex, rawToHex } from "./bytes";

const hardeningConstant = 0x80000000;
const cointype = 1; // 0 = bitcoin, 42 = decred, 1 = decred testnet

export function addressPath(index, branch) {
    return [
        (44 | hardeningConstant) >>> 0, // purpose
        (cointype | hardeningConstant) >>> 0, // coin type
        (0 | hardeningConstant) >>> 0, // account
        (branch || 0) >>> 0, // branch
        index >>> 0  // index
    ]
}

export function accountPath(account) {
    return [
        (44 | hardeningConstant) >>> 0, // purpose
        (cointype | hardeningConstant) >>> 0, // coin type
        (account | hardeningConstant) >>> 0, // account
    ];
}

export function pathDefinition2path(path) {
    return path.map(v => {
        const hardened = v[v.length-1] === "'"
        const nb = parseInt(hardened ? v.substring(0, v.length-1) : v);
        if (hardened) return (nb | hardeningConstant) >>> 0
        else return nb >>> 0;
    });
}

/******************************************************************************
 * Trezor Helpers
 ******************************************************************************/

// walletTxToBtcjsTx converts a tx decoded by the decred wallet (ie,
// returned from the decodeRawTransaction call) into a bitcoinjs-compatible
// transaction (to be used in trezor)
export async function walletTxToBtcjsTx(tx, changeIndex, inputTxs, walletSvc) {
    const inputTxsMap = inputTxs.reduce((m, tx) => {
        m[rawHashToHex(tx.getTransactionHash())] = tx;
        return m;
    }, {});

    const inputs = [];
    for (const inp of tx.getInputsList()) {
        console.log("a2");
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
export function walletTxToRefTx(tx) {
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
