require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const BASE_URL = 'https://bucketgram.co.kr';
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products_index.json');

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // Vercel serverless request body 제한을 고려해 4MB로 설정
    fileSize: 4 * 1024 * 1024,
  },
});

let products = loadProducts();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadProducts() {
  try {
    if (!fs.existsSync(PRODUCTS_PATH)) return [];
    return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function saveProducts(list) {
  ensureDir();
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(list, null, 2), 'utf-8');
}

async function fetchHtml(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: BASE_URL,
    },
  });

  const buf = Buffer.from(res.data);
  const contentType = String(res.headers['content-type'] || '').toLowerCase();
  const head = buf.slice(0, 2048).toString('ascii').toLowerCase();

  let charset = 'utf-8';
  const headerMatch = contentType.match(/charset=([^;\s]+)/i);
  if (headerMatch?.[1]) charset = headerMatch[1].toLowerCase();

  if (head.includes('charset=euc-kr') || head.includes('charset=ks_c_5601-1987')) {
    charset = 'euc-kr';
  }

  if (charset === 'euc-kr' || charset === 'ks_c_5601-1987' || charset === 'cp949') {
    return iconv.decode(buf, 'cp949');
  }
  return iconv.decode(buf, 'utf-8');
}

function extractCateNos(html) {
  const set = new Set();
  const re = /cate_no=(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    set.add(m[1]);
  }
  return [...set];
}

function normalizeProductUrl(url) {
  if (!url) return null;
  const clean = url.replace(/#.*$/, '').replace(/\?.*$/, '');
  return clean.startsWith('http') ? clean : `${BASE_URL}${clean}`;
}

function toProductDetailUrlFromAny(url) {
  const m = url.match(/\/(\d+)\/category\//);
  if (!m) return null;
  return `${BASE_URL}/product/detail.html?product_no=${m[1]}`;
}

function parseProductNo(url) {
  const m = url.match(/product_no=(\d+)/) || url.match(/\/(\d+)\/category\//);
  return m ? m[1] : null;
}

function textOf($, selectors) {
  for (const sel of selectors) {
    const v = $(sel).first().text().trim();
    if (v) return v;
  }
  return '';
}

async function scrapeProductDetail(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr('content') ||
      textOf($, ['.headingArea h2', '.xans-product-detail h2', 'h2']) ||
      '상품명 확인 필요';

    const price =
      $('meta[property="product:price:amount"]').attr('content') ||
      textOf($, ['#span_product_price_text', '.price', '.prdPrice']) ||
      '';

    const summary =
      $('meta[name="description"]').attr('content') ||
      textOf($, ['.summary_desc', '.simple_desc', '.prdInfo']) ||
      '';

    const no = parseProductNo(url);
    return {
      product_no: no,
      name: title,
      price,
      summary,
      detail_url: url,
    };
  } catch {
    return {
      product_no: parseProductNo(url),
      name: '상품명 확인 필요',
      price: '',
      summary: '',
      detail_url: url,
    };
  }
}

async function crawlBucketgramProducts() {
  const home = await fetchHtml(`${BASE_URL}/`);
  const cateNos = extractCateNos(home);
  const rawProductLinks = new Set();

  for (const cate of cateNos) {
    for (let page = 1; page <= 30; page += 1) {
      const listUrl = `${BASE_URL}/product/list.html?cate_no=${cate}&page=${page}`;
      let html;
      try {
        html = await fetchHtml(listUrl);
      } catch {
        break;
      }

      const matches = html.match(/\/product\/[^"'\s<>]+?\/\d+\/category\/\d+\/[^"'\s<>]*/g) || [];
      const before = rawProductLinks.size;
      matches.forEach((u) => rawProductLinks.add(normalizeProductUrl(u)));

      if (rawProductLinks.size === before && page > 2) {
        break;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  const detailMap = new Map();
  for (const u of rawProductLinks) {
    const detail = toProductDetailUrlFromAny(u);
    if (!detail) continue;
    const no = parseProductNo(detail);
    if (!no || detailMap.has(no)) continue;
    detailMap.set(no, detail);
  }

  const detailUrls = [...detailMap.values()];
  const parsed = [];

  // 서버 과부하를 줄이기 위해 순차+짧은 대기 방식으로 상세 페이지를 읽습니다.
  for (let i = 0; i < detailUrls.length; i += 1) {
    const item = await scrapeProductDetail(detailUrls[i]);
    parsed.push(item);
    await new Promise((r) => setTimeout(r, 90));
  }

  return parsed.sort((a, b) => Number(a.product_no) - Number(b.product_no));
}

function selectRelevantProducts(userText, allProducts, max = 8) {
  if (!allProducts.length) return [];

  const normalize = (v) =>
    String(v || '')
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[^0-9a-z가-힣]/g, '');

  const stripKoreanParticle = (t) =>
    t.replace(/(은|는|이|가|도|을|를|에|의|과|와|로|으로)$/g, '');

  const stopwords = new Set([
    '추천',
    '제품',
    '찾고',
    '있어요',
    '원해요',
    '신경',
    '같이',
    '함께',
    '그리고',
    '정도',
    '좋은',
    '어떤',
  ]);

  const domainKeywords = [
    '오메가3',
    'rtg',
    '알티지',
    '혈행',
    '눈건강',
    '눈',
    '관절',
    '유산균',
    '장건강',
    '밀크씨슬',
    '간건강',
    '다이어트',
    '체지방',
    '혈당',
    '피부',
    '두피',
    '모발',
  ];

  const intentLexicon = {
    혈행: ['오메가3', '알티지', 'rtg', '혈행'],
    눈: ['오메가3', '눈건강', '아스타잔틴', '루테인'],
    관절: ['관절', 'msm', '글루코사민'],
    장: ['유산균', '프로바이오틱스', '장건강'],
    간: ['밀크씨슬', '간건강'],
    다이어트: ['다이어트', '체지방', '혈당'],
    피부: ['앰플', '크림', '패드', '피부', '화이트'],
    두피: ['두피', '모발', '붕붕'],
  };

  const tokens = userText
    .toLowerCase()
    .split(/\s+/)
    .map((t) => normalize(stripKoreanParticle(t.trim())))
    .filter((t) => t.length >= 2 && !stopwords.has(t));

  const normalizedUserText = normalize(userText);
  const intentTokens = domainKeywords
    .map((k) => normalize(k))
    .filter((k) => normalizedUserText.includes(k));

  const expandedTokens = new Set(intentTokens.length ? intentTokens : tokens);
  Object.entries(intentLexicon).forEach(([k, arr]) => {
    if (userText.includes(k)) {
      arr.forEach((x) => expandedTokens.add(x));
    }
  });

  const scored = allProducts
    .map((p) => {
      const hay = `${p.name} ${p.summary}`.toLowerCase();
      const hayNorm = normalize(hay);
      let score = 0;
      [...expandedTokens].forEach((t) => {
        const tNorm = normalize(t);
        if (!tNorm) return;
        if (hay.includes(t.toLowerCase())) score += 2;
        if (hayNorm.includes(tNorm)) score += 1;
      });
      return { product: p, score };
    })
    .sort((a, b) => b.score - a.score);

  const positive = scored.filter((x) => x.score > 0).slice(0, max).map((x) => x.product);
  if (positive.length > 0) return positive;
  return allProducts.slice(0, max);
}

function buildContext(productsForPrompt) {
  return productsForPrompt
    .map(
      (p, idx) =>
        `${idx + 1}. [${p.product_no}] ${p.name}\n- 가격: ${p.price || '미확인'}\n- 요약: ${p.summary || '미확인'}\n- 링크: ${p.detail_url}`,
    )
    .join('\n\n');
}

function toMessageText(message) {
  const raw = message?.text ?? message?.content ?? '';
  return String(raw || '').trim();
}

function buildRecentConversation(messages, maxTurns = 10) {
  const cleaned = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, text: toMessageText(m) }))
    .filter((m) => m.text.length > 0);

  return cleaned.slice(-maxTurns);
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function estimateBodyMetrics({ heightCm, weightKg, age, gender, activityLevel }) {
  const h = toNumberOrNull(heightCm);
  const w = toNumberOrNull(weightKg);
  const a = toNumberOrNull(age);

  let bmi = null;
  if (h && w && h > 0) {
    bmi = Number((w / ((h / 100) * (h / 100))).toFixed(1));
  }

  let bmr = null;
  const isMale = gender === '남성';
  const isFemale = gender === '여성';
  if (h && w && a && (isMale || isFemale)) {
    bmr = Number((10 * w + 6.25 * h - 5 * a + (isMale ? 5 : -161)).toFixed(0));
  }

  const activityFactorMap = {
    '거의 앉아서 생활': 1.2,
    '가벼운 활동': 1.375,
    '중간 활동': 1.55,
    '높은 활동': 1.725,
  };
  const activityFactor = activityFactorMap[activityLevel] || null;
  let tdee = null;
  if (bmr && activityFactor) {
    tdee = Number((bmr * activityFactor).toFixed(0));
  }

  return { bmi, bmr, tdee, activityFactor };
}

async function validateAnalyzerImage({ imageBase64, mimeType, expectedType }) {
  if (!openai) {
    return {
      isValid: false,
      reason: 'OpenAI API 키가 없어 이미지 유형 검증을 수행할 수 없습니다.',
      confidence: 0,
    };
  }

  const modeText =
    expectedType === 'body'
      ? '전신(머리부터 발끝까지 대부분이 보이는 단일 인물)'
      : '정면 얼굴(얼굴 중심, 피부 상태 확인 가능한 해상도)';

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: 'system',
        content:
          '너는 이미지 적합성 검증기다. 분석 목적에 맞는 사진인지 엄격히 판단하고 JSON만 반환한다.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `요구 유형: ${modeText}`,
              '판단 규칙:',
              '- 조건 미달이면 무조건 isValid=false',
              '- 애매하면 isValid=false',
              '- 풍경/음식/사물/텍스트 이미지면 false',
              '- reason은 한국어로 짧고 구체적으로',
            ].join('\n'),
          },
          {
            type: 'input_image',
            image_url: `data:${mimeType};base64,${imageBase64}`,
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'image_validation_result',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            isValid: { type: 'boolean' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
          },
          required: ['isValid', 'confidence', 'reason'],
        },
      },
    },
    temperature: 0,
  });

  const parsed = JSON.parse(response.output_text || '{}');
  return {
    isValid: Boolean(parsed.isValid),
    confidence: Number(parsed.confidence || 0),
    reason: String(parsed.reason || '이미지 판별에 실패했습니다.'),
  };
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    openaiEnabled: Boolean(openai),
    productCount: products.length,
    model: OPENAI_MODEL,
  });
});

app.get('/api/products', (req, res) => {
  res.json({ count: products.length, products });
});

app.post('/api/crawl', async (req, res) => {
  try {
    const crawled = await crawlBucketgramProducts();
    products = crawled;
    saveProducts(products);
    res.json({ ok: true, productCount: products.length });
  } catch (err) {
    res.status(500).json({ error: `크롤링 실패: ${err.message}` });
  }
});

app.post('/api/chat', upload.single('image'), async (req, res) => {
  try {
    const parsedMessages =
      typeof req.body.messages === 'string' ? JSON.parse(req.body.messages) : req.body.messages;
    const messages = Array.isArray(parsedMessages) ? parsedMessages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const rawUserText = req.body.userText ?? lastUser?.text ?? lastUser?.content ?? '';
    const userText = String(rawUserText || '').trim();
    const hasImage = Boolean(req.file?.buffer?.length);

    if (!userText && !hasImage) {
      return res.status(400).json({ error: '사용자 메시지가 필요합니다.' });
    }

    const recentConversation = buildRecentConversation(messages, 10);
    const historyWithoutLatestUser =
      recentConversation.length > 0 && recentConversation[recentConversation.length - 1].role === 'user'
        ? recentConversation.slice(0, -1)
        : recentConversation;
    const recentUserHints = historyWithoutLatestUser
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.text);
    const retrievalQuery = [...recentUserHints, userText].filter(Boolean).join(' ');

    const relevant = selectRelevantProducts(retrievalQuery, products, 8);
    const context = buildContext(relevant);

    if (!openai) {
      const fallback = [
        '현재 OpenAI API 키가 설정되지 않아 규칙 기반 안내로 답변합니다.',
        '아래 제품을 먼저 검토해보세요:',
        ...relevant.map((p) => `- ${p.name} (${p.detail_url})`),
      ].join('\n');

      return res.json({
        answer: hasImage
          ? `${fallback}\n\n참고: 이미지 첨부는 OpenAI 연결 시에만 분석됩니다.`
          : fallback,
        sources: relevant.map((p) => ({ product_no: p.product_no, name: p.name, url: p.detail_url })),
      });
    }

    const systemPrompt = [
      '너는 버킷그램 구매 상담 도우미다.',
      '반드시 한국어로 답한다.',
      '의료 진단처럼 단정하지 말고, 일반적인 제품 선택 가이드를 제공한다.',
      '답변 형식: 1) 핵심 요약 2) 추천 후보 2~3개 3) 선택 기준 4) 주의사항.',
      '근거 없는 정보는 만들지 말고, 제공된 상품 컨텍스트 범위에서만 답한다.',
      '',
      '[상품 컨텍스트]',
      context || '현재 상품 데이터 없음',
      '',
      hasImage
        ? '첨부 이미지가 있으면 제품/패키지/성분표로 보이는 요소를 참고하되, 보이지 않는 정보는 추정하지 않는다.'
        : '',
    ].join('\n');

    const userContents = [
      {
        type: 'input_text',
        text: userText || '첨부 이미지를 바탕으로 상담해주세요.',
      },
    ];

    if (hasImage) {
      const imageBase64 = req.file.buffer.toString('base64');
      const mimeType = req.file.mimetype || 'image/jpeg';
      userContents.push({
        type: 'input_image',
        image_url: `data:${mimeType};base64,${imageBase64}`,
      });
    }

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        ...historyWithoutLatestUser.map((m) => ({
          role: m.role,
          content: m.text,
        })),
        { role: 'user', content: userContents },
      ],
      temperature: 0.4,
    });

    const answer = response.output_text || '답변 생성에 실패했습니다.';
    return res.json({
      answer,
      sources: relevant.map((p) => ({ product_no: p.product_no, name: p.name, url: p.detail_url })),
    });
  } catch (err) {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '이미지 파일은 5MB 이하만 업로드할 수 있습니다.' });
    }
    return res.status(500).json({ error: `상담 응답 실패: ${err.message}` });
  }
});

app.post('/api/body-analyze', upload.single('image'), async (req, res) => {
  try {
    const hasImage = Boolean(req.file?.buffer?.length);
    if (!hasImage) {
      return res.status(400).json({ error: '체형 분석용 이미지를 업로드해주세요.' });
    }

    if (!openai) {
      return res.status(400).json({ error: 'OpenAI API 키가 설정되어야 체형 분석을 사용할 수 있습니다.' });
    }

    const heightCm = String(req.body.heightCm || '').trim();
    const weightKg = String(req.body.weightKg || '').trim();
    const age = String(req.body.age || '').trim();
    const gender = String(req.body.gender || '').trim();
    const activityLevel = String(req.body.activityLevel || '').trim();
    const painPoints = String(req.body.painPoints || '').trim();
    const goal = String(req.body.goal || '').trim();
    const metrics = estimateBodyMetrics({ heightCm, weightKg, age, gender, activityLevel });

    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const imageValidation = await validateAnalyzerImage({
      imageBase64,
      mimeType,
      expectedType: 'body',
    });
    if (!imageValidation.isValid || imageValidation.confidence < 0.7) {
      return res.status(400).json({
        error: `체형 분석용 사진에 전신사진을 올리지 않았습니다. 다시 제대로 된 사진을 넣고 다시 해주세요. (판별 사유: ${imageValidation.reason})`,
      });
    }

    const systemPrompt = [
      '너는 체형 분석 코치다.',
      '반드시 한국어로 답한다.',
      '의료 진단이나 질병 판단은 하지 않는다.',
      '사진에서 명확히 보이는 정보만 말하고, 확신이 낮으면 "추정"이라고 표현한다.',
      '각 분석 항목에는 근거(이미지 근거/입력값 근거)와 신뢰도(높음/중간/낮음)를 붙인다.',
      '답변은 반드시 아래 형식을 지킨다:',
      '1) 핵심 프로필 요약(BMI/BMR/TDEE 포함)',
      '2) 자세/정렬 분석(목-어깨-골반-무릎-발 정렬을 항목별로)',
      '3) 체형 리스크 우선순위 TOP3(왜 우선인지)',
      '4) 4주 교정 플랜(주차별 목표, 주간 루틴, 세트/횟수/강도)',
      '5) 식단/영양 전략(권장 칼로리 범위, 단백질/탄수/지방 가이드)',
      '6) 체크포인트(2주/4주 측정 지표와 목표치)',
      '7) 주의사항(금기/통증 대응/전문가 상담 필요 시점)',
      '외모 비하 표현, 단정적 평가를 금지한다.',
    ].join('\n');

    const userText = [
      '아래 정보와 첨부 이미지를 바탕으로 체형 분석 가이드를 작성해줘.',
      `- 키(cm): ${heightCm || '미입력'}`,
      `- 몸무게(kg): ${weightKg || '미입력'}`,
      `- 나이: ${age || '미입력'}`,
      `- 성별: ${gender || '미입력'}`,
      `- 활동량: ${activityLevel || '미입력'}`,
      `- 불편/통증 부위: ${painPoints || '미입력'}`,
      `- 목표: ${goal || '미입력'}`,
      '',
      '[계산 참고값]',
      `- BMI: ${metrics.bmi ?? '계산불가'}`,
      `- BMR(kcal): ${metrics.bmr ?? '계산불가'}`,
      `- TDEE(kcal): ${metrics.tdee ?? '계산불가'}`,
      '',
      '요청: 전문 코치 리포트처럼 디테일하고 실천 가능한 계획으로 작성해줘.',
      '추가 요청: 관찰이 어려운 항목은 솔직히 한계를 말하고, 대체 체크 방법을 제시해줘.',
    ].join('\n');

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: userText },
            { type: 'input_image', image_url: `data:${mimeType};base64,${imageBase64}` },
          ],
        },
      ],
      temperature: 0.3,
    });

    const analysis = response.output_text || '체형 분석 결과를 생성하지 못했습니다.';
    return res.json({ analysis });
  } catch (err) {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '이미지 파일은 5MB 이하만 업로드할 수 있습니다.' });
    }
    return res.status(500).json({ error: `체형 분석 실패: ${err.message}` });
  }
});

app.post('/api/skin-analyze', upload.single('image'), async (req, res) => {
  try {
    const hasImage = Boolean(req.file?.buffer?.length);
    if (!hasImage) {
      return res.status(400).json({ error: '피부 분석용 얼굴 이미지를 업로드해주세요.' });
    }

    if (!openai) {
      return res.status(400).json({ error: 'OpenAI API 키가 설정되어야 피부 분석을 사용할 수 있습니다.' });
    }

    const age = String(req.body.age || '').trim();
    const skinType = String(req.body.skinType || '').trim();
    const concerns = String(req.body.concerns || '').trim();
    const currentRoutine = String(req.body.currentRoutine || '').trim();

    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const imageValidation = await validateAnalyzerImage({
      imageBase64,
      mimeType,
      expectedType: 'face',
    });
    if (!imageValidation.isValid || imageValidation.confidence < 0.7) {
      return res.status(400).json({
        error: `피부 분석용 사진에 얼굴사진을 올리지 않았습니다. 다시 제대로 된 사진을 넣고 다시 해주세요. (판별 사유: ${imageValidation.reason})`,
      });
    }

    const systemPrompt = [
      '너는 피부 분석 코치다.',
      '반드시 한국어로 답한다.',
      '의료 진단, 질병 단정, 치료 처방은 하지 않는다.',
      '사진에서 확인 가능한 정보와 사용자 입력을 구분해서 설명한다.',
      '확실하지 않은 부분은 반드시 추정이라고 표시한다.',
      '답변 형식: 1) 피부 요약 2) 관찰 포인트 3) 문제 우선순위 4) 아침/저녁 루틴 5) 주간 관리 6) 주의사항.',
      '외모 비하, 자극적인 표현을 금지한다.',
    ].join('\n');

    const userText = [
      '아래 정보와 얼굴 사진을 바탕으로 피부 상태를 분석해줘.',
      `- 나이: ${age || '미입력'}`,
      `- 사용자 인지 피부타입: ${skinType || '미입력'}`,
      `- 주요 고민: ${concerns || '미입력'}`,
      `- 현재 루틴: ${currentRoutine || '미입력'}`,
      '',
      '요청:',
      '- 수분/유분 밸런스, 모공, 톤 균일도, 민감도 징후를 관찰 기준으로 설명',
      '- 아침/저녁 루틴을 단계별로 구체화',
      '- 성분 카테고리(예: 나이아신아마이드, 세라마이드 등) 중심으로 추천',
      '- 2주/4주 체크포인트를 제시',
    ].join('\n');

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: userText },
            { type: 'input_image', image_url: `data:${mimeType};base64,${imageBase64}` },
          ],
        },
      ],
      temperature: 0.3,
    });

    const analysis = response.output_text || '피부 분석 결과를 생성하지 못했습니다.';
    return res.json({ analysis });
  } catch (err) {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '이미지 파일은 4MB 이하만 업로드할 수 있습니다.' });
    }
    return res.status(500).json({ error: `피부 분석 실패: ${err.message}` });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function runCrawlOnlyMode() {
  const result = await crawlBucketgramProducts();
  products = result;
  saveProducts(products);
  console.log(`crawl 완료: ${products.length}개 상품 인덱싱`);
}

if (process.argv.includes('--crawl-only')) {
  runCrawlOnlyMode().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`server started: http://localhost:${PORT}`);
    console.log(`openai enabled: ${Boolean(openai)}`);
    console.log(`products loaded: ${products.length}`);
  });
}

module.exports = app;
