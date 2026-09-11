import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHttpFile, interpolate, unresolved, resolveRequest, redactHeader, isSensitiveHeader,
} from './httpFile.ts';

const FILE = `@baseUrl = https://api.example.com
@token = s3cr3t

### List users
# a comment that is not a separator
GET {{baseUrl}}/users?limit=10
Accept: application/json
Authorization: Bearer {{token}}

### Create a user
POST {{baseUrl}}/users
Content-Type: application/json

{
  "name": "ada",
  "tags": ["x"]
}

### Delete
DELETE {{baseUrl}}/users/1
`;

test('requests, headers and bodies are separated', () => {
  const parsed = parseHttpFile(FILE);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.requests.length, 3);
  assert.deepEqual(parsed.variables, { baseUrl: 'https://api.example.com', token: 's3cr3t' });

  const [list, create, remove] = parsed.requests;
  assert.equal(list.name, 'List users');
  assert.equal(list.method, 'GET');
  assert.equal(list.url, '{{baseUrl}}/users?limit=10');
  assert.equal(list.headers.length, 2);
  assert.equal(list.body, '', 'a request with no body must not absorb the next one');

  assert.equal(create.method, 'POST');
  // A JSON body contains blank lines and braces; it must survive intact.
  assert.match(create.body, /"name": "ada"/);
  assert.match(create.body, /\}$/);
  assert.equal(remove.method, 'DELETE');
});

test('the request line carries its source line for jump-to', () => {
  const parsed = parseHttpFile(FILE);
  assert.equal(parsed.requests[0].line, 6);
  assert.equal(FILE.split('\n')[parsed.requests[0].line - 1], 'GET {{baseUrl}}/users?limit=10');
});

test('a body keeps its blank lines but loses the trailing ones', () => {
  const parsed = parseHttpFile('### x\nPOST http://h/p\n\nline one\n\nline two\n\n\n');
  assert.equal(parsed.requests[0].body, 'line one\n\nline two');
});

test('an unnamed request is labelled by its method and URL', () => {
  const parsed = parseHttpFile('GET http://example.com/health\n');
  assert.equal(parsed.requests[0].name, 'GET http://example.com/health');
});

test('malformed lines are reported, not silently dropped', () => {
  const parsed = parseHttpFile('### x\nFETCH http://h/p\n\n### y\nGET\n');
  assert.equal(parsed.requests.length, 0);
  assert.equal(parsed.problems.length, 2);
  assert.match(parsed.problems[0], /line 2/);
  assert.match(parsed.problems[1], /no URL/);
});

test('a bad header is reported without losing the request', () => {
  const parsed = parseHttpFile('GET http://h/p\nnot a header\nAccept: text/plain\n');
  assert.equal(parsed.requests.length, 1);
  assert.deepEqual(parsed.requests[0].headers, [['Accept', 'text/plain']]);
  assert.match(parsed.problems[0], /Header: value/);
});

test('CRLF files parse the same as LF', () => {
  assert.deepEqual(parseHttpFile(FILE.replace(/\n/g, '\r\n')).requests.length, 3);
});

test('interpolation leaves unknown names visible', () => {
  assert.equal(interpolate('{{a}}/{{b}}', { a: 'x' }), 'x/{{b}}');
  // Substituting an empty string would produce a plausible-looking wrong URL.
  assert.deepEqual(unresolved('{{a}}/{{b}}/{{b}}', { a: 'x' }), ['b']);
});

test('resolving reports everything still missing', () => {
  const [request] = parseHttpFile('### r\nGET {{host}}/x\nAuthorization: Bearer {{token}}\n').requests;
  const { resolved, missing } = resolveRequest(request, { host: 'http://h' });
  assert.equal(resolved.url, 'http://h/x');
  assert.deepEqual(missing, ['token']);
});

test('credentials are recognised and redacted, keeping the scheme', () => {
  assert.ok(isSensitiveHeader('Authorization') && isSensitiveHeader('x-api-key'));
  assert.ok(!isSensitiveHeader('Accept'));
  assert.equal(redactHeader('Authorization', 'Bearer abc123'), 'Bearer <redacted>');
  assert.equal(redactHeader('X-Api-Key', 'abc123'), '<redacted>');
  assert.equal(redactHeader('Accept', 'application/json'), 'application/json');
});

test('an empty file is not an error', () => {
  const parsed = parseHttpFile('');
  assert.deepEqual(parsed.requests, []);
  assert.deepEqual(parsed.problems, []);
});
