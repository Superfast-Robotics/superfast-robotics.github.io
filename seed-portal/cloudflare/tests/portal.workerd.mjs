// Run with Node 22+:
// node --test cloudflare/tests/portal.workerd.mjs
// Uses the actual workerd runtime, local D1 and local R2. No cloud account,
// network email service, production secrets, or deployment is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID, scryptSync } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEED = 'https://seed.example.com';
const ADMIN = 'https://admin.example.com';
const PASSWORD = 'Synthetic-worker-test-password!';
const DAY = 86_400_000;
let bundlePromise;
let gatewayBundlePromise;

async function gatewayBundle() {
  gatewayBundlePromise ??= build({
    absWorkingDir: ROOT, entryPoints: ['cloudflare/entry.js'],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['node:*', 'cloudflare:*'], logLevel: 'silent',
  }).then((result) => result.outputFiles[0].text);
  return gatewayBundlePromise;
}

// Only this test wrapper understands the clock header and maintenance path.
// The production entrypoint has neither hook.
async function testBundle() {
  bundlePromise ??= build({
    absWorkingDir: ROOT,
    stdin: {
      resolveDir: ROOT,
      sourcefile: 'workerd-test-entry.mjs',
      contents: `import { createHandler } from './cloudflare/worker.js';
        export default {
          async fetch(request, env, ctx) {
            const handler = createHandler({
              now: () => Number(request.headers.get('x-test-now')),
              mailReady: () => true,
              sendMail: async (mailEnv, message) => {
                const response = await mailEnv.MAIL_CAPTURE.fetch(new Request('https://capture.test/', {
                  method: 'POST', body: JSON.stringify(message), headers: {'content-type':'application/json'}
                }));
                if (!response.ok) throw new Error('Injected delivery failure');
              }
            });
            if (new URL(request.url).pathname === '/__test/prune') {
              await handler.scheduled({scheduledTime: Number(request.headers.get('x-test-now')), cron:'0 3 * * *'}, env, ctx);
              return Response.json({ok:true});
            }
            return handler.fetch(request, env, ctx);
          }
        };`,
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['node:*', 'cloudflare:*'], logLevel: 'silent',
  }).then((result) => result.outputFiles[0].text);
  return bundlePromise;
}

function schemaStatements(schema) {
  const statements = [];
  let buffer = [], trigger = false;
  for (const original of schema.split(/\r?\n/)) {
    const line = original.replace(/--.*$/, '').trim();
    if (!line) continue;
    if (/^CREATE\s+TRIGGER\b/i.test(line)) trigger = true;
    buffer.push(line);
    if (line.endsWith(';') && (!trigger || /^END;$/i.test(line))) {
      statements.push(buffer.join(' '));
      buffer = []; trigger = false;
    }
  }
  assert.equal(buffer.length, 0, 'schema must end with a complete statement');
  return statements;
}

function pdfFixture(pageCount = 2) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`];
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

async function harness(t, { gateway = false } = {}) {
  let clock = Date.UTC(2026, 10, 16, 12), failMail = false;
  const sent = [];
  const salt = 'a64271dfb5b682d65bf83b0524193a85';
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: `portal-test-${randomUUID()}`, modules: true, script: gateway ? await gatewayBundle() : await testBundle(),
    compatibilityDate: '2026-11-16', compatibilityFlags: ['nodejs_compat'],
    log: new Log(LogLevel.ERROR),
    d1Databases: ['DB'], r2Buckets: ['DECKS'],
    durableObjects: gateway ? { PORTAL_API: { className: 'PortalApi', useSQLite: true } } : undefined,
    bindings: {
      AUTH_SECRET: 'test-auth-secret-with-at-least-thirty-two-characters',
      ADMIN_PASSWORD_HASH: `${salt}:${scryptSync(PASSWORD, salt, 64).toString('hex')}`,
      ADMIN_USERNAME: 'admin', SEED_ORIGIN: SEED, ADMIN_ORIGIN: ADMIN,
      CODE_DAYS: '10', SESSION_DAYS: '90', RETENTION_DAYS: '365',
      MAIL_PROVIDER: 'smtp', MAIL_FROM: 'Seed <seed@example.com>',
      SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_SECURE: 'true',
    },
    serviceBindings: {
      MAIL_CAPTURE: async (request) => {
        if (failMail) return new Response('Unavailable', { status: 503 });
        sent.push(await request.json());
        return Response.json({ ok: true });
      },
      ASSETS: async (request) => new Response(
        ['/','/index.html','/admin','/admin.html'].includes(new URL(request.url).pathname) ? '<html>Public UI fixture</html>' : 'Not found',
        { status: ['/','/index.html','/admin','/admin.html'].includes(new URL(request.url).pathname) ? 200 : 404,
          headers: { 'content-type': 'text/html' } }),
    },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('DECKS');
  const statements = schemaStatements(await readFile(path.join(ROOT, 'cloudflare/schema.sql'), 'utf8'));
  await db.batch(statements.map((sql) => db.prepare(sql)));

  function client(origin = SEED) {
    const jar = new Map();
    const call = async (route, { method = 'GET', body, headers: extraHeaders = {}, originHeader = origin } = {}) => {
      const headers = new Headers(extraHeaders);
      headers.set('x-test-now', String(clock));
      headers.set('cf-connecting-ip', '203.0.113.7');
      if (jar.size && !headers.has('cookie')) headers.set('cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
      if (!['GET','HEAD','OPTIONS'].includes(method) && originHeader !== null) headers.set('origin', originHeader);
      if (body instanceof FormData) {
        // Miniflare and Node expose different FormData classes. Encode the
        // browser-equivalent multipart body before crossing that boundary.
        const encoded = new Request(origin, { method: 'POST', body });
        headers.set('content-type', encoded.headers.get('content-type'));
        body = await encoded.arrayBuffer();
      } else if (body !== undefined && typeof body !== 'string') {
        headers.set('content-type', 'application/json'); body = JSON.stringify(body);
      }
      const response = await mf.dispatchFetch(origin + route, { method, body, headers, redirect: 'manual' });
      const cookie = response.headers.get('set-cookie');
      if (cookie) {
        const [name, ...parts] = cookie.split(';')[0].split('=');
        if (parts.join('=')) jar.set(name, parts.join('=')); else jar.delete(name);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const text = bytes.toString('utf8');
      let json;
      if (response.headers.get('content-type')?.includes('application/json')) json = JSON.parse(text);
      return { status: response.status, headers: response.headers, text, bytes, body: json };
    };
    return { call, jar, get: (route, options) => call(route, options),
      post: (route, body = {}, options) => call(route, { method: 'POST', body, ...options }),
      patch: (route, body) => call(route, { method: 'PATCH', body }) };
  }
  async function issue(email = 'reader@example.com') {
    const result = await client().post('/api/auth/request', { email });
    assert.equal(result.status, 200, result.text);
    assert.equal(sent.at(-1)?.to, email);
    return sent.at(-1);
  }
  async function login(email = 'reader@example.com') {
    const mail = await issue(email), agent = client();
    const result = await agent.post('/api/auth/verify', { email, code: mail.code });
    assert.equal(result.status, 200, result.text);
    return { agent, visitor: result.body.visitor, result, mail };
  }
  async function admin() {
    const agent = client(ADMIN);
    const result = await agent.post('/api/admin/login', { username: 'admin', password: PASSWORD });
    assert.equal(result.status, 200, result.text);
    return agent;
  }
  async function seedDeck() {
    const id = randomUUID();
    await db.prepare(`INSERT INTO decks(id,title,version,kind,page_count,created_at,published_at,status,files_json,pdf_file)
      VALUES(?,?,?,'html',2,?,?,'published',?,'download.pdf')`)
      .bind(id, 'Protected HTML deck', `v-${id}`, clock, clock, JSON.stringify(['index.html','clip.mp4','download.pdf'])).run();
    await bucket.put(`decks/${id}/index.html`, '<html><body><section class="slide">A</section><section class="slide">B</section></body></html>', { httpMetadata: { contentType: 'text/html' } });
    await bucket.put(`decks/${id}/clip.mp4`, '0123456789', { httpMetadata: { contentType: 'video/mp4' } });
    await bucket.put(`decks/${id}/download.pdf`, pdfFixture(), { httpMetadata: { contentType: 'application/pdf' } });
    return { id };
  }
  async function upload(adminClient, version = 'v1', bytes = pdfFixture()) {
    const form = new FormData();
    form.set('title', 'Uploaded PDF'); form.set('version', version); form.set('downloadAllowed', 'false');
    form.set('file', new Blob([bytes], { type: 'application/pdf' }), 'deck.pdf');
    return adminClient.post('/api/admin/decks', form);
  }
  return { mf, db, bucket, sent, client, issue, login, admin, seedDeck, upload,
    now: () => clock, advance: (ms) => { clock += ms; }, setMailFailure: (value) => { failMail = value; } };
}

test('workerd: one OTP creates exactly one 90-day session under concurrent verification', async (t) => {
  const h = await harness(t);
  const mail = await h.issue();
  assert.equal(new Date(mail.expiresAt).getTime() - h.now(), 10 * DAY);
  const results = await Promise.all(Array.from({ length: 8 }, () => h.client().post('/api/auth/verify', { email: mail.to, code: mail.code })));
  const success = results.filter((result) => result.status === 200);
  assert.equal(success.length, 1, results.map((r) => r.status).join(','));
  assert.equal(results.filter((result) => result.status >= 400).length, 7);
  const cookie = success[0].headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /Max-Age=7776000/i);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal(new Date(success[0].body.expiresAt).getTime() - h.now(), 90 * DAY);
  assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM sessions WHERE role='visitor'").first()).n, 1);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM visitors').first()).n, 1);
  const stored = await h.db.prepare('SELECT * FROM codes').first();
  assert.notEqual(stored.code_hash, mail.code);
  assert.ok(stored.used_at);
});

test('workerd: cooldown is atomic, failed attempts lock a code, and expiry is enforced', async (t) => {
  const h = await harness(t);
  const requests = await Promise.all(Array.from({ length: 6 }, () => h.client().post('/api/auth/request', { email: 'reader@example.com' })));
  assert.equal(requests.filter((r) => r.status === 200).length, 1);
  assert.equal(h.sent.length, 1);
  const mail = h.sent[0];
  for (let i = 0; i < 5; i++) assert.ok((await h.client().post('/api/auth/verify', { email: mail.to, code: '000000000000' })).status >= 400);
  assert.ok((await h.client().post('/api/auth/verify', { email: mail.to, code: mail.code })).status >= 400);
  h.advance(3_600_001);
  const expired = await h.issue('expired@example.com');
  h.advance(10 * DAY + 1);
  assert.ok((await h.client().post('/api/auth/verify', { email: expired.to, code: expired.code })).status >= 400);
  const signedIn = await h.login('session@example.com');
  h.advance(90 * DAY + 1);
  assert.equal((await signedIn.agent.get('/api/auth/me')).status, 401);
});

test('workerd: host isolation, CSRF and visitor/admin role boundaries apply to all private paths', async (t) => {
  const h = await harness(t), deck = await h.seedDeck();
  assert.equal((await h.client().get('/api/admin/overview')).status, 404);
  assert.equal((await h.client(ADMIN).get('/api/admin/overview')).status, 401);
  assert.equal((await h.client('https://unknown.example.com').get('/api/config')).status, 421);
  for (const originHeader of ['https://attacker.example.com', null, ADMIN]) {
    assert.equal((await h.client().post('/api/auth/request', { email: 'reader@example.com' }, { originHeader })).status, 403);
  }
  assert.equal(h.sent.length, 0);
  assert.equal((await h.client().get(`/content/${deck.id}/index.html`)).status, 401);
  const reader = await h.login();
  assert.equal((await reader.agent.get(`/content/${deck.id}/index.html`)).status, 200);
  assert.equal((await h.client(ADMIN).get('/api/admin/overview', { headers: { cookie: [...reader.agent.jar].map(([k,v]) => `${k}=${v}`).join('; ') } })).status, 401);
  const admin = await h.admin();
  assert.equal((await admin.get('/api/admin/overview')).status, 200);
  assert.equal((await h.client().get('/api/admin/overview', { headers: { cookie: [...admin.jar].map(([k,v]) => `${k}=${v}`).join('; ') } })).status, 404);
  assert.equal(new URL((await h.client(ADMIN).get('/')).headers.get('location'), ADMIN).pathname, '/admin');
});

test('workerd: HTTP reads redirect only configured hosts while insecure writes stay rejected', async (t) => {
  const h = await harness(t);
  for (const secureOrigin of [SEED, ADMIN]) {
    const insecureOrigin = secureOrigin.replace('https:', 'http:');
    const visitor = h.client(insecureOrigin);
    const get = await visitor.get('/?source=email&campaign=seed');
    assert.equal(get.status, 308);
    assert.equal(get.headers.get('location'), `${secureOrigin}/?source=email&campaign=seed`);
    const head = await visitor.get('/admin?preview=deck-id', { method: 'HEAD' });
    assert.equal(head.status, 308);
    assert.equal(head.headers.get('location'), `${secureOrigin}/admin?preview=deck-id`);
    assert.equal(head.bytes.length, 0);
    const deceptivePath = await visitor.get('//attacker.example.com/path?next=external');
    assert.equal(new URL(deceptivePath.headers.get('location')).origin, secureOrigin);
    assert.equal(new URL(deceptivePath.headers.get('location')).pathname, '//attacker.example.com/path');
    const write = await visitor.post('/api/auth/request', { email: 'reader@example.com' });
    assert.equal(write.status, 421);
    assert.equal(write.headers.get('location'), null);
  }
  assert.equal((await h.client('http://unknown.example.com').get('/')).status, 421);
  assert.equal((await h.client('https://unknown.example.com').get('/')).status, 421);
  assert.equal(h.sent.length, 0);
  assert.equal((await h.client().get('/api/config')).status, 200);
});

test('workerd: private R2 media supports byte ranges and requires both download grants', async (t) => {
  const h = await harness(t), deck = await h.seedDeck();
  const reader = await h.login(), admin = await h.admin();
  const file = `/content/${deck.id}/clip.mp4`;
  assert.equal((await h.client().get(file, { headers: { range: 'bytes=2-5' } })).status, 401);
  const range = await reader.agent.get(file, { headers: { range: 'bytes=2-5' } });
  assert.equal(range.status, 206, range.text); assert.equal(range.text, '2345');
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.match(range.headers.get('cache-control'), /no-store/);
  const suffix = await reader.agent.get(file, { headers: { range: 'bytes=-4' } });
  assert.equal(suffix.status, 206); assert.equal(suffix.text, '6789');
  assert.equal((await reader.agent.get(file, { headers: { range: 'bytes=30-40' } })).status, 416);
  const head = await reader.agent.get(file, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
  assert.equal(head.headers.get('content-length'), '10');
  for (const name of ['download.pdf','..%2f..%2fportal.sqlite','..%5c..%5cportal.sqlite','unknown.mp4']) {
    assert.ok((await reader.agent.get(`/content/${deck.id}/${name}`)).status >= 400);
  }
  const download = `/api/deck/${deck.id}/download`;
  assert.equal((await reader.agent.get(download)).status, 403);
  await admin.patch(`/api/admin/decks/${deck.id}`, { downloadAllowed: true });
  assert.equal((await reader.agent.get(download)).status, 403);
  await admin.patch(`/api/admin/visitors/${reader.visitor.id}`, { downloadAllowed: true });
  const allowed = await reader.agent.get(download);
  assert.equal(allowed.status, 200); assert.match(allowed.headers.get('content-disposition'), /attachment/);
  await admin.patch(`/api/admin/visitors/${reader.visitor.id}`, { blocked: true });
  assert.ok([401,403].includes((await reader.agent.get(file)).status));
});

test('workerd: session revocation and access expiration also invalidate content access', async (t) => {
  const h = await harness(t), deck = await h.seedDeck(), admin = await h.admin();
  const reader = await h.login();
  h.advance(61_000);
  const pending = await h.issue();
  assert.equal((await admin.post(`/api/admin/visitors/${reader.visitor.id}/revoke`)).status, 200);
  assert.equal((await reader.agent.get(`/content/${deck.id}/index.html`)).status, 401);
  assert.ok((await h.client().post('/api/auth/verify', { email: pending.to, code: pending.code })).status >= 400);
  h.advance(61_000);
  const fresh = await h.login();
  assert.equal((await admin.patch(`/api/admin/visitors/${fresh.visitor.id}`, { accessExpiresAt: new Date(h.now() + 60_000).toISOString() })).status, 200);
  assert.equal((await fresh.agent.get('/api/deck')).status, 200);
  h.advance(60_001);
  assert.ok([401,403].includes((await fresh.agent.get(`/content/${deck.id}/index.html`)).status));
  const before = h.sent.length;
  assert.equal((await h.client().post('/api/auth/request', { email: fresh.visitor.email })).status, 200);
  assert.equal(h.sent.length, before);
});

test('workerd: concurrent analytics cannot double-count, cross visitors, or exceed real elapsed time', async (t) => {
  const h = await harness(t), deck = await h.seedDeck(), admin = await h.admin();
  const alice = await h.login('alice@example.com'), bob = await h.login('bob@example.com');
  const opened = await alice.agent.post('/api/visits', { deckId: deck.id });
  assert.equal(opened.status, 201, opened.text);
  const visitId = opened.body.visitId;
  h.advance(15_000);
  const event = { visitId, page: 1, seconds: 15, sequence: 1 };
  assert.ok([403,404].includes((await bob.agent.post('/api/events', event)).status));
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => alice.agent.post('/api/events', event)));
  assert.ok(duplicates.every((r) => r.status === 200), duplicates.map((r) => r.status).join(','));
  let detail = await admin.get(`/api/admin/visitors/${alice.visitor.id}`);
  assert.equal(detail.body.visits[0].seconds, 15);
  assert.equal(detail.body.visits[0].pages.reduce((sum, p) => sum + p.seconds, 0), 15);
  h.advance(10_000);
  await Promise.all([2,3].map((sequence) => alice.agent.post('/api/events', { ...event, sequence, page: sequence - 1, seconds: 10 })));
  detail = await admin.get(`/api/admin/visitors/${alice.visitor.id}`);
  assert.equal(detail.body.visits[0].seconds, 25);
  assert.equal(detail.body.visits[0].pages.reduce((sum, p) => sum + p.seconds, 0), 25);
  assert.ok((await alice.agent.post('/api/events', { ...event, sequence: 4, seconds: 900 })).status >= 400);
  assert.ok((await alice.agent.post('/api/events', { ...event, sequence: 4, page: 999 })).status >= 400);
  assert.equal((await admin.get('/api/admin/overview')).body.stats.activeSeconds, 25);
});

test('workerd: PDF uploads are parsed into protected drafts and publication is atomic', async (t) => {
  const h = await harness(t), admin = await h.admin(), reader = await h.login();
  const upload = await h.upload(admin);
  assert.equal(upload.status, 201, upload.text);
  const first = upload.body.deck;
  assert.equal(first.pageCount, 2); assert.equal(first.status, 'draft');
  assert.equal((await reader.agent.get('/api/deck')).body.deck, null);
  const preview = await admin.get(`/api/admin/decks/${first.id}/preview`);
  assert.equal(preview.status, 200);
  assert.ok([403,404].includes((await reader.agent.get(preview.body.deck.contentUrl)).status));
  assert.equal((await admin.get(preview.body.deck.contentUrl)).status, 200);
  assert.equal((await admin.post(`/api/admin/decks/${first.id}/publish`)).status, 200);
  const second = await h.upload(admin, 'v2', pdfFixture(1));
  assert.equal(second.status, 201, second.text);
  assert.equal((await admin.post(`/api/admin/decks/${second.body.deck.id}/publish`)).status, 200);
  assert.equal((await reader.agent.get('/api/deck')).body.deck.id, second.body.deck.id);
  assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM decks WHERE status='published'").first()).n, 1);
  const objectCount = (await h.bucket.list()).objects.length;
  const invalid = await h.upload(admin, 'invalid', Buffer.from('<script>alert(1)</script>'));
  assert.ok([400,415,422].includes(invalid.status), invalid.text);
  assert.equal((await h.bucket.list()).objects.length, objectCount);
});

test('workerd: retention erases old analytics while keeping blocked and expired access denied', async (t) => {
  const h = await harness(t), deck = await h.seedDeck(), admin = await h.admin();
  const blocked = await h.login('blocked@example.com'), expired = await h.login('expired@example.com'), ordinary = await h.login('ordinary@example.com');
  for (const reader of [blocked,expired,ordinary]) assert.equal((await reader.agent.post('/api/visits', { deckId: deck.id })).status, 201);
  assert.equal((await admin.patch(`/api/admin/visitors/${blocked.visitor.id}`, { blocked: true })).status, 200);
  const expiry = new Date(h.now() + DAY).toISOString();
  assert.equal((await admin.patch(`/api/admin/visitors/${expired.visitor.id}`, { accessExpiresAt: expiry })).status, 200);
  h.advance(366 * DAY);
  assert.equal((await h.client().get('/__test/prune')).status, 200);
  const freshAdmin = await h.admin();
  assert.equal((await freshAdmin.get('/api/admin/overview')).body.stats.visits, 0);
  assert.equal((await freshAdmin.get(`/api/admin/visitors/${ordinary.visitor.id}`)).status, 404);
  const before = h.sent.length;
  for (const reader of [blocked,expired]) {
    const detail = await freshAdmin.get(`/api/admin/visitors/${reader.visitor.id}`);
    assert.equal(detail.status, 200); assert.deepEqual(detail.body.visits, []);
    assert.equal((await h.client().post('/api/auth/request', { email: reader.visitor.email })).status, 200);
  }
  assert.equal(h.sent.length, before);
});

test('workerd: failed replacement email preserves the last delivered code without disclosing it', async (t) => {
  const h = await harness(t), mail = await h.issue();
  h.advance(61_000); h.setMailFailure(true);
  const failed = await h.client().post('/api/auth/request', { email: mail.to });
  assert.ok([502,503].includes(failed.status), failed.text);
  assert.ok(!failed.text.includes(mail.code));
  assert.equal(h.sent.length, 1);
  const verify = await h.client().post('/api/auth/verify', { email: mail.to, code: mail.code });
  assert.equal(verify.status, 200, verify.text);
});

test('workerd: the production Durable Object gateway shares D1 sessions with protected R2 delivery', async (t) => {
  // This imports the unmodified production entrypoint and uses a real
  // SQLite-backed Durable Object; there are no factory overrides here.
  const h = await harness(t, { gateway: true });
  assert.equal((await h.client().get('/healthz')).status, 200);
  const admin = await h.admin();
  assert.equal((await admin.get('/api/admin/me')).status, 200);
  const uploaded = await h.upload(admin, 'gateway-pdf');
  assert.equal(uploaded.status, 201, uploaded.text);
  const deck = uploaded.body.deck;
  assert.equal((await admin.post(`/api/admin/decks/${deck.id}/publish`)).status, 200);
  const preview = await admin.get(`/api/admin/decks/${deck.id}/preview`);
  assert.equal(preview.status, 200);
  const content = await admin.get(preview.body.deck.contentUrl);
  assert.equal(content.status, 200, content.text);
  assert.match(content.headers.get('content-type'), /application\/pdf/);
  assert.equal((await h.client().get(preview.body.deck.contentUrl)).status, 401);
  assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM sessions WHERE role='admin'").first()).n, 1);
});
