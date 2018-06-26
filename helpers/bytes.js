
// Convert a string tx id (hex bytes) into a binary buffer. Also reverses
// the hash
export function txidToBin(s) {
  return new Uint8Array(Buffer.from(reverseHash(s), "hex"));
}

// strHashToRaw converts a (reversed) string hash into an Uint8Array.
export function strHashToRaw(hash) {
  return new Uint8Array(Buffer.from(hash, "hex").reverse());
}

// Convert raw bytes (from grpc endpoint) to hex
export function rawToHex(bin) {
  return Buffer.from(bin).toString("hex")
}

// Convert hash encoded as raw bytes into an hex (reversed) string hash.
export function rawHashToHex(raw) {
  return reverseHash(Buffer.from(raw).toString("hex"))
}

export function reverseHash(s) {
  s = s.replace(/^(.(..)*)$/, "0$1"); // add a leading zero if needed
  var a = s.match(/../g);             // split number in groups of two
  a.reverse();                        // reverse the groups
  var s2 = a.join("");
  return s2;
}

// str2hex converts an (ascii only) string into hex.
export function str2hex (str) {
  var hex, i;

  // TODO: exception on non-ascii

  var result = "";
  for (i = 0; i < str.length; i++) {
      hex = str.charCodeAt(i).toString(16);
      result += ("000"+hex).slice(-2);
  }

  return result
}

export function hex2b64(hex) {
  return new Buffer(hex, 'hex').toString('base64');
}
