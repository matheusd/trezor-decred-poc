import { strHashToRaw, rawHashToHex, hexToRaw } from "./bytes";
import * as pb from "../dcrwallet-api/api_pb";

export const getTransaction = (walletService, txHash) =>
  new Promise((resolve, reject) => {
    var request = new pb.GetTransactionRequest();
    var buffer = Buffer.isBuffer(txHash) ? txHash : strHashToRaw(txHash);
    request.setTransactionHash(buffer);
    walletService.getTransaction(request, (err, resp) => {
      if (err) {
        reject(err);
        return;
      }

      const tx = resp.getTransaction();
      resolve(tx);
    });
  });

export function verifyMessage(wsvcMsgVerif, addr, msg, sig) {
    const request = new pb.VerifyMessageRequest();
    request.setAddress(addr);
    request.setMessage(msg);
    request.setSignature(sig);
    return new Promise((resolve, reject) => wsvcMsgVerif
      .verifyMessage(request, (error, response) => error ? reject(error) : resolve(response)));
}

export const constructTransaction = (walletService, accountNum, confirmations, outputs) =>
  new Promise((ok, fail) => {
    const totalAmount = outputs.reduce((tot, { amount }) => tot + amount, 0);
    const request = new pb.ConstructTransactionRequest();
    request.setSourceAccount(accountNum);
    request.setRequiredConfirmations(confirmations);
    request.setOutputSelectionAlgorithm(0);
    outputs.forEach(({ destination, amount }) => {
      const outputDest = new pb.ConstructTransactionRequest.OutputDestination();
      const output = new pb.ConstructTransactionRequest.Output();
      outputDest.setAddress(destination);
      output.setDestination(outputDest);
      output.setAmount(parseInt(amount));
      request.addNonChangeOutputs(output);
    });
    walletService.constructTransaction(request, (err, res) =>
      err ? fail(err) : ok({ res }));
  });

export const decodeTransaction = (decodeMessageService, rawTx) =>
  new Promise((resolve, reject) => {
    var request = new pb.DecodeRawTransactionRequest();
    var buffer = Buffer.isBuffer(rawTx) ? rawTx : Buffer.from(rawTx, "hex");
    var buff = new Uint8Array(buffer);
    request.setSerializedTransaction(buff);
    decodeMessageService.decodeRawTransaction(request, (error, tx) => {
      if (error) {
        reject(error);
      } else {
        resolve(tx.getTransaction());
      }
    });
  });

export const publishTransaction = (walletService, rawTx) =>
  new Promise((resolve, reject) => {
    var request = new pb.PublishTransactionRequest();
    var buffer = Buffer.isBuffer(rawTx) ? rawTx : Buffer.from(rawTx, "hex");
    var buff = new Uint8Array(buffer);
    request.setSignedTransaction(buff);
    walletService.publishTransaction(request, (error, resp) => {
      if (error) {
        reject(error);
      } else {
        resolve(rawHashToHex(resp.getTransactionHash()));
      }
    });
  });

// getInputTransactions returns the input transactions to the given source
// transaction (assumes srcTx was returned from decodeTransaction).
export const getInputTransactions = async (walletService, decodeMessageService, srcTx) => {
  const txs = [];
  for (let inp of srcTx.getInputsList()) {
    const inpTx = await getTransaction(walletService, rawHashToHex(inp.getPreviousTransactionHash()));
    const decodedInp = await decodeTransaction(decodeMessageService, inpTx.getTransaction());
    txs.push(decodedInp);
  }

  return txs;
}

export const validateAddress = (walletService, address) =>
  new Promise((resolve, reject) => {
    const request = new pb.ValidateAddressRequest();
    request.setAddress(address);
    walletService.validateAddress(request, (error, response) => error ? reject(error) : resolve(response));
  });

export const importScript = (walletService, passphrase, script, rescan, scanFrom) =>
  new Promise((ok, fail) => {
    const request = new pb.ImportScriptRequest();
    request.setPassphrase(new Uint8Array(Buffer.from(passphrase)));
    request.setScript(hexToRaw(script));
    request.setRescan(rescan);
    request.setScanFrom(scanFrom);
    request.setRequireRedeemable(true);
    walletService.importScript(request, (err, res) => err ? fail(err) : ok(res));
  });

export const ticketPrice = (walletService) =>
  new Promise((resolve, reject) => {
    const request = new pb.TicketPriceRequest();
    walletService.ticketPrice(request, (error, response) => error ? reject(error) : resolve(response));
  });

export const balance = (walletService, confirms) =>
  new Promise((resolve, reject) => {
    const request = new pb.BalanceRequest();
    request.setRequiredConfirmations(confirms)
    walletService.balance(request, (error, response) => error ? reject(error) : resolve(response));
  });

export const bestBlock = (walletService) =>
  new Promise((resolve, reject) => {
    const request = new pb.BestBlockRequest();
    walletService.bestBlock(request, (error, response) => error ? reject(error) : resolve(response));
  });
