import * as services from './dcrwallet-api/api_grpc_pb'
import * as wallet from './helpers/wallet'
import * as ui from './ui'
import * as trezorHelpers from './helpers/trezor'
import * as homescreens from './helpers/homescreens'

import { InitService, WalletCredentials } from './helpers/services'
import { rawToHex, str2utf8hex } from './helpers/bytes'
import { globalCryptoShim } from './helpers/random'
import { ECPair } from 'utxo-lib'

// Handle the local config for wallet credentials and vsp config. Copy
// config.js.sample to config.js and adjust as needed.
try {
	require("./config.js");
} catch (error) {
	console.log("Create config.js file with the wallet config.")
	console.log(error);
	process.exit(1);
}
import { default as cfg } from "./config.js";

// app constants
const session = require('trezor-connect').default
const { TRANSPORT_EVENT, UI, UI_EVENT, DEVICE_EVENT } = require('trezor-connect')
const CHANGE = 'device-changed'
const DISCONNECT = 'device-disconnect'
const CONNECT = 'device-connect'
const AQUIRED = 'acquired'
const NOBACKUP = 'no-backup'
const TRANSPORT_ERROR = 'transport-error'
const TRANSPORT_START = 'transport-start'
const coin = 'Decred Testnet'
const walletCredentials = WalletCredentials(cfg.server, cfg.port,
  cfg.rpccert, cfg.clientcert, cfg.clientkey)

// helpers
const log = ui.log
const debugLog = ui.debugLog
console.log = ui.debugLog
console.warn = ui.debugLog
console.error = ui.debugLog

// this is needed because trezor.js does not recognize the node crypto module
global.crypto = globalCryptoShim

// app state
const devices = {}
// let publishTxs = false
let publishTxs = true

function onChange (features) {
  if (features == null) throw Error('no features on connect')
  devices[features.device_id] = features
}

function onDisconnect (id) {
  delete devices[id]
}

function noDevice () {
  if (Object.keys(devices).length === 0) {
    log('No devices.')
    return true
  }
  return false
}

const sendToAddress = async (destAddress, destAmount) => {
  if (noDevice()) return

  if (!destAddress) {
    const destAddress = await ui.queryInput('Destination Address', 'Tsm5vzkspGWW8zAVRy5FCEF2FKkrnMqgZuJ')
    if (!destAddress) return
  }

  if (!destAmount) {
    const destAmount = await ui.queryInput('Amount (in DCR)')
    if (!destAmount) return
  }

  const wsvc = await InitService(services.WalletServiceClient, walletCredentials)
  debugLog('Got wallet services')

  const output = { destination: destAddress, amount: Math.floor(destAmount * 1e8) }

  const rawUnsigTxResp = await wallet.constructTransaction(wsvc, 0, 0, [output])
  log('Got raw unsiged tx')

  const rawUnsigTx = rawToHex(rawUnsigTxResp.res.getUnsignedTransaction())
  debugLog('Raw unsigned tx hex follows')
  debugLog(rawUnsigTx)

  signTransaction(rawUnsigTx, [rawUnsigTxResp.res.getChangeIndex()])
}

const signTransaction = async (tx, changeIndexes) => {
  if (noDevice()) return

  const wsvc = await InitService(services.WalletServiceClient, walletCredentials)
  const decodeSvc = await InitService(services.DecodeMessageServiceClient, walletCredentials)
  debugLog('Got wallet services')

  const decodedUnsigTx = await wallet.decodeTransaction(decodeSvc, tx)
  log('Decoded unsigned tx')
  // decodedUnsigTx.getInputsList().forEach((t, i) => log("input", i, t.toObject()))
  // decodedUnsigTx.getOutputsList().forEach((t, i) => log("output", i, t.toObject()))

  const inputTxs = await wallet.getInputTransactions(wsvc, decodeSvc, decodedUnsigTx)
  log('Got input transactions (to extract pkscripts)')

  const txInfo = await trezorHelpers.walletTxToBtcjsTx(decodedUnsigTx,
    changeIndexes, inputTxs, wsvc)
  const refTxs = inputTxs.map(trezorHelpers.walletTxToRefTx)
  // Determine if this is paying from a stakegen or revocation, which are
  // special cases.
  for (let i = 0; i < txInfo.inputs.length; i++) {
    const input = txInfo.inputs[i]
    for (let j = 0; j < refTxs.length; j++) {
      const ref = refTxs[j]
      if (ref.hash && ref.hash === input.prev_hash) {
        let s = ref.bin_outputs[input.prev_index].script_pubkey
        if (s.length > 1) {
          s = s.slice(0, 2)
          switch (s) {
            case 'bc':
              input.script_type = 'SPENDSSRTX'
              break
            case 'bb':
              input.script_type = 'SPENDSSGEN'
              break
          }
        }
        break
      }
    }
  }
  log('Going to sign tx on trezor')
  const signedResp = await session.signTransaction({
    coin: coin,
    inputs: txInfo.inputs,
    outputs: txInfo.outputs,
    refTxs: refTxs
  })
  const signedRaw = signedResp.payload.serializedTx
  log('Successfully signed tx')
  log(JSON.stringify(signedResp.payload, null, 2))

  if (!publishTxs) {
    log('Raw signed hex tx follows.')
    log(signedRaw)
    return
  }
  const txHash = await wallet.publishTransaction(wsvc, signedRaw)
  log('Published tx', txHash)
  return signedRaw
}

const signMessage = async (addrStr, testMessage) => {
  if (noDevice()) return
  if (!testMessage) {
    testMessage = await ui.queryInput('Message to Sign')
    if (!testMessage) return
  }

  let args = []
  if (addrStr) {
    const wsvc = await InitService(services.WalletServiceClient, walletCredentials)
    const addrValidResp = await wallet.validateAddress(wsvc, addrStr)
    if (!addrValidResp.getIsValid()) { throw Error('Input has an invalid address ' + addrStr) }
    if (!addrValidResp.getIsMine()) { throw Error('Trezor only supports signing with wallet addresses') }
    const addrIndex = addrValidResp.getIndex()
    const addrBranch = addrValidResp.getIsInternal() ? 1 : 0
    args = [addrIndex, addrBranch]
  } else {
    const addrInput = await ui.queryInput('Address to use (index [branch])')
    args = addrInput.split(' ')
  }
  if (args.length < 1) return

  const address_n = trezorHelpers.addressPath(args[0], args[1])

  log("Signing message '%s'", testMessage)
  const signedMsg = await session.signMessage({
    path: address_n,
    coin: coin,
    message: str2utf8hex(testMessage),
    hex: true
  })

  const addr = signedMsg.payload.address
  const sig = signedMsg.payload.signature
  debugLog('Signed Message', signedMsg)
  log('Signed using address', addr)

  log('Decrediton verifiable sig', sig)

  const wsvcMsg = await InitService(services.MessageVerificationServiceClient, walletCredentials)
  debugLog('Got message verification svc from wallet')

  const verifyResp = await wallet.verifyMessage(wsvcMsg, addr,
    testMessage, sig)
  debugLog('Verification response', verifyResp.toObject())
  verifyResp.getValid() ? log('Verification PASSED!') : log('Verification FAILED!')
  return signedMsg.payload.signature
}

function setDeviceListeners (dispatch, getState) {
  session.on(TRANSPORT_EVENT, (event) => {
    const type = event.type
    switch (type) {
      case TRANSPORT_ERROR:
        break
      case TRANSPORT_START:
        break
    };
  })

  session.on(DEVICE_EVENT, (event) => {
    const type = event.type
    switch (type) {
      case CHANGE:
        if (event.payload && event.payload.type === AQUIRED) {
          onChange(event.payload)
        }
        break
      case CONNECT:
        break
      case DISCONNECT:
        onDisconnect(event.payload)
        break
    };
  })

  // TODO: Trezor needs some time to start listening for the responses to its
  // requests. Find a better way than static sleeps to accomplish this.
  session.on(UI_EVENT, async (event) => {
    const type = event.type
    switch (type) {
      case UI.REQUEST_CONFIRMATION:
        // Some requests require the device to be backed up. We are offered a
        // chance to start the backup now. Refuse and inform the user via
        // snackbar that they must backup before performing this operation.
        if (event.payload.view === NOBACKUP) {
          await new Promise(r => setTimeout(r, 2000))
          session.uiResponse({
            type: UI.RECEIVE_CONFIRMATION,
            payload: false
          })
        };
        break
      case UI.REQUEST_PASSPHRASE: {
        console.log('passphrase requested, waiting two seconds to respond')
        await new Promise(r => setTimeout(r, 2000))
        const inp = await ui.queryInput('Type the passphrase')
        session.uiResponse({
          type: UI.RECEIVE_PASSPHRASE,
          payload: {
            value: inp,
            save: true
          }
        })
        break
      }
      case UI.REQUEST_PIN: {
        console.log('pin requested, waiting two seconds to respond')
        await new Promise(r => setTimeout(r, 2000))
        const inp = await ui.queryInput('Type the pin')
        session.uiResponse({
          type: UI.RECEIVE_PIN,
          payload: inp
        })
        break
      }
      case UI.REQUEST_WORD: {
        console.log('word requested, waiting two seconds to respond')
        await new Promise(r => setTimeout(r, 2000))
        const inp = await ui.queryInput('Type the word')
        session.uiResponse({
          type: UI.RECEIVE_WORD,
          payload: inp
        })
        break
      }
    }
  })
}

function initTrezor () {
  session.init({
    connectSrc: 'https://localhost:8088/',
    lazyLoad: true,
    popup: false,
    manifest: {
      email: 'joegruffins@gmail.com',
      appUrl: 'https://github.com/decred/decrediton'
    },
    webusb: true
  })
    .then(
      log('TrezorConnect init ok')
    )
    .then(async () => {
      const res = await session.getFeatures()
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
    const res = await ui.queryInput('index [branch]')
    const args = res.split(' ')
    if (args.length < 1) return

    const address_n = trezorHelpers.addressPath(args[0], args[1])
    const resp = await session.getAddress({
      path: address_n,
      coin: coin,
      showOnTrezor: false
    })
    const addr = resp.payload.address
    log('Address: %s', addr)
  },

  updateFirmware: async () => {
    const features = await session.getFeatures()
    const model = features.payload.model
    try {
      const path = await ui.queryInput('Firmware path', cfg.firmwarePath)
      const rawFirmware = fs.readFileSync(path)
      let firmwareData
      // Current models are either 1 or "T".
      if (model === 1) {
        firmwareData = rawToHex(rawFirmware)
      } else {
        firmwareData = rawFirmware.buffer
      }
      await session.firmwareUpdate({
        binary: firmwareData
      })
      log('Updating complete.')
    } catch (error) {
      log(error)
    }
  },

  getMasterPubKey: async () => {
    if (noDevice()) return
    const account = parseInt(await ui.queryInput('Account #'))

    const path = trezorHelpers.accountPath(account)

    const res = await session.getPublicKey({
      path: path,
      coin: coin,
      showOnTrezor: false
    })
    log('Extended PubKey of account %d: %s', account, res.payload.xpub)
  },

  togglePinProtection: async () => {
    if (noDevice()) return
    const features = await session.getFeatures()
    const newVal = !!features.payload.pin_protection
    log('%s pin protection', newVal ? 'Disabling' : 'Enabling')
    await session.changePin({ remove: newVal })
  },

  togglePassphraseProtection: async () => {
    if (noDevice()) return
    const features = await session.getFeatures()
    const newVal = !!features.payload.passphrase_protection
    log('%s passphrase protection', newVal ? 'Disabling' : 'Enabling')
    await session.applySettings({ use_passphrase: !newVal })
  },

  wipeDevice: async () => {
    if (noDevice()) return
    log('Trying to wipe device')
    await session.wipeDevice()
  },

  recoverDevice: async () => {
    if (noDevice()) return
    log('Starting recover procedure')
    const wordCount = parseInt(await ui.queryInput('Number of recovery words (12, 18 or 24)'))
    if ([12, 18, 24].indexOf(wordCount) === -1) {
      throw Error('Not a valid word count')
    }

    const settings = {
      word_count: wordCount,
      passphrase_protection: false,
      pin_protection: false,
      label: 'New DCR Trezor',
      dry_run: false
    }

    const res = await session.recoveryDevice(settings)
    log(res.payload)
  },

  changeLabel: async () => {
    if (noDevice()) return
    log('Changing device label')
    const label = await ui.queryInput('New Label')
    await session.applySettings({ label: label })
  },

  signMessage: signMessage,

  signTransaction: sendToAddress,

  purchaseTicketV3: async () => {
    if (noDevice()) return
    const wsvc = await InitService(services.WalletServiceClient, walletCredentials)
    const decodeSvc = await InitService(services.DecodeMessageServiceClient, walletCredentials)
    const votingSvc = await InitService(services.VotingServiceClient, walletCredentials)

    try {
      // Disabled on mainnet.
      if (coin !== 'Decred Testnet') throw Error('can only be used on testnet')
      // TODO: Fill this with deterministic crypto magic.
      const privateKeySeed = Buffer.alloc(32)
      privateKeySeed[31] = 1
      const net = trezorHelpers.conToTrezCoinParams(coin)
      const ecp = ECPair.fromPrivateKeyBuffer(privateKeySeed, net)
      const votingKey = ecp.toWIF()
      const votingAddr = ecp.getAddress()
      // TODO: Add cspp purchasing.
      // TODO: Add multiple ticket purchasing.
      let res = await wallet.purchaseTicketsV3(wsvc, 1, cfg.vsp, {})
      const splitTx = res.getSplitTx()
      const decodedInp = await wallet.decodeTransaction(
        decodeSvc,
        splitTx
      )
      const changeIndexes = []
      for (let i = 0; i < decodedInp.getOutputsList().length; i++) {
        changeIndexes.push(i)
      };
      log('Signing split tx.')
      await signTransaction(splitTx, changeIndexes)
      let i = 0
      for (const ticketMap of res.getTicketsList()) {
        const ticket = Array.from(ticketMap.values())
        const decodedTicket = await wallet.decodeTransaction(
          decodeSvc,
          ticket
        )
        const inputTxs = await wallet.getInputTransactions(wsvc, decodeSvc, decodedTicket)
        const refTxs = inputTxs.map(trezorHelpers.walletTxToRefTx)
        // Seems like every other. TODO: figure out which value this is...
        const ticketOutN = i * 2
        const inAddr = decodedInp.getOutputsList()[ticketOutN].array[7][0]
        let addrValidResp = await wallet.validateAddress(wsvc, inAddr)
        const inAddr_n = trezorHelpers.addressPath(addrValidResp.getIndex(), 1)
        const commitAddr = decodedTicket.getOutputsList()[1].array[7][0]
        addrValidResp = await wallet.validateAddress(wsvc, commitAddr)
        const commitAddr_n = trezorHelpers.addressPath(addrValidResp.getIndex(), 1)
        const ticketInput = {
          address_n: inAddr_n,
          prev_hash: Buffer.from(Array.from(decodedTicket.getInputsList()[0].array[0].values())).reverse().toString('hex'),
          prev_index: ticketOutN,
          amount: decodedTicket.getInputsList()[0].array[4].toString()
        }
        const sstxsubmission = {
          script_type: 'SSTXSUBMISSIONPKH',
          address: votingAddr,
          amount: decodedTicket.getOutputsList()[0].array[0].toString()
        }
        // Trezor doesn't want opcodes included in op_return_data.
        const opScript = Array.from(decodedTicket.getOutputsList()[1].array[3].values())
        const ticketOPreturn = Buffer.from(opScript.slice(2)).toString('hex')
        const ticketsstxcommitment = {
          script_type: 'SSTXCOMMITMENTOWNED',
          op_return_data: ticketOPreturn,
          address_n: commitAddr_n,
          amount: '0'
        }
        const ticketsstxchange = {
          script_type: 'SSTXCHANGE',
          address: decodedTicket.getOutputsList()[2].array[7][0],
          amount: '0'
        }
        const inputs = [ticketInput]
        const outputs = [sstxsubmission, ticketsstxcommitment, ticketsstxchange]
        log('Signing ticket.')
        res = await session.signTransaction({
          coin: coin,
          inputs: inputs,
          outputs: outputs,
          refTxs: refTxs
        })
        const signedRaw = res.payload.serializedTx
        log(JSON.stringify(res.payload, null, 2))
        await wallet.publishTransaction(wsvc, signedRaw)
        // Pay fee.
        log('Waiting 5 seconds for the ticket to propogate throughout the network.')
        await new Promise(r => setTimeout(r, 5000))
        const host = 'https://' + cfg.vsp.host
        await trezorHelpers.payVSPFee(wsvc, decodeSvc, votingSvc, host, signedRaw, votingKey, 0, coin, signMessage, signTransaction, log)
        i++
      }
    } catch (error) {
      log(error)
    }
  },

  initDevice: async () => {
    if (noDevice()) return
    const settings = {
      strength: 256,
      passphrase_protection: false,
      pin_protection: false,
      label: 'New DCR Trezor'
    }
    log('Initializing device. You must choose to backup for some commands to work.')
    await session.resetDevice(settings)
    log('Device initialized with new seed')
  },

  backupDevice: async () => {
    if (noDevice()) return
    let res = await session.getFeatures()
    if (res.payload.unfinished_backup) {
      log('Backup in unrecoverable state.')
      return
    }
    if (!res.payload.needs_backup) {
      log('Already backed up.')
      return
    }
    log('Attempting to backup device.')
    res = await session.backupDevice()
  },

  changeHomeScreen: async () => {
    if (noDevice()) return
    log('Changing home screen to DCR')
    await session.applySettings({ homescreen: homescreens.decred })
  },

  // ui/informational/state actions
  listDevices: () => {
    if (noDevice()) return
    log('Listing devices')
    log(JSON.stringify(devices, null, 2))
    log('End of device list')
  },

  showFeatures: async () => {
    if (noDevice()) return
    const features = await session.getFeatures()
    log('Features of current device')
    log(JSON.stringify(features, null, 2))
  },

  validateAddress: async () => {
    const addr = await ui.queryInput('Address to validate')
    if (!addr) return

    const wsvc = await InitService(services.WalletServiceClient, walletCredentials)
    const resp = await wallet.validateAddress(wsvc, addr)

    const bool = b => b ? 'true' : 'false'
    log('Validating %s', addr)
    log('Valid=%s  Mine=%s  Script=%s  Account=%d  Internal=%s  Index=%d',
      bool(resp.getIsValid()), bool(resp.getIsMine()), bool(resp.getIsScript()),
      resp.getAccountNumber(), bool(resp.getIsInternal()), resp.getIndex())
    log('PubKeyAddress: %s', resp.getPubKeyAddr())
    log('PubKey: %s', rawToHex(resp.getPubKey()))
  },

  importScript: async () => {
    const script = await ui.queryInput('Hex raw script')
    if (!script) return

    const wsvc = await InitService(services.WalletServiceClient, walletCredentials)
    const resp = await wallet.importScript(wsvc, '', script, false, 0)
    log('')
    log(resp.toObject())
    log('Resulting P2SH Address: %s', resp.getP2shAddress())
  },

  togglePublishTxs: () => {
    publishTxs = !publishTxs
    ui.setPublishTxsState(publishTxs)
  }
}

// start of main procedure
ui.buildUI(uiActions)
ui.runUI()
setTimeout(initTrezor(), 1000)
