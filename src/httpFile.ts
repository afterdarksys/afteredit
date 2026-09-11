/**
 * `.http` / `.rest` files, in the format JetBrains and REST Client both use.
 *
 *     @baseUrl = https://api.example.com
 *
 *     ### List users
 *     GET {{baseUrl}}/users
 *     Accept: application/json
 *
 *     ### Create
 *     POST {{baseUrl}}/users
 *     Content-Type: application/json
 *
 *     { "name": "ada" }
 *
 * Parsing lives here rather than in Rust so the panel can list the requests in
 * a buffer as it is typed, without a round trip.
 */

export type HttpRequest = {
  name: string;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: string;
  /** 1-based line of the request line, for jump-to-source. */
  line: number;
};

export type ParsedHttpFile = {
  variables: Record<string, string>;
  requests: HttpRequest[];
  problems: string[];
};

const METHODS = [
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT',
];

const SEPARATOR = /^###\s*(.*)$/;
const VARIABLE = /^@([A-Za-z0-9_.-]+)\s*=\s*(.*)$/;
const COMMENT = /^\s*(?:#(?!##)|\/\/)/;

function isRequestLine(line: string): boolean {
  const [method] = line.trim().split(/\s+/);
  return METHODS.includes(method?.toUpperCase() ?? '');
}

export function parseHttpFile(text: string): ParsedHttpFile {
  const variables: Record<string, string> = {};
  const requests: HttpRequest[] = [];
  const problems: string[] = [];

  const lines = text.split(/\r?\n/);
  let name = '';
  let current: HttpRequest | null = null;
  // Headers come before the first blank line; everything after it is body.
  let inBody = false;

  const finish = () => {
    if (current) {
      current.body = current.body.replace(/\s+$/, '');
      requests.push(current);
    }
    current = null;
    inBody = false;
  };

  lines.forEach((raw, index) => {
    const separator = SEPARATOR.exec(raw);
    if (separator) {
      finish();
      name = separator[1].trim();
      return;
    }

    if (current && inBody) {
      current.body += `${raw}\n`;
      return;
    }

    if (COMMENT.test(raw)) return;

    const variable = VARIABLE.exec(raw.trim());
    if (variable && !current) {
      variables[variable[1]] = variable[2].trim();
      return;
    }

    if (!current) {
      if (!raw.trim()) return;
      if (!isRequestLine(raw)) {
        problems.push(`line ${index + 1}: expected a method and URL, got "${raw.trim().slice(0, 60)}"`);
        return;
      }
      const parts = raw.trim().split(/\s+/);
      const url = parts[1] ?? '';
      if (!url) {
        problems.push(`line ${index + 1}: ${parts[0]} has no URL`);
        return;
      }
      current = {
        name: name || `${parts[0].toUpperCase()} ${url}`,
        method: parts[0].toUpperCase(),
        url,
        headers: [],
        body: '',
        line: index + 1,
      };
      name = '';
      return;
    }

    if (!raw.trim()) {
      inBody = true;
      return;
    }

    const colon = raw.indexOf(':');
    if (colon <= 0) {
      problems.push(`line ${index + 1}: expected "Header: value", got "${raw.trim().slice(0, 60)}"`);
      return;
    }
    current.headers.push([raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()]);
  });

  finish();
  return { variables, requests, problems };
}

/** Substitute `{{name}}`. Unknown names are left as written so the failure is
 *  visible in the URL rather than silently becoming an empty string. */
export function interpolate(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : whole);
}

export function unresolved(text: string, variables: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
    if (!Object.prototype.hasOwnProperty.call(variables, match[1])) missing.add(match[1]);
  }
  return [...missing];
}

export type ResolvedRequest = {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: string;
};

export function resolveRequest(
  request: HttpRequest,
  variables: Record<string, string>,
): { resolved: ResolvedRequest; missing: string[] } {
  const everything = [request.url, request.body, ...request.headers.flat()].join('\n');
  return {
    missing: unresolved(everything, variables),
    resolved: {
      method: request.method,
      url: interpolate(request.url, variables),
      headers: request.headers.map(([key, value]) =>
        [interpolate(key, variables), interpolate(value, variables)] as [string, string]),
      body: interpolate(request.body, variables),
    },
  };
}

/** Header names whose values must never be shown in full or logged. */
const SENSITIVE = ['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key'];

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE.includes(name.toLowerCase());
}

/** Keep enough to recognise the header, never enough to use it. */
export function redactHeader(name: string, value: string): string {
  if (!isSensitiveHeader(name)) return value;
  const scheme = /^(\w+)\s+/.exec(value)?.[1];
  return scheme ? `${scheme} <redacted>` : '<redacted>';
}
