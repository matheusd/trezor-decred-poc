import { strHashToRaw, rawHashToHex } from "./bytes";
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

// getInputTransactions returns the input transactions to the given source
// transaction (assumes srcTx was returned from decodeTransaction).
export const getInputTransactions = async (walletService, decodeMessageService, srcTx) => {
  const txs = [];
  for (let inp of srcTx.getInputsList()) {
    console.log("gonna get from");
    const inpTx = await getTransaction(walletService, rawHashToHex(inp.getPreviousTransactionHash()));
    console.log("got transaction");
    const decodedInp = await decodeTransaction(decodeMessageService, inpTx.getTransaction());
    console.log("decoded transaction");
    txs.push(decodedInp);
  }

  return txs;
}
