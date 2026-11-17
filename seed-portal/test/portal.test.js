import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Test-only-password-123!';
const DAY = 86_400_000;

// A real PDF with a complete xref table, so tests exercise the production PDF
// parser and upload flow without checking in binary fixtures.
function pdfFixture(pageCount = 2) {
  const objects = [];
  const pageRefs = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageCount} >>`);
  for (let i = 0; i < pageCount; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 360] /Resources << >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push('<< /Length 0 >>\nstream\n\nendstream');
  }
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function harness(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'seed-portal-test-'));
  let clock = Date.UTC(2026, 10, 16, 12);
  const sent = [];
  const salt = 'c349f046d217b8db7135f7b8c3e8b81c';
  const config = {
    dataDir, port: 3000, production: false,
    seedOrigin: ORIGIN, adminOrigin: ORIGIN,
    codeDays: 10, sessionDays: 90, retentionDays: 365,
    adminUsername: 'admin',
    adminPasswordHash: `${salt}:${scryptSync(PASSWORD, salt, 64).toString('hex')}`,
    authSecret: 'test-auth-secret-that-is-longer-than-thirty-two-characters',
    mailProvider: 'test', mailFrom: 'Seed <seed@example.com>',
    secureCookies: false, trustProxy: false,
    ...overrides,
  };
  const instance = await createApp({
    config,
    sendMail: async (mail) => { sent.push(mail); },
    now: () => clock,
  });
  t.after(async () => {
    await instance.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const client = () => request.agent(instance.app).set('Host', 'localhost:3000');
  const mutate = (agent, method, path, body) => agent[method](path).set('Origin', ORIGIN).send(body);
  const admin = async () => {
    const agent = client();
    const response = await mutate(agent, 'post', '/api/admin/login', { username: 'admin', password: PASSWORD });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return agent;
  };
  const issue = async (email = 'reader@example.com') => {
    const response = await mutate(client(), 'post', '/api/auth/request', { email });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const mail = sent.at(-1);
    assert.equal(mail.to, email.trim().toLowerCase());
    return mail;
  };
  const login = async (email = 'reader@example.com') => {
    const mail = await issue(email);
    const agent = client();
    const response = await mutate(agent, 'post', '/api/auth/verify', { email, code: mail.code });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return { agent, visitor: response.body.visitor, response, mail };
  };
  const upload = async (agent, options = {}) => {
    const response = await agent.post('/api/admin/decks').set('Origin', ORIGIN)
      .field('title', options.title || 'Integration test deck')
      .field('version', options.version || 'v1')
      .field('downloadAllowed', String(options.downloadAllowed || false))
      .attach('file', options.file || pdfFixture(), {
        filename: options.filename || 'test-deck.pdf', contentType: 'application/pdf',
      });
    assert.ok([200, 201].includes(response.status), JSON.stringify(response.body));
    return response.body.deck;
  };
  const publish = async (agent, deck) => {
    const response = await mutate(agent, 'post', `/api/admin/decks/${deck.id}/publish`, {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  return { ...instance, config, sent, client, mutate, admin, issue, login, upload, publish,
    now: () => clock, advance: (ms) => { clock += ms; } };
}

test('protected content and administrator APIs require distinct authentication', async (t) => {
  const h = await harness(t);
  for (const path of ['/api/deck', '/api/admin/overview', '/api/admin/visitors', '/api/admin/export']) {
    assert.equal((await h.client().get(path)).status, 401, path);
  }
  const { agent } = await h.login();
  assert.equal((await agent.get('/api/admin/overview')).status, 401);
  assert.equal((await h.mutate(agent, 'post', '/api/admin/login', { username: 'admin', password: 'incorrect' })).status, 401);
  const admin = await h.admin();
  const deck = await h.upload(admin);
  await h.publish(admin, deck);
  const current = await agent.get('/api/deck');
  assert.equal(current.status, 200);
  const contentUrl = current.body.deck.contentUrl;
  assert.equal((await h.client().get(contentUrl)).status, 401);
  assert.equal((await agent.get(contentUrl)).status, 200);
});

test('production scopes administrator endpoints to the admin host and sets secure cookies', async (t) => {
  const h = await harness(t, {
    production: true, secureCookies: true,
    seedOrigin: 'https://seed.example.com', adminOrigin: 'https://admin.example.com',
  });
  const login = await h.client().post('/api/admin/login')
    .set('Host', 'admin.example.com').set('Origin', 'https://admin.example.com')
    .send({ username: 'admin', password: PASSWORD });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.doesNotMatch(cookie, /; Domain=/i, 'host-only cookies must not be shared with sibling sites');
  const session = cookie.split(';')[0];
  assert.equal((await h.client().get('/api/admin/me').set('Host', 'admin.example.com').set('Cookie', session)).status, 200);
  assert.equal((await h.client().get('/api/admin/me').set('Host', 'seed.example.com').set('Cookie', session)).status, 404);
  assert.equal((await h.client().get('/api/config').set('Host', 'untrusted.example.com')).status, 421);
  assert.equal((await h.client().get('/healthz').set('Host', 'internal.render.example')).status, 200);
  assert.equal((await h.client().get('/').set('Host', 'admin.example.com')).headers.location, '/admin');
});

test('OTP is valid for ten days, single use, normalized, and creates a 90-day HttpOnly session', async (t) => {
  const h = await harness(t);
  const email = '  Investor@Example.com  ';
  const mail = await h.issue(email);
  assert.equal(new Date(mail.expiresAt).getTime() - h.now(), 10 * DAY);
  assert.match(mail.code.replaceAll('-', ''), /^[A-F0-9]{12}$/);
  const agent = h.client();
  const code = mail.code.replaceAll('-', '').match(/.{4}/g).join('-').toLowerCase();
  const response = await h.mutate(agent, 'post', '/api/auth/verify', { email, code });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.visitor.email, 'investor@example.com');
  const cookies = response.headers['set-cookie'].join('; ');
  assert.match(cookies, /HttpOnly/i);
  assert.match(cookies, /SameSite=(Lax|Strict)/i);
  assert.match(cookies, /Max-Age=7776000/);
  assert.equal(new Date(response.body.expiresAt).getTime() - h.now(), 90 * DAY);
  assert.equal((await agent.get('/api/auth/me')).status, 200);
  assert.ok((await h.mutate(h.client(), 'post', '/api/auth/verify', { email, code })).status >= 400);
  assert.equal((await h.mutate(agent, 'post', '/api/auth/logout', {})).status, 200);
  assert.equal((await agent.get('/api/auth/me')).status, 401);
});

test('expired code and expired session cannot be used', async (t) => {
  const h = await harness(t);
  const mail = await h.issue('expired@example.com');
  h.advance(10 * DAY + 1);
  const expired = await h.mutate(h.client(), 'post', '/api/auth/verify', { email: mail.to, code: mail.code });
  assert.ok(expired.status >= 400);
  const { agent } = await h.login('long-lived@example.com');
  h.advance(89 * DAY);
  assert.equal((await agent.get('/api/auth/me')).status, 200);
  h.advance(DAY + 1);
  assert.equal((await agent.get('/api/auth/me')).status, 401);
});

test('resending has cooldown, invalidates the older code, and failed attempts lock a code', async (t) => {
  const h = await harness(t);
  const mail = await h.issue();
  const cooldown = await h.mutate(h.client(), 'post', '/api/auth/request', { email: mail.to });
  assert.equal(cooldown.status, 429);
  assert.equal(h.sent.length, 1);
  h.advance(61_000);
  const next = await h.issue();
  assert.notEqual(next.code, mail.code);
  assert.ok((await h.mutate(h.client(), 'post', '/api/auth/verify', { email: mail.to, code: mail.code })).status >= 400);
  for (let i = 0; i < 12; i++) {
    const attempt = await h.mutate(h.client(), 'post', '/api/auth/verify', { email: mail.to, code: '000000000000' });
    assert.ok(attempt.status >= 400);
  }
  assert.ok((await h.mutate(h.client(), 'post', '/api/auth/verify', { email: mail.to, code: next.code })).status >= 400);
});

test('simultaneous verification can consume a code only once', async (t) => {
  const h = await harness(t);
  const mail = await h.issue();
  const responses = await Promise.all(Array.from({ length: 2 }, () =>
    h.mutate(h.client(), 'post', '/api/auth/verify', { email: mail.to, code: mail.code })));
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status >= 400).length, 1);
});

test('cross-origin mutations are rejected before sending mail or changing data', async (t) => {
  const h = await harness(t);
  const response = await h.client().post('/api/auth/request')
    .set('Origin', 'https://untrusted.example').send({ email: 'reader@example.com' });
  assert.equal(response.status, 403);
  assert.equal(h.sent.length, 0);
  const missingOrigin = await h.client().post('/api/auth/request').send({ email: 'reader@example.com' });
  assert.equal(missingOrigin.status, 403);
  const admin = await h.admin();
  const badOrigin = await admin.post('/api/admin/logout').set('Origin', 'https://untrusted.example').send({});
  assert.equal(badOrigin.status, 403);
  assert.equal((await admin.get('/api/admin/me')).status, 200);
});

test('server files and paths outside a deck never become public assets', async (t) => {
  const h = await harness(t);
  const admin = await h.admin();
  const deck = await h.upload(admin);
  await h.publish(admin, deck);
  const { agent } = await h.login();
  for (const path of [
    '/.env', '/data/portal.sqlite', '/src/config.js',
    `/content/${deck.id}/..%2f..%2fportal.sqlite`,
    `/content/${deck.id}/..%5c..%5cportal.sqlite`,
    `/content/${deck.id}/unlisted-file.txt`,
  ]) {
    assert.notEqual((await agent.get(path)).status, 200, path);
  }
});

test('CSV export neutralizes formula-leading user input', async (t) => {
  const h = await harness(t);
  await h.login('=sum@example.com');
  const admin = await h.admin();
  const response = await admin.get('/api/admin/export');
  assert.equal(response.status, 200);
  assert.match(response.text, /['\t]=sum@example\.com/);
});

test('blocking and revoking invalidate access, including protected assets and outstanding codes', async (t) => {
  const h = await harness(t);
  const admin = await h.admin();
  const deck = await h.upload(admin);
  await h.publish(admin, deck);
  const { agent, visitor } = await h.login();
  const contentUrl = (await agent.get('/api/deck')).body.deck.contentUrl;
  assert.equal((await h.mutate(admin, 'patch', `/api/admin/visitors/${visitor.id}`, { blocked: true })).status, 200);
  assert.ok([401, 403].includes((await agent.get(contentUrl)).status));
  h.advance(61_000);
  const sentBeforeBlock = h.sent.length;
  const blockedRequest = await h.mutate(agent, 'post', '/api/auth/request', { email: visitor.email });
  assert.ok([200, 403].includes(blockedRequest.status));
  assert.equal(h.sent.length, sentBeforeBlock, 'blocked addresses must not receive new codes');
  await h.mutate(admin, 'patch', `/api/admin/visitors/${visitor.id}`, { blocked: false });
  h.advance(61_000);
  const fresh = await h.login();
  h.advance(61_000);
  const pending = await h.issue();
  assert.equal((await h.mutate(admin, 'post', `/api/admin/visitors/${visitor.id}/revoke`, {})).status, 200);
  assert.equal((await fresh.agent.get('/api/auth/me')).status, 401);
  assert.ok((await h.mutate(h.client(), 'post', '/api/auth/verify', { email: visitor.email, code: pending.code })).status >= 400);
});

test('per-visitor access expiration is enforced on every content request', async (t) => {
  const h = await harness(t);
  const admin = await h.admin();
  const deck = await h.upload(admin);
  await h.publish(admin, deck);
  const { agent, visitor } = await h.login();
  const contentUrl = (await agent.get('/api/deck')).body.deck.contentUrl;
  const expires = new Date(h.now() + 60_000).toISOString();
  assert.equal((await h.mutate(admin, 'patch', `/api/admin/visitors/${visitor.id}`, { accessExpiresAt: expires })).status, 200);
  assert.equal((await agent.get(contentUrl)).status, 200);
  h.advance(60_001);
  assert.ok([401, 403].includes((await agent.get(contentUrl)).status));
});

test('retention removes old analytics but preserves blocked and expired access restrictions', async (t) => {
  const h = await harness(t);
  const admin = await h.admin();
  const deck = await h.upload(admin);
  await h.publish(admin, deck);
  const blocked = await h.login('blocked-retention@example.com');
  const expired = await h.login('expired-retention@example.com');
  const unrestricted = await h.login('ordinary-retention@example.com');
  for (const reader of [blocked, expired, unrestricted]) {
    const visit = await h.mutate(reader.agent, 'post', '/api/visits', { deckId: deck.id });
    assert.equal(visit.status, 201);
    h.advance(10_000);
    assert.equal((await h.mutate(reader.agent, 'post', '/api/events', {
      visitId: visit.body.visitId, page: 1, seconds: 10, sequence: 1,
    })).status, 200);
  }
  const accessExpiresAt = new Date(h.now() + DAY).toISOString();
  assert.equal((await h.mutate(admin, 'patch', `/api/admin/visitors/${blocked.visitor.id}`, { blocked: true })).status, 200);
  assert.equal((await h.mutate(admin, 'patch', `/api/admin/visitors/${expired.visitor.id}`, { accessExpiresAt })).status, 200);
  assert.equal((await admin.get('/api/admin/overview')).body.stats.visits, 3);

  h.advance(366 * DAY);
  // The next request runs the actual hourly retention job. Administrator
  // reauthentication is necessary because its original session also expired.
  const freshAdmin = await h.admin();
  const overview = await freshAdmin.get('/api/admin/overview');
  assert.equal(overview.body.stats.visitors, 2);
  assert.equal(overview.body.stats.visits, 0);
  assert.equal(overview.body.stats.activeSeconds, 0);
  const blockedDetail = await freshAdmin.get(`/api/admin/visitors/${blocked.visitor.id}`);
  const expiredDetail = await freshAdmin.get(`/api/admin/visitors/${expired.visitor.id}`);
  assert.equal(blockedDetail.status, 200);
  assert.equal(blockedDetail.body.visitor.blocked, true);
  assert.deepEqual(blockedDetail.body.visits, []);
  assert.equal(expiredDetail.status, 200);
  assert.equal(expiredDetail.body.visitor.accessExpiresAt, accessExpiresAt);
  assert.deepEqual(expiredDetail.body.visits, []);
  assert.equal((await freshAdmin.get(`/api/admin/visitors/${unrestricted.visitor.id}`)).status, 404);

  const sentBeforeRequests = h.sent.length;
  for (const reader of [blocked, expired]) {
    const response = await h.mutate(h.client(), 'post', '/api/auth/request', { email: reader.visitor.email });
    assert.equal(response.status, 200, 'use a generic response without revealing access policy');
    assert.equal((await reader.agent.get('/api/deck')).status, 401);
    assert.ok((await h.mutate(h.client(), 'post', '/api/auth/verify', {
      email: reader.visitor.email, code: reader.mail.code,
    })).status >= 400);
  }
  assert.equal(h.sent.length, sentBeforeRequests, 'retention must never reopen access by sending a fresh code');
});

test('PDF upload stays draft, is parsed server-side, and publishing swaps the current version', async (t) => {
  const h = await harness(t);
  const admin = await h.admin();
  const { agent } = await h.login();
  const first = await h.upload(admin);
  assert.equal(first.pageCount, 2);
  assert.equal(first.status, 'draft');
  assert.equal((await agent.get('/api/deck')).body.deck, null);
  const preview = await admin.get(`/api/admin/decks/${first.id}/preview`);
  assert.equal(preview.status, 200);
  assert.ok([403, 404].includes((await agent.get(preview.body.deck.contentUrl)).status));
  assert.equal((await admin.get(preview.body.deck.contentUrl)).status, 200);
  assert.equal((await admin.get('/api/admin/overview')).body.stats.visits, 0);
  await h.publish(admin, first);
  assert.equal((await agent.get('/api/deck')).body.deck.id, first.id);
  const second = await h.upload(admin, { version: 'v2', file: pdfFixture(1) });
  await h.publish(admin, second);
  assert.equal((await agent.get('/api/deck')).body.deck.id, second.id);
  const versions = (await admin.get('/api/admin/decks')).body.decks;
  assert.equal(versions.find((deck) => deck.id === first.id).status, 'archived');
  assert.equal(versions.filter((deck) => deck.status === 'published').length, 1);
  const invalid = await admin.post('/api/admin/decks').set('Origin', ORIGIN)
    .field('title', 'Pretend PDF').field('version', 'bad')
    .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'pretend.pdf', contentType: 'application/pdf' });
  assert.ok([400, 415, 422].includes(invalid.status), JSON.stringify(invalid.body));
});

test('download requires both deck permission and visitor permission', async (t) => {
  const h = await harness(t);
  const admin = await h.admin();
  const deck = await h.upload(admin);
  await h.publish(admin, deck);
  const { agent, visitor } = await h.login();
  const path = `/api/deck/${deck.id}/download`;
  assert.equal((await agent.get(path)).status, 403);
  await h.mutate(admin, 'patch', `/api/admin/decks/${deck.id}`, { downloadAllowed: true });
  assert.equal((await agent.get(path)).status, 403);
  await h.mutate(admin, 'patch', `/api/admin/visitors/${visitor.id}`, { downloadAllowed: true });
  const allowed = await agent.get(path);
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers['content-disposition'], /attachment/i);
  await h.mutate(admin, 'patch', `/api/admin/decks/${deck.id}`, { downloadAllowed: false });
  assert.equal((await agent.get(path)).status, 403);
});

test('analytics are visitor-bound, deduplicated, page-validated, and bounded by elapsed time', async (t) => {
  const h = await harness(t);
  const admin = await h.admin();
  const deck = await h.upload(admin);
  await h.publish(admin, deck);
  const alice = await h.login('alice@example.com');
  const bob = await h.login('bob@example.com');
  const opened = await h.mutate(alice.agent, 'post', '/api/visits', { deckId: deck.id });
  assert.ok([200, 201].includes(opened.status), JSON.stringify(opened.body));
  const visitId = opened.body.visitId;
  h.advance(15_000);
  const payload = { visitId, page: 1, seconds: 15, sequence: 1 };
  assert.ok([403, 404].includes((await h.mutate(bob.agent, 'post', '/api/events', payload)).status));
  assert.equal((await h.mutate(alice.agent, 'post', '/api/events', payload)).status, 200);
  await h.mutate(alice.agent, 'post', '/api/events', payload);
  const invalidPage = await h.mutate(alice.agent, 'post', '/api/events', { ...payload, page: 999, sequence: 2 });
  assert.ok(invalidPage.status >= 400);
  const negative = await h.mutate(alice.agent, 'post', '/api/events', { ...payload, seconds: -20, sequence: 2 });
  assert.ok(negative.status >= 400);
  const detail = (await admin.get(`/api/admin/visitors/${alice.visitor.id}`)).body;
  assert.equal(detail.visits.length, 1);
  assert.equal(detail.visits[0].seconds, 15);
  h.advance(10_000);
  await h.mutate(alice.agent, 'post', '/api/events', { ...payload, page: 2, seconds: 900, sequence: 2 });
  const capped = (await admin.get(`/api/admin/visitors/${alice.visitor.id}`)).body;
  assert.ok(capped.visits[0].seconds <= 45, 'a heartbeat cannot add more than 30 seconds');
  assert.ok(capped.visits[0].seconds <= 25, 'analytics cannot exceed elapsed wall-clock time');
  const overview = (await admin.get('/api/admin/overview')).body;
  assert.equal(overview.stats.visitors, 2);
  assert.equal(overview.stats.visits, 1);
  assert.equal(overview.activity.length, 14);
  assert.equal((await admin.get('/api/admin/visitors?q=alice')).body.total, 1);
  assert.match((await admin.get('/api/admin/export')).headers['content-type'], /text\/csv/);
});

test('dashboard activity buckets use the requested timezone and reject invalid zones', async (t) => {
  const h = await harness(t);
  const admin = await h.admin();
  const deck = await h.upload(admin);
  await h.publish(admin, deck);
  const reader = await h.login();
  assert.equal((await h.mutate(reader.agent, 'post', '/api/visits', { deckId: deck.id })).status, 201);
  // Starting at Nov 16 12:00 UTC, move to Nov 17 01:00 UTC: Seoul has
  // crossed midnight while Los Angeles is still on November 16.
  h.advance(13 * 3_600_000);
  assert.equal((await h.mutate(reader.agent, 'post', '/api/visits', { deckId: deck.id })).status, 201);
  const freshAdmin = await h.admin();
  const seoul = await freshAdmin.get('/api/admin/overview').query({ timezone: 'Asia/Seoul' });
  const losAngeles = await freshAdmin.get('/api/admin/overview').query({ timezone: 'America/Los_Angeles' });
  assert.equal(seoul.status, 200);
  assert.equal(losAngeles.status, 200);
  assert.deepEqual(seoul.body.activity.at(-1), { date: '2026-11-17', visits: 1 });
  assert.deepEqual(seoul.body.activity.at(-2), { date: '2026-11-16', visits: 1 });
  assert.deepEqual(losAngeles.body.activity.at(-1), { date: '2026-11-16', visits: 2 });
  for (const result of [seoul, losAngeles]) {
    assert.equal(result.body.activity.length, 14);
    assert.equal(result.body.activity.reduce((sum, day) => sum + day.visits, 0), 2);
    assert.equal(result.body.stats.visits, 2, 'timezone must not change total visits');
  }
  assert.equal((await freshAdmin.get('/api/admin/overview').query({ timezone: 'Invalid/Timezone' })).status, 400);
});

test('mail delivery failure is reported and never authenticates a visitor', async (t) => {
  const h = await harness(t);
  const isolatedDir = await mkdtemp(join(tmpdir(), 'seed-portal-mail-test-'));
  const instance = await createApp({
    config: { ...h.config, dataDir: isolatedDir },
    sendMail: async () => { throw new Error('provider unavailable'); },
    now: h.now,
  });
  t.after(async () => { await instance.close(); await rm(isolatedDir, { recursive: true, force: true }); });
  const agent = request.agent(instance.app).set('Host', 'localhost:3000');
  const response = await agent.post('/api/auth/request').set('Origin', ORIGIN).send({ email: 'reader@example.com' });
  assert.ok([502, 503].includes(response.status), JSON.stringify(response.body));
  assert.ok(response.body.error);
  assert.equal((await agent.get('/api/auth/me')).status, 401);
});
