import * as wallet from './wallet'
import { rawHashToHex, rawToHex, hexToRaw } from './bytes'
import { networks, Transaction } from 'utxo-lib'
import { sprintf } from 'sprintf-js'

const axios = require('axios').default

const hardeningConstant = 0x80000000
const cointype = 1 // 0 = bitcoin, 42 = decred, 1 = decred testnet

export function addressPath (index, branch) {
  return [
    (44 | hardeningConstant) >>> 0, // purpose
    (cointype | hardeningConstant) >>> 0, // coin type
    (0 | hardeningConstant) >>> 0, // account
    (branch || 0) >>> 0, // branch
    index >>> 0 // index
  ]
}

export function accountPath (account) {
  return [
    (44 | hardeningConstant) >>> 0, // purpose
    (cointype | hardeningConstant) >>> 0, // coin type
    (account | hardeningConstant) >>> 0 // account
  ]
}

export function pathDefinition2path (path) {
  return path.map(v => {
    const hardened = v[v.length - 1] === "'"
    const nb = parseInt(hardened ? v.substring(0, v.length - 1) : v)
    if (hardened) return (nb | hardeningConstant) >>> 0
    else return nb >>> 0
  })
}

/******************************************************************************
 * Trezor Helpers
 ******************************************************************************/

// walletTxToBtcjsTx converts a tx decoded by the decred wallet (ie,
// returned from the decodeRawTransaction call) into a bitcoinjs-compatible
// transaction (to be used in trezor)
export async function walletTxToBtcjsTx (tx, changeIndexes, inputTxs, walletSvc) {
  const inputTxsMap = inputTxs.reduce((m, tx) => {
    m[rawHashToHex(tx.getTransactionHash())] = tx
    return m
  }, {})

  const inputs = []
  for (const inp of tx.getInputsList()) {
    const inputTx = inputTxsMap[rawHashToHex(inp.getPreviousTransactionHash())]
    if (!inputTx) {
      throw Error('Cannot sign transaction without knowing source tx ' +
            rawHashToHex(inp.getPreviousTransactionHash()))
    }

    const inputTxOut = inputTx.getOutputsList()[inp.getPreviousTransactionIndex()]
    if (!inputTxOut) {
      throw Error(sprintf('Trying to use unknown outpoint %s:%d as input',
        rawHashToHex(inp.getPreviousTransactionHash()), inp.getPreviousTransactionIndex()))
    }

    const addr = inputTxOut.getAddressesList()[0]
    if (!addr) {
      throw Error(sprintf('Outpoint %s:%d does not have addresses.',
        rawHashToHex(inp.getPreviousTransactionHash()), inp.getPreviousTransactionIndex()))
    }

    const addrValidResp = await wallet.validateAddress(walletSvc, addr)
    if (!addrValidResp.getIsValid()) throw Error('Input has an invalid address ' + addr)

    // Trezor firmware (mcu) currently (2018-06-25) only support signing
    // when all inputs of the transaction are from the wallet. This happens
    // due to the fact that trezor firmware re-calculates the source
    // pkscript given the address_n of the input, instead of using it (the
    // pkscript) directly when hashing the tx prior to signing. This needs
    // to be changed so that we can perform more advanced types of
    // transactions.
    if (!addrValidResp.getIsMine()) throw Error('Trezor only supports signing when all inputs are from the wallet.')

    const addrIndex = addrValidResp.getIndex()
    const addrBranch = addrValidResp.getIsInternal() ? 1 : 0
    const pushIt = {
      prev_hash: rawHashToHex(inp.getPreviousTransactionHash()),
      prev_index: inp.getPreviousTransactionIndex(),
      amount: inp.getAmountIn().toString(),
      sequence: inp.getSequence(),
      address_n: addressPath(addrIndex, addrBranch),
      decred_tree: inp.getTree(),
      script_type: 'SPENDADDRESS'
    }
    inputs.push(pushIt)
  }

  const outputs = []
  for (const outp of tx.getOutputsList()) {
    if (outp.getAddressesList().length !== 1) {
      // TODO: this will be true on OP_RETURNs. Support those.
      throw Error('Output has different number of addresses than expected')
    }
    let addr = outp.getAddressesList()[0]
    const addrValidResp = await wallet.validateAddress(walletSvc, addr)
    if (!addrValidResp.getIsValid()) throw Error('Not a valid address: ' + addr)
    let address_n = null

    if (changeIndexes.includes(outp.getIndex())) {
      const addrIndex = addrValidResp.getIndex()
      const addrBranch = addrValidResp.getIsInternal() ? 1 : 0
      address_n = addressPath(addrIndex, addrBranch)
      addr = null
    }
    const pushIt = {
      amount: outp.getValue().toString(),
      script_type: 'PAYTOADDRESS' // needs to change on OP_RETURNs
    }
    if (address_n) {
      pushIt.address_n = address_n
    } else {
      pushIt.address = addr
    }

    outputs.push(pushIt)
  }

  const txInfo = {
    lock_time: tx.getLockTime(),
    version: tx.getVersion(),
    expiry: tx.getExpiry(),
    inputs: inputs,
    outputs: outputs
  }

  return txInfo
}

// walletTxToRefTx converts a tx decoded by the decred wallet into a trezor
// RefTransaction object to be used with SignTx.
export function walletTxToRefTx (tx) {
  const inputs = tx.getInputsList().map(inp => ({
    prev_hash: rawHashToHex(inp.getPreviousTransactionHash()),
    prev_index: inp.getPreviousTransactionIndex(),
    script_sig: inp.getSignatureScript(),
    decred_tree: inp.getTree(),
    sequence: inp.getSequence()
  }))

  const bin_outputs = tx.getOutputsList().map(outp => ({
    amount: outp.getValue().toString(),
    script_pubkey: rawToHex(outp.getScript()),
    decred_script_version: outp.getVersion()
  }))

  const txInfo = {
    hash: rawHashToHex(tx.getTransactionHash()),
    lock_time: tx.getLockTime(),
    version: tx.getVersion(),
    expiry: tx.getExpiry(),
    inputs,
    bin_outputs
  }

  return txInfo
}

export const conToTrezCoinParams = (coin) => {
  switch (coin) {
    case 'Decred':
      return networks.decred
    case 'Decred Testnet':
      return networks.decredTest
    default:
      throw Error('unsupported coin ' + coin)
  }
}

export const payVSPFee = async (wsvc, decodeSvc, votingSvc, host, txHex, parentTxHex, votingKey, accountNum, coin, signFn, sendFn, log) => {
  // Gather information about the ticket.
  const net = conToTrezCoinParams(coin)
  const decodedTicket = await wallet.decodeTransaction(
    decodeSvc,
    hexToRaw(txHex)
  )
  const commitmentAddr = decodedTicket.getOutputsList()[1].array[7][0]
  const txHash = Transaction.fromHex(txHex, net).getId()
  // Request fee info from the vspd.
  let req = {
    timestamp: +new Date(),
    tickethash: txHash,
    tickethex: txHex,
    parenthex: parentTxHex
  }
  let jsonStr = JSON.stringify(req)
  log('Signing message to request fee from vsp at ' + host)
  let sig = await signFn(commitmentAddr, jsonStr)
  // This will throw becuase of http.status 400 if already paid.
  // TODO: Investigate whether other fee payment errors will cause this to
  // throw. Other fee payment errors should continue, and we should only stop
  // here if already paid or the ticket is not found by the vsp.
  let res = null
  try {
    res = await getFeeAddress({ host, sig, req })
  } catch (error) {
    if (error.response && error.response.data && error.response.data.message) {
      // NOTE: already paid is error.response.data.code == 3
      throw Error(error.response.data.message)
    }
    throw error
  }
  const payAddr = res.feeaddress
  const fee = res.feeamount
  const outputs = [{ destination: payAddr, amount: fee }]
  const txResp = await wallet.constructTransaction(
    wsvc,
    accountNum,
    0,
    outputs
  )
  const unsignedTx = txResp.res.array[0]
  const decodedInp = await wallet.decodeTransaction(
    decodeSvc,
    unsignedTx
  )
  let changeIndex = 0
  for (const out of decodedInp.getOutputsList()) {
    const addr = out.array[7][0]
    const addrValidResp = await wallet.validateAddress(wsvc, addr)
    if (addrValidResp.getIsInternal()) {
      break
    }
    changeIndex++
  };
  log('Signing fee transaction.')
  const feeTx = await sendFn(unsignedTx, [changeIndex])
  log('Waiting 5 seconds for the fee tx to propogate throughout the network.')
  await new Promise(r => setTimeout(r, 5000))

  // Send ticket fee data and voting chioces back to the vsp.
  const voteChoicesRes = await wallet.getVoteChoices(votingSvc)
  const voteChoices = {}
  for (const choice of voteChoicesRes.getChoicesList()) {
    voteChoices[choice.array[0]] = choice.array[2]
  }
  req = {
    timestamp: +new Date(),
    tickethash: txHash,
    feetx: feeTx,
    votingkey: votingKey,
    votechoices: voteChoices
  }
  jsonStr = JSON.stringify(req)
  log('Signing message to inform vsp of fee.')
  sig = await signFn(commitmentAddr, jsonStr)
  try {
    await payFee({ host, sig, req })
  } catch (error) {
    if (error.response && error.response.data && error.response.data.message) {
      throw error.response.data.message
    }
    throw error
  }
  log('Successfully purchased ticket!\nhash: ' + txHash + '\nfrom: ' + host + '\nfor (atoms): ' + decodedTicket.getOutputsList()[0].array[0] + '\nwith fee (atoms): ' + fee)
}

// getFeeAddress gets a ticket`s fee address.
async function getFeeAddress ({ host, sig, req }) {
  return POST(host + '/api/v3/feeaddress', sig, req)
}

// payFee informs of a ticket`s fee payment.
async function payFee ({ host, sig, req }) {
  return POST(host + '/api/v3/payfee', sig, req)
}

const POST = async (path, vspClientSig, json) => {
  const config = {
    headers: {
      'VSP-CLIENT-SIGNATURE': vspClientSig
    }
  }
  console.log(JSON.stringify(path, null, 2))
  console.log(JSON.stringify(config, null, 2))
  console.log(JSON.stringify(json, null, 2))
  const res = await axios.post(path, json, config)
  console.log(JSON.stringify(res.data, null, 2))
  return res.data
}
