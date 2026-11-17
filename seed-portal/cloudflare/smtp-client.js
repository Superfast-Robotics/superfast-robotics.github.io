// Small, dependency-free SMTP submission client. Credentials are transmitted
// only after implicit TLS or a successful mandatory STARTTLS upgrade.
const encoder = new TextEncoder();
const MAX_REPLY_BYTES = 32768;
const MAX_LINE_BYTES = 4096;
const MAX_REPLY_LINES = 100;

export class SmtpError extends Error {
  constructor(code, message, responseCode) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    if (responseCode !== undefined) this.responseCode = responseCode;
  }
}

const configError = () => new SmtpError('SMTP_NOT_CONFIGURED', 'SMTP configuration is incomplete or invalid.');
const inputError = () => new SmtpError('SMTP_INVALID_MESSAGE', 'The access email contains invalid fields.');
const protocolError = () => new SmtpError('SMTP_PROTOCOL', 'The SMTP server returned an invalid response.');
const connectionError = () => new SmtpError('SMTP_CONNECTION_FAILED', 'The secure SMTP connection failed.');
const validMailbox = value => typeof value === 'string' && value.length <= 254 &&
  /^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value) && value.split('@')[0].length <= 64;

function sender(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n\0]/.test(value)) throw configError();
  const plain = value.trim();
  if (validMailbox(plain)) return { address: plain, name: '' };
  const match = /^([^<>]+)\s*<([^<>]+)>$/.exec(plain);
  if (!match || !validMailbox(match[2]) || match[1].trim().length > 120) throw configError();
  return { address: match[2], name: match[1].trim().replace(/^"(.*)"$/, '$1') };
}

function smtpConfig(env) {
  const host = typeof env.SMTP_HOST === 'string' ? env.SMTP_HOST.trim().toLowerCase() : '';
  const port = Number(env.SMTP_PORT || 465);
  const secure = env.SMTP_SECURE === undefined ? port === 465 : env.SMTP_SECURE === true || env.SMTP_SECURE === 'true';
  const username = typeof env.SMTP_USER === 'string' ? env.SMTP_USER.trim() : '';
  let password = env.SMTP_PASS;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || host.length > 253 ||
      !((port === 465 && secure) || (port === 587 && !secure)) || !validMailbox(username) ||
      typeof password !== 'string' || !password.length || password.length > 1024 || /[\r\n\0]/.test(password)) throw configError();
  // Google displays app passwords in groups separated by spaces.
  if (host === 'smtp.gmail.com') password = password.replace(/ /g, '');
  if (!password.length) throw configError();
  const from = sender(env.MAIL_FROM);
  return { host, port, secure, username, password, from, ehlo: from.address.split('@')[1].toLowerCase() };
}

export function mailReady(env) {
  try { smtpConfig(env); return true; } catch { return false; }
}

function base64(value) {
  const bytes = encoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodedName(name) {
  const parts = [];
  let part = '';
  for (const character of name) {
    if (encoder.encode(part + character).length > 42) { parts.push(part); part = ''; }
    part += character;
  }
  if (part) parts.push(part);
  return parts.map(value => `=?UTF-8?B?${base64(value)}?=`).join('\r\n ');
}

function accessMessage(env, config, { to, code, expiresAt } = {}) {
  if (!validMailbox(to) || !/^[A-F0-9]{12}$/i.test(code || '')) throw inputError();
  let origin;
  try {
    origin = new URL(env.SEED_ORIGIN);
    if (origin.protocol !== 'https:' || origin.origin !== env.SEED_ORIGIN) throw inputError();
  } catch { throw inputError(); }
  const expiry = new Date(expiresAt);
  const codeDays = Number(env.CODE_DAYS || 10), sessionDays = Number(env.SESSION_DAYS || 90);
  if (!Number.isFinite(expiry.getTime()) || !Number.isInteger(codeDays) || codeDays < 1 || codeDays > 30 ||
      !Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 365) throw inputError();
  const display = code.toUpperCase().match(/.{4}/g).join('-');
  const text = `Your one-time access code is ${display}\n\nOpen ${origin.origin} and enter this code.\nExpires: ${expiry.toISOString()} (${codeDays} days from issue). It can be used once.\nAfter sign-in, this browser stays signed in for ${sessionDays} days.\n\nIf you did not request this code, you can ignore this email.\nSuperfast Robotics\n`;
  const messageId = crypto.randomUUID();
  const headers = [
    `From: ${config.from.name ? encodedName(config.from.name) + ' ' : ''}<${config.from.address}>`,
    `To: <${to}>`,
    'Subject: Your Superfast Robotics access code',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}@${config.ehlo}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return { to, wire: headers.join('\r\n') + '\r\n\r\n' + base64(text).match(/.{1,76}/g).join('\r\n') + '\r\n' };
}

class SmtpConnection {
  constructor(connect, config, { timeoutMs, commandTimeoutMs }) {
    this.connect = connect;
    this.config = config;
    this.commandTimeoutMs = commandTimeoutMs;
    this.deadline = Date.now() + timeoutMs;
    this.buffer = '';
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.tls = false;
  }

  async bounded(promise, limit = this.commandTimeoutMs) {
    const remaining = Math.min(limit, this.deadline - Date.now());
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new SmtpError('SMTP_TIMEOUT', 'The SMTP server timed out.')), Math.max(0, remaining)); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  attach(socket) {
    this.socket = socket;
    // The rejected closed promise must always have a handler, including when
    // an earlier operation fails or a STARTTLS upgrade replaces this socket.
    Promise.resolve(socket.closed).catch(() => {});
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buffer = '';
    this.decoder = new TextDecoder('utf-8', { fatal: true });
  }

  async open() {
    const { host, port, secure } = this.config;
    const socket = this.connect({ hostname: host, port }, { secureTransport: secure ? 'on' : 'starttls', allowHalfOpen: false });
    this.attach(socket);
    await this.bounded(socket.opened);
    this.tls = secure;
    await this.expect([220]);
    let hello = await this.command(`EHLO ${this.config.ehlo}`, [250]);
    if (!secure) {
      if (!hello.lines.some(line => /^STARTTLS(?:\s|$)/i.test(line))) throw new SmtpError('SMTP_TLS_REQUIRED', 'The SMTP server did not offer required TLS.');
      await this.command('STARTTLS', [220]);
      if (this.buffer) throw protocolError();
      this.reader.releaseLock(); this.writer.releaseLock();
      this.reader = null; this.writer = null;
      this.attach(socket.startTls());
      await this.bounded(this.socket.opened);
      this.tls = true;
      hello = await this.command(`EHLO ${this.config.ehlo}`, [250]);
    }
    if (!this.tls) throw new SmtpError('SMTP_TLS_REQUIRED', 'SMTP authentication requires TLS.');
    const methods = hello.lines.flatMap(line => /^AUTH[ =](.*)$/i.exec(line)?.[1].toUpperCase().split(/\s+/) || []);
    if (methods.includes('PLAIN')) {
      const credentials = base64(`\0${this.config.username}\0${this.config.password}`);
      const response = await this.command(`AUTH PLAIN ${credentials}`, [235, 334], 'auth');
      if (response.code === 334) await this.command(credentials, [235], 'auth');
    } else if (methods.includes('LOGIN')) {
      await this.command('AUTH LOGIN', [334], 'auth');
      await this.command(base64(this.config.username), [334], 'auth');
      await this.command(base64(this.config.password), [235], 'auth');
    } else throw new SmtpError('SMTP_AUTH_UNSUPPORTED', 'The SMTP server did not offer a supported authentication method.');
  }

  async line() {
    while (true) {
      const end = this.buffer.indexOf('\r\n');
      if (end >= 0) {
        if (end > MAX_LINE_BYTES) throw protocolError();
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return line;
      }
      if (this.buffer.length > MAX_LINE_BYTES || this.buffer.includes('\n')) throw protocolError();
      const { value, done } = await this.bounded(this.reader.read());
      if (done) throw connectionError();
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_REPLY_BYTES) throw protocolError();
      try { this.buffer += this.decoder.decode(value, { stream: true }); } catch { throw protocolError(); }
      if (this.buffer.length > MAX_REPLY_BYTES) throw protocolError();
    }
  }

  async expect(codes, stage = 'command') {
    const lines = [];
    let code, bytes = 0;
    while (lines.length < MAX_REPLY_LINES) {
      const line = await this.line();
      bytes += encoder.encode(line).length + 2;
      if (bytes > MAX_REPLY_BYTES) throw protocolError();
      const match = /^([2-5]\d{2})([ -])(.*)$/.exec(line);
      if (!match || (code && code !== Number(match[1]))) throw protocolError();
      code = Number(match[1]); lines.push(match[3]);
      if (match[2] === ' ') {
        if (!codes.includes(code)) throw new SmtpError(stage === 'auth' ? 'SMTP_AUTH_FAILED' : 'SMTP_REJECTED', stage === 'auth' ? 'SMTP authentication failed.' : 'The SMTP server rejected the request.', code);
        return { code, lines };
      }
    }
    throw protocolError();
  }

  async command(command, codes, stage) {
    if (/[\r\n]/.test(command)) throw inputError();
    await this.bounded(this.writer.write(encoder.encode(command + '\r\n')));
    return this.expect(codes, stage);
  }

  async deliver(message) {
    await this.command(`MAIL FROM:<${this.config.from.address}>`, [250]);
    await this.command(`RCPT TO:<${message.to}>`, [250, 251]);
    await this.command('DATA', [354]);
    const data = message.wire.replace(/(^|\r\n)\./g, '$1..') + '.\r\n';
    await this.bounded(this.writer.write(encoder.encode(data)));
    await this.expect([250]);
  }

  async quit() {
    // Once DATA is accepted, a QUIT failure cannot undo delivery. Reporting a
    // delivery failure here would invalidate a code the recipient already got.
    try { await this.bounded(this.command('QUIT', [221]), 1500); } catch { /* best effort */ }
  }

  async close() {
    const socket = this.socket;
    if (!socket) return;
    try {
      const closing = Promise.resolve(socket.close()).catch(() => {});
      await this.bounded(closing, 500).catch(() => {});
    } catch { /* socket may already be closed or failed */ }
    try { this.reader?.releaseLock(); } catch { /* pending read closes with socket */ }
    try { this.writer?.releaseLock(); } catch { /* pending write closes with socket */ }
  }
}

// Dependency injection keeps protocol tests entirely offline, using the same
// implementation as Workers without a Node polyfill of cloudflare:sockets.
export function createSmtpClient(connect, { timeoutMs = 40000, commandTimeoutMs = 10000 } = {}) {
  async function run(env, message) {
    const config = smtpConfig(env);
    const prepared = message === undefined ? null : accessMessage(env, config, message);
    const connection = new SmtpConnection(connect, config, { timeoutMs, commandTimeoutMs });
    try {
      await connection.open();
      if (prepared) await connection.deliver(prepared);
      await connection.quit();
      return prepared ? { accepted: true } : { ok: true, host: config.host, port: config.port, tls: true, authenticated: true };
    } catch (error) {
      // Never propagate provider text, socket errors, AUTH payloads, or passwords.
      if (error instanceof SmtpError) throw error;
      throw connectionError();
    } finally { await connection.close(); }
  }
  return {
    sendAccessMail: (env, message) => run(env, message),
    verifySmtp: env => run(env),
  };
}
