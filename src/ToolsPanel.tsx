import { useMemo, useState, type ReactNode } from "react";
import {
  Regex, Binary, Clock, Network, ArrowLeftRight, Copy, Check, AlertTriangle,
} from "lucide-react";
import { base64Encode, base64Decode, base32Encode, base32Decode, hexEncode, hexDecode, urlEncode, urlDecode } from "./tools/encoding";
import { analyzeLineEndings, convertLineEndings, stripTrailingWhitespace, ensureFinalNewline, type Eol } from "./tools/lineEndings";
import { parseCidr, cidrContains, splitCidr } from "./tools/subnet";
import { parseNumber, describe as describeNumber, applyBitwise, type BitWidth, type BitwiseOp } from "./tools/numbers";
import { parseTimestamp, describeTimestamp } from "./tools/dates";
import { testRegex, COMMON_PATTERNS } from "./tools/regex";

type ToolId = "regex" | "encode" | "time" | "number" | "subnet" | "eol";

const TOOLS: Array<{ id: ToolId; label: string; icon: ReactNode }> = [
  { id: "regex", label: "Regex", icon: <Regex size={15} /> },
  { id: "encode", label: "Encode / Decode", icon: <ArrowLeftRight size={15} /> },
  { id: "time", label: "Timestamp", icon: <Clock size={15} /> },
  { id: "number", label: "Number / Bitwise", icon: <Binary size={15} /> },
  { id: "subnet", label: "IP Subnet", icon: <Network size={15} /> },
  { id: "eol", label: "Line Endings", icon: <ArrowLeftRight size={15} /> },
];

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="tool-copy"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="tool-row">
      <span className="tool-row-label">{label}</span>
      <span className="tool-row-value">{value}</span>
      <CopyButton value={value} />
    </div>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <div className="tool-error">
      <AlertTriangle size={13} /> {message}
    </div>
  );
}

/** Run a tool, turning a thrown error into a rendered message rather than a
 *  blank panel. */
function attempt<T>(run: () => T): { value: T } | { error: string } {
  try {
    return { value: run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function RegexTool() {
  const [pattern, setPattern] = useState(String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`);
  const [flags, setFlags] = useState("g");
  const [input, setInput] = useState("allow 10.0.1.5 and 192.168.0.200\ndeny 172.16.4.9");

  const result = useMemo(() => testRegex(pattern, flags, input), [pattern, flags, input]);

  return (
    <>
      <div className="tool-inline">
        <input className="tool-input mono" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="pattern" />
        <input className="tool-input mono tool-flags" value={flags} onChange={(e) => setFlags(e.target.value)} placeholder="flags" />
      </div>
      <select
        className="tool-input"
        value=""
        onChange={(e) => {
          const preset = COMMON_PATTERNS.find((p) => p.label === e.target.value);
          if (preset) {
            setPattern(preset.pattern);
            setFlags(preset.flags);
          }
        }}
      >
        <option value="">Common patterns...</option>
        {COMMON_PATTERNS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
      </select>
      <textarea className="tool-textarea mono" value={input} onChange={(e) => setInput(e.target.value)} rows={6} />

      {!result.ok && <Problem message={result.error ?? "invalid pattern"} />}
      {result.ok && (
        <div className="tool-results">
          <div className="tool-summary">
            {result.matches.length} match{result.matches.length === 1 ? "" : "es"}
            {result.truncated && " (truncated)"}
            {result.matchedEmpty && " - pattern can match empty"}
          </div>
          {result.matches.map((match, i) => (
            <div key={`${match.index}-${i}`} className="tool-match">
              <span className="tool-match-index">@{match.index}</span>
              <span className="mono">{match.text || "(empty)"}</span>
              {match.groups.length > 0 && (
                <span className="tool-groups">
                  {match.groups.map((g) => `${g.name}=${g.value ?? "-"}`).join("  ")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const CODECS = {
  "base64": { encode: (v: string) => base64Encode(v), decode: base64Decode },
  "base64url": { encode: (v: string) => base64Encode(v, true), decode: base64Decode },
  "base32": { encode: base32Encode, decode: base32Decode },
  "hex": { encode: (v: string) => hexEncode(v), decode: hexDecode },
  "url": { encode: urlEncode, decode: urlDecode },
} as const;

function EncodeTool() {
  const [codec, setCodec] = useState<keyof typeof CODECS>("base64");
  const [direction, setDirection] = useState<"encode" | "decode">("encode");
  const [input, setInput] = useState("hello world");

  const output = useMemo(
    () => attempt(() => CODECS[codec][direction](input)),
    [codec, direction, input],
  );

  return (
    <>
      <div className="tool-inline">
        <select className="tool-input" value={codec} onChange={(e) => setCodec(e.target.value as keyof typeof CODECS)}>
          {Object.keys(CODECS).map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select className="tool-input" value={direction} onChange={(e) => setDirection(e.target.value as "encode" | "decode")}>
          <option value="encode">encode</option>
          <option value="decode">decode</option>
        </select>
      </div>
      <textarea className="tool-textarea mono" value={input} onChange={(e) => setInput(e.target.value)} rows={5} />
      {"error" in output ? <Problem message={output.error} /> : (
        <div className="tool-output-block">
          <CopyButton value={output.value} />
          <pre className="mono">{output.value || "(empty)"}</pre>
        </div>
      )}
    </>
  );
}

function TimeTool() {
  const [input, setInput] = useState(() => Math.floor(Date.now() / 1000).toString());
  const parsed = useMemo(() => attempt(() => parseTimestamp(input)), [input]);

  return (
    <>
      <div className="tool-inline">
        <input className="tool-input mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="1700000000 or 2024-01-31T12:00:00Z" />
        <button type="button" className="tool-button" onClick={() => setInput(Math.floor(Date.now() / 1000).toString())}>now</button>
      </div>
      {"error" in parsed ? <Problem message={parsed.error} /> : (() => {
        const view = describeTimestamp(parsed.value.date);
        return (
          <div className="tool-results">
            <div className="tool-summary">read as {parsed.value.interpretation}</div>
            <Row label="ISO 8601" value={view.iso} />
            <Row label="UTC" value={view.utc} />
            <Row label={`Local (${view.timeZone})`} value={view.local} />
            <Row label="Epoch seconds" value={view.epochSeconds} />
            <Row label="Epoch millis" value={view.epochMillis} />
            <Row label="Day" value={view.dayOfWeek} />
            <Row label="Relative" value={view.relative} />
          </div>
        );
      })()}
    </>
  );
}

const OPS: BitwiseOp[] = ["and", "or", "xor", "shl", "shr", "add", "sub", "mul", "not"];

function NumberTool() {
  const [left, setLeft] = useState("0xFF");
  const [right, setRight] = useState("0b1010");
  const [op, setOp] = useState<BitwiseOp>("and");
  const [width, setWidth] = useState<BitWidth>(32);

  const result = useMemo(
    () => attempt(() => {
      const a = parseNumber(left);
      const b = op === "not" ? 0n : parseNumber(right);
      return { a: describeNumber(a, width), out: describeNumber(applyBitwise(op, a, b, width), width) };
    }),
    [left, right, op, width],
  );

  return (
    <>
      <div className="tool-inline">
        <input className="tool-input mono" value={left} onChange={(e) => setLeft(e.target.value)} placeholder="255, 0xff, 0o377, 0b1111" />
        <select className="tool-input tool-op" value={op} onChange={(e) => setOp(e.target.value as BitwiseOp)}>
          {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <input className="tool-input mono" value={right} onChange={(e) => setRight(e.target.value)} disabled={op === "not"} />
        <select className="tool-input tool-op" value={width} onChange={(e) => setWidth(Number(e.target.value) as BitWidth)}>
          {[8, 16, 32, 64].map((w) => <option key={w} value={w}>{w}-bit</option>)}
        </select>
      </div>
      {"error" in result ? <Problem message={result.error} /> : (
        <div className="tool-results">
          <div className="tool-summary">input</div>
          <Row label="Binary" value={result.value.a.binaryGrouped} />
          <div className="tool-summary">result of {op}</div>
          <Row label="Decimal" value={result.value.out.decimal} />
          <Row label="Signed" value={result.value.out.signed} />
          <Row label="Hex" value={result.value.out.hex} />
          <Row label="Octal" value={result.value.out.octal} />
          <Row label="Binary" value={result.value.out.binaryGrouped} />
          <Row label="Bytes" value={result.value.out.bytes} />
        </div>
      )}
    </>
  );
}

function SubnetTool() {
  const [cidr, setCidr] = useState("10.42.0.0/22");
  const [probe, setProbe] = useState("10.42.3.17");

  const result = useMemo(() => attempt(() => parseCidr(cidr)), [cidr]);
  const contains = useMemo(
    () => (probe.trim() ? attempt(() => cidrContains(cidr, probe)) : null),
    [cidr, probe],
  );
  return (
    <>
      <input className="tool-input mono" value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="10.0.0.0/16 or 2001:db8::/32" />
      {"error" in result ? <Problem message={result.error} /> : (
        <div className="tool-results">
          {result.value.version === 4 ? (
            <>
              <Row label="Network" value={result.value.cidr} />
              <Row label="Netmask" value={result.value.netmask} />
              <Row label="Wildcard" value={result.value.wildcard} />
              <Row label="Broadcast" value={result.value.broadcast} />
              <Row label="Host range" value={`${result.value.firstHost} - ${result.value.lastHost}`} />
              <Row label="Usable hosts" value={result.value.usableHosts.toLocaleString()} />
              <Row label="Total addresses" value={result.value.totalAddresses.toLocaleString()} />
              <Row label="Scope" value={result.value.isPrivate ? "private (RFC 1918 / CGNAT / loopback)" : "public"} />
              {result.value.prefix < 32 && (
                <>
                  <div className="tool-summary">split into /{Math.min(result.value.prefix + 2, 32)}</div>
                  <div className="tool-split mono">
                    {splitCidr(result.value.cidr, Math.min(result.value.prefix + 2, 32), 8).join("  ")}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <Row label="Network" value={result.value.cidr} />
              <Row label="First address" value={result.value.network} />
              <Row label="Last address" value={result.value.lastAddress} />
              <Row label="Total addresses" value={result.value.totalAddresses.toLocaleString()} />
            </>
          )}

          <div className="tool-summary">contains?</div>
          <div className="tool-inline">
            <input className="tool-input mono" value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="10.42.3.17" />
            <span className={contains && "value" in contains && contains.value ? "tool-yes" : "tool-no"}>
              {!contains ? "" : "error" in contains ? contains.error : contains.value ? "in range" : "outside"}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

function EolTool({ fileName, buffer, onApply }: { fileName: string; buffer: string; onApply: (next: string) => void }) {
  const stats = useMemo(() => analyzeLineEndings(buffer), [buffer]);

  const apply = (transform: (text: string) => string) => onApply(transform(buffer));

  return (
    <div className="tool-results">
      <div className="tool-summary">{fileName}</div>
      <Row label="LF" value={stats.lf.toString()} />
      <Row label="CRLF" value={stats.crlf.toString()} />
      <Row label="CR (classic Mac)" value={stats.cr.toString()} />
      <Row label="Dominant" value={stats.dominant ? stats.dominant.toUpperCase() : "none"} />
      <Row label="Trailing whitespace" value={`${stats.trailingWhitespaceLines} line(s)`} />
      <Row label="Final newline" value={stats.finalNewline ? "yes" : "no"} />
      {stats.mixed && <Problem message="Mixed line endings - this is the classic cause of 'bad interpreter' and broken shell scripts in containers." />}

      <div className="tool-summary">convert this buffer</div>
      <div className="tool-inline">
        {(["lf", "crlf", "cr"] as Eol[]).map((eol) => (
          <button key={eol} type="button" className="tool-button" onClick={() => apply((t) => convertLineEndings(t, eol))}>
            to {eol.toUpperCase()}
          </button>
        ))}
        <button type="button" className="tool-button" onClick={() => apply(stripTrailingWhitespace)}>strip trailing</button>
        <button type="button" className="tool-button" onClick={() => apply((t) => ensureFinalNewline(t))}>add final newline</button>
      </div>
    </div>
  );
}

export default function ToolsPanel({
  fileName,
  buffer,
  onApplyToBuffer,
}: {
  fileName: string;
  buffer: string;
  onApplyToBuffer: (next: string) => void;
}) {
  const [tool, setTool] = useState<ToolId>("regex");

  return (
    <div className="tools-ui">
      <div className="tools-nav">
        {TOOLS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tools-nav-item ${tool === entry.id ? "active" : ""}`}
            onClick={() => setTool(entry.id)}
          >
            {entry.icon} {entry.label}
          </button>
        ))}
      </div>
      <div className="tools-body">
        {tool === "regex" && <RegexTool />}
        {tool === "encode" && <EncodeTool />}
        {tool === "time" && <TimeTool />}
        {tool === "number" && <NumberTool />}
        {tool === "subnet" && <SubnetTool />}
        {tool === "eol" && <EolTool fileName={fileName} buffer={buffer} onApply={onApplyToBuffer} />}
      </div>
    </div>
  );
}
