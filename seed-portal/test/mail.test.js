import test from 'node:test';
import assert from 'node:assert/strict';
import { mailReady } from '../src/mail.js';

test('Google SMTP is not marked ready until account credentials and sender are configured', () => {
  const config = { mailProvider:'smtp', mailFrom:'sender@example.com', smtpHost:'smtp.gmail.com' };
  assert.equal(mailReady(config), false);
  assert.equal(mailReady({...config,smtpUser:'sender@example.com'}), false);
  assert.equal(mailReady({...config,smtpPass:'synthetic-app-password'}), false);
  assert.equal(mailReady({...config,smtpUser:'sender@example.com',smtpPass:'synthetic-app-password'}), true);
  assert.equal(mailReady({...config,mailFrom:'',smtpUser:'sender@example.com',smtpPass:'synthetic-app-password'}), false);
});
