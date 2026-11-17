# Superfast Robotics Seed Portal

이메일로 접근 코드를 받고 투자 덱을 열람하는 포털과 관리자 대시보드입니다. 기존 회사 홈페이지와 공개 덱은 별도로 유지하며, 이 앱은 Node 서버에서 인증·권한·파일 접근을 처리합니다.

- 방문자: `https://seed.superfastrobotics.com`
- 관리자: `https://superadmin.superfastrobotics.com` (로컬에서는 `/admin`)
- 저장: SQLite 데이터베이스 및 덱 파일을 `DATA_DIR` 아래에 저장

## 기본 동작

누구나 이메일을 등록할 수 있습니다. 발송된 12자리 접근 코드는 **발급 후 10일 동안 유효하며 한 번만 사용**할 수 있습니다. 새 코드를 요청하면 이전 코드는 교체됩니다. 발송과 입력 시도는 제한됩니다.

인증 후에는 브라우저의 HttpOnly 세션 쿠키로 **로그인 시점부터 90일**간 유지합니다. 방문할 때마다 만료가 연장되는 구조는 아닙니다. 10일은 코드의 사용 기한이며, 인증된 방문자의 열람 권한이 자동으로 10일 뒤 끝난다는 의미는 아닙니다. 관리자는 방문자별 접근 만료일을 별도로 지정할 수 있습니다.

대시보드에서 이메일별 방문·재방문, 덱 버전, 마지막 페이지, 페이지별 추정 체류 시간을 확인하고 방문자 차단·해제, 로그인 세션 회수, 접근 만료일과 다운로드 권한을 관리합니다. PDF 업로드는 초안으로 저장되며, 게시할 버전을 선택하면 현재 버전이 바뀝니다. HTML 덱은 신뢰할 수 있는 로컬 번들만 CLI로 가져옵니다.

체류 시간은 화면이 보이고 활성화된 동안의 추정치입니다. 실제 독서 여부를 확정하지 않습니다. 다운로드는 기본적으로 꺼져 있으며, 덱과 방문자 양쪽에서 허용해야 활성화됩니다. 인증된 브라우저가 받은 자료의 캡처·저장까지 막는 DRM은 제공하지 않습니다.

## 로컬 실행

Node.js 22와 npm을 권장합니다. 다음 명령은 `seed-portal` 디렉터리에서 실행합니다.

```powershell
npm ci
Copy-Item .env.example .env
node scripts/generate-admin-hash.js
```

마지막 명령은 비밀번호를 화면에 표시하지 않고 입력받아 `salt:hash` 값을 출력합니다. 이 값을 `.env`의 `ADMIN_PASSWORD_HASH`에 넣고 `ADMIN_USERNAME=admin`을 설정합니다. 지정된 비밀번호는 코드나 브라우저 번들에 저장하지 않습니다. `AUTH_SECRET`에는 다음 명령으로 만든 임의 값을 넣습니다.

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run check
npm test
npm start
```

로컬 기본 URL은 `http://localhost:3100`, 관리자는 `http://localhost:3100/admin`입니다. `.env`, `data/`, 로그는 Git에서 제외됩니다. 기존 `.env`가 준비되어 있다면 덮어쓰지 말고 필요한 항목만 수정합니다.

## 이메일 연결

`MAIL_PROVIDER=disabled`에서는 실제 메일을 보내지 않습니다. 인증코드를 API 응답이나 화면에 대신 노출하지도 않습니다. 방문자 로그인을 사용하려면 아래 중 하나를 설정해야 합니다.

| 방식 | 환경 변수 |
| --- | --- |
| Resend | `MAIL_PROVIDER=resend`, `RESEND_API_KEY`, `MAIL_FROM` |
| SMTP | `MAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` |

`MAIL_FROM`에는 발송 서비스에서 확인된 발신자를 지정합니다. 예: `Superfast Robotics <access@superfastrobotics.com>`. 도메인 인증에 필요한 DNS 레코드는 선택한 발송 서비스에서 제공하는 실제 값을 사용합니다. SMTP 587의 일반적인 설정은 `SMTP_SECURE=false`이며 465는 `true`입니다. 운영 서버에서는 테스트 수신자 제한이 없는 발송 자격을 확인합니다.

### Google Workspace

선택한 발송 서비스는 Google Workspace이며, 확인된 발신 계정은 `hello@superfastrobotics.com`입니다. `.env`에는 아래 서버·계정 설정이 반영되어 있습니다. 앱 비밀번호를 입력하면 연결을 검증할 수 있습니다.

```dotenv
MAIL_PROVIDER=smtp
MAIL_FROM=Superfast Robotics <hello@superfastrobotics.com>
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=hello@superfastrobotics.com
SMTP_PASS=
```

이 앱은 587 포트에서 STARTTLS를 필수로 사용합니다. `SMTP_SECURE=false`는 암호화를 끈다는 뜻이 아니라, 연결 직후 TLS로 전환하는 설정입니다. Google은 Gmail SMTP 인증에 전체 Workspace 이메일 주소와 앱 비밀번호를 안내합니다. [Google Workspace SMTP 설정](https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app?hl=en)

발신 계정에서 2단계 인증을 사용한 뒤 [앱 비밀번호](https://myaccount.google.com/apppasswords)를 생성해 로컬 `.env`의 `SMTP_PASS`에만 입력합니다. 일반 Google 계정 비밀번호를 사용하거나 비밀번호를 채팅·소스 코드에 넣지 않습니다. 운영 배포 시에는 같은 값을 호스팅 서비스의 비밀 환경 변수에 설정합니다. 저장 후 서버를 재시작합니다.

조직 계정 정책이나 계정 보안 설정에 따라 앱 비밀번호 메뉴가 제공되지 않을 수 있습니다. 이 경우 보안 설정을 낮추지 않고 Workspace 관리자가 허용하는 SMTP relay 또는 OAuth 연결을 별도로 구성합니다. 현재 앱의 기본 SMTP 인증은 앱 비밀번호 방식입니다. [Google 앱 비밀번호 안내](https://support.google.com/mail/answer/185833?hl=en)

`npm run mail:verify`는 메일을 보내지 않고 SMTP 연결·TLS·로그인만 확인합니다. 실제 발신자 허용 및 수신함 도착 여부는 인증 메일 요청으로 별도 확인합니다.

## 기존 HTML 덱 가져오기

작성용 `pitch/` 전체 대신, 공개용 빌더를 거친 검토된 번들을 가져옵니다. 이 작업은 원본 파일을 수정하지 않습니다.

이 작업 환경의 기존 번들:

```powershell
npm run import:deck -- --source "C:/Users/dlqks/Documents/sfr_seeddeck" --title "Superfast Robotics Seed Deck" --version "seed-20m-v14"
```

동일 버전의 PDF를 함께 보관하려면 다음 옵션을 추가할 수 있습니다.

```powershell
npm run import:deck -- --source "C:/Users/dlqks/Documents/sfr_seeddeck" --title "Superfast Robotics Seed Deck" --version "seed-20m-v14" --pdf "C:/Users/dlqks/Documents/sfr_web/output/pdf/Superfast_Robotics_Pitch_Deck_v14_Local.pdf"
```

가져온 결과를 대시보드에서 확인하고 공개할 버전을 게시합니다. 새 PDF 버전은 대시보드에서 업로드할 수 있습니다. 발표자 메모, `drafts/`, `planning/`, 저장소 전체를 업로드하지 않습니다. 기존 공개 덱 주소는 그대로 공개 상태이므로, 포털 인증을 추가해도 이미 공개한 사본의 접근 상태까지 변경되지는 않습니다.

## Render 배포

`render.yaml`은 단일 Node 웹 서비스와 1 GB 영구 디스크를 선언합니다. 유료 컴퓨트와 디스크가 필요한 구성입니다. 두 도메인은 같은 서비스로 연결하고, 관리자 요청은 별도 인증으로 처리합니다.

1. 앱 소스를 Git 저장소에 커밋·푸시합니다. `.env`와 `data/`는 포함하지 않습니다.
2. Render 연결을 인증하고 사용할 워크스페이스를 확인합니다.
3. Render CLI가 있다면 `render blueprints validate render.yaml`로 검증합니다.
4. 새 Blueprint를 만들 때 저장소 내 Blueprint 경로를 `seed-portal/render.yaml`로 선택합니다. 앱만 별도 저장소로 옮겼다면 YAML의 `rootDir: seed-portal`을 제거합니다.
5. 초기 설정에서 `ADMIN_PASSWORD_HASH`, 확인된 `MAIL_FROM`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`를 입력합니다. `AUTH_SECRET`은 Render가 생성합니다. 기본 발송 방식은 요청하신 SMTP이며, 제공업체에 맞게 포트와 TLS 설정을 조정합니다.
6. 실제 서비스가 제공하는 도메인 연결 안내에 따라 Cloudflare에 `seed`, `superadmin` DNS 레코드를 등록하고 HTTPS 인증서 발급을 확인합니다.
7. 덱을 서비스의 영구 디스크로 가져온 뒤 관리자에서 게시합니다. HTML 번들은 Render SSH/SCP로 `/var/data/imports/`에 전송하고 실행 중인 서비스의 Shell에서 아래 명령을 사용합니다. PDF는 대시보드에서 업로드할 수 있습니다.

```sh
node scripts/import-deck.js --source /var/data/imports/seeddeck --title "Superfast Robotics Seed Deck" --version "seed-20m-v14"
```

Render 영구 디스크는 실행 중인 서비스에서만 접근할 수 있으므로 덱 가져오기를 build/pre-deploy 명령에 넣지 않습니다. 이 구성은 단일 인스턴스이고, 배포 중 잠깐 중단될 수 있습니다. [Render 디스크 문서](https://render.com/docs/disks)

서버 상태 확인은 `/healthz`로 합니다. 최종 확인에서는 실제 수신함으로 코드 수신 → 로그인 → 슬라이드 이동 → 대시보드 기록 확인 → 세션 회수 후 재접근 차단까지 점검합니다. DNS·HTTPS와 이메일 발송이 연결되기 전에는 운영 배포가 완료된 것으로 보지 않습니다.

검토 당시 Render 커넥터는 재인증이 필요했고 두 새 서브도메인은 등록되어 있지 않았습니다. 배포 YAML은 준비용이며, 이 파일 작성만으로 원격 서비스나 DNS가 생성되지는 않습니다. YAML 필드는 [현재 Blueprint 사양](https://render.com/docs/blueprint-spec)을 기준으로 작성했습니다.

## Docker로 실행

```sh
docker build -t superfast-seed-portal .
docker volume create superfast-seed-data
docker run --rm --env-file .env -e NODE_ENV=production -e DATA_DIR=/app/data -p 3100:3100 -v superfast-seed-data:/app/data superfast-seed-portal
```

운영에서는 `.env`의 두 origin을 실제 HTTPS 도메인으로 바꾸고 TLS 프록시 뒤에서 실행합니다. `TRUST_PROXY`는 실제 신뢰할 프록시 수에 맞춥니다. 컨테이너에 데이터를 영구 보관하려면 위처럼 볼륨을 연결해야 합니다.

## 운영 설정과 백업

| 변수 | 기본값 / 역할 |
| --- | --- |
| `CODE_DAYS` | 코드 사용 기한 10일 |
| `SESSION_DAYS` | 방문자 로그인 유지 90일 |
| `RETENTION_DAYS` | 열람 기록 보관 365일 |
| `DATA_DIR` | 로컬 `./data`, Render `/var/data` |
| `SEED_ORIGIN`, `ADMIN_ORIGIN` | 허용하는 방문자·관리자 origin |
| `AUTH_SECRET` | 인증용 비밀키. 재시작 간 동일하게 유지 |
| `ADMIN_PASSWORD_HASH` | 서버에서 검증하는 scrypt 비밀번호 해시 |

데이터베이스는 SQLite의 일관된 백업 기능을 사용하고 덱 파일과 함께 외부 보관합니다. 실행 중인 DB 파일만 임의 복사하거나 디스크 스냅샷만을 유일한 DB 백업으로 삼지 않습니다. 복구할 때는 백업의 데이터베이스와 덱 파일이 서로 맞는지 확인합니다. `DATA_DIR` 전체를 웹 정적 경로로 노출하지 않습니다.

열람 기록은 기본 365일 뒤 정리됩니다. 차단 또는 접근 만료를 지정한 이메일의 최소 계정 정보는 접근 제한을 유지하기 위해 남깁니다. 제한이 없는 비활성 계정은 보관 기간 뒤 삭제됩니다.

API 계약은 [API.md](API.md)에 정리되어 있습니다.
