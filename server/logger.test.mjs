import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoggerServer, configFromEnv } from './logger.mjs';

async function fixture(t, overrides = {}) {
  const requests = [];
  const app = createLoggerServer({ webhookUrl: 'https://discord.com/api/webhooks/123456/fake-test-token',
    allowedOrigins: ['https://students.school.test'], publicOrigin: 'https://portal.school.test', clock: () => Date.parse('2026-11-03T12:00:00.000Z'),
    fetchImpl: async (url, options) => { requests.push({ url, options }); return Response.json({ id: '123456789012345678' }); }, ...overrides });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.close(); });
  const post = async (body, requestOrigin, headers = {}) => {
    const response = await fetch(`${origin}/api/log-attempt`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(requestOrigin ? { Origin: requestOrigin } : {}), ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { ...app, requests, origin, post };
}

test('valid submission is acknowledged only after Discord accepts an ID and server-generated time', async t => {
  const f = await fixture(t);
  const response = await f.post({ enrollmentNumber: 'MTA26000001' }, 'https://students.school.test');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { saved: true, time: '2026-11-03T12:00:00.000Z' });
  assert.equal(f.requests.length, 1);
  assert.equal(new URL(f.requests[0].url).searchParams.get('wait'), 'true');
  const message = JSON.parse(f.requests[0].options.body);
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.equal(message.content, '**RMO2026 TEST LOGIN**\nEnrollment number: MTA26000001\nTime: 2026-11-03T12:00:00.000Z | 03 Nov 2026, 17:30:00 IST\nPublic IP: Unavailable (non-public connection)');
  assert.equal(Object.keys(message).length, 2);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://students.school.test');
});

test('malformed IDs and extra fields, including DOB, are rejected without contacting Discord', async t => {
  const f = await fixture(t);
  for (const body of [{ enrollmentNumber: 'ERP26000001' }, { enrollmentNumber: 'MTA2600001' }, { enrollmentNumber: 'MTA260000001' }, { enrollmentNumber: 'mta26000001' }, { enrollmentNumber: 'MTA26000001', dateOfBirth: '2010-01-15' }, { enrollmentNumber: 'MTA26000001', time: 'forged' }, {}]) assert.equal((await f.post(body)).status, 400);
  assert.equal(f.requests.length, 0);
});

test('unapproved browser origins cannot submit records', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ enrollmentNumber: 'MTA26000001' }, 'https://evil.test')).status, 403);
  assert.equal(f.requests.length, 0);
});

test('Discord failures and missing acknowledgements return 502 without exposing the webhook', async t => {
  for (const fetchImpl of [async () => new Response('secret error', { status: 429 }), async () => Response.json({}), async () => { throw new Error('https://discord.com/api/webhooks/SECRET'); }]) {
    const f = await fixture(t, { fetchImpl });
    const response = await f.post({ enrollmentNumber: 'MTA26000001' });
    assert.equal(response.status, 502);
    assert.equal(JSON.stringify(response.body).includes('SECRET'), false);
    assert.equal(response.body.saved, undefined);
  }
});

test('missing or unsafe Discord settings disable logging', async t => {
  for (const webhookUrl of ['', 'http://discord.com/api/webhooks/123/token', 'https://discord.com.evil.test/api/webhooks/123/token', 'https://user:pass@discord.com/api/webhooks/123/token', 'https://discord.com/other/path']) {
    const f = await fixture(t, { webhookUrl });
    assert.equal((await f.post({ enrollmentNumber: 'MTA26000001' })).status, 503);
    const health = await fetch(`${f.origin}/api/health`).then(response => response.json());
    assert.deepEqual(health, { service: 'RMO test logger', loggingConfigured: false });
    assert.equal(f.requests.length, 0);
  }
});

test('per-ID rate limits allow independent students on the same school connection', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.post({ enrollmentNumber: 'MTA26000001' })).status, 200);
  assert.equal((await f.post({ enrollmentNumber: 'MTA26000001' })).status, 429);
  for (let i = 2; i < 13; i++) assert.equal((await f.post({ enrollmentNumber: `MTA26${String(i).padStart(6, '0')}` })).status, 200);
});

test('JSON input is limited and non-JSON content is rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ enrollmentNumber: 'x'.repeat(1500) })).status, 413);
  const response = await fetch(`${f.origin}/api/log-attempt`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'MTA26000001' });
  assert.equal(response.status, 415);
  assert.equal(f.requests.length, 0);
});

test('static files are served while encoded traversal cannot leave the public directory', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'rmo-logger-test-'));
  const publicDir = path.join(directory, 'public');
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<h1>RMO test</h1>');
  writeFileSync(path.join(directory, 'outside.txt'), 'PRIVATE SENTINEL');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await fixture(t, { publicDir });
  assert.equal(await fetch(`${f.origin}/`).then(response => response.text()), '<h1>RMO test</h1>');
  for (const suffix of ['/%2e%2e%2foutside.txt', '/%2e%2e%5coutside.txt', '/outside.txt']) {
    const response = await fetch(`${f.origin}${suffix}`);
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes('PRIVATE SENTINEL'), false);
  }
});

test('Live Server origins are enabled only for the local setup', () => {
  const local = configFromEnv({});
  assert.ok(local.allowedOrigins.has('http://127.0.0.1:5500'));
  assert.ok(local.allowedOrigins.has('http://localhost:5500'));
  const production = configFromEnv({ PUBLIC_ORIGIN: 'https://portal.school.test', ALLOWED_ORIGINS: 'https://name.github.io' });
  assert.equal(production.allowedOrigins.has('http://localhost:5500'), false);
  assert.ok(production.allowedOrigins.has('https://name.github.io'));
});

test('local testing looks up and caches the network IP with an explicit local label', async t => {
  const urls = [], messages = [];
  const f = await fixture(t, { publicOrigin: 'http://127.0.0.1:3000', fetchImpl: async (url, options) => {
    urls.push(url);
    if (url === 'https://api64.ipify.org?format=json') return Response.json({ ip: '8.8.8.8' });
    messages.push(JSON.parse(options.body));
    return Response.json({ id: '123456789012345678' });
  } });
  assert.equal((await f.post({ enrollmentNumber: 'MTA26000001' })).status, 200);
  assert.equal((await f.post({ enrollmentNumber: 'MTA26000002' })).status, 200);
  assert.equal(urls.filter(url => url === 'https://api64.ipify.org?format=json').length, 1);
  assert.match(messages[0].content, /Public IP: 8\.8\.8\.8 \(local test network\)$/);
});

test('local IP lookup failure does not fail the Discord record', async t => {
  let content;
  const f = await fixture(t, { publicOrigin: 'http://127.0.0.1:3000', fetchImpl: async (url, options) => {
    if (url === 'https://api64.ipify.org?format=json') throw new Error('Offline');
    content = JSON.parse(options.body).content;
    return Response.json({ id: '123456789012345678' });
  } });
  assert.equal((await f.post({ enrollmentNumber: 'MTA26000001' })).status, 200);
  assert.match(content, /Public IP: Unavailable \(local test\)$/);
});

test('forwarded IP is ignored unless proxy trust is explicitly configured', async t => {
  const untrusted = await fixture(t);
  assert.equal((await untrusted.post({ enrollmentNumber: 'MTA26000001' }, undefined, { 'X-Forwarded-For': '8.8.8.8' })).status, 200);
  assert.match(JSON.parse(untrusted.requests[0].options.body).content, /Public IP: Unavailable \(non-public connection\)$/);
  assert.equal(untrusted.requests.length, 1, 'Production private peers must never trigger an outgoing-IP lookup.');
  const trusted = await fixture(t, { trustProxy: true });
  assert.equal((await trusted.post({ enrollmentNumber: 'MTA26000001' }, undefined, { 'X-Forwarded-For': '::ffff:8.8.8.8, 10.0.0.1' })).status, 200);
  assert.match(JSON.parse(trusted.requests[0].options.body).content, /Public IP: 8\.8\.8\.8$/);
});

test('private and malformed forwarded addresses are never displayed as public IPs', async t => {
  const f = await fixture(t, { trustProxy: true });
  for (const address of ['192.168.1.10', '10.0.0.1', '::ffff:127.0.0.1', '::1', 'fd00::1', 'fe80::1', 'not-an-IP']) {
    assert.equal((await f.post({ enrollmentNumber: 'MTA26000001' }, undefined, { 'X-Forwarded-For': address })).status, 200);
    assert.match(JSON.parse(f.requests.at(-1).options.body).content, /Public IP: Unavailable \(non-public connection\)$/);
  }
});

test('trusted proxy visitors have separate IP rate limits after one client reaches its limit', async t => {
  const f = await fixture(t, { trustProxy: true });
  const firstClient = { 'X-Forwarded-For': '::ffff:8.8.8.8, 10.0.0.1' };
  for (let i = 0; i < 300; i++) {
    const enrollmentNumber = `MTA26${String(i + 1000).padStart(6, '0')}`;
    assert.equal((await f.post({ enrollmentNumber }, undefined, firstClient)).status, 200);
  }
  assert.equal((await f.post({ enrollmentNumber: 'MTA26900001' }, undefined, { 'X-Forwarded-For': '8.8.8.8' })).status, 429);
  assert.equal((await f.post({ enrollmentNumber: 'MTA26900002' }, undefined, { 'X-Forwarded-For': '1.1.1.1' })).status, 200);
});
