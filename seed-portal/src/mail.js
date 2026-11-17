import nodemailer from 'nodemailer';

export function mailReady(config) {
  const requiresAuth = config.smtpHost?.toLowerCase() === 'smtp.gmail.com' || Boolean(config.smtpUser || config.smtpPass);
  const smtpReady = config.smtpHost && (!requiresAuth || (config.smtpUser && config.smtpPass));
  return config.mailProvider === 'test' || Boolean(config.mailFrom && (
    (config.mailProvider === 'resend' && config.resendApiKey) ||
    (config.mailProvider === 'smtp' && smtpReady)
  ));
}
export function createSmtpTransport(config) {
  return nodemailer.createTransport({
    host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure,
    requireTLS: !config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true,
  });
}
export function makeMailer(config) {
  const smtp = config.mailProvider === 'smtp' ? createSmtpTransport(config) : null;
  return async ({ to, code, expiresAt }) => {
    if (!mailReady(config)) throw new Error('Email delivery is not configured');
    const display = code.match(/.{1,4}/g).join('-');
    const message = {
      from: config.mailFrom, to, subject: 'Your Superfast Robotics access code',
      text: `Your one-time access code is ${display}\n\nOpen ${config.seedOrigin} and enter this code.\nExpires: ${new Date(expiresAt).toISOString()} (${config.codeDays} days). It can be used once.\nAfter sign-in, this browser stays signed in for ${config.sessionDays} days.\n\nIf you did not request this code, you can ignore this email.\nSuperfast Robotics`,
    };
    if (smtp) return smtp.sendMail(message);
    if (config.mailProvider === 'resend') {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...message, to: [to] }), signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`Email provider rejected delivery (${response.status})`);
      return;
    }
    throw new Error('Email delivery is not configured');
  };
}
