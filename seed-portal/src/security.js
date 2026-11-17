import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const DAY = 86400000;
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');
export const codeValue = () => randomBytes(6).toString('hex').toUpperCase();
export const normalizeCode = value => String(value || '').toUpperCase().replace(/[\s-]/g, '');
export const equal = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function verifyPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const [salt, key] = hash.split(':');
  return equal(scryptSync(password, salt, 64).toString('hex'), key);
}
export function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (value.length > 254 || !/^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) || value.split('@')[0].length > 64) return null;
  return value;
}
export function readCookie(req, name) {
  return (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1) || '';
}
export function rateLimit(db, key, max, windowMs, now) {
  return db.transaction(() => {
    let row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
    if (!row || row.resets_at <= now) {
      db.prepare('INSERT OR REPLACE INTO rate_limits(key,count,resets_at) VALUES (?,1,?)').run(key, now + windowMs);
      return true;
    }
    if (row.count >= max) return false;
    db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
    return true;
  })();
}
