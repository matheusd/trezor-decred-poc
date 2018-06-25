import fs from "fs";
import grpc from "grpc";

export const services = require("../dcrwallet-api/api_grpc_pb.js");
export const messages = require("../dcrwallet-api/api_pb.js");

export function getCert(certPath) {
  var cert;
  try {
    cert = fs.readFileSync(certPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log(certPath + " does not exist");
    } else if (err.code === "EACCES") {
      console.log(certPath + " permission denied");
    } else {
      console.error(certPath + " " + err);
    }
  }

  return (cert);
}

export function WalletCredentials(address, port, certificate) {
  return {
    address: address || "127.0.0.1",
    port: port || 19121,
    certificate: certificate || "/home/user/.config/decrediton/wallets/testnet/trezor/rpc.cert",
  }
}

export function InitService(svcClass, creds) {
  // needed for node.js to use the correct cipher when connecting to dcrwallet
  process.env.GRPC_SSL_CIPHER_SUITES = "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-SHA256:ECDHE-ECDSA-AES256-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384";

  //var cert = getCert();
  var sslCreds = grpc.credentials.createSsl(getCert(creds.certificate));
  var client = new svcClass(creds.address + ":" + creds.port, sslCreds);

  var deadline = new Date();
  var deadlineInSeconds = 30;
  deadline.setSeconds(deadline.getSeconds() + deadlineInSeconds);
  return new Promise((resolve, reject) => {
    grpc.waitForClientReady(client, deadline, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve(client);
      }
    });
  });
}
