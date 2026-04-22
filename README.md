# 버킷그램 상담 LLM 웹앱

버킷그램(`https://bucketgram.co.kr`) 공개 페이지를 크롤링해 상품 인덱스를 만들고, OpenAI API를 통해 구매 상담 답변을 제공하는 모바일 대응 웹앱입니다.

## 기능
- 버킷그램 카테고리/상품 페이지 크롤링
- `product_no` 기준 상품 중복 제거
- OpenAI 기반 상담 답변 (`/api/chat`)
- 채팅에서 이미지 1장 첨부 후 상담 가능 (최대 5MB)
- 모바일 대응 채팅 UI
- 수동 데이터 갱신 버튼 (`버킷그램 데이터 새로 수집`)

## 실행 방법
1. 의존성 설치
```bash
npm install
```
2. 환경 변수 설정
```bash
copy .env.example .env
```
`.env`에 `OPENAI_API_KEY`를 입력합니다.

3. 서버 실행
```bash
npm start
```
브라우저에서 `http://localhost:3000` 접속

## 데이터 수집만 실행
```bash
npm run crawl
```

## Vercel 배포
1. 로컬에서 최신 상품 데이터 갱신
```bash
npm run crawl
```

2. Vercel CLI 로그인/배포
```bash
npx vercel login
npx vercel --prod
```

3. 환경 변수 설정
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (예: `gpt-4.1-mini`)

CLI 예시:
```bash
npx vercel env add OPENAI_API_KEY production
npx vercel env add OPENAI_MODEL production
```

참고:
- Vercel Serverless 환경에서는 장시간 크롤링(`POST /api/crawl`)이 타임아웃될 수 있습니다.
- 배포 전에 로컬에서 `npm run crawl`로 `data/products_index.json`을 갱신한 뒤 배포하는 방식을 권장합니다.

## 주의
- 사이트 구조 변경 시 크롤러 정규식/선택자를 업데이트해야 합니다.
- 의료 효능을 단정하는 표현은 피하고, 구매 가이드 중심 답변을 권장합니다.
- 타 서비스 UI를 완전히 동일하게 복제하지 말고, 유사한 사용성만 참고하세요.
