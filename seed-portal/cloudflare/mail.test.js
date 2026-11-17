import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createSmtpClient, mailReady } from './smtp-client.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const encode = value => new TextEncoder().encode(value);
const env = {
  SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_SECURE: 'true',
  SMTP_USER: 'sender@example.com', SMTP_PASS: 'offline-test-password',
  MAIL_FROM: 'Superfast Robotics <sender@example.com>',
  SEED_ORIGIN: 'https://seed.example.com', CODE_DAYS: '10', SESSION_DAYS: '90',
};
const access = { to: 'investor@example.com', code: 'ABCDEF012345', expiresAt: Date.UTC(2026, 10, 26) };

function server({ starttls = false, auth = 'PLAIN', rejectAuth = false, malformed = false, stall = false, failQuit = false } = {}) {
  const commands = [], connections = [];
  let authenticated = false, received = '';
  function socket(secure, greeting) {
    let controller, resolveClosed, closed = false, loginStep = 0;
    const response = value => { if (!closed) controller.enqueue(encode(value)); };
    const result = {
      readable: new ReadableStream({ start(c) { controller = c; } }),
      writable: new WritableStream({ write(chunk) {
        const text = new TextDecoder().decode(chunk);
        commands.push({ text, secure });
        if (stall) return;
        if (text.startsWith('EHLO ')) {
          if (malformed) return response('250-one\r\n251 changed-code\r\n');
          // Fragment a multiline reply, including its CRLF, across chunks.
          response('250-smtp.example.com\r');
          response(`\n250-${secure ? `AUTH ${auth}` : 'STARTTLS'}\r\n250 SIZE 100000\r\n`);
        } else if (text === 'STARTTLS\r\n') response('220 Ready for TLS\r\n');
        else if (text.startsWith('AUTH PLAIN ')) {
          assert.equal(secure, true, 'AUTH must never be sent before TLS');
          const payload = Buffer.from(text.slice(11).trim(), 'base64').toString('utf8');
          assert.equal(payload, `\0${env.SMTP_USER}\0${env.SMTP_PASS}`);
          authenticated = !rejectAuth;
          response(rejectAuth ? `535 do not leak ${env.SMTP_PASS}\r\n` : '235 Authentication successful\r\n');
        } else if (text === 'AUTH LOGIN\r\n') {
          assert.equal(secure, true, 'LOGIN must never be sent before TLS');
          loginStep = 1; response('334 VXNlcm5hbWU6\r\n');
        } else if (loginStep === 1) {
          assert.equal(Buffer.from(text.trim(), 'base64').toString(), env.SMTP_USER);
          loginStep = 2; response('334 UGFzc3dvcmQ6\r\n');
        } else if (loginStep === 2) {
          assert.equal(Buffer.from(text.trim(), 'base64').toString(), env.SMTP_PASS);
          authenticated = true; loginStep = 0; response('235 Authentication successful\r\n');
        } else if (text.startsWith('MAIL FROM:') || text.startsWith('RCPT TO:')) {
          assert.equal(authenticated, true); response('250 OK\r\n');
        } else if (text === 'DATA\r\n') response('354 End with dot\r\n');
        else if (text.endsWith('\r\n.\r\n')) { received = text; response('250 Message queued\r\n'); }
        else if (text === 'QUIT\r\n') {
          if (failQuit) throw new Error('Synthetic socket failure with secret ' + env.SMTP_PASS);
          response('221 Bye\r\n');
        } else throw new Error('Unexpected synthetic SMTP command');
      } }),
      opened: Promise.resolve({}),
      closed: new Promise(resolve => { resolveClosed = resolve; }),
      close() { if (!closed) { closed = true; controller.close(); resolveClosed(); } return Promise.resolve(); },
      startTls() { assert.equal(secure, false); result.close(); return socket(true, false); },
      get isClosed() { return closed; },
    };
    connections.push(result);
    if (greeting && !stall) response('220 smtp.example.com ESMTP\r\n');
    return result;
  }
  return {
    commands, connections,
    get message() { return received; },
    connect(address, options) {
      assert.deepEqual(address, { hostname: 'smtp.gmail.com', port: starttls ? 587 : 465 });
      assert.equal(options.secureTransport, starttls ? 'starttls' : 'on');
      return socket(!starttls, true);
    },
  };
}

test('Cloudflare SMTP sends an encoded access email over implicit TLS and closes the socket', async () => {
  const smtp = server();
  const result = await createSmtpClient(smtp.connect).sendAccessMail(env, access);
  assert.deepEqual(result, { accepted: true });
  assert.ok(smtp.connections.every(socket => socket.isClosed));
  const message = smtp.message;
  assert.match(message, /Content-Transfer-Encoding: base64\r\n/);
  assert.match(message, /To: <investor@example.com>\r\n/);
  const body = Buffer.from(message.split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, ''), 'base64').toString('utf8');
  assert.match(body, /ABCD-EF01-2345/);
  assert.match(body, /https:\/\/seed\.example\.com/);
  assert.match(body, /90 days/);
});

test('Cloudflare SMTP upgrades 587 to TLS before LOGIN and sends no message during verification', async () => {
  const smtp = server({ starttls: true, auth: 'LOGIN' });
  const result = await createSmtpClient(smtp.connect).verifySmtp({ ...env, SMTP_PORT: '587', SMTP_SECURE: 'false' });
  assert.equal(result.authenticated, true);
  assert.equal(result.tls, true);
  assert.deepEqual(smtp.commands.filter(item => !item.secure).map(item => item.text), ['EHLO example.com\r\n', 'STARTTLS\r\n']);
  assert.ok(smtp.commands.some(item => item.text === 'QUIT\r\n'));
  assert.ok(!smtp.commands.some(item => /^(MAIL|RCPT|DATA)/.test(item.text)));
  assert.ok(smtp.connections.every(socket => socket.isClosed));
});

test('Cloudflare SMTP rejects insecure configurations and incomplete credentials', () => {
  assert.equal(mailReady(env), true);
  for (const patch of [
    { SMTP_PORT: '25' }, { SMTP_SECURE: 'false' }, { SMTP_PORT: '587', SMTP_SECURE: 'true' },
    { SMTP_USER: '' }, { SMTP_PASS: '' }, { SMTP_PASS: '\r\n' },
    { SMTP_HOST: 'smtp.gmail.com\r\nAUTH PLAIN x' },
    { MAIL_FROM: 'sender@example.com\r\nBcc: hidden@example.com' },
  ]) assert.equal(mailReady({ ...env, ...patch }), false);
});

test('Cloudflare SMTP rejects envelope/header injection before connecting', async () => {
  let connects = 0;
  const client = createSmtpClient(() => { connects++; throw new Error('Should not connect'); });
  for (const message of [
    { ...access, to: 'investor@example.com\r\nRCPT TO:<hidden@example.com>' },
    { ...access, to: 'a@example.com,b@example.com' },
    { ...access, code: 'ABCD\r\nSubject:x' },
    { ...access, expiresAt: 'not a date' },
  ]) await assert.rejects(client.sendAccessMail(env, message), { code: 'SMTP_INVALID_MESSAGE' });
  await assert.rejects(client.sendAccessMail({ ...env, SEED_ORIGIN: 'https://seed.example.com/?x=secret' }, access), { code: 'SMTP_INVALID_MESSAGE' });
  assert.equal(connects, 0);
});

test('Cloudflare SMTP error messages never include provider text or credentials', async () => {
  const smtp = server({ rejectAuth: true });
  await assert.rejects(createSmtpClient(smtp.connect).verifySmtp(env), error => {
    assert.equal(error.code, 'SMTP_AUTH_FAILED');
    assert.equal(error.responseCode, 535);
    assert.ok(!String(error).includes(env.SMTP_PASS));
    assert.ok(!String(error).includes('do not leak'));
    return true;
  });
  assert.ok(smtp.connections.every(socket => socket.isClosed));
});

test('Cloudflare SMTP bounds malformed multiline responses and timeout cleanup', async () => {
  const malformed = server({ malformed: true });
  await assert.rejects(createSmtpClient(malformed.connect).verifySmtp(env), { code: 'SMTP_PROTOCOL' });
  assert.ok(malformed.connections.every(socket => socket.isClosed));
  const stalled = server({ stall: true });
  await assert.rejects(createSmtpClient(stalled.connect, { timeoutMs: 50, commandTimeoutMs: 10 }).verifySmtp(env), { code: 'SMTP_TIMEOUT' });
  assert.ok(stalled.connections.every(socket => socket.isClosed));
});

test('Cloudflare SMTP does not invalidate accepted mail if QUIT fails', async () => {
  const smtp = server({ failQuit: true });
  assert.deepEqual(await createSmtpClient(smtp.connect).sendAccessMail(env, access), { accepted: true });
  assert.ok(smtp.connections.every(socket => socket.isClosed));
});
