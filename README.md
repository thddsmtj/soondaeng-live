# 순댕이

기존 순위추적 로직을 기반으로 만든 별도 사이트입니다. 기존 본사이트의 상품/키워드 데이터는 사용하지 않고, 순댕이에 새로 등록한 상품과 키워드만 추적합니다.

## 주요 기능

- 회원가입/로그인
- 회원가입 기준: 이메일, 010 전화번호 11자리, 8자 이상 비밀번호, 개인정보 동의
- 신규 회원은 관리자 승인 전까지 로그인 불가
- 상품 URL과 키워드 등록
- 키워드별 기준 순위 1~3개 설정
- 키워드별 하락폭 기준 설정
- 네이버 쇼핑 검색 API 기준 1~50위 순위 확인
- 매일 오전 8시 자동 순위 체크
- 최근 7일 기준 분석
  - 지정 순위 안에 있다가 밖으로 떨어진 키워드
  - 최근 7일 중 지정 하락폭 이상 떨어진 키워드
  - 50위 밖에 있다가 새로 50위 안에 들어온 키워드
- 엑셀 `.xlsx` 리포트 다운로드
- Resend API를 통한 매일 리포트 이메일 발송

## Render 설정

- Runtime: `Node`
- Build Command: 비워두기
- Start Command: `node server.js`

환경변수:

```txt
NAVER_CLIENT_ID=...
NAVER_CLIENT_SECRET=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STATE_TABLE=soondaeng_state
SESSION_SECRET=...
CRON_SECRET=...
ADMIN_SECRET=...
FREE_PRODUCT_LIMIT=100
SCHEDULE_TIMEZONE=Asia/Seoul
SCHEDULE_TIMES=08:00
RESEND_API_KEY=...
REPORT_FROM=순댕이 <report@example.com>
REPORT_RECIPIENTS=owner@example.com,manager@example.com
```

`RESEND_API_KEY`, `REPORT_FROM`, `REPORT_RECIPIENTS`가 모두 있어야 이메일이 발송됩니다. 없으면 리포트 생성은 진행되고 이메일만 건너뜁니다.

## Supabase 설정

Supabase SQL Editor에서 `supabase/schema.sql` 내용을 실행합니다. 기존 본사이트와 분리하기 위해 테이블명은 `soondaeng_state`를 사용합니다.
