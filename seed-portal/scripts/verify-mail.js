import { loadConfig } from '../src/config.js';
import { createSmtpTransport, mailReady } from '../src/mail.js';

// Verify connectivity, TLS, and credentials without sending an email.
let transport;
try {
  const config = loadConfig();
  if (config.mailProvider !== 'smtp' || !mailReady(config)) {
    throw Object.assign(new Error('Set MAIL_FROM, SMTP_HOST, SMTP_USER, and SMTP_PASS in .env first.'), { code: 'INCOMPLETE_CONFIG' });
  }
  transport = createSmtpTransport(config);
  await transport.verify();
  console.log('SMTP connection and authentication verified. No email was sent.');
  console.log('Sender acceptance and inbox delivery still require a real access-code request.');
} catch (error) {
  const messages = {
    INCOMPLETE_CONFIG: 'SMTP setup incomplete. Set MAIL_FROM, SMTP_HOST, SMTP_USER, and SMTP_PASS in .env.',
    EAUTH: 'SMTP authentication failed. Check the full account email, app password, and Workspace policy.',
    ETIMEDOUT: 'SMTP connection timed out. Check the server, port, and outbound network access.',
    ESOCKET: 'SMTP connection or TLS verification failed. Check the server, port, and network access.',
    EDNS: 'SMTP hostname could not be resolved. Check SMTP_HOST.',
  };
  // Never print provider responses, credentials, or the complete error object.
  console.error(messages[error.code] || 'SMTP verification failed. Check the local configuration and mail provider settings.');
  process.exitCode = 1;
} finally { transport?.close(); }
