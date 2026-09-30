# 좀비고 거래소

좀비고 계정·클랜·굿즈 거래와 대리를 위한 한국어 거래 게시판입니다. 화면 구조는 숨고(soomgo.com)의 목록·프로필·채팅 흐름을 따르고, 메인 색은 파랑 `#0066FF` 한 가지만 씁니다.

- 거래 탭: **구매 · 판매 · 교환 · 대리(구함) · 대리(진행)**
- 세부 분류: 구매·판매는 계정/클랜/굿즈 및 쿠폰/기타, 대리는 래더/스토리 및 재화/이벤트, 교환은 “[계정·클랜]에서 [계정·클랜] 구함”
- 판매: 즉거가·현젯(만원 단위), 즉거가를 바꾸면 이전 가격이 취소선으로 남음(예: ~~60만원~~ ~~50만원~~ 40만원)
- 구매: 최대 사용 가능 금액(MAX), 허용 대주 수, 전적 조건, 원하는 닉 조건
- 래더 시즌 체크(아이언 25~, 마스터 17~, 챔피언 8~, 나머지 6~현재 시즌), 우대 스킨, 대주 수, 팬텀 %, 닉 글자 수·등급으로 검색
- 회원가입·로그인(30일 유지), 프로필, 1:1 채팅(사진 첨부), 가격 제안, 찜, 신고, 차단
- **인증**: 대리 인증 · 본인 인증 · 신용인. 닉네임 옆에 인증 이름과 체크 표시. 대리(진행) 글은 대리 인증 회원만 작성
- **등급**: 일반 → 플러스 → 프리미엄 → 엘리트 → 관리자. 플러스 영구 3만원, 프리미엄 영구 5만원/6개월 3만원, 엘리트 영구 10만원/6개월 6만원, 관리자는 매니저 지정
- 인증·등급 신청: 우측 상단 **인증/등급 신청하기** → 설명 창 → **신청하러 가기** → 매니저와의 채팅. 매니저는 채팅의 신청 카드에서 바로 승인·반려하고, 오른쪽 회원 관리 패널에서 인증·등급을 지급·회수
- 매니저 관리: 신청, 회원 검색, 신고, 숨긴 글, 공지, 설정(등급 입금 안내 문구, 현재 래더 시즌)

결제·에스크로·거래 보증 기능은 없습니다. 등급 결제는 매니저 계좌 입금을 매니저가 확인한 뒤 지급하는 방식입니다.

## 서버 배포 (한 번만 설정)

서비스는 Cloudflare Workers(서버)와 D1(데이터베이스)에서 무료 요금제로 동작합니다. 저장소의 GitHub Actions가 데이터베이스 생성, 테이블 준비, 배포까지 모두 처리하므로 **로그인이나 명령어 입력 없이** 아래 두 가지만 한 번 등록하면 됩니다.

1. **Cloudflare API 토큰 만들기**
   1. <https://dash.cloudflare.com/sign-up> 에서 무료 가입(이미 있으면 로그인)
   2. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Edit Cloudflare Workers** 템플릿의 **Use template**
   3. Permissions에 **+ Add more** → `Account` · `D1` · `Edit` 한 줄 추가
   4. Account Resources는 본인 계정 선택 → **Continue to summary** → **Create Token** → 표시된 토큰 복사
2. **GitHub 저장소에 비밀값 등록**: 저장소 **Settings → Secrets and variables → Actions → New repository secret**
   - `CLOUDFLARE_API_TOKEN`: 위에서 복사한 토큰
   - `MANAGER_PASSWORD`: 매니저 계정(아이디 `sosirusok`, 닉네임 `우와오`)의 비밀번호. 매니저 계정이 처음 만들어질 때만 쓰입니다.
3. **Actions → Deploy to Cloudflare → Run workflow** (이후에는 main 브랜치에 반영될 때마다 자동 배포)

실행 결과 요약(Summary)에 사이트 주소 `https://zombiego-market.<계정 이름>.workers.dev` 가 표시됩니다. 처음 만든 주소는 연결까지 몇 분 걸릴 수 있습니다.

- 사진은 R2가 켜진 계정이면 R2에, 아니면 D1에 저장합니다. R2는 결제수단 등록이 필요하므로 켜지 않아도 됩니다.
- 토큰으로 볼 수 있는 Cloudflare 계정이 여러 개라면 `CLOUDFLARE_ACCOUNT_ID` 비밀값도 추가하세요.
- 원하는 주소 이름이 있으면 저장소 **Variables**에 `WORKERS_SUBDOMAIN`을 넣으세요. 개인 도메인은 Cloudflare의 Worker 설정에서 연결합니다.
- 비밀값이 없으면 배포 작업은 아무것도 바꾸지 않고 안내만 남깁니다.

## 운영 메모

- **새 래더 시즌**: 매니저 관리 → 설정에서 현재 시즌을 올리면 글쓰기·검색의 시즌 선택지가 늘어납니다.
- **등급 입금 안내**: 매니저 관리 → 설정의 문구가 인증·등급 신청 창에 그대로 표시됩니다.
- **6개월 등급**: 지급일부터 6개월 뒤 자동으로 내려가며, 영구 등급이 있으면 그 등급으로 돌아갑니다. 같은 등급을 기간 중에 다시 지급하면 남은 기간 뒤로 6개월이 이어집니다.
- **관리자 등급**은 표시용 등급입니다. 매니저 권한(신청 처리, 신고, 숨김)은 매니저 계정에만 있습니다.
- 무료 요금제 기준으로 요청당 CPU 시간이 짧아 비밀번호 해시는 PBKDF2-SHA256 20,000회로 저장하며, 해시에 반복 횟수를 함께 기록합니다.

## 로컬 개발

Node.js 22.13 이상과 pnpm(`packageManager`에 지정된 버전)을 사용합니다.

```bash
pnpm install --frozen-lockfile
echo 'MANAGER_PASSWORD=원하는-비밀번호' > .dev.vars   # 로컬 매니저 계정용, Git에 올라가지 않음
pnpm db:migrate:local
pnpm dev
```

로컬에서는 D1과 R2를 흉내 낸 저장소(`.wrangler/state`)를 쓰므로 Cloudflare 계정이 없어도 됩니다.

검사:

```bash
pnpm typecheck
pnpm build
pnpm test      # 로컬 서버를 띄워 API 검증 3종(거래, 인증·등급, R2 없는 사진 저장)을 실행
```

## 구조

| 경로 | 역할 |
| --- | --- |
| `src/` | 화면(React). `pages/`는 화면별, `components/`는 공용 부품, `styles/`는 디자인 토큰과 스타일 |
| `worker/` | API 서버(Cloudflare Worker). 게시글, 사진, 채팅, 인증·등급 신청, 매니저 기능 |
| `shared/` | 화면과 서버가 함께 쓰는 거래 규칙(티어·시즌, 분류, 우대 스킨, 등급·인증 정의) |
| `migrations/` | D1 테이블 변경 기록(추가만 함) |
| `tests/`, `scripts/test-local.mjs` | 로컬 API 검증 |
| `public/icons/` | Microsoft Fluent Emoji 컬러 아이콘(MIT, `LICENSE.md` 포함) |
| `.github/workflows/` | CI(타입 검사·빌드·검증)와 Cloudflare 자동 배포 |
| `docs/research.md` | 거래 용어·우대 스킨·배포 제약 조사 근거 |

글꼴은 Pretendard(SIL OFL)를 사이트에 포함해 배포합니다.
