
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

export function hexToRaw(hex) {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function reverseHash(s) {
  s = s.replace(/^(.(..)*)$/, "0$1"); // add a leading zero if needed
  var a = s.match(/../g);             // split number in groups of two
  a.reverse();                        // reverse the groups
  var s2 = a.join("");
  return s2;
}

// str2utf8hex converts a (js, utf-16) string into (utf-8 encoded) hex.
export function str2utf8hex (str) {
  return Buffer.from(str).toString("hex");
}

export function hex2b64(hex) {
  return new Buffer(hex, 'hex').toString('base64');
}
