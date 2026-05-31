# TYCG

공장/타이쿤/키우기 형태의 웹 게임 (개발 초기 — 인프라 골격 단계).

## 구조
- **프론트엔드 / 빌드**: Vite (vanilla JS)
- **회원가입 · 로그인 · 저장**: Supabase (Auth + Postgres)
- **호스팅 (URL, 24시간)**: Vercel (GitHub 연동 자동 배포)
- 노트북은 개발용일 뿐, 실제 서비스는 전부 클라우드에서 동작.

## 로컬 개발
```bash
npm install
npm run dev
```
`.env` 에 Supabase 공개 값이 필요 (`.env.example` 참고).

## 배포
GitHub `main` 에 push → Vercel 이 자동 빌드/배포.
Vercel 프로젝트 환경변수에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 설정 필요.
