import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENROLLMENT_RE = /^MTA26\d{6}$/;
const localHost = hostname => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);

export function configFromEnv(env = process.env) {
  const requestedPort = Number(env.PORT || 3000);
  const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : 3000;
  const publicUrl = new URL(env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`);
  const allowedOrigins = new Set([publicUrl.origin, ...(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)]);
  if (publicUrl.protocol === 'http:' && localHost(publicUrl.hostname)) {
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
      allowedOrigins.add(`http://${hostname}:${port}`);
      allowedOrigins.add(`http://${hostname}:5500`);
    }
  }
  return { host: env.HOST || '127.0.0.1', port, publicOrigin: publicUrl.origin, allowedOrigins,
    webhookUrl: env.NOTIFICATION_WEBHOOK_URL || '', publicDir: path.join(root, 'public'),
    trustProxy: env.TRUST_PROXY === 'true',
    fetchImpl: globalThis.fetch, clock: Date.now };
}

function normalizedIp(value) {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (!isIP(ip)) return null;
  if (isIP(ip) === 6) {
    try { ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return null; }
    if (ip.startsWith('::ffff:')) {
      const pieces = ip.slice(7).split(':');
      if (pieces.length !== 2) return null;
      const first = parseInt(pieces[0], 16), second = parseInt(pieces[1], 16);
      ip = `${first >>> 8}.${first & 255}.${second >>> 8}.${second & 255}`;
    }
  }
  return ip;
}

function publicIp(value) {
  const ip = normalizedIp(value);
  if (!ip) return null;
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return null;
  } else if (ip === '::' || ip === '::1' || /^(fc|fd|fe[89ab]|ff)/i.test(ip) || ip.startsWith('2001:db8:')) return null;
  return ip;
}

function discordUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname) || url.username || url.password || url.port || url.hash || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)) return null;
    url.searchParams.set('wait', 'true');
    return url.href;
  } catch { return null; }
}

export function createLoggerServer(options = {}) {
  const config = { ...configFromEnv({}), ...options };
  const allowedOrigins = new Set(config.allowedOrigins);
  const webhook = discordUrl(config.webhookUrl);
  const buckets = new Map();
  const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const originIsLocal = localHost(new URL(config.publicOrigin).hostname);
  let localIpCache = null, localIpLookup = null;
  function connectionIp(req) {
    const forwarded = config.trustProxy && typeof req.headers['x-forwarded-for'] === 'string'
      ? normalizedIp(req.headers['x-forwarded-for'].split(',')[0]) : null;
    return forwarded || normalizedIp(req.socket.remoteAddress) || 'unknown';
  }
  async function requestPublicIp(req) {
    const peer = normalizedIp(req.socket.remoteAddress);
    const verified = publicIp(connectionIp(req));
    if (verified) return verified;
    if (!originIsLocal || !['127.0.0.1', '::1'].includes(peer)) return 'Unavailable (non-public connection)';
    if (localIpCache && localIpCache.expires > config.clock()) return localIpCache.value;
    if (!localIpLookup) {
      localIpLookup = (async () => {
        let value = 'Unavailable (local test)';
        try {
          const response = await config.fetchImpl('https://api64.ipify.org?format=json', { signal: AbortSignal.timeout(3_000), redirect: 'error' });
          const data = response.ok ? await response.json() : null;
          const address = publicIp(data?.ip);
          if (address) value = `${address} (local test network)`;
        } catch { /* IP lookup must not prevent the login record. */ }
        localIpCache = { value, expires: config.clock() + 60_000 };
        return value;
      })().finally(() => { localIpLookup = null; });
    }
    return localIpLookup;
  }
  const cleanup = () => { const now = config.clock(); for (const [key, bucket] of buckets) if (bucket.expires <= now) buckets.delete(key); };
  const timer = setInterval(cleanup, 60_000);
  timer.unref();
  function limited(key, maximum, windowMs) {
    const now = config.clock();
    const prior = buckets.get(key);
    if (!prior || prior.expires <= now) { buckets.set(key, { count: 1, expires: now + windowMs }); return false; }
    prior.count++;
    return prior.count > maximum;
  }
  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }
  async function bodyJson(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw Object.assign(new Error('Use application/json.'), { status: 415 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 });
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      return body;
    } catch { throw Object.assign(new Error('Send a valid JSON object.'), { status: 400 }); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    let url;
    try { url = new URL(req.url, config.publicOrigin); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    try {
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: 'This website is not allowed to submit login records.' });
        if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
          return res.end();
        }
        if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { service: 'RMO test logger', loggingConfigured: !!webhook });
        if (url.pathname !== '/api/log-attempt' || req.method !== 'POST') return send(res, 404, { error: 'Endpoint not found.' });
        if (limited(`ip:${connectionIp(req)}`, 300, 15 * 60_000)) return send(res, 429, { error: 'Too many submissions. Please try again later.' }, { 'Retry-After': '900' });
        const body = await bodyJson(req);
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'enrollmentNumber')) return send(res, 400, { error: 'Send only enrollmentNumber.' });
        if (typeof body.enrollmentNumber !== 'string' || !ENROLLMENT_RE.test(body.enrollmentNumber)) return send(res, 400, { error: 'Enter MTA26 followed by exactly six digits.' });
        if (limited(`id:${body.enrollmentNumber}`, 10, 60_000)) return send(res, 429, { error: 'Too many submissions for this enrollment number. Please try again in a minute.' }, { 'Retry-After': '60' });
        if (!webhook) return send(res, 503, { error: 'Online login logging is not configured yet.' });
        const time = new Date(config.clock()).toISOString();
        const address = await requestPublicIp(req);
        const content = `**RMO2026 TEST LOGIN**\nEnrollment number: ${body.enrollmentNumber}\nTime: ${time} | ${timeFormat.format(new Date(time))} IST\nPublic IP: ${address}`;
        try {
          const response = await config.fetchImpl(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
          const acknowledgement = response.ok ? await response.json().catch(() => null) : null;
          if (!response.ok || !acknowledgement || typeof acknowledgement.id !== 'string' || !/^\d+$/.test(acknowledgement.id)) return send(res, 502, { error: 'The login record could not be confirmed. Please try again.' });
          return send(res, 200, { saved: true, time });
        } catch { return send(res, 502, { error: 'The login record could not be confirmed. Please try again.' }); }
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'Method not allowed.' });
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Invalid path.' }); }
      if (decoded.includes('\0') || decoded.includes('\\')) return send(res, 404, { error: 'Not found.' });
      const file = path.resolve(config.publicDir, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!file.startsWith(`${path.resolve(config.publicDir)}${path.sep}`)) return send(res, 404, { error: 'Not found.' });
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
      let bytes;
      try { if (!statSync(file).isFile()) throw new Error(); bytes = readFileSync(file); } catch { return send(res, 404, { error: 'Not found.' }); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Unable to complete this request.' });
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, loggingConfigured: !!webhook, close: () => clearInterval(timer) };
}
