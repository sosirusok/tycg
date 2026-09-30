# 좀비고 거래소

구매, 판매, 교환, 대리 모집을 위한 한국어 거래 게시판입니다. 아이디 로그인, 프로필, 게시글 수정과 삭제, 사진 첨부, 회원 간 1대1 채팅을 제공합니다.

이 저장소는 애플리케이션 소스와 검증 워크플로를 관리합니다. 실제 서비스는 Cloudflare Workers에서 실행하며 D1 데이터베이스와 R2 파일 저장소가 필요합니다. GitHub에 코드를 올리거나 CI가 성공하는 것만으로 운영 서비스가 배포되지는 않습니다. GitHub Pages는 이 앱의 서버 기능을 실행할 수 없습니다.

## 거래 분류

| 탭 | 세부 분류 | 입력 방식 |
| --- | --- | --- |
| 구매 | 계정, 클랜, 굿즈 및 쿠폰, 기타 | 최대 사용 금액과 원하는 조건 |
| 판매 | 계정, 클랜, 굿즈 및 쿠폰, 기타 | 판매 대상의 실제 정보, 즉거가, 현젯 |
| 교환 | 계정 또는 클랜 → 계정 또는 클랜 | 내놓는 대상과 구하는 대상을 따로 선택 |
| 대리(구함) | 래더, 스토리 및 재화, 이벤트 | 원하는 작업과 조건 |
| 대리(진행) | 래더, 스토리 및 재화, 이벤트 | 진행 가능한 작업과 조건 |

계정 구매에는 허용 대주 수, 전적 조건, 원하는 닉네임 조건을 받습니다. 보유 가스나 미네랄, 판매자의 실제 대주 수를 구매자에게 묻지 않습니다. 계정 판매에는 실제 대주 수를 숫자로 입력하고 보유 닉네임과 재화를 기록합니다. 교환은 제공 정보와 원하는 조건을 분리합니다.

판매 글의 즉거가를 바꾸면 서버에 이전 금액을 기록합니다. 공개 화면에는 이전 가격을 취소선으로 표시하고 현재 가격을 강조합니다. 현젯은 판매자가 기재하는 별도 금액이며, 플랫폼에서 확인한 거래 성사 금액을 뜻하지 않습니다. 구매 예산 변경은 판매 가격 이력에 섞이지 않습니다.

래더는 티어와 시즌의 정확한 조합을 체크합니다. 아이언은 25~32시즌, 마스터는 17~32시즌, 챔피언은 8~32시즌, 나머지 티어는 6~32시즌입니다. 우대 스킨 목록은 사용자 요청과 공개 자료에서 확인한 표기를 반영하며 인기 순위나 자동 시세로 사용하지 않습니다. 제목, 설명, 가격과 상세 조건은 각각 분리합니다.

회원은 자신의 글을 수정하고 삭제할 수 있습니다. 매니저는 신고 검토, 게시글 숨김과 복원, 공지 관리를 할 수 있습니다. 등급은 매니저와 일반 회원만 있으며 자동 승급은 없습니다. 결제, 에스크로, 거래 보증과 소유권 인증 기능은 제공하지 않습니다.

## 로컬 실행

Node.js 22.13 이상과 `package.json`에 지정된 pnpm을 사용합니다.

```bash
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm dev
```

로컬 개발은 모의 D1과 R2를 사용하므로 Cloudflare 계정이 없어도 실행할 수 있습니다. `wrangler.jsonc`의 기본 D1 ID는 로컬 전용 자리표시자입니다. 로컬 데이터는 Git에서 제외된 `.wrangler/state`에 저장됩니다.

빌드와 API 검증은 다음과 같이 실행합니다.

```bash
pnpm typecheck
pnpm build
pnpm test:v9
```

`test:v9`는 로컬 마이그레이션을 적용하고 8790번 포트에 빌드된 Worker를 띄워 거래 분류, 구매와 판매 조건, 교환 방향, 숫자 대주 수, 가격 이력과 검색을 검증한 뒤 서버를 종료합니다. 테스트 대상은 로컬 서버로 제한됩니다. 브라우저 검증용 미리보기와 운영 배포는 별개입니다.

## Cloudflare에 처음 배포하기

아래 명령은 운영자가 자신의 Cloudflare 계정에서 실행하는 절차입니다. 저장소의 CI는 이 명령을 자동 실행하지 않습니다.

먼저 Cloudflare에 인증하고 사용할 D1 데이터베이스와 R2 버킷을 만듭니다.

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create zombiego-market-db
pnpm exec wrangler r2 bucket create zombiego-market-uploads
```

`wrangler.jsonc`에서 다음을 설정합니다.

- `name`: 배포할 Worker 이름
- `d1_databases[0].database_id`: 생성 결과에 나온 실제 D1 ID
- `d1_databases[0].database_name`: 실제 데이터베이스 이름
- `r2_buckets[0].bucket_name`: 실제 업로드 버킷 이름

R2 버킷은 공개 버킷으로 설정하지 않습니다. 앱의 사진 API가 게시글 공개 여부와 접근 권한을 검사합니다. 기존 운영 데이터를 이전하는 경우 새 DB 생성만으로 회원, 게시글이나 업로드가 옮겨지지는 않으므로 별도 이관이 필요합니다.

실제 D1 ID를 설정한 다음 마이그레이션과 빌드를 실행합니다. 원격 마이그레이션 스크립트는 자리표시자 ID가 남아 있으면 실행을 중단합니다.

```bash
pnpm db:migrate:remote
pnpm typecheck
pnpm build
pnpm exec wrangler deploy --config dist/server/wrangler.json
```

배포 명령이 출력한 주소에서 서비스를 확인할 수 있습니다. 도메인은 Cloudflare의 해당 Worker 설정에서 연결합니다. `wrangler.jsonc`를 수정하면 반드시 다시 빌드한 뒤 배포합니다. 빌드된 설정 파일을 직접 수정하지 않습니다.

## 초기 매니저 설정

예약된 매니저 아이디는 `sosirusok`, 닉네임은 `우와오`입니다. 실제 비밀번호는 저장소에 포함하지 않습니다. 서버 비밀값 `MANAGER_PASSWORD_HASH`, `MANAGER_PASSWORD_SALT`가 설정된 후 최초 요청에서 매니저를 생성합니다. 이미 존재하는 매니저의 비밀번호는 이 설정을 바꿔도 덮어쓰지 않습니다.

해시는 PBKDF2 SHA-256, 100000회, 32바이트입니다. salt는 임의 32바이트의 16진수 문자열이며 해시 계산에는 그 문자열의 UTF-8 바이트를 사용합니다.

다음 명령은 비밀번호를 화면에 표시하지 않고 입력받아, salt와 해시만 로컬 `.dev.vars`에 저장합니다. Python 3가 필요합니다. 기존 파일이 있으면 덮어쓰지 않습니다.

```bash
python3 - <<'PY'
import getpass
import hashlib
import os
from pathlib import Path

path = Path('.dev.vars')
if path.exists():
    raise SystemExit('.dev.vars가 이미 있습니다. 기존 설정을 확인하세요.')
password = getpass.getpass('초기 매니저 비밀번호: ')
confirm = getpass.getpass('비밀번호 확인: ')
if len(password) < 8 or password != confirm:
    raise SystemExit('8자 이상이며 두 입력이 같아야 합니다.')
salt = os.urandom(32).hex()
digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000, 32).hex()
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as file:
    file.write(f'MANAGER_PASSWORD_SALT={salt}\nMANAGER_PASSWORD_HASH={digest}\n')
print('.dev.vars에 매니저 해시 설정을 저장했습니다.')
PY
```

로컬 개발에서는 이 파일을 자동으로 읽습니다. 위 Cloudflare 최초 배포가 끝난 뒤 다음 명령으로 같은 두 값을 Worker 비밀값에 등록할 수 있습니다. 이 명령은 Worker의 새 버전을 즉시 배포합니다.

```bash
pnpm exec wrangler secret bulk .dev.vars --config wrangler.jsonc
```

`.dev.vars`에는 이 두 설정만 넣고 원문 비밀번호를 넣지 않습니다. `.env*`, `.dev.vars*`, 로컬 DB와 업로드는 Git에서 제외됩니다. GitHub Actions 검증에는 매니저 비밀값이나 Cloudflare API 토큰이 필요하지 않습니다.

## 구성

| 경로 | 역할 |
| --- | --- |
| `app/`, `components/market/` | 화면과 라우팅 |
| `lib/market.ts`, `lib/trade-server.ts` | 거래 규칙과 서버 검증 |
| `lib/server.ts` | 인증, 세션, DB와 파일 저장소 |
| `db/schema.ts`, `drizzle/` | 스키마와 추가형 마이그레이션 |
| `build/standalone-worker.ts`, `wrangler.jsonc` | 독립 Cloudflare Worker 진입점과 바인딩 |
| `.github/workflows/ci.yml` | 고정된 의존성 설치, 타입 검사, 빌드, 로컬 API 검증 |
| `docs/` | 조사 근거와 검증 기록 |

실행 경로는 별도 사이트 프로젝트 ID, ChatGPT 로그인 또는 커넥터 연결에 의존하지 않습니다. 남아 있는 이전 개발 도구 파일은 Worker 진입점에 연결되지 않습니다.

참고 문서: [Cloudflare Vite 플러그인](https://developers.cloudflare.com/workers/vite-plugin/get-started/), [D1 명령](https://developers.cloudflare.com/d1/wrangler-commands/), [R2 버킷 생성](https://developers.cloudflare.com/r2/buckets/create-buckets/), [Worker 비밀값](https://developers.cloudflare.com/workers/configuration/secrets/).
