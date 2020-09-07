import * as wallet from "./wallet";
import { rawHashToHex, rawToHex } from "./bytes";
import { networks, address } from "@trezor/utxo-lib";

const Buffer = require('safe-buffer').Buffer

const hardeningConstant = 0x80000000;
const cointype = 1; // 0 = bitcoin, 42 = decred, 1 = decred testnet
const testnetTicketPoolSize = 1024
const testnetSubsidyReductionInterval = 2048
const testnetWorkRewardProportion = 6
const testnetStakeRewardProportion = 3
const testnetBlockTaxProportion = 1
const testnetTicketsPerBlock = 5
const testnetMulSubsidy = 100
const testnetDivSubsidy = 101
const testnetBaseSubsidy = 2500000000
const simnetTicketPoolSize = 64
const simnetSubsidyReductionInterval = 128
const simnetWorkRewardProportion = 6
const simnetStakeRewardProportion = 3
const simnetBlockTaxProportion = 1
const simnetTicketsPerBlock = 5
const simnetMulSubsidy = 100
const simnetDivSubsidy = 101
const simnetBaseSubsidy = 50000000000
const defaultTicketFeeLimits = 0x5800



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
        const pushIt = {
            prev_hash: rawHashToHex(inp.getPreviousTransactionHash()),
            prev_index: inp.getPreviousTransactionIndex(),
            amount: inp.getAmountIn().toString(),
            sequence: inp.getSequence(),
            address_n: addressPath(addrIndex, addrBranch),
            decred_tree: inp.getTree(),
        }
        inputs.push(pushIt);
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
        const pushIt = {
            amount: outp.getValue().toString(),
            script_type: "PAYTOADDRESS", // needs to change on OP_RETURNs
        }
        if (address_n) {
          pushIt.address_n = address_n
        } else {
          pushIt.address = addr
        }

        outputs.push(pushIt);
    }

    const txInfo = {
        lock_time: tx.getLockTime(),
        version: tx.getVersion(),
        expiry: tx.getExpiry(),
        inputs: inputs,
        outputs: outputs
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
        script_sig: inp.getSignatureScript(),
        decred_tree: inp.getTree(),
    }));

    const bin_outputs = tx.getOutputsList().map(outp => ({
        amount: outp.getValue(),
        script_pubkey: rawToHex(outp.getScript()),
        decred_script_version: outp.getVersion(),
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

// stakePoolTicketFee determines the stake pool ticket fee for a given ticket
// from the passed percentage. Pool fee as a percentage is truncated from 0.01%
// to 100.00%. This all must be done with integers.
export function stakePoolTicketFee(stakeDiff, relayFee, height, poolFee) {
  /*
  Args:
      stakeDiff (int): The ticket price.
      relayFee (int): Transaction fees.
      height (int): Current block height.
      poolFee (int): The pools fee, as percent.

  Returns:
      int: The stake pool ticket fee.
  */

  // Shift the decimal two places, e.g. 1.00%
  // to 100. This assumes that the proportion
  // is already multiplied by 100 to give a
  // percentage, thus making the entirety
  // be a multiplication by 10000.
  const poolFeeInt = Math.floor(poolFee * 100)
  console.log("poolFeeInt", poolFeeInt)

  // Subsidy is fetched from the blockchain package, then
  // pushed forward a number of adjustment periods for
  // compensation in gradual subsidy decay. Recall that
  // the average time to claiming 50% of the tickets as
  // votes is the approximately the same as the ticket
  // pool size (netParams.TicketPoolSize), so take the
  // ceiling of the ticket pool size divided by the
  // reduction interval.
  const adjs = Math.ceil(simnetTicketPoolSize / simnetSubsidyReductionInterval)
  console.log("adjs", adjs)
  var subsidy = calcStakeVoteSubsidy(height)
  for (const _ of Array(adjs).keys()) {
    console.log("doing")
    subsidy *= 100
    subsidy = Math.floor(subsidy / 101)
  }
  console.log("subsidy", subsidy)

  // The numerator is (p*10000*s*(v+z)) << 64.
  const shift = BigInt(64)
  const s = subsidy
  const v = Math.floor(stakeDiff)
  const z = Math.floor(relayFee)
  var num = BigInt(poolFeeInt)
  num *= BigInt(s)
  const vPlusZ = v + z
  num *= BigInt(vPlusZ)
  console.log("num", num)
  num = num << shift
  console.log("num", num)

  // The denominator is 10000*(s+v).
  // The extra 10000 above cancels out.
  var den = s
  den += v
  den *= 10000

  // Divide and shift back.
  num = num / BigInt(den)
  num = num >> shift
  console.log("num", num)

  return Number(num)
}

// CalcStakeVoteSubsidy returns the subsidy for a single stake vote for a block.
// It is calculated as a proportion of the total subsidy and max potential
// number of votes per block.
function calcStakeVoteSubsidy(height) {
  /*
  Unlike the Proof-of-Work and Treasury subsidies, the subsidy that votes
  receive is not reduced when a block contains less than the maximum number of
  votes.  Consequently, this does not accept the number of votes.  However, it
  is important to note that blocks that do not receive the minimum required
  number of votes for a block to be valid by consensus won't actually produce
  any vote subsidy either since they are invalid.

  This function is safe for concurrent access.
  */
  // Calculate the full block subsidy and reduce it according to the stake
  // proportion.  Then divide it by the number of votes per block to arrive
  // at the amount per vote.
  var subsidy = calcBlockSubsidy(height)
  const proportions = simnetWorkRewardProportion + simnetStakeRewardProportion + simnetBlockTaxProportion
  subsidy *= simnetStakeRewardProportion
  subsidy = Math.floor(subsidy / (proportions * simnetTicketsPerBlock))

  return subsidy
}

// calcBlockSubsidy returns the max potential subsidy for a block at the
// provided height.  This value is reduced over time based on the height and
// then split proportionally between PoW, PoS, and the Treasury.
function calcBlockSubsidy(height) {
  // Calculate the subsidy by applying the appropriate number of
  // reductions per the starting and requested interval.
  const reductionMultiplier = simnetMulSubsidy
  const reductionDivisor = simnetDivSubsidy
  var subsidy = simnetBaseSubsidy
  const neededIntervals = Math.floor(height / simnetSubsidyReductionInterval)
  for (const _ of Array(neededIntervals).keys()) {
    subsidy *= reductionMultiplier
    subsidy = Math.floor(subsidy / reductionDivisor)

    // Stop once no further reduction is possible.
    if (subsidy == 0) break
  }
  return subsidy
}

export function makeCommitmentPush(addr, price, isP2SH) {
  const pkh = address.fromBase58Check(addr, networks.decredSim).hash
  const b = Buffer.alloc(30)
  pkh.copy(b, 0)
  b.writeUInt8(price&0xFF, 20)
  b.writeUInt8((price>>8)&0xFF, 21)
  b.writeUInt8((price>>16)&0xFF, 22)
  b.writeUInt8(price>>24, 23)
  b.writeUInt8(58, 29)
  if (isP2SH) b[27] |= 1 << 7
  return b.toString('hex')
}

export function random32() {
  return Math.floor(Math.random() << 32)
}
