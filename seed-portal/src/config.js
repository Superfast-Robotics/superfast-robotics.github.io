import path from 'node:path';

const days = (value, fallback, max) => {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error('Invalid lifetime configuration');
  return number;
};

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const config = {
    production,
    port: Number(env.PORT || 3000),
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    seedOrigin: env.SEED_ORIGIN || 'http://localhost:3000',
    adminOrigin: env.ADMIN_ORIGIN || 'http://localhost:3000',
    codeDays: days(env.CODE_DAYS, 10, 30),
    sessionDays: days(env.SESSION_DAYS, 90, 365),
    retentionDays: days(env.RETENTION_DAYS, 365, 3650),
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPasswordHash: env.ADMIN_PASSWORD_HASH || '',
    authSecret: env.AUTH_SECRET || '',
    secureCookies: production,
    trustProxy: env.TRUST_PROXY === '1' ? 1 : false,
    mailProvider: env.MAIL_PROVIDER || 'disabled',
    mailFrom: env.MAIL_FROM || '',
    resendApiKey: env.RESEND_API_KEY || '',
    smtpHost: (env.SMTP_HOST || '').trim().toLowerCase(),
    smtpPort: Number(env.SMTP_PORT || 587),
    smtpSecure: env.SMTP_SECURE === 'true',
    smtpUser: env.SMTP_USER || '',
    smtpPass: env.SMTP_PASS || '',
  };
  // Google's app password screen groups characters with spaces for readability.
  if (config.smtpHost === 'smtp.gmail.com') config.smtpPass = config.smtpPass.replace(/\s+/g, '');
  if (config.authSecret.length < 32) throw new Error('AUTH_SECRET must contain at least 32 characters');
  if (!/^[a-f0-9]{32,}:[a-f0-9]{128}$/i.test(config.adminPasswordHash)) throw new Error('ADMIN_PASSWORD_HASH must be a scrypt salt:key hash');
  for (const origin of [config.seedOrigin, config.adminOrigin]) {
    const url = new URL(origin);
    if (url.origin !== origin || (production && url.protocol !== 'https:')) throw new Error('Set exact HTTPS origins for production');
  }
  if (production && path.resolve(config.dataDir) === path.resolve('public')) throw new Error('DATA_DIR cannot be the public directory');
  return config;
}
