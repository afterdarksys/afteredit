/** Base conversion and bitwise arithmetic, in BigInt so 64-bit values and
 *  two's-complement views are exact. */

export type BitWidth = 8 | 16 | 32 | 64;

export interface BaseView {
  decimal: string;
  hex: string;
  octal: string;
  binary: string;
  /** Binary grouped in nibbles, which is the only readable form past a byte. */
  binaryGrouped: string;
  /** Interpretation of the same bit pattern as a signed value at `width`. */
  signed: string;
  bytes: string;
}

export function parseNumber(input: string): bigint {
  const text = input.trim().replace(/[_\s,]/g, "");
  if (!text) throw new Error("enter a number");

  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;

  let value: bigint;
  if (/^0x[0-9a-f]+$/i.test(body)) value = BigInt(body);
  else if (/^0o[0-7]+$/i.test(body)) value = BigInt(body);
  else if (/^0b[01]+$/i.test(body)) value = BigInt(body);
  else if (/^\d+$/.test(body)) value = BigInt(body);
  else throw new Error(`cannot parse "${input}" - try 255, 0xff, 0o377 or 0b11111111`);

  return negative ? -value : value;
}

/** Wrap into the unsigned range of `width`, the way a register would. */
export function toUnsigned(value: bigint, width: BitWidth): bigint {
  const modulus = 1n << BigInt(width);
  return ((value % modulus) + modulus) % modulus;
}

export function toSigned(value: bigint, width: BitWidth): bigint {
  const unsigned = toUnsigned(value, width);
  const limit = 1n << BigInt(width - 1);
  return unsigned >= limit ? unsigned - (1n << BigInt(width)) : unsigned;
}

export function describe(value: bigint, width: BitWidth = 64): BaseView {
  const unsigned = toUnsigned(value, width);
  const binary = unsigned.toString(2).padStart(width, "0");
  return {
    decimal: unsigned.toString(10),
    hex: `0x${unsigned.toString(16).toUpperCase()}`,
    octal: `0o${unsigned.toString(8)}`,
    binary,
    binaryGrouped: (binary.match(/.{1,4}/g) ?? []).join(" "),
    signed: toSigned(value, width).toString(10),
    bytes: (binary.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2).toString(16).padStart(2, "0")).join(" "),
  };
}

export type BitwiseOp = "and" | "or" | "xor" | "not" | "shl" | "shr" | "add" | "sub" | "mul";

export function applyBitwise(op: BitwiseOp, left: bigint, right: bigint, width: BitWidth = 64): bigint {
  const a = toUnsigned(left, width);
  const b = toUnsigned(right, width);
  switch (op) {
    case "and": return toUnsigned(a & b, width);
    case "or": return toUnsigned(a | b, width);
    case "xor": return toUnsigned(a ^ b, width);
    case "not": return toUnsigned(~a, width);
    case "shl": return toUnsigned(a << b, width);
    // Logical shift: `a` is already the unsigned bit pattern.
    case "shr": return toUnsigned(a >> b, width);
    case "add": return toUnsigned(a + b, width);
    case "sub": return toUnsigned(a - b, width);
    case "mul": return toUnsigned(a * b, width);
  }
}
