/** IPv4/IPv6 CIDR calculator. All IPv4 maths is done in BigInt to sidestep
 *  JavaScript's signed 32-bit bitwise operators, which turn 255.255.255.0
 *  into a negative number. */

export interface SubnetV4 {
  version: 4;
  cidr: string;
  address: string;
  prefix: number;
  netmask: string;
  wildcard: string;
  network: string;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  /** Every address in the block, including network and broadcast. */
  totalAddresses: bigint;
  usableHosts: bigint;
  isPrivate: boolean;
}

export interface SubnetV6 {
  version: 6;
  cidr: string;
  address: string;
  prefix: number;
  network: string;
  lastAddress: string;
  totalAddresses: bigint;
}

const V4_MAX = (1n << 32n) - 1n;
const V6_MAX = (1n << 128n) - 1n;

function v4ToBigInt(address: string): bigint {
  const parts = address.split(".");
  if (parts.length !== 4) throw new Error(`not an IPv4 address: ${address}`);
  return parts.reduce((acc, part) => {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`bad IPv4 octet: ${part}`);
    const value = Number(part);
    if (value > 255) throw new Error(`IPv4 octet out of range: ${part}`);
    return (acc << 8n) | BigInt(value);
  }, 0n);
}

function bigIntToV4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
}

function v6ToBigInt(address: string): bigint {
  const [head, tail] = address.split("::");
  if (address.split("::").length > 2) throw new Error("IPv6 address has more than one '::'");

  const parse = (part: string) => (part ? part.split(":").filter(Boolean) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];

  if (groups.length !== 8) throw new Error(`not an IPv6 address: ${address}`);
  return groups.reduce((acc, group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) throw new Error(`bad IPv6 group: ${group}`);
    return (acc << 16n) | BigInt(parseInt(group, 16));
  }, 0n);
}

function bigIntToV6(value: bigint): string {
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(Number((value >> shift) & 0xffffn).toString(16));
  }
  // Collapse the longest run of zero groups, per RFC 5952.
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  let length = 0;
  groups.forEach((group, index) => {
    if (group === "0") {
      if (start < 0) start = index;
      length += 1;
      if (length > bestLength) [bestStart, bestLength] = [start, length];
    } else {
      start = -1;
      length = 0;
    }
  });
  if (bestLength < 2) return groups.join(":");
  return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLength).join(":")}`;
}

const PRIVATE_V4: Array<[string, number]> = [
  ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["100.64.0.0", 10],
];

export function parseCidr(input: string): SubnetV4 | SubnetV6 {
  const trimmed = input.trim();
  const [address, prefixPart] = trimmed.split("/");
  if (!address) throw new Error("enter an address, e.g. 10.0.0.0/16");

  if (address.includes(":")) {
    const prefix = prefixPart === undefined ? 128 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
      throw new Error("IPv6 prefix must be 0-128");
    }
    const value = v6ToBigInt(address);
    const mask = prefix === 0 ? 0n : (V6_MAX << BigInt(128 - prefix)) & V6_MAX;
    const network = value & mask;
    const last = network | (V6_MAX ^ mask);
    return {
      version: 6,
      cidr: `${bigIntToV6(network)}/${prefix}`,
      address: bigIntToV6(value),
      prefix,
      network: bigIntToV6(network),
      lastAddress: bigIntToV6(last),
      totalAddresses: 1n << BigInt(128 - prefix),
    };
  }

  const prefix = prefixPart === undefined ? 32 : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error("IPv4 prefix must be 0-32");
  }

  const value = v4ToBigInt(address);
  const mask = prefix === 0 ? 0n : (V4_MAX << BigInt(32 - prefix)) & V4_MAX;
  const network = value & mask;
  const broadcast = network | (V4_MAX ^ mask);
  const total = 1n << BigInt(32 - prefix);

  // /31 is a point-to-point link (RFC 3021) and /32 is a single host: neither
  // reserves a network or broadcast address.
  const usableHosts = prefix >= 31 ? total : total - 2n;
  const firstHost = prefix >= 31 ? network : network + 1n;
  const lastHost = prefix >= 31 ? broadcast : broadcast - 1n;

  return {
    version: 4,
    cidr: `${bigIntToV4(network)}/${prefix}`,
    address: bigIntToV4(value),
    prefix,
    netmask: bigIntToV4(mask),
    wildcard: bigIntToV4(V4_MAX ^ mask),
    network: bigIntToV4(network),
    broadcast: bigIntToV4(broadcast),
    firstHost: bigIntToV4(firstHost),
    lastHost: bigIntToV4(lastHost),
    totalAddresses: total,
    usableHosts,
    isPrivate: PRIVATE_V4.some(([base, bits]) => {
      const blockMask = (V4_MAX << BigInt(32 - bits)) & V4_MAX;
      return (value & blockMask) === v4ToBigInt(base);
    }),
  };
}

/** Does `cidr` contain `address`? Both must be the same IP version. */
export function cidrContains(cidr: string, address: string): boolean {
  const block = parseCidr(cidr);
  const probe = parseCidr(address);
  if (block.version !== probe.version) return false;

  if (block.version === 4) {
    const mask = block.prefix === 0 ? 0n : (V4_MAX << BigInt(32 - block.prefix)) & V4_MAX;
    return (v4ToBigInt(probe.address) & mask) === v4ToBigInt(block.network);
  }
  const mask = block.prefix === 0 ? 0n : (V6_MAX << BigInt(128 - block.prefix)) & V6_MAX;
  return (v6ToBigInt(probe.address) & mask) === v6ToBigInt(block.network);
}

/** Split a block into equal subnets of the given (longer) prefix. */
export function splitCidr(cidr: string, newPrefix: number, limit = 64): string[] {
  const block = parseCidr(cidr);
  if (block.version !== 4) throw new Error("splitting is IPv4 only for now");
  if (newPrefix <= block.prefix || newPrefix > 32) {
    throw new Error(`new prefix must be between ${block.prefix + 1} and 32`);
  }
  const step = 1n << BigInt(32 - newPrefix);
  const start = v4ToBigInt(block.network);
  const count = 1n << BigInt(newPrefix - block.prefix);
  const out: string[] = [];
  for (let i = 0n; i < count && out.length < limit; i += 1n) {
    out.push(`${bigIntToV4(start + i * step)}/${newPrefix}`);
  }
  return out;
}
