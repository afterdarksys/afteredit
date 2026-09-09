import test from "node:test";
import assert from "node:assert/strict";

import { base64Encode, base64Decode, base32Encode, base32Decode, hexEncode, hexDecode } from "./encoding.ts";
import { analyzeLineEndings, convertLineEndings, stripTrailingWhitespace, ensureFinalNewline } from "./lineEndings.ts";
import { parseCidr, cidrContains, splitCidr, type SubnetV4, type SubnetV6 } from "./subnet.ts";
import { parseNumber, describe as describeNumber, applyBitwise, toSigned } from "./numbers.ts";
import { parseTimestamp, relativeTo } from "./dates.ts";
import { testRegex, escapeLiteral } from "./regex.ts";

const v4 = (input: string) => parseCidr(input) as SubnetV4;
const v6 = (input: string) => parseCidr(input) as SubnetV6;

test("base64 round-trips, including non-ASCII", () => {
  assert.equal(base64Encode("hello"), "aGVsbG8=");
  assert.equal(base64Decode("aGVsbG8="), "hello");
  for (const value of ["", "a", "ab", "abc", "héllo wörld", "🔒 secret", "a".repeat(10000)]) {
    assert.equal(base64Decode(base64Encode(value)), value);
  }
});

test("base64url strips padding and still decodes", () => {
  const encoded = base64Encode("subjects?_d=1", true);
  assert.ok(!encoded.includes("="), "url-safe output should not be padded");
  assert.ok(!encoded.includes("+") && !encoded.includes("/"));
  assert.equal(base64Decode(encoded), "subjects?_d=1");
});

test("base32 matches RFC 4648 test vectors", () => {
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["f", "MY======"],
    ["fo", "MZXQ===="],
    ["foo", "MZXW6==="],
    ["foob", "MZXW6YQ="],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI======"],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(plain), encoded, `encode ${JSON.stringify(plain)}`);
    assert.equal(base32Decode(encoded), plain, `decode ${encoded}`);
  }
});

test("base32 rejects characters outside the alphabet", () => {
  assert.throws(() => base32Decode("MZXW6YTB!"), /invalid base32/);
});

test("hex round-trips and tolerates separators", () => {
  assert.equal(hexEncode("hi"), "6869");
  assert.equal(hexEncode("hi", ":"), "68:69");
  assert.equal(hexDecode("68 69"), "hi");
  assert.equal(hexDecode("0x6869"), "hi");
  assert.throws(() => hexDecode("689"), /odd number/);
});

test("line endings are counted without double-counting CRLF", () => {
  const stats = analyzeLineEndings("a\r\nb\nc\rd");
  assert.equal(stats.crlf, 1);
  assert.equal(stats.lf, 1, "the LF inside CRLF must not be counted again");
  assert.equal(stats.cr, 1);
  assert.ok(stats.mixed);
});

test("line ending conversion is idempotent and lossless", () => {
  const mixed = "a\r\nb\nc\rd";
  assert.equal(convertLineEndings(mixed, "lf"), "a\nb\nc\nd");
  assert.equal(convertLineEndings(mixed, "crlf"), "a\r\nb\r\nc\r\nd");
  const once = convertLineEndings(mixed, "crlf");
  assert.equal(convertLineEndings(once, "crlf"), once);
});

test("whitespace helpers", () => {
  assert.equal(stripTrailingWhitespace("a  \nb\t\nc"), "a\nb\nc");
  assert.equal(ensureFinalNewline("a"), "a\n");
  assert.equal(ensureFinalNewline("a\n"), "a\n");
  assert.equal(ensureFinalNewline(""), "");
});

test("IPv4 subnet maths", () => {
  const net = v4("192.168.1.130/26");
  assert.equal(net.network, "192.168.1.128");
  assert.equal(net.broadcast, "192.168.1.191");
  assert.equal(net.netmask, "255.255.255.192");
  assert.equal(net.wildcard, "0.0.0.63");
  assert.equal(net.firstHost, "192.168.1.129");
  assert.equal(net.lastHost, "192.168.1.190");
  assert.equal(net.totalAddresses, 64n);
  assert.equal(net.usableHosts, 62n);
  assert.ok(net.isPrivate);
});

test("/0 and /8 masks survive signed-32-bit pitfalls", () => {
  // 255.0.0.0 as a signed int32 is negative; BigInt maths must not care.
  assert.equal(v4("10.1.2.3/8").netmask, "255.0.0.0");
  assert.equal(v4("10.1.2.3/8").network, "10.0.0.0");
  assert.equal(v4("1.2.3.4/0").netmask, "0.0.0.0");
  assert.equal(v4("1.2.3.4/0").broadcast, "255.255.255.255");
  assert.equal(v4("1.2.3.4/0").totalAddresses, 4294967296n);
});

test("/31 and /32 do not reserve network and broadcast", () => {
  const p2p = v4("10.0.0.0/31");
  assert.equal(p2p.usableHosts, 2n, "RFC 3021 point-to-point link");
  assert.equal(p2p.firstHost, "10.0.0.0");
  assert.equal(p2p.lastHost, "10.0.0.1");

  const host = v4("10.0.0.7/32");
  assert.equal(host.usableHosts, 1n);
  assert.equal(host.firstHost, "10.0.0.7");
});

test("IPv4 validation", () => {
  assert.throws(() => parseCidr("10.0.0.256/24"), /out of range/);
  assert.throws(() => parseCidr("10.0.0/24"), /not an IPv4/);
  assert.throws(() => parseCidr("10.0.0.1/33"), /0-32/);
});

test("public ranges are not flagged private", () => {
  assert.equal(v4("8.8.8.8/32").isPrivate, false);
  assert.equal(v4("172.32.0.1/32").isPrivate, false, "172.32 is outside 172.16/12");
  assert.equal(v4("172.16.0.1/32").isPrivate, true);
});

test("IPv6 parsing, compression and range", () => {
  const net = v6("2001:db8::1/64");
  assert.equal(net.network, "2001:db8::");
  assert.equal(net.lastAddress, "2001:db8::ffff:ffff:ffff:ffff");
  assert.equal(net.totalAddresses, 1n << 64n);
  assert.equal(v6("::1/128").address, "::1");
  assert.throws(() => parseCidr("2001:db8::1::2/64"), /more than one/);
});

test("cidrContains", () => {
  assert.ok(cidrContains("10.0.0.0/8", "10.255.255.255"));
  assert.ok(!cidrContains("10.0.0.0/8", "11.0.0.1"));
  assert.ok(cidrContains("2001:db8::/32", "2001:db8:1234::1"));
  assert.ok(!cidrContains("10.0.0.0/8", "2001:db8::1"), "mixed versions never match");
});

test("splitCidr", () => {
  assert.deepEqual(splitCidr("10.0.0.0/24", 26), [
    "10.0.0.0/26", "10.0.0.64/26", "10.0.0.128/26", "10.0.0.192/26",
  ]);
  assert.throws(() => splitCidr("10.0.0.0/24", 24), /between 25 and 32/);
});

test("number parsing across bases", () => {
  assert.equal(parseNumber("255"), 255n);
  assert.equal(parseNumber("0xFF"), 255n);
  assert.equal(parseNumber("0o377"), 255n);
  assert.equal(parseNumber("0b1111_1111"), 255n);
  assert.equal(parseNumber("-1"), -1n);
  assert.throws(() => parseNumber("12ff"), /cannot parse/);
});

test("two's complement views", () => {
  assert.equal(describeNumber(-1n, 8).binary, "11111111");
  assert.equal(describeNumber(-1n, 8).decimal, "255");
  assert.equal(describeNumber(-1n, 8).signed, "-1");
  assert.equal(toSigned(0xffffffffn, 32), -1n);
  assert.equal(toSigned(0x7fffffffn, 32), 2147483647n);
  assert.equal(describeNumber(255n, 16).binaryGrouped, "0000 0000 1111 1111");
});

test("bitwise ops wrap at the chosen width", () => {
  assert.equal(applyBitwise("and", 0b1100n, 0b1010n, 8), 0b1000n);
  assert.equal(applyBitwise("or", 0b1100n, 0b1010n, 8), 0b1110n);
  assert.equal(applyBitwise("xor", 0b1100n, 0b1010n, 8), 0b0110n);
  assert.equal(applyBitwise("not", 0n, 0n, 8), 255n);
  assert.equal(applyBitwise("shl", 1n, 9n, 8), 0n, "shifted past the width");
  assert.equal(applyBitwise("shr", 0xffn, 4n, 8), 0x0fn, "logical, not arithmetic");
  assert.equal(applyBitwise("add", 255n, 1n, 8), 0n, "wraps like a register");
});

test("timestamps are disambiguated by magnitude", () => {
  assert.equal(parseTimestamp("1700000000").interpretation, "epoch seconds");
  assert.equal(parseTimestamp("1700000000000").interpretation, "epoch milliseconds");
  assert.equal(parseTimestamp("1700000000000000").interpretation, "epoch microseconds");
  assert.equal(parseTimestamp("1700000000000000000").interpretation, "epoch nanoseconds");

  const seconds = parseTimestamp("1700000000").date.toISOString();
  for (const input of ["1700000000000", "1700000000000000", "1700000000000000000"]) {
    assert.equal(parseTimestamp(input).date.toISOString(), seconds, `${input} is the same instant`);
  }
});

test("ISO timestamps and failures", () => {
  assert.equal(parseTimestamp("2023-11-14T22:13:20Z").date.getTime(), 1700000000000);
  assert.throws(() => parseTimestamp("not a date"), /cannot parse/);
  assert.throws(() => parseTimestamp("  "), /enter a timestamp/);
});

test("relative time", () => {
  const now = new Date("2024-01-01T00:00:00Z");
  assert.equal(relativeTo(new Date("2023-12-31T23:00:00Z"), now), "1 hour ago");
  assert.equal(relativeTo(new Date("2024-01-01T02:00:00Z"), now), "in 2 hours");
  assert.equal(relativeTo(now, now), "now");
});

test("regex finds every match with groups", () => {
  const result = testRegex(String.raw`(\w+)@(\w+)`, "g", "a@b and c@d");
  assert.ok(result.ok);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].text, "a@b");
  assert.equal(result.matches[0].groups[0].value, "a");
  assert.equal(result.matches[1].index, 8);
});

test("named groups are reported", () => {
  const result = testRegex(String.raw`(?<key>\w+)=(?<value>\w+)`, "", "env=prod");
  const names = result.matches[0].groups.map((g) => g.name);
  assert.ok(names.includes("key") && names.includes("value"));
});

test("a zero-length match does not hang the tester", () => {
  const result = testRegex("a*", "g", "bbb");
  assert.ok(result.ok);
  assert.ok(result.matchedEmpty);
  assert.ok(result.matches.length <= 4, "must terminate, not loop forever");
});

test("an invalid pattern reports instead of throwing", () => {
  const result = testRegex("([a-z", "g", "abc");
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
});

test("match limit truncates", () => {
  const result = testRegex("a", "g", "a".repeat(50), 10);
  assert.equal(result.matches.length, 10);
  assert.ok(result.truncated);
});

test("escapeLiteral makes text safe to embed", () => {
  const escaped = escapeLiteral("a.b*c");
  assert.equal(testRegex(escaped, "g", "a.b*c").matches.length, 1);
  assert.equal(testRegex(escaped, "g", "axbxc").matches.length, 0);
});
