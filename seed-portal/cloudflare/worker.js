import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import {
  DAY, randomToken, digest, codeValue, normalizeCode, equal,
  verifyPassword as defaultVerifyPassword, normalizeEmail,
} from '../src/security.js';
import { mailReady as defaultMailReady, sendAccessMail, verifySmtp } from './mail.js';

const MAX_UPLOAD_MB = 25;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const JSON_LIMIT = 16 * 1024;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
const DECK_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";
const iso = value => value == null ? null : new Date(value).toISOString();
const safeText = (value, max = 140) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;
const permitted = (visitor, now) => visitor && !visitor.blocked && (!visitor.access_expires_at || visitor.access_expires_at > now);
const cookieName = role => role === 'admin' ? 'admin_session' : 'seed_session';
const readCookie = (request, name) => (request.headers.get('cookie') || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';

class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED', headers = {}) { super(message); this.status = status; this.code = code; this.headers = headers; }
}
const bad = (status, message, code, headers) => { throw new HttpError(status, message, code, headers); };
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const prepare = (db, sql, args = []) => db.prepare(sql).bind(...args);
const first = (db, sql, args = []) => prepare(db, sql, args).first();
const run = (db, sql, args = []) => prepare(db, sql, args).run();
const all = async (db, sql, args = []) => (await prepare(db, sql, args).all()).results || [];

function loadConfig(env) {
  const development=env.ENVIRONMENT==='development';
  const days = (value, fallback, max) => {
    const parsed = Number(value ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error('Invalid lifetime configuration');
    return parsed;
  };
  const seedOrigin = env.SEED_ORIGIN || 'https://seed.superfastrobotics.com';
  const adminOrigin = env.ADMIN_ORIGIN || 'https://superadmin.superfastrobotics.com';
  for (const origin of [seedOrigin, adminOrigin]) {
    const url = new URL(origin);
    if (url.origin !== origin || (!development && url.protocol !== 'https:') || (development && !['http:','https:'].includes(url.protocol))) throw new Error('Invalid configured origin');
  }
  if (typeof env.AUTH_SECRET !== 'string' || env.AUTH_SECRET.length < 32) throw new Error('Missing authentication secret');
  if (!/^[a-f0-9]{32,}:[a-f0-9]{128}$/i.test(env.ADMIN_PASSWORD_HASH || '')) throw new Error('Invalid administrator hash');
  return {
    seedOrigin, adminOrigin, authSecret: env.AUTH_SECRET,
    adminUsername: env.ADMIN_USERNAME || 'admin', adminPasswordHash: env.ADMIN_PASSWORD_HASH,
    codeDays: days(env.CODE_DAYS, 10, 30), sessionDays: days(env.SESSION_DAYS, 90, 365),
    retentionDays: days(env.RETENTION_DAYS, 365, 3650),
    secureCookies: !development,
    mailProvider: env.MAIL_PROVIDER || 'disabled',
  };
}

function sessionCookie(role, token, milliseconds, secure) {
  return `${cookieName(role)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(milliseconds / 1000))}${secure ? '; Secure' : ''}`;
}

function publicDeck(row, downloadAllowed = false) {
  return {
    id: row.id, title: row.title, version: row.version, kind: row.kind, pageCount: row.page_count,
    status: row.status, createdAt: iso(row.created_at), publishedAt: iso(row.published_at),
    downloadAllowed: Boolean(downloadAllowed && row.download_allowed && row.pdf_file),
    contentUrl: `/content/${row.id}/${row.kind === 'html' ? 'index.html' : 'document.pdf'}`,
    downloadUrl: `/api/deck/${row.id}/download`,
  };
}

const visitorSelect = `SELECT u.*,
  (SELECT COUNT(*) FROM visits WHERE visitor_id=u.id) AS visit_count,
  (SELECT COALESCE(SUM(seconds),0) FROM visits WHERE visitor_id=u.id) AS active_seconds,
  (SELECT last_page FROM visits WHERE visitor_id=u.id ORDER BY last_at DESC LIMIT 1) AS last_page
  FROM visitors u`;
const visitorJson = row => ({
  id: row.id, email: row.email, createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at),
  visitCount: row.visit_count, activeSeconds: row.active_seconds, lastPage: row.last_page,
  blocked: Boolean(row.blocked), accessExpiresAt: iso(row.access_expires_at), downloadAllowed: Boolean(row.download_allowed),
});
const visitJson = row => ({ id: row.id, email: row.email, deckTitle: row.title, version: row.version, startedAt: iso(row.started_at), lastAt: iso(row.last_at), lastPage: row.last_page, seconds: row.seconds });

/** Count the stream before parsing so chunked requests cannot bypass body limits. */
function boundedBody(request, limit) {
  const stated = request.headers.get('content-length');
  if (stated && Number(stated) > limit) bad(413, limit === JSON_LIMIT ? 'Request is too large.' : `The PDF must be smaller than ${MAX_UPLOAD_MB} MB.`, 'BODY_TOO_LARGE');
  if (!request.body) return new ReadableStream({ start(controller) { controller.close(); } });
  const reader = request.body.getReader(); let bytes = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { controller.close(); return; }
        bytes += result.value.byteLength;
        if (bytes > limit) { await reader.cancel(); controller.error(new HttpError(413, 'Request is too large.', 'BODY_TOO_LARGE')); return; }
        controller.enqueue(result.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}
async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) bad(415, 'Send a JSON request.');
  try {
    const value = await new Response(boundedBody(request, JSON_LIMIT)).json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) bad(400, 'Send a JSON object.');
    return value;
  } catch (error) { if (error instanceof HttpError) throw error; bad(400, 'Invalid JSON.'); }
}
async function rateLimit(db, key, max, windowMs, now) {
  // A conditional UPSERT is atomic; simultaneous attempts cannot exceed max.
  const row = await first(db, `INSERT INTO rate_limits(key,count,resets_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN resets_at<=? THEN 1 ELSE count+1 END,
      resets_at=CASE WHEN resets_at<=? THEN ? ELSE resets_at END
    WHERE resets_at<=? OR count<? RETURNING count`, [key, now + windowMs, now, now, now + windowMs, now, max]);
  return Boolean(row);
}

async function getSession(request, db, config, role, now) {
  const token = readCookie(request, cookieName(role));
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return first(db, 'SELECT * FROM sessions WHERE token_hash=? AND role=? AND expires_at>?', [digest(config.authSecret, token), role, now]);
}
async function requireVisitor(request, db, config, now) {
  const session = await getSession(request, db, config, 'visitor', now);
  if (!session) bad(401, 'Please sign in to view the deck.', 'SIGN_IN_REQUIRED');
  const visitor = await first(db, 'SELECT * FROM visitors WHERE id=?', [session.visitor_id]);
  if (!permitted(visitor, now)) bad(403, 'Your access is unavailable. Please contact Superfast Robotics.', 'ACCESS_DENIED');
  return { session, visitor };
}
async function requireAdmin(request, db, config, now) {
  const session = await getSession(request, db, config, 'admin', now);
  if (!session) bad(401, 'Please sign in as an administrator.', 'ADMIN_REQUIRED');
  return session;
}
const auditStatement = (db, action, target, now) => prepare(db, 'INSERT INTO audit(action,target,created_at) VALUES (?,?,?)', [action, target, now]);

function mimeType(file) {
  const extension = file.split('.').pop().toLowerCase();
  return ({ html:'text/html; charset=utf-8', css:'text/css; charset=utf-8', js:'text/javascript; charset=utf-8', mjs:'text/javascript; charset=utf-8', json:'application/json', pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif', svg:'image/svg+xml', mp4:'video/mp4', webm:'video/webm', woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', otf:'font/otf', txt:'text/plain; charset=utf-8' })[extension] || 'application/octet-stream';
}

/** Auth runs before every R2 read, including HEAD, Range and conditional requests. */
async function serveObject(request, bucket, key, file, attachment) {
  const metadata = await bucket.head(key);
  if (!metadata) bad(404, 'File not found.');
  const headers = new Headers({ 'Content-Type': mimeType(file), 'Accept-Ranges':'bytes', 'Cache-Control':'private, no-store', 'ETag': metadata.httpEtag });
  if (attachment) headers.set('Content-Disposition', `attachment; filename="${attachment}"`);
  if (file.endsWith('.html')) headers.set('Content-Security-Policy', DECK_CSP);
  const rangeHeader = request.headers.get('range');
  let range;
  // A single byte range supports PDF.js and video seeking without public URLs.
  if (rangeHeader && (!request.headers.has('if-range') || request.headers.get('if-range') === metadata.httpEtag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status:416, headers:{ ...Object.fromEntries(headers), 'Content-Range':`bytes */${metadata.size}` } });
    let start, end;
    if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0,metadata.size-suffix); end = metadata.size-1; if (!suffix) start=metadata.size; }
    else { start=Number(match[1]); end=match[2] ? Math.min(Number(match[2]),metadata.size-1) : metadata.size-1; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || start>=metadata.size || end<start) return new Response(null, { status:416, headers:{ ...Object.fromEntries(headers), 'Content-Range':`bytes */${metadata.size}` } });
    range = { offset:start, length:end-start+1 };
    headers.set('Content-Range',`bytes ${start}-${end}/${metadata.size}`);
  }
  headers.set('Content-Length',String(range ? range.length : metadata.size));
  if (request.method === 'HEAD') return new Response(null,{ status:range ? 206 : 200,headers });
  const object = await bucket.get(key, range ? { range } : undefined);
  if (!object) bad(404,'File not found.');
  return new Response(object.body,{ status:range ? 206 : 200,headers });
}

async function prune(db, now, retentionDays) {
  const cutoff=now-retentionDays*DAY;
  await db.batch([
    prepare(db,'DELETE FROM codes WHERE expires_at<? OR used_at<?',[now,now-DAY]),
    prepare(db,'DELETE FROM sessions WHERE expires_at<?',[now]),
    prepare(db,'DELETE FROM rate_limits WHERE resets_at<?',[now]),
    prepare(db,'DELETE FROM visits WHERE last_at<?',[cutoff]),
    // Retention never removes an explicit access restriction.
    prepare(db,'DELETE FROM visitors WHERE blocked=0 AND access_expires_at IS NULL AND COALESCE(last_seen_at,created_at)<?',[cutoff]),
    prepare(db,'DELETE FROM audit WHERE created_at<?',[cutoff]),
  ]);
}

function hardenedResponse(response, request, config) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff');
  headers.set('Referrer-Policy','same-origin');
  headers.set('X-Robots-Tag','noindex, nofollow, noarchive');
  headers.set('X-Frame-Options','SAMEORIGIN');
  headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy',CSP);
  if (config?.secureCookies) headers.set('Strict-Transport-Security','max-age=31536000');
  const path=new URL(request.url).pathname;
  if (path.startsWith('/api/') || path.startsWith('/content/') || response.headers.has('Set-Cookie')) headers.set('Cache-Control','private, no-store');
  return new Response(request.method==='HEAD'?null:response.body,{status:response.status,statusText:response.statusText,headers});
}

/** Injectable boundaries are only for tests; production has no debug/auth bypass. */
export function createHandler({ sendMail=sendAccessMail, now=Date.now, verifyPassword=defaultVerifyPassword, mailReady=defaultMailReady }={}) {
  async function route(request,env,context,config) {
    const url=new URL(request.url), path=url.pathname, method=request.method;
    const timestamp=now();
    const origins=[config.seedOrigin,config.adminOrigin];
    if (config.secureCookies && url.protocol==='http:' && ['GET','HEAD'].includes(method)) {
      const configuredOrigin=origins.find(origin=>new URL(origin).hostname===url.hostname);
      if (configuredOrigin) {
        // Assign path/query separately so a path beginning with // cannot
        // replace the configured host and become an external redirect.
        const target=new URL(configuredOrigin);
        target.pathname=url.pathname;
        target.search=url.search;
        return Response.redirect(target.href,308);
      }
    }
    if (!origins.includes(url.origin) && path!=='/healthz') bad(421,'Use the configured website address.');
    const adminHost=url.origin===config.adminOrigin;
    if (path.startsWith('/api/admin/') && !adminHost) bad(404,'Not found.');
    if (!['GET','HEAD','OPTIONS'].includes(method)) {
      const origin=request.headers.get('origin');
      if (!origin || origin!==url.origin || !origins.includes(origin)) bad(403,'Request origin was not accepted.','INVALID_ORIGIN');
      if (request.headers.get('sec-fetch-site')==='cross-site') bad(403,'Cross-site requests are not accepted.');
    }
    // Sessions API keeps the initial auth lookup on the primary D1 database.
    const db=env.DB.withSession?env.DB.withSession('first-primary'):env.DB;
    const settings=()=>({codeDays:config.codeDays,sessionDays:config.sessionDays,retentionDays:config.retentionDays,mailReady:mailReady(env),maxUploadMB:MAX_UPLOAD_MB});
    const ip=digest(config.authSecret,`ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
    const limited=(key,max,ms)=>rateLimit(db,key,max,ms,timestamp);

    if (path==='/healthz' && ['GET','HEAD'].includes(method)) { await first(db,'SELECT 1 AS ok'); return json({ok:true}); }
    if (path==='/api/config' && method==='GET') return json({...settings(),seedUrl:config.seedOrigin,adminUrl:config.adminOrigin});

    if (path==='/api/auth/request' && method==='POST') {
      const body=await readJson(request), email=normalizeEmail(body.email);
      if (!email) bad(400,'Enter a valid email address.','INVALID_EMAIL');
      if (!mailReady(env)) bad(503,'Email delivery is not configured yet. Please contact Superfast Robotics.','MAIL_UNAVAILABLE');
      const emailKey=digest(config.authSecret,`email:${email}`);
      if (!await limited(`request-ip:${ip}`,20,3600000) || !await limited(`request-email:${emailKey}`,5,3600000) || !await limited(`request-cooldown:${emailKey}`,1,60000)) bad(429,'Too many requests. Please wait before trying again.','RATE_LIMITED',{'Retry-After':'60'});
      const message={message:'If this address can access the deck, an access code is on its way.',expiresInDays:config.codeDays};
      const existing=await first(db,'SELECT * FROM visitors WHERE email=?',[email]);
      if (existing && !permitted(existing,timestamp)) return json(message);
      const code=codeValue(), id=randomUUID(), expiresAt=timestamp+config.codeDays*DAY;
      await run(db,'INSERT INTO codes(id,email,code_hash,created_at,expires_at) VALUES (?,?,?,?,?)',[id,email,digest(config.authSecret,`${email}:${code}`),timestamp,expiresAt]);
      try { await sendMail(env,{to:email,code,expiresAt}); }
      catch { await run(db,'DELETE FROM codes WHERE id=?',[id]); bad(502,'The access email could not be sent. Please try again shortly.','MAIL_FAILED'); }
      await db.batch([
        // Do not resurrect a code revoked while SMTP was in flight. A late
        // delivery also cannot replace a newer successfully delivered code.
        prepare(db,`UPDATE codes SET delivered=1,used_at=CASE WHEN EXISTS(
          SELECT 1 FROM codes newer WHERE newer.email=codes.email AND newer.delivered=1 AND newer.created_at>codes.created_at
        ) THEN COALESCE(used_at,?) ELSE used_at END WHERE id=?`,[timestamp,id]),
        prepare(db,`UPDATE codes SET used_at=? WHERE email=? AND id<>? AND used_at IS NULL
          AND created_at<=? AND EXISTS(SELECT 1 FROM codes fresh WHERE fresh.id=? AND fresh.delivered=1 AND fresh.used_at IS NULL)`,[timestamp,email,id,timestamp,id]),
      ]);
      return json(message);
    }

    if (path==='/api/auth/verify' && method==='POST') {
      const body=await readJson(request),email=normalizeEmail(body.email),code=normalizeCode(body.code);
      if (!email || !/^[A-F0-9]{12}$/.test(code)) bad(400,'Enter your email and the 12-character code.','INVALID_CODE');
      if (!await limited(`verify:${ip}`,60,3600000)) bad(429,'Too many attempts. Please try again later.','RATE_LIMITED');
      const claim=randomToken(),token=randomToken(),tokenHash=digest(config.authSecret,token),expiresAt=timestamp+config.sessionDays*DAY;
      const candidateHash=digest(config.authSecret,`${email}:${code}`),visitorId=randomUUID();
      // All conditional writes share one transaction. Only this unique claim
      // can create its session; concurrent/replayed verification creates none.
      const result=await db.batch([
        prepare(db,`UPDATE codes SET attempts=attempts+1,
          used_at=CASE WHEN code_hash=? THEN ? ELSE used_at END,
          claim_token=CASE WHEN code_hash=? THEN ? ELSE claim_token END
          WHERE id=(SELECT id FROM codes WHERE email=? AND delivered=1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1)
          AND used_at IS NULL AND attempts<5 AND expires_at>?
          AND NOT EXISTS(SELECT 1 FROM visitors WHERE email=? AND (blocked=1 OR (access_expires_at IS NOT NULL AND access_expires_at<=?)))`,
          [candidateHash,timestamp,candidateHash,claim,email,timestamp,email,timestamp]),
        prepare(db,`INSERT OR IGNORE INTO visitors(id,email,created_at,last_seen_at)
          SELECT ?,email,?,? FROM codes WHERE claim_token=?`,[visitorId,timestamp,timestamp,claim]),
        prepare(db,`UPDATE visitors SET last_seen_at=MAX(COALESCE(last_seen_at,0),?)
          WHERE email=(SELECT email FROM codes WHERE claim_token=?)`,[timestamp,claim]),
        prepare(db,`INSERT INTO sessions(token_hash,visitor_id,role,created_at,expires_at)
          SELECT ?,u.id,'visitor',?,? FROM codes c JOIN visitors u ON u.email=c.email
          WHERE c.claim_token=? AND u.blocked=0 AND (u.access_expires_at IS NULL OR u.access_expires_at>?)`,[tokenHash,timestamp,expiresAt,claim,timestamp]),
        prepare(db,`SELECT u.id,u.email FROM sessions s JOIN visitors u ON u.id=s.visitor_id WHERE s.token_hash=?`,[tokenHash]),
      ]);
      const visitor=result[4].results?.[0];
      if (!visitor) bad(400,'This code is incorrect, expired, or already used. Request a new code.','INVALID_CODE');
      return json({visitor,expiresAt:iso(expiresAt)},200,{'Set-Cookie':sessionCookie('visitor',token,config.sessionDays*DAY,config.secureCookies)});
    }

    if ((path==='/api/auth/logout' || path==='/api/admin/logout') && method==='POST') {
      const role=path.startsWith('/api/admin/')?'admin':'visitor',token=readCookie(request,cookieName(role));
      if (token) await run(db,'DELETE FROM sessions WHERE token_hash=? AND role=?',[digest(config.authSecret,token),role]);
      return json({ok:true},200,{'Set-Cookie':sessionCookie(role,'',0,config.secureCookies)});
    }
    if (path==='/api/auth/me' && method==='GET') {
      const {visitor,session}=await requireVisitor(request,db,config,timestamp);
      return json({visitor:{id:visitor.id,email:visitor.email},expiresAt:iso(session.expires_at)});
    }
    if (path==='/api/deck' && method==='GET') {
      const {visitor}=await requireVisitor(request,db,config,timestamp);
      const row=await first(db,"SELECT * FROM decks WHERE status='published'");
      return json({deck:row?publicDeck(row,visitor.download_allowed):null});
    }
    if (path==='/api/visits' && method==='POST') {
      const {visitor}=await requireVisitor(request,db,config,timestamp),body=await readJson(request);
      if (!await limited(`visits:${visitor.id}`,120,3600000)) bad(429,'Please wait before reopening the deck.');
      const id=randomUUID();
      const result=await db.batch([
        prepare(db,`INSERT INTO visits(id,visitor_id,deck_id,started_at,last_at,last_event_at)
          SELECT ?,?,id,?,?,? FROM decks WHERE id=? AND status='published' RETURNING id`,[id,visitor.id,timestamp,timestamp,timestamp,String(body.deckId||'')]),
        prepare(db,'UPDATE visitors SET last_seen_at=MAX(COALESCE(last_seen_at,0),?) WHERE id=? AND EXISTS(SELECT 1 FROM visits WHERE id=?)',[timestamp,visitor.id,id]),
      ]);
      if (!result[0].results?.length) bad(404,'This deck is no longer published. Reload to open the current version.');
      return json({visitId:id},201);
    }
    if (path==='/api/events' && method==='POST') {
      const {visitor}=await requireVisitor(request,db,config,timestamp),{visitId,page,seconds,sequence}=await readJson(request);
      if (typeof visitId!=='string' || !Number.isInteger(page) || !Number.isFinite(seconds) || seconds<0 || seconds>30 || !Number.isSafeInteger(sequence) || sequence<0) bad(400,'Invalid viewing event.');
      const visit=await first(db,'SELECT v.*,d.page_count FROM visits v JOIN decks d ON d.id=v.deck_id WHERE v.id=? AND v.visitor_id=?',[visitId,visitor.id]);
      if (!visit) bad(404,'Viewing session was not found.');
      if (page<1 || page>visit.page_count) bad(400,'Invalid page.');
      if (sequence<=visit.last_sequence) return json({ok:true});
      if (!await limited(`events:${visitor.id}`,1800,3600000)) bad(429,'Too many viewing events.');
      await run(db,`UPDATE visits SET seconds=seconds+MAX(0,MIN(?,(?-last_event_at)/1000.0,30)),
        last_at=MAX(last_at,?),last_page=?,last_sequence=?,last_event_at=MAX(last_event_at,?)
        WHERE id=? AND visitor_id=? AND last_sequence<?`,[seconds,timestamp,timestamp,page,sequence,timestamp,visitId,visitor.id,sequence]);
      return json({ok:true});
    }

    let match;
    if ((match=/^\/content\/([^/]+)(?:\/(.*))?$/.exec(path)) && ['GET','HEAD'].includes(method)) {
      const admin=adminHost?await getSession(request,db,config,'admin',timestamp):null;
      if (!admin) await requireVisitor(request,db,config,timestamp);
      const deck=await first(db,'SELECT * FROM decks WHERE id=?',[match[1]]);
      if (!deck || (!admin && deck.status!=='published')) bad(404,'This version is not available.');
      let file;
      try { file=decodeURIComponent(match[2]||'index.html'); } catch { bad(400,'Invalid file.'); }
      const manifest=JSON.parse(deck.files_json);
      if (!Array.isArray(manifest) || !manifest.includes(file) || file==='download.pdf' || file.includes('..') || file.includes('\\') || file.split('/').some(segment=>segment.startsWith('.'))) bad(404,'File not found.');
      return serveObject(request,env.DECKS,`decks/${deck.id}/${file}`,file);
    }
    if ((match=/^\/api\/deck\/([^/]+)\/download$/.exec(path)) && ['GET','HEAD'].includes(method)) {
      const {visitor}=await requireVisitor(request,db,config,timestamp);
      const deck=await first(db,"SELECT * FROM decks WHERE id=? AND status='published'",[match[1]]);
      if (!deck || !deck.pdf_file) bad(404,'Download not available.');
      if (!deck.download_allowed || !visitor.download_allowed) bad(403,'Downloads are not enabled for your account.');
      if (!JSON.parse(deck.files_json).includes(deck.pdf_file) || deck.pdf_file.includes('..') || deck.pdf_file.includes('\\')) bad(404,'Download not available.');
      return serveObject(request,env.DECKS,`decks/${deck.id}/${deck.pdf_file}`,deck.pdf_file,`Superfast-Robotics-${deck.version.replace(/[^\w.-]/g,'_')}.pdf`);
    }

    if (path==='/api/admin/login' && method==='POST') {
      if (!await limited(`admin:${ip}`,10,15*60000)) bad(429,'Too many sign-in attempts. Try again in 15 minutes.');
      const body=await readJson(request);
      const valid=await verifyPassword(body.password,config.adminPasswordHash);
      if (!valid || !equal(String(body.username||''),config.adminUsername)) bad(401,'Incorrect administrator credentials.');
      const token=randomToken(),lifetime=12*3600000,expiresAt=timestamp+lifetime;
      await db.batch([
        prepare(db,"INSERT INTO sessions(token_hash,visitor_id,role,created_at,expires_at) VALUES (?,NULL,'admin',?,?)",[digest(config.authSecret,token),timestamp,expiresAt]),
        auditStatement(db,'admin.login',null,timestamp),
      ]);
      return json({username:config.adminUsername,expiresAt:iso(expiresAt)},200,{'Set-Cookie':sessionCookie('admin',token,lifetime,config.secureCookies)});
    }

    if (path.startsWith('/api/admin/')) {
      const adminSession=await requireAdmin(request,db,config,timestamp);
      if (path==='/api/admin/me' && method==='GET') return json({username:config.adminUsername,expiresAt:iso(adminSession.expires_at)});
      if (path==='/api/admin/settings' && method==='GET') return json({...settings(),mailProvider:config.mailProvider,adminUsername:config.adminUsername});
      if (path==='/api/admin/mail/verify' && method==='POST') {
        if (!await limited(`mail-verify:${ip}`,5,60000)) bad(429,'Please wait before checking mail again.');
        if (!mailReady(env)) bad(503,'Email delivery is not configured.','MAIL_UNAVAILABLE');
        try { await verifySmtp(env); return json({ok:true}); } catch { bad(502,'The mail server could not be verified.','MAIL_FAILED'); }
      }
      if (path==='/api/admin/overview' && method==='GET') return overview(db,url,settings,timestamp);
      if (path==='/api/admin/visitors' && method==='GET') {
        const q=(url.searchParams.get('q')||'').slice(0,254).toLowerCase(),status=url.searchParams.get('status');
        const page=Math.max(1,Math.min(100000,parseInt(url.searchParams.get('page'),10)||1));
        const where=' WHERE instr(u.email,?)>0'+(status==='blocked'?' AND u.blocked=1':status==='active'?' AND u.blocked=0 AND (u.access_expires_at IS NULL OR u.access_expires_at>?)':'');
        const args=status==='active'?[q,timestamp]:[q];
        const result=await db.batch([
          prepare(db,visitorSelect+where+' ORDER BY COALESCE(u.last_seen_at,u.created_at) DESC LIMIT 50 OFFSET ?',[...args,(page-1)*50]),
          prepare(db,'SELECT COUNT(*) n FROM visitors u'+where,args),
        ]);
        return json({visitors:result[0].results.map(visitorJson),total:result[1].results[0].n,page,pageSize:50});
      }
      if ((match=/^\/api\/admin\/visitors\/([^/]+)$/.exec(path)) && method==='GET') {
        const row=await first(db,visitorSelect+' WHERE u.id=?',[match[1]]);
        if (!row) bad(404,'Visitor not found.');
        const result=await db.batch([
          prepare(db,'SELECT v.*,d.title,d.version FROM visits v JOIN decks d ON d.id=v.deck_id WHERE v.visitor_id=? ORDER BY v.started_at DESC LIMIT 200',[row.id]),
          prepare(db,'SELECT p.visit_id,p.page,p.seconds FROM page_views p WHERE p.visit_id IN (SELECT id FROM visits WHERE visitor_id=? ORDER BY started_at DESC LIMIT 200) ORDER BY p.page',[row.id]),
        ]);
        const pages=new Map(); for (const p of result[1].results) { if (!pages.has(p.visit_id)) pages.set(p.visit_id,[]); pages.get(p.visit_id).push({page:p.page,seconds:p.seconds}); }
        return json({visitor:visitorJson(row),visits:result[0].results.map(v=>({...visitJson(v),pages:pages.get(v.id)||[]}))});
      }
      if ((match=/^\/api\/admin\/visitors\/([^/]+)$/.exec(path)) && method==='PATCH') {
        const visitor=await first(db,'SELECT * FROM visitors WHERE id=?',[match[1]]);
        if (!visitor) bad(404,'Visitor not found.');
        const {blocked,accessExpiresAt,downloadAllowed}=await readJson(request);
        if ((blocked!==undefined && typeof blocked!=='boolean') || (downloadAllowed!==undefined && typeof downloadAllowed!=='boolean')) bad(400,'Use true or false for access options.');
        let expiry=null;
        if (accessExpiresAt!==undefined && accessExpiresAt!==null) { expiry=Date.parse(accessExpiresAt); if (typeof accessExpiresAt!=='string' || !Number.isFinite(expiry)) bad(400,'Enter a valid expiration date.'); }
        // CASE leaves unrelated fields unchanged even if two admins edit at once.
        await db.batch([
          prepare(db,`UPDATE visitors SET blocked=CASE WHEN ? THEN ? ELSE blocked END,
            access_expires_at=CASE WHEN ? THEN ? ELSE access_expires_at END,
            download_allowed=CASE WHEN ? THEN ? ELSE download_allowed END WHERE id=?`,[Number(blocked!==undefined),Number(blocked||false),Number(accessExpiresAt!==undefined),expiry,Number(downloadAllowed!==undefined),Number(downloadAllowed||false),visitor.id]),
          prepare(db,'DELETE FROM sessions WHERE visitor_id=? AND EXISTS(SELECT 1 FROM visitors WHERE id=? AND (blocked=1 OR (access_expires_at IS NOT NULL AND access_expires_at<=?)))',[visitor.id,visitor.id,timestamp]),
          prepare(db,'UPDATE codes SET used_at=? WHERE email=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM visitors WHERE id=? AND (blocked=1 OR (access_expires_at IS NOT NULL AND access_expires_at<=?)))',[timestamp,visitor.email,visitor.id,timestamp]),
          auditStatement(db,'visitor.update',visitor.id,timestamp),
        ]);
        return json({ok:true});
      }
      if ((match=/^\/api\/admin\/visitors\/([^/]+)\/revoke$/.exec(path)) && method==='POST') {
        const visitor=await first(db,'SELECT * FROM visitors WHERE id=?',[match[1]]);
        if (!visitor) bad(404,'Visitor not found.');
        await db.batch([
          prepare(db,'DELETE FROM sessions WHERE visitor_id=?',[visitor.id]),
          prepare(db,'UPDATE codes SET used_at=? WHERE email=? AND used_at IS NULL',[timestamp,visitor.email]),
          auditStatement(db,'visitor.revoke',visitor.id,timestamp),
        ]);
        return json({ok:true});
      }
      if (path==='/api/admin/export' && method==='GET') return exportCsv(db);
      if (path==='/api/admin/decks' && method==='GET') return json({decks:(await all(db,'SELECT * FROM decks ORDER BY created_at DESC')).map(row=>({...publicDeck(row,true),downloadAllowed:Boolean(row.download_allowed)}))});
      if (path==='/api/admin/decks' && method==='POST') {
        if (!await limited(`upload:${ip}`,20,3600000)) bad(429,'Too many uploads. Please try again later.');
        return uploadPdf(request,env,db,timestamp);
      }
      if ((match=/^\/api\/admin\/decks\/([^/]+)\/publish$/.exec(path)) && method==='POST') {
        const deck=await first(db,'SELECT * FROM decks WHERE id=?',[match[1]]);
        if (!deck) bad(404,'Deck not found.');
        const entry=deck.kind==='html'?'index.html':'document.pdf';
        if (!await env.DECKS.head(`decks/${deck.id}/${entry}`)) bad(409,'The deck content is missing. Upload the complete deck before publishing.');
        await db.batch([
          prepare(db,"UPDATE decks SET status='archived' WHERE status='published'"),
          prepare(db,"UPDATE decks SET status='published',published_at=? WHERE id=?",[timestamp,deck.id]),
          auditStatement(db,'deck.publish',deck.id,timestamp),
        ]);
        return json({ok:true});
      }
      if ((match=/^\/api\/admin\/decks\/([^/]+)$/.exec(path)) && method==='PATCH') {
        const body=await readJson(request);
        if ((body.title!==undefined && !safeText(body.title)) || (body.downloadAllowed!==undefined && typeof body.downloadAllowed!=='boolean')) bad(400,'Invalid deck settings.');
        const result=await db.batch([
          prepare(db,'UPDATE decks SET title=CASE WHEN ? THEN ? ELSE title END,download_allowed=CASE WHEN ? THEN ? ELSE download_allowed END WHERE id=? RETURNING id',[Number(body.title!==undefined),body.title?.trim()||'',Number(body.downloadAllowed!==undefined),Number(body.downloadAllowed||false),match[1]]),
          auditStatement(db,'deck.update',match[1],timestamp),
        ]);
        if (!result[0].results?.length) bad(404,'Deck not found.');
        return json({ok:true});
      }
      if ((match=/^\/api\/admin\/decks\/([^/]+)\/preview$/.exec(path)) && method==='GET') {
        const deck=await first(db,'SELECT * FROM decks WHERE id=?',[match[1]]);
        if (!deck) bad(404,'Deck not found.');
        return json({deck:publicDeck(deck,true)});
      }
      bad(404,'API endpoint not found.');
    }
    if (path.startsWith('/api/') || path.startsWith('/content/')) bad(404,'API endpoint not found.');
    if (!['GET','HEAD'].includes(method)) bad(405,'Method not allowed.');
    if (path==='/' && adminHost && config.adminOrigin!==config.seedOrigin) return Response.redirect(`${config.adminOrigin}/admin`,302);
    if ((path==='/admin' || path==='/admin/' || path==='/admin.html') && !adminHost) bad(404,'Not found.');
    // ASSETS contains only public UI/vendor files, never deck content or secrets.
    const assetUrl=new URL(request.url);
    if (path==='/') assetUrl.pathname='/index.html';
    if (path==='/admin' || path==='/admin/') assetUrl.pathname='/admin.html';
    return env.ASSETS.fetch(new Request(assetUrl,request));
  }

  return {
    async fetch(request,env,context={}) {
      let config;
      try { config=loadConfig(env); return hardenedResponse(await route(request,env,context,config),request,config); }
      catch (error) {
        const response=error instanceof HttpError?json({error:error.message,code:error.code},error.status,error.headers):json({error:'Something went wrong. Please try again.',code:'INTERNAL_ERROR'},500);
        if (!(error instanceof HttpError)) console.error('Portal request failed:',error?.name||'Error');
        return hardenedResponse(response,request,config);
      }
    },
    async scheduled(event,env,context) {
      const config=loadConfig(env);
      const work=prune(env.DB,now(),config.retentionDays);
      if (context?.waitUntil) context.waitUntil(work);
      await work;
    },
  };
}

async function overview(db,url,settings,now) {
  let dateFormat;
  try { dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:url.searchParams.get('timezone')||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}); }
  catch { bad(400,'Choose a valid dashboard timezone.'); }
  const dayKey=value=>{const parts=Object.fromEntries(dateFormat.formatToParts(value).map(x=>[x.type,x.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
  const today=Date.parse(`${dayKey(now)}T00:00:00Z`);
  const result=await db.batch([
    prepare(db,"SELECT * FROM decks WHERE status='published'"),
    prepare(db,`SELECT
      (SELECT COUNT(*) FROM visitors) visitors,
      (SELECT COUNT(*) FROM visits) visits,
      (SELECT COALESCE(SUM(seconds),0) FROM visits) active_seconds,
      (SELECT COUNT(*) FROM (SELECT visitor_id FROM visits GROUP BY visitor_id HAVING COUNT(*)>1)) returning_visitors,
      (SELECT COUNT(*) FROM visits v JOIN decks d ON d.id=v.deck_id WHERE (SELECT COUNT(*) FROM page_views p WHERE p.visit_id=v.id)>=d.page_count) completed`),
    // Group into UTC-minute buckets to bound response size while retaining exact
    // local-day mapping, including half-hour and quarter-hour timezones below.
    prepare(db,'SELECT started_at,COUNT(*) n FROM visits WHERE started_at>=? GROUP BY CAST(started_at/60000 AS INTEGER)',[now-15*DAY]),
    prepare(db,"SELECT p.page,COUNT(*) views,SUM(p.seconds) seconds FROM page_views p JOIN visits v ON v.id=p.visit_id JOIN decks d ON d.id=v.deck_id WHERE d.status='published' GROUP BY p.page"),
    prepare(db,'SELECT v.*,d.title,d.version,u.email FROM visits v JOIN decks d ON d.id=v.deck_id JOIN visitors u ON u.id=v.visitor_id ORDER BY v.last_at DESC LIMIT 12'),
  ]);
  const current=result[0].results[0]||null,stats=result[1].results[0],daily=new Map();
  for (const row of result[2].results) { const key=dayKey(row.started_at);daily.set(key,(daily.get(key)||0)+row.n); }
  const activity=Array.from({length:14},(_,index)=>{const date=new Date(today+(index-13)*DAY).toISOString().slice(0,10);return {date,visits:daily.get(date)||0};});
  const totals=new Map(result[3].results.map(page=>[page.page,page]));
  const pages=current?Array.from({length:current.page_count},(_,index)=>({page:index+1,views:0,seconds:0,...totals.get(index+1)})):[];
  return json({stats:{visitors:stats.visitors,visits:stats.visits,activeSeconds:stats.active_seconds,returningVisitors:stats.returning_visitors,completionRate:stats.visits?Math.round(stats.completed/stats.visits*100):0},activity,pages,recent:result[4].results.map(visitJson),settings:settings(),currentDeck:current?publicDeck(current):null});
}

async function uploadPdf(request,env,db,now) {
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(request.headers.get('content-type')||'')) bad(415,'Upload a PDF using multipart/form-data.');
  let form;
  try { form=await new Response(boundedBody(request,MAX_UPLOAD_BYTES+65536),{headers:{'Content-Type':request.headers.get('content-type')}}).formData(); }
  catch (error) { if (error instanceof HttpError) throw error; bad(400,'The upload could not be read.'); }
  const file=form.get('file'),title=safeText(form.get('title')),version=safeText(form.get('version'),64);
  if (!file || typeof file.arrayBuffer!=='function' || form.getAll('file').length!==1) bad(400,'Choose one PDF file.');
  if (!title || !version) bad(400,'Title and version are required (140 and 64 characters maximum).');
  if (file.size>MAX_UPLOAD_BYTES) bad(413,`The PDF must be smaller than ${MAX_UPLOAD_MB} MB.`,'BODY_TOO_LARGE');
  if (await first(db,'SELECT id FROM decks WHERE version=?',[version])) bad(409,'This version label already exists.');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-') bad(400,'The uploaded file must be a PDF.');
  let pageCount;
  try {
    const pdf=await PDFDocument.load(bytes,{ignoreEncryption:false,updateMetadata:false,throwOnInvalidObject:true});
    pageCount=pdf.getPageCount();
    if (!Number.isInteger(pageCount) || pageCount<1 || pageCount>500) throw new Error('Invalid page count');
  } catch { bad(400,'This PDF could not be opened. Upload an unencrypted PDF with 1–500 pages.'); }
  const id=randomUUID(),key=`decks/${id}/document.pdf`;
  const downloadAllowed=form.get('downloadAllowed')==='true';
  await env.DECKS.put(key,bytes,{httpMetadata:{contentType:'application/pdf',cacheControl:'private, no-store'}});
  try {
    await db.batch([
      prepare(db,`INSERT INTO decks(id,title,version,kind,page_count,created_at,download_allowed,files_json,pdf_file)
        VALUES (?,?,?,'pdf',?,?,?,'["document.pdf"]','document.pdf')`,[id,title,version,pageCount,now,Number(downloadAllowed)]),
      auditStatement(db,'deck.upload',id,now),
    ]);
  } catch (error) {
    await env.DECKS.delete(key);
    if (await first(db,'SELECT id FROM decks WHERE version=?',[version])) bad(409,'This version label already exists.');
    throw error;
  }
  return json({deck:publicDeck(await first(db,'SELECT * FROM decks WHERE id=?',[id]),true)},201);
}

async function exportCsv(db) {
  const keys=['email','createdAt','lastSeenAt','visitCount','activeSeconds','lastPage','blocked','accessExpiresAt','downloadAllowed'];
  const quote=value=>'"'+String(value??'').replace(/^[=+@\-\t\r]/,"'$&").replace(/"/g,'""')+'"';
  const encoder=new TextEncoder();let offset=0,started=false;
  const stream=new ReadableStream({
    async pull(controller) {
      try {
        if (!started) { controller.enqueue(encoder.encode('\uFEFF'+keys.join(',')+'\r\n'));started=true; }
        const rows=await all(db,visitorSelect+' ORDER BY u.created_at DESC,u.id LIMIT 500 OFFSET ?',[offset]);
        if (!rows.length) { controller.close();return; }
        controller.enqueue(encoder.encode(rows.map(visitorJson).map(row=>keys.map(key=>quote(row[key])).join(',')).join('\r\n')+'\r\n'));
        offset+=rows.length;
        if (rows.length<500) controller.close();
      } catch (error) { controller.error(error); }
    },
  });
  return new Response(stream,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="superfast-visitors.csv"','Cache-Control':'private, no-store'}});
}

export default createHandler();
