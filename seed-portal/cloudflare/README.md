# Cloudflare 배포

운영 구성은 Workers + SQLite 기반 Durable Object + D1 + 비공개 R2입니다.

2026-11-17에 Cloudflare 계정의 `superfast-seed-portal` Worker로 배포했습니다. `wrangler.jsonc`에 운영 D1 ID와 두 Custom Domain이 저장되어 있습니다. 재배포는 기존 리소스와 비밀값을 유지하며 `npm run cf:deploy`로 진행합니다.

최초 게시 덱은 `seed-20m-v14`(16슬라이드)이며, 검토된 파일 110개를 해시 검증 후 비공개 R2에 가져왔습니다. 운영 관리자 로그인, SMTP TLS 인증·코드 발송, HTTPS 리다이렉트와 인증 없는 원본 파일 접근 차단을 확인했습니다.

- `seed.superfastrobotics.com`: 방문자 로그인과 덱 뷰어
- `superadmin.superfastrobotics.com`: 관리자 로그인과 대시보드
- Workers: 공개 UI와 인증된 덱 파일 전달
- Durable Object: 인증·관리자 API, 비밀번호 해싱, PDF 검사. Free Workers의 짧은 CPU 제한과 분리합니다.
- D1 `DB`: 계정, 코드 해시, 세션 해시, 덱 메타데이터, 열람 기록
- R2 `DECKS`: 덱 원본. 공개 도메인과 r2.dev 공개 접근을 켜지 않습니다.
- Google Workspace: TLS로 `smtp.gmail.com:465`에 연결하여 기존 발신 계정으로 코드 발송

코드는 10일 이내 한 번만 사용하고, 방문자 세션은 로그인 후 90일입니다. 관리자 세션은 12시간입니다. PDF 업로드는 메모리 사용을 제한하기 위해 25MB 이하이며 서버에서 1–500페이지의 유효한 PDF인지 검사합니다.

## 개발과 검증

Wrangler 개발 도구에는 Node 22.12 이상이 필요합니다. 기존 Node 서버는 별도로 실행할 수 있습니다.

```sh
npm ci
npm run cf:build
npx wrangler d1 execute DB --local --file cloudflare/schema.sql
npm run cf:dev
npm run cf:test
```

로컬 `.dev.vars`에 `AUTH_SECRET`, `ADMIN_PASSWORD_HASH`, `SMTP_PASS`를 넣습니다. 로컬 브라우저 테스트에는 아래 값을 추가합니다. 이 파일은 Git에 포함되지 않습니다.

```dotenv
ENVIRONMENT=development
SEED_ORIGIN=http://localhost:8787
ADMIN_ORIGIN=http://localhost:8787
```

`.cloudflare-assets`에는 공개 UI와 PDF.js만 복사합니다. `assets.run_worker_first=true`로 설정되어 모든 요청이 서버의 호스트·인증 검사를 먼저 통과합니다. 덱 파일은 이 디렉터리에 넣지 않습니다.

PDF.js의 CMap과 표준 폰트도 함께 배포하여 한글 및 폰트가 포함되지 않은 PDF를 지원합니다. 운영 도메인의 HTTP GET/HEAD 요청은 HTTPS로 이동합니다.

`cloudflare/tests/portal.workerd.mjs`는 실제 workerd·D1·R2에서 인증과 동시성, 관리자 권한, 파일 Range 처리, PDF 업로드, Durable Object 전달을 검증합니다. `mail.test.js`는 TLS·SMTP 프로토콜과 오류 처리를 메일 발송 없이 검증합니다.

## 최초 배포

1. Cloudflare 공식 Wrangler 로그인 권한을 승인합니다. 계정은 `8df378989a27166c1180b588582573df`입니다.
2. R2를 활성화하고 비공개 버킷 `superfast-seed-decks`를 만듭니다. 무료 한도 초과 시 요금이 발생하므로 구독 조건을 확인합니다.
3. D1 데이터베이스 `superfast-seed-portal`을 만들고 반환된 ID를 `wrangler.jsonc`의 `database_id`에 저장합니다.
4. `wrangler d1 execute DB --remote --file cloudflare/schema.sql`로 스키마를 적용합니다.
5. 운영 비밀값 `AUTH_SECRET`, `ADMIN_PASSWORD_HASH`, `SMTP_PASS`를 Wrangler secret 명령으로 저장합니다. 터미널·로그에 값을 출력하거나 Git에 넣지 않습니다. 운영 `AUTH_SECRET`은 새 난수를 생성해 이후 배포에서도 유지합니다.
6. `npm run cf:deploy`로 배포합니다. `workers_dev=false`와 `preview_urls=false`를 유지합니다.
7. 검토된 덱 패키지를 가져옵니다. 이 명령은 파일 해시를 검증한 뒤 비공개 R2에 저장하고 D1에 초안만 등록합니다. 중단된 업로드는 `.cloudflare-import`의 체크포인트로 재개됩니다.

```sh
node scripts/cloudflare-import.js --package /absolute/path/to/seed-20m-v14 --remote
```

8. Worker에 두 Custom Domain을 연결합니다. Wrangler의 `routes`에는 각각 `{ "pattern": "seed.superfastrobotics.com", "custom_domain": true }`와 관리자 도메인을 지정할 수 있습니다. 이미 다른 서비스로 연결된 레코드를 덮어쓰지 않습니다.
9. 관리자에서 가져온 초안을 미리 보고 게시합니다. 이메일 인증·덱·통계·접근 회수를 운영 도메인에서 검증합니다.

## 운영

`POST /api/admin/mail/verify`는 관리자 인증 후 SMTP 연결·TLS·로그인만 확인하며 메일은 보내지 않습니다. 실제 코드 요청은 `/api/auth/request`입니다. SMTP 오류 응답이나 인증코드는 브라우저 API와 서버 로그에 노출하지 않습니다.

매일 Cron Trigger로 만료 코드·세션과 365일 지난 방문 기록을 정리합니다. 차단 또는 접근 만료가 설정된 계정은 접근 제한을 보존합니다. D1 Time Travel과 R2 백업을 운영 정책에 맞춰 활용합니다.

Workers/D1/Durable Object는 Free 할당량에서 시작합니다. 한도를 넘으면 서비스 요청이 실패할 수 있습니다. R2는 무료 저장·요청 한도 초과 시 사용량 요금이 청구됩니다. 운영 사용량은 Cloudflare 계정 대시보드에서 확인합니다.

공식 참고: [Workers](https://developers.cloudflare.com/workers/), [Durable Objects 한도](https://developers.cloudflare.com/durable-objects/platform/limits/), [D1](https://developers.cloudflare.com/d1/), [R2 요금](https://developers.cloudflare.com/r2/pricing/), [TCP/TLS](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).
