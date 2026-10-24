# 해외파 축구 트래커

해외파 한국 축구선수의 기록과 뉴스를 한곳에서 보는 Next.js 앱.

- 뉴스: 구글 뉴스 RSS (키 불필요, 5분 캐시, 화면 5분 자동 갱신)
- 기록: [API-Football](https://www.api-football.com/) (무료 플랜 하루 100회라 6시간 캐시)
- 선수 목록: `lib/players.ts` (소속 변경·선수 추가는 여기서)

```
cp .env.example .env.local   # API_FOOTBALL_KEY 입력
npm install && npm run dev
```
