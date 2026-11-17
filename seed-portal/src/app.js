import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase, prune } from './db.js';
import { DAY, randomToken, digest, codeValue, normalizeCode, equal, verifyPassword, normalizeEmail, readCookie, rateLimit } from './security.js';
import { mailReady, makeMailer } from './mail.js';
import { publicDeck, inspectPdf } from './decks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iso = value => value == null ? null : new Date(value).toISOString();
const fail = (res, status, error, code = 'REQUEST_FAILED') => res.status(status).json({ error, code });
const safeText = (value, max = 140) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;

export function createApp({ config, db = openDatabase(config.dataDir), sendMail = makeMailer(config), now = Date.now }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy || false);
  fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'decks'), { recursive: true });
  const upload = multer({ dest: path.join(config.dataDir, 'uploads'), limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 5, fieldSize: 1024 } });
  let lastPrune = 0;
  const audit = (action, target = null) => db.prepare('INSERT INTO audit(action,target,created_at) VALUES (?,?,?)').run(action, target, now());
  const ipKey = req => digest(config.authSecret, `ip:${req.ip}`);
  const limited = (key, max, ms) => rateLimit(db, key, max, ms, now());
  const cookies = maxAge => ({ httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path: '/', ...(maxAge ? { maxAge } : {}) });
  const sessionFor = (req, role) => {
    const token = readCookie(req, role === 'admin' ? 'admin_session' : 'seed_session');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND role = ? AND expires_at > ?').get(digest(config.authSecret, token), role, now());
  };
  function createSession(res, role, visitorId = null) {
    const token = randomToken();
    const lifetime = role === 'admin' ? 12 * 3600000 : config.sessionDays * DAY;
    const expiresAt = now() + lifetime;
    db.prepare('INSERT INTO sessions(token_hash,visitor_id,role,created_at,expires_at) VALUES (?,?,?,?,?)').run(digest(config.authSecret, token), visitorId, role, now(), expiresAt);
    res.cookie(role === 'admin' ? 'admin_session' : 'seed_session', token, cookies(lifetime));
    return expiresAt;
  }
  function permitted(visitor) {
    return visitor && !visitor.blocked && (!visitor.access_expires_at || visitor.access_expires_at > now());
  }
  function visitorAuth(req, res, next) {
    const session = sessionFor(req, 'visitor');
    if (!session) return fail(res, 401, 'Please sign in to view the deck.', 'SIGN_IN_REQUIRED');
    const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(session.visitor_id);
    if (!permitted(visitor)) return fail(res, 403, 'Your access is unavailable. Please contact Superfast Robotics.', 'ACCESS_DENIED');
    req.visitor = visitor; req.session = session; next();
  }
  function adminAuth(req, res, next) {
    const session = sessionFor(req, 'admin');
    if (!session) return fail(res, 401, 'Please sign in as an administrator.', 'ADMIN_REQUIRED');
    req.session = session; next();
  }
  function contentAuth(req, res, next) {
    const admin = sessionFor(req, 'admin');
    const onAdmin = !config.production || req.hostname === new URL(config.adminOrigin).hostname;
    if (admin && onAdmin) { req.isAdmin = true; return next(); }
    return visitorAuth(req, res, next);
  }

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Frame-Options': 'SAMEORIGIN',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/') || req.path.startsWith('/content/')) res.set('Cache-Control', 'private, no-store');
    if (now() - lastPrune > 3600000) { prune(db, now(), config.retentionDays); lastPrune = now(); }
    const origins = [config.seedOrigin, config.adminOrigin];
    if (config.production && !origins.some(origin => new URL(origin).hostname === req.hostname) && req.path !== '/healthz') return fail(res, 421, 'Use the configured website address.');
    if (config.production && req.path.startsWith('/api/admin/') && req.hostname !== new URL(config.adminOrigin).hostname) return fail(res, 404, 'Not found.');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (!origins.includes(origin) || new URL(origin).host !== req.get('host')) return fail(res, 403, 'Request origin was not accepted.', 'INVALID_ORIGIN');
      if (req.get('sec-fetch-site') === 'cross-site') return fail(res, 403, 'Cross-site requests are not accepted.');
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });
  const settings = () => ({ codeDays: config.codeDays, sessionDays: config.sessionDays, retentionDays: config.retentionDays, mailReady: mailReady(config) });
  app.get('/api/config', (req, res) => res.json({ ...settings(), seedUrl: config.seedOrigin, adminUrl: config.adminOrigin }));

  app.post('/api/auth/request', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) return fail(res, 400, 'Enter a valid email address.', 'INVALID_EMAIL');
    if (!mailReady(config)) return fail(res, 503, 'Email delivery is not configured yet. Please contact Superfast Robotics.', 'MAIL_UNAVAILABLE');
    const emailKey = digest(config.authSecret, `email:${email}`);
    if (!limited(`request-ip:${ipKey(req)}`, 20, 3600000) || !limited(`request-email:${emailKey}`, 5, 3600000) || !limited(`request-cooldown:${emailKey}`, 1, 60000)) {
      res.set('Retry-After', '60'); return fail(res, 429, 'Too many requests. Please wait before trying again.', 'RATE_LIMITED');
    }
    const message = { message: 'If this address can access the deck, an access code is on its way.', expiresInDays: config.codeDays };
    const existing = db.prepare('SELECT * FROM visitors WHERE email = ?').get(email);
    if (existing && !permitted(existing)) return res.json(message);
    const code = codeValue(), id = randomUUID(), expiresAt = now() + config.codeDays * DAY;
    db.prepare('INSERT INTO codes(id,email,code_hash,created_at,expires_at) VALUES (?,?,?,?,?)').run(id, email, digest(config.authSecret, `${email}:${code}`), now(), expiresAt);
    try { await sendMail({ to: email, code, expiresAt }); }
    catch {
      db.prepare('DELETE FROM codes WHERE id = ?').run(id);
      // Retain the previous delivered code if a replacement cannot be sent.
      return fail(res, 502, 'The access email could not be sent. Please try again shortly.', 'MAIL_FAILED');
    }
    db.transaction(() => {
      db.prepare('UPDATE codes SET used_at = ? WHERE email = ? AND id != ? AND used_at IS NULL').run(now(), email, id);
      db.prepare('UPDATE codes SET delivered = 1 WHERE id = ?').run(id);
    })();
    res.json(message);
  });

  app.post('/api/auth/verify', (req, res) => {
    const email = normalizeEmail(req.body?.email), code = normalizeCode(req.body?.code);
    if (!email || !/^[A-F0-9]{12}$/.test(code)) return fail(res, 400, 'Enter your email and the 12-character code.', 'INVALID_CODE');
    if (!limited(`verify:${ipKey(req)}`, 60, 3600000)) return fail(res, 429, 'Too many attempts. Please try again later.', 'RATE_LIMITED');
    const result = db.transaction(() => {
      const row = db.prepare('SELECT * FROM codes WHERE email = ? AND delivered = 1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1').get(email);
      if (!row || row.expires_at <= now() || row.attempts >= 5) return null;
      db.prepare('UPDATE codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      if (!equal(row.code_hash, digest(config.authSecret, `${email}:${code}`))) return null;
      let visitor = db.prepare('SELECT * FROM visitors WHERE email = ?').get(email);
      if (visitor && !permitted(visitor)) return null;
      db.prepare('UPDATE codes SET used_at = ? WHERE id = ?').run(now(), row.id);
      if (!visitor) {
        const id = randomUUID();
        db.prepare('INSERT INTO visitors(id,email,created_at,last_seen_at) VALUES (?,?,?,?)').run(id, email, now(), now());
        visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(id);
      } else db.prepare('UPDATE visitors SET last_seen_at = ? WHERE id = ?').run(now(), visitor.id);
      return visitor;
    })();
    if (!result) return fail(res, 400, 'This code is incorrect, expired, or already used. Request a new code.', 'INVALID_CODE');
    const expiresAt = createSession(res, 'visitor', result.id);
    res.json({ visitor: { id: result.id, email: result.email }, expiresAt: iso(expiresAt) });
  });
  app.get('/api/auth/me', visitorAuth, (req, res) => res.json({ visitor: { id: req.visitor.id, email: req.visitor.email }, expiresAt: iso(req.session.expires_at) }));
  const logout = role => (req, res) => {
    const name = role === 'admin' ? 'admin_session' : 'seed_session';
    const token = readCookie(req, name);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ? AND role = ?').run(digest(config.authSecret, token), role);
    res.clearCookie(name, cookies()); res.json({ ok: true });
  };
  app.post('/api/auth/logout', logout('visitor'));
  app.get('/api/deck', visitorAuth, (req, res) => {
    const row = db.prepare("SELECT * FROM decks WHERE status = 'published'").get();
    res.json({ deck: row ? publicDeck(row, req.visitor.download_allowed) : null });
  });

  app.post('/api/visits', visitorAuth, (req, res) => {
    const deck = db.prepare("SELECT * FROM decks WHERE id = ? AND status = 'published'").get(String(req.body?.deckId || ''));
    if (!deck) return fail(res, 404, 'This deck is no longer published. Reload to open the current version.');
    if (!limited(`visits:${req.visitor.id}`, 120, 3600000)) return fail(res, 429, 'Please wait before reopening the deck.');
    const id = randomUUID();
    db.prepare('INSERT INTO visits(id,visitor_id,deck_id,started_at,last_at,last_event_at) VALUES (?,?,?,?,?,?)').run(id, req.visitor.id, deck.id, now(), now(), now());
    db.prepare('UPDATE visitors SET last_seen_at = ? WHERE id = ?').run(now(), req.visitor.id);
    res.status(201).json({ visitId: id });
  });
  app.post('/api/events', visitorAuth, (req, res) => {
    const { visitId, page, seconds, sequence } = req.body || {};
    if (typeof visitId !== 'string' || !Number.isInteger(page) || !Number.isFinite(seconds) || seconds < 0 || seconds > 30 || !Number.isSafeInteger(sequence) || sequence < 0) return fail(res, 400, 'Invalid viewing event.');
    const visit = db.prepare('SELECT v.*,d.page_count FROM visits v JOIN decks d ON d.id = v.deck_id WHERE v.id = ? AND v.visitor_id = ?').get(visitId, req.visitor.id);
    if (!visit) return fail(res, 404, 'Viewing session was not found.');
    if (page < 1 || page > visit.page_count) return fail(res, 400, 'Invalid page.');
    if (sequence <= visit.last_sequence) return res.json({ ok: true });
    if (!limited(`events:${req.visitor.id}`, 1800, 3600000)) return fail(res, 429, 'Too many viewing events.');
    const counted = Math.max(0, Math.min(seconds, (now() - visit.last_event_at) / 1000, 30));
    db.transaction(() => {
      db.prepare('UPDATE visits SET last_at = ?,last_page = ?,seconds = seconds + ?,last_sequence = ?,last_event_at = ? WHERE id = ?').run(now(), page, counted, sequence, now(), visitId);
      db.prepare('INSERT INTO page_views(visit_id,page,seconds) VALUES (?,?,?) ON CONFLICT(visit_id,page) DO UPDATE SET seconds = seconds + excluded.seconds').run(visitId, page, counted);
      db.prepare('UPDATE visitors SET last_seen_at = ? WHERE id = ?').run(now(), req.visitor.id);
    })();
    res.json({ ok: true });
  });

  app.use('/content/:deckId', contentAuth, (req, res) => {
    const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(req.params.deckId);
    if (!deck || (!req.isAdmin && deck.status !== 'published')) return fail(res, 404, 'This version is not available.');
    let file;
    try { file = decodeURIComponent(req.path).replace(/^\//, '') || 'index.html'; } catch { return fail(res, 400, 'Invalid file.'); }
    const manifest = JSON.parse(deck.files_json);
    if (!manifest.includes(file) || file === 'download.pdf' || file.includes('..') || file.includes('\\')) return fail(res, 404, 'File not found.');
    res.set('Cache-Control', 'private, no-store');
    if (file.endsWith('.html')) res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'none'");
    res.sendFile(path.join(config.dataDir, 'decks', deck.id, file), { dotfiles: 'deny', cacheControl: false });
  });
  app.get('/api/deck/:id/download', visitorAuth, (req, res) => {
    const deck = db.prepare("SELECT * FROM decks WHERE id = ? AND status = 'published'").get(req.params.id);
    if (!deck || !deck.pdf_file) return fail(res, 404, 'Download not available.');
    if (!deck.download_allowed || !req.visitor.download_allowed) return fail(res, 403, 'Downloads are not enabled for your account.');
    res.download(path.join(config.dataDir, 'decks', deck.id, deck.pdf_file), `Superfast-Robotics-${deck.version.replace(/[^\w.-]/g, '_')}.pdf`, { cacheControl: false });
  });

  app.post('/api/admin/login', (req, res) => {
    if (!limited(`admin:${ipKey(req)}`, 10, 15 * 60000)) return fail(res, 429, 'Too many sign-in attempts. Try again in 15 minutes.');
    const validPassword = verifyPassword(req.body?.password, config.adminPasswordHash);
    if (!validPassword || !equal(String(req.body?.username || ''), config.adminUsername)) return fail(res, 401, 'Incorrect administrator credentials.');
    const expiresAt = createSession(res, 'admin'); audit('admin.login');
    res.json({ username: config.adminUsername, expiresAt: iso(expiresAt) });
  });
  app.post('/api/admin/logout', logout('admin'));
  app.use('/api/admin', adminAuth);
  app.get('/api/admin/me', (req, res) => res.json({ username: config.adminUsername, expiresAt: iso(req.session.expires_at) }));
  app.get('/api/admin/settings', (req, res) => res.json({ ...settings(), mailProvider: config.mailProvider, adminUsername: config.adminUsername }));

  const visitorSelect = `SELECT u.*,
    (SELECT COUNT(*) FROM visits WHERE visitor_id=u.id) AS visit_count,
    (SELECT COALESCE(SUM(seconds),0) FROM visits WHERE visitor_id=u.id) AS active_seconds,
    (SELECT last_page FROM visits WHERE visitor_id=u.id ORDER BY last_at DESC LIMIT 1) AS last_page
    FROM visitors u`;
  const visitorJson = row => ({ id: row.id, email: row.email, createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at), visitCount: row.visit_count, activeSeconds: row.active_seconds, lastPage: row.last_page, blocked: Boolean(row.blocked), accessExpiresAt: iso(row.access_expires_at), downloadAllowed: Boolean(row.download_allowed) });
  const visitJson = row => ({ id: row.id, email: row.email, deckTitle: row.title, version: row.version, startedAt: iso(row.started_at), lastAt: iso(row.last_at), lastPage: row.last_page, seconds: row.seconds });

  app.get('/api/admin/overview', (req, res) => {
    const count = sql => db.prepare(sql).get().n;
    const current = db.prepare("SELECT * FROM decks WHERE status = 'published'").get();
    const visits = count('SELECT COUNT(*) n FROM visits');
    const completed = count('SELECT COUNT(*) n FROM visits v JOIN decks d ON d.id=v.deck_id WHERE (SELECT COUNT(*) FROM page_views p WHERE p.visit_id=v.id) >= d.page_count');
    let dateFormat;
    try { dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: String(req.query.timezone || 'UTC'), year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { return fail(res, 400, 'Choose a valid dashboard timezone.'); }
    const dayKey = timestamp => {
      const parts = Object.fromEntries(dateFormat.formatToParts(timestamp).map(x => [x.type,x.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const today = Date.parse(dayKey(now()) + 'T00:00:00Z');
    const daily = new Map();
    for (const row of db.prepare('SELECT started_at FROM visits WHERE started_at>=?').all(now()-15*DAY)) {
      const day = dayKey(row.started_at); daily.set(day,(daily.get(day)||0)+1);
    }
    const activity = Array.from({ length:14 }, (_, i) => { const date = new Date(today+(i-13)*DAY).toISOString().slice(0,10); return { date, visits: daily.get(date) || 0 }; });
    const totals = current ? db.prepare('SELECT p.page,COUNT(*) views,SUM(p.seconds) seconds FROM page_views p JOIN visits v ON v.id=p.visit_id WHERE v.deck_id=? GROUP BY p.page').all(current.id) : [];
    const pages = current ? Array.from({length:current.page_count},(_,i)=>({page:i+1,views:0,seconds:0,...totals.find(x=>x.page===i+1)})) : [];
    res.json({ stats: {
      visitors: count('SELECT COUNT(*) n FROM visitors'), visits,
      activeSeconds: count('SELECT COALESCE(SUM(seconds),0) n FROM visits'),
      returningVisitors: count('SELECT COUNT(*) n FROM (SELECT visitor_id FROM visits GROUP BY visitor_id HAVING COUNT(*)>1)'),
      completionRate: visits ? Math.round(completed/visits*100) : 0,
    }, activity, pages, recent: db.prepare('SELECT v.*,d.title,d.version,u.email FROM visits v JOIN decks d ON d.id=v.deck_id JOIN visitors u ON u.id=v.visitor_id ORDER BY v.last_at DESC LIMIT 12').all().map(visitJson), settings: settings(), currentDeck: current ? publicDeck(current) : null });
  });
  app.get('/api/admin/visitors', (req, res) => {
    const q = String(req.query.q || '').slice(0,254);
    const status = ['active','blocked'].includes(req.query.status) ? req.query.status : 'all';
    const page = Math.max(1, Math.min(100000, parseInt(req.query.page,10) || 1));
    const where = " WHERE instr(u.email,?)>0" + (status === 'blocked' ? ' AND u.blocked=1' : status === 'active' ? ' AND u.blocked=0 AND (u.access_expires_at IS NULL OR u.access_expires_at>?)' : '');
    const args = status === 'active' ? [q.toLowerCase(), now()] : [q.toLowerCase()];
    const visitors = db.prepare(visitorSelect+where+' ORDER BY COALESCE(u.last_seen_at,u.created_at) DESC LIMIT 50 OFFSET ?').all(...args,(page-1)*50).map(visitorJson);
    const total = db.prepare('SELECT COUNT(*) n FROM visitors u'+where).get(...args).n;
    res.json({visitors,total,page,pageSize:50});
  });
  app.get('/api/admin/visitors/:id', (req, res) => {
    const row = db.prepare(visitorSelect+' WHERE u.id=?').get(req.params.id);
    if (!row) return fail(res,404,'Visitor not found.');
    const visits = db.prepare('SELECT v.*,d.title,d.version FROM visits v JOIN decks d ON d.id=v.deck_id WHERE v.visitor_id=? ORDER BY v.started_at DESC LIMIT 200').all(row.id).map(v=>({...visitJson(v),pages:db.prepare('SELECT page,seconds FROM page_views WHERE visit_id=? ORDER BY page').all(v.id)}));
    res.json({visitor:visitorJson(row),visits});
  });
  app.patch('/api/admin/visitors/:id', (req, res) => {
    const visitor = db.prepare('SELECT * FROM visitors WHERE id=?').get(req.params.id);
    if (!visitor) return fail(res,404,'Visitor not found.');
    const {blocked,accessExpiresAt,downloadAllowed} = req.body || {};
    if ((blocked !== undefined && typeof blocked !== 'boolean') || (downloadAllowed !== undefined && typeof downloadAllowed !== 'boolean')) return fail(res,400,'Use true or false for access options.');
    let expiry = visitor.access_expires_at;
    if (accessExpiresAt !== undefined) {
      expiry = accessExpiresAt === null ? null : Date.parse(accessExpiresAt);
      if (expiry !== null && (!Number.isFinite(expiry) || typeof accessExpiresAt !== 'string')) return fail(res,400,'Enter a valid expiration date.');
    }
    db.transaction(()=>{
      db.prepare('UPDATE visitors SET blocked=?,access_expires_at=?,download_allowed=? WHERE id=?').run(blocked === undefined ? visitor.blocked : Number(blocked),expiry,downloadAllowed === undefined ? visitor.download_allowed : Number(downloadAllowed),visitor.id);
      if (blocked || (expiry !== null && expiry <= now())) {
        db.prepare('DELETE FROM sessions WHERE visitor_id=?').run(visitor.id);
        db.prepare('UPDATE codes SET used_at=? WHERE email=? AND used_at IS NULL').run(now(),visitor.email);
      }
      audit('visitor.update',visitor.id);
    })();
    res.json({ok:true});
  });
  app.post('/api/admin/visitors/:id/revoke', (req,res)=>{
    const visitor=db.prepare('SELECT * FROM visitors WHERE id=?').get(req.params.id);
    if(!visitor)return fail(res,404,'Visitor not found.');
    db.transaction(()=>{
      db.prepare('DELETE FROM sessions WHERE visitor_id=?').run(visitor.id);
      db.prepare('UPDATE codes SET used_at=? WHERE email=? AND used_at IS NULL').run(now(),visitor.email);
      audit('visitor.revoke',visitor.id);
    })();res.json({ok:true});
  });
  app.get('/api/admin/export', (req,res)=>{
    const escape = value => '"'+String(value??'').replace(/^[=+@\-\t\r]/,"'$&").replace(/"/g,'""')+'"';
    const rows=db.prepare(visitorSelect+' ORDER BY u.created_at DESC').all().map(visitorJson);
    const keys=['email','createdAt','lastSeenAt','visitCount','activeSeconds','lastPage','blocked','accessExpiresAt','downloadAllowed'];
    res.type('text/csv').attachment('superfast-visitors.csv').send('\uFEFF'+[keys.join(','),...rows.map(row=>keys.map(k=>escape(row[k])).join(','))].join('\r\n'));
  });
  app.get('/api/admin/decks', (req,res)=>res.json({decks:db.prepare('SELECT * FROM decks ORDER BY created_at DESC').all().map(row=>({...publicDeck(row,true),downloadAllowed:Boolean(row.download_allowed)}))}));
  app.post('/api/admin/decks', upload.single('file'), async (req,res)=>{
    const file=req.file;
    try {
      if(!file) return fail(res,400,'Choose a PDF file.');
      const title=safeText(req.body.title),version=safeText(req.body.version,64);
      if(!title||!version)return fail(res,400,'Title and version are required (140 and 64 characters maximum).');
      if(db.prepare('SELECT id FROM decks WHERE version=?').get(version))return fail(res,409,'This version label already exists.');
      const header=Buffer.alloc(5),fd=fs.openSync(file.path,'r');
      try {fs.readSync(fd,header,0,5,0);}finally{fs.closeSync(fd);}
      if(header.toString()!=='%PDF-')return fail(res,400,'The uploaded file must be a PDF.');
      let pageCount;
      try{pageCount=await inspectPdf(file.path);}catch{return fail(res,400,'This PDF could not be opened. Upload an unencrypted PDF with 1–500 pages.');}
      const id=randomUUID(),directory=path.join(config.dataDir,'decks',id);
      fs.mkdirSync(directory,{recursive:true});
      fs.renameSync(file.path,path.join(directory,'document.pdf'));
      try {
        db.prepare(`INSERT INTO decks(id,title,version,kind,page_count,created_at,download_allowed,files_json,pdf_file) VALUES (?,?,?,'pdf',?,?,?,?, 'document.pdf')`).run(id,title,version,pageCount,now(),Number(req.body.downloadAllowed==='true'),JSON.stringify(['document.pdf']));
      } catch (error) { fs.rmSync(directory,{recursive:true,force:true}); throw error; }
      audit('deck.upload',id);
      res.status(201).json({deck:publicDeck(db.prepare('SELECT * FROM decks WHERE id=?').get(id),true)});
    } finally {if(file && fs.existsSync(file.path))fs.unlinkSync(file.path);}
  });
  app.post('/api/admin/decks/:id/publish', (req,res)=>{
    const deck=db.prepare('SELECT * FROM decks WHERE id=?').get(req.params.id);
    if(!deck)return fail(res,404,'Deck not found.');
    db.transaction(()=>{
      db.prepare("UPDATE decks SET status='archived' WHERE status='published'").run();
      db.prepare("UPDATE decks SET status='published',published_at=? WHERE id=?").run(now(),deck.id);
      audit('deck.publish',deck.id);
    })();res.json({ok:true});
  });
  app.patch('/api/admin/decks/:id', (req,res)=>{
    const deck=db.prepare('SELECT * FROM decks WHERE id=?').get(req.params.id);
    if(!deck)return fail(res,404,'Deck not found.');
    const title=req.body?.title===undefined?deck.title:safeText(req.body.title);
    if(!title || (req.body.downloadAllowed!==undefined && typeof req.body.downloadAllowed!=='boolean'))return fail(res,400,'Invalid deck settings.');
    db.prepare('UPDATE decks SET title=?,download_allowed=? WHERE id=?').run(title,req.body.downloadAllowed===undefined?deck.download_allowed:Number(req.body.downloadAllowed),deck.id);
    audit('deck.update',deck.id);res.json({ok:true});
  });
  app.get('/api/admin/decks/:id/preview',(req,res)=>{
    const row=db.prepare('SELECT * FROM decks WHERE id=?').get(req.params.id);
    if(!row)return fail(res,404,'Deck not found.');res.json({deck:publicDeck(row,true)});
  });
  app.use('/api', (req,res)=>fail(res,404,'API endpoint not found.'));
  const vendorRoot=path.join(root,'node_modules','pdfjs-dist');
  app.get('/vendor/pdf.mjs',(req,res)=>res.sendFile(path.join(vendorRoot,'build','pdf.mjs')));
  app.get('/vendor/pdf.worker.mjs',(req,res)=>res.sendFile(path.join(vendorRoot,'build','pdf.worker.mjs')));
  for(const folder of ['cmaps','standard_fonts','wasm'])app.use(`/vendor/${folder}`,express.static(path.join(vendorRoot,folder),{dotfiles:'deny'}));
  app.get('/',(req,res)=>{
    if(new URL(config.adminOrigin).hostname!==new URL(config.seedOrigin).hostname && req.hostname===new URL(config.adminOrigin).hostname)return res.redirect('/admin');
    res.sendFile(path.join(root,'public','index.html'));
  });
  app.get(['/admin','/admin/'],(req,res)=>res.sendFile(path.join(root,'public','admin.html')));
  app.use(express.static(path.join(root,'public'),{dotfiles:'deny',index:false}));
  app.use((req,res)=>fail(res,404,'Page not found.'));
  app.use((error,req,res,next)=>{
    if(res.headersSent)return next(error);
    if(error instanceof multer.MulterError)return fail(res,400,error.code==='LIMIT_FILE_SIZE'?'The PDF must be smaller than 100 MB.':'The upload could not be accepted.');
    if(error.type==='entity.parse.failed')return fail(res,400,'Invalid JSON.');
    if(error.type==='entity.too.large')return fail(res,413,'Request is too large.');
    // Log only classification, never request bodies, cookies, codes, or mail-provider errors.
    console.error('Portal request failed:',error.code || error.name || 'Error');
    fail(res,500,'Something went wrong. Please try again.');
  });
  return { app,db,close:()=>db.close() };
}
