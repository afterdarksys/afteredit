/** Base64 / base32 / hex / URL codecs. Pure and UTF-8 correct. */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const utf8 = {
  encode: (text: string) => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};

function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on
  // anything large.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64Encode(text: string, urlSafe = false): string {
  const encoded = btoa(bytesToBinary(utf8.encode(text)));
  return urlSafe ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
}

export function base64Decode(encoded: string): string {
  let normalized = encoded.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  // Restore stripped padding, which base64url and many APIs omit.
  if (normalized.length % 4 !== 0) normalized += "=".repeat(4 - (normalized.length % 4));
  return utf8.decode(binaryToBytes(atob(normalized)));
}

export function base32Encode(text: string): string {
  const bytes = utf8.encode(text);
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += "=";
  return out;
}

export function base32Decode(encoded: string): string {
  const clean = encoded.trim().toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of clean) {
    const index = B32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`invalid base32 character: ${char}`);
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return utf8.decode(new Uint8Array(bytes));
}

export function hexEncode(text: string, separator = ""): string {
  return Array.from(utf8.encode(text), (b) => b.toString(16).padStart(2, "0")).join(separator);
}

export function hexDecode(encoded: string): string {
  const clean = encoded.replace(/(?:0x|[\s:,-])/gi, "");
  if (clean.length % 2 !== 0) throw new Error("hex input has an odd number of digits");
  if (!/^[0-9a-f]*$/i.test(clean)) throw new Error("hex input has non-hex characters");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return utf8.decode(bytes);
}

export const urlEncode = (text: string) => encodeURIComponent(text);
export const urlDecode = (text: string) => decodeURIComponent(text.replace(/\+/g, " "));
