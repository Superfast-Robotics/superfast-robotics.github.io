# Portal API contract

Same-origin JSON. Every response with an error uses `{error: "human readable message", code: "CODE"}`. Fetch credentials same-origin. State-changing requests require JSON or multipart/form-data and same-origin Origin. Session cookies are HttpOnly. Dates are ISO UTC strings, durations seconds. No frontend credentials.

Visitor at `/`, admin at `/admin` (superadmin hostname redirects root to /admin). Public assets `/assets/...` (portal UI ONLY).

- GET `/api/config` → `{codeDays:10,sessionDays:90,retentionDays:365,mailReady:boolean}`.
- POST `/api/auth/request` `{email}` → `{message, expiresInDays:10}` (60 sec cooldown, throttled, failures actionable).
- POST `/api/auth/verify` `{email,code}` → `{visitor:{id,email},expiresAt}`. Codes are 12 uppercase hex chars; display as XXXX-XXXX-XXXX; input may include spaces/hyphens. One use.
- GET `/api/auth/me` → `{visitor:{id,email},expiresAt}` or 401/403.
- POST `/api/auth/logout` → `{ok:true}`.
- GET `/api/deck` → `{deck:null}` or `{deck:{id,title,version,kind:'html'|'pdf',pageCount,publishedAt,downloadAllowed,contentUrl:'/content/ID/index.html' or '/content/ID/document.pdf',downloadUrl:'/api/deck/ID/download'}}`.
- POST `/api/visits` `{deckId}` → `{visitId}`. Create when viewer opens, including repeat opens.
- POST `/api/events` `{visitId,page,seconds,sequence}` → `{ok:true}`. Page 1-based. seconds max 30 per batch. Sequence strictly increasing per visit. Heartbeat every 10–15 sec, flush page changes/visibility/pagehide, only visible & focused active time. Server deduplicates/caps. HTML deck iframe is same-origin and authenticated; can observe `.slide.is-active` and hash. PDF.js bundled from `/vendor/pdf.mjs` worker `/vendor/pdf.worker.mjs`. `/vendor/cmaps/`, `/vendor/standard_fonts/` and `/vendor/wasm/` may be provided. iframe HTML content sandbox allow-scripts allow-same-origin allow-presentation; uploaded HTML NOT supported (only trusted CLI-imported local deck).

Admin:
- POST `/api/admin/login` `{username,password}` → `{username,expiresAt}`.
- GET `/api/admin/me` → `{username,expiresAt}` or 401.
- POST `/api/admin/logout` → `{ok:true}`.
- GET `/api/admin/overview` → `{stats:{visitors,visits,activeSeconds,returningVisitors,completionRate},activity:[{date,visits}],pages:[{page,views,seconds}],recent:[{id,email,deckTitle,version,startedAt,lastAt,lastPage,seconds}],settings:{codeDays,sessionDays,retentionDays,mailReady},currentDeck:{id,title,version,kind,pageCount}|null}`. pages for current deck only; activity last 14 days.
- GET `/api/admin/visitors?q=&status=all|active|blocked&page=1` → `{visitors:[{id,email,createdAt,lastSeenAt,visitCount,activeSeconds,lastPage,blocked,accessExpiresAt,downloadAllowed}],total,page,pageSize}`. pageSize=50. Search debounced.
- GET `/api/admin/visitors/:id` → `{visitor:{...above},visits:[{id,deckTitle,version,startedAt,lastAt,lastPage,seconds,pages:[{page,seconds}]}]}`.
- PATCH `/api/admin/visitors/:id` `{blocked?:boolean,accessExpiresAt?:ISO|null,downloadAllowed?:boolean}` → `{ok:true}`.
- POST `/api/admin/visitors/:id/revoke` → `{ok:true}`. Revoke all sessions and pending codes.
- GET `/api/admin/export` → CSV of visitor metrics.
- GET `/api/admin/decks` → `{decks:[{id,title,version,kind,pageCount,createdAt,publishedAt,status:'published'|'draft'|'archived',downloadAllowed}]}`.
- POST `/api/admin/decks` multipart `file` (PDF max 100MB), `title`, `version`, `downloadAllowed` string true/false → `{deck}`. Server determines pageCount. Upload creates draft; no auto publish. UI file picker PDF only.
- POST `/api/admin/decks/:id/publish` → `{ok:true}` (archives current published).
- PATCH `/api/admin/decks/:id` `{title?,downloadAllowed?}` → `{ok:true}`.
- GET `/api/admin/decks/:id/preview` authenticated admin PDF/HTML preview redirect, sets no visitor analytics; response `{deck}` same shape as GET /api/deck.
- GET `/api/admin/settings` → `{codeDays,sessionDays,retentionDays,mailReady,mailProvider,adminUsername}`. Informational settings only; environment-managed.

No fake sample data. Clear loading, empty, error, success states. Default downloads disabled. Visitor-specific permission + deck permission BOTH needed for download. HTML has no download. Uploaded PDF viewed inside canvas, downloaded only via permissioned route. Browser can still save authorized content; don't claim DRM.
