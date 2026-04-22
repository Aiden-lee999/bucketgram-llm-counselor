const chatLog = document.getElementById('chat-log');
const form = document.getElementById('chat-form');
const input = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const crawlBtn = document.getElementById('crawl-btn');
const attachBtn = document.getElementById('attach-btn');
const imageInput = document.getElementById('image-input');
const attachmentPreview = document.getElementById('attachment-preview');
const newChatBtn = document.getElementById('new-chat-btn');
const bodyImageInput = document.getElementById('body-image-input');
const bodyImagePreview = document.getElementById('body-image-preview');
const bodyUploadBtn = document.getElementById('body-upload-btn');
const bodyAnalyzeBtn = document.getElementById('body-analyze-btn');
const bodyHeight = document.getElementById('body-height');
const bodyWeight = document.getElementById('body-weight');
const bodyAge = document.getElementById('body-age');
const bodyGender = document.getElementById('body-gender');
const bodyActivity = document.getElementById('body-activity');
const bodyPain = document.getElementById('body-pain');
const bodyGoal = document.getElementById('body-goal');

const STORAGE_KEY = 'bucketgram.chat.messages.v1';
const DEFAULT_ASSISTANT_MESSAGE =
  '안녕하세요. 버킷그램 구매 상담 도우미입니다. 고민/예산/선호 제형을 알려주시면 제품 후보를 정리해드릴게요.';

let attachedImageFile = null;
let bodyImageFile = null;
let isPending = false;

const messages = [];

function getDefaultMessages() {
  return [{ role: 'assistant', text: DEFAULT_ASSISTANT_MESSAGE }];
}

function loadMessagesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultMessages();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return getDefaultMessages();

    const sanitized = parsed
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, text: String(m.text || '').trim() }))
      .filter((m) => m.text.length > 0);

    return sanitized.length ? sanitized : getDefaultMessages();
  } catch {
    return getDefaultMessages();
  }
}

function saveMessagesToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
}

function renderMessage(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role === 'user' ? 'user' : 'bot'}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function syncView() {
  chatLog.innerHTML = '';
  messages.forEach((m) => renderMessage(m.role, m.text));
  if (isPending) {
    renderMessage('assistant', '생각 중...');
  }
  saveMessagesToStorage();
}

async function refreshMeta() {
  // 상태 노출이 필요 없어서 메타 정보는 가져오지 않습니다.
}

async function sendMessage(text) {
  sendBtn.disabled = true;
  attachBtn.disabled = true;
  newChatBtn.disabled = true;
  isPending = true;

  const previewLabel = attachedImageFile ? `\n[첨부 이미지: ${attachedImageFile.name}]` : '';
  messages.push({ role: 'user', text: `${text}${previewLabel}`.trim() });
  syncView();

  try {
    const formData = new FormData();
    formData.append('messages', JSON.stringify(messages));
    formData.append('userText', text);
    if (attachedImageFile) {
      formData.append('image', attachedImageFile);
    }

    const res = await fetch('/api/chat', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || '요청 실패');
    }

    messages.push({ role: 'assistant', text: data.answer || '답변을 생성하지 못했습니다.' });
    syncView();
  } catch (err) {
    messages.push({ role: 'assistant', text: `오류: ${err.message}` });
    syncView();
  } finally {
    isPending = false;
    attachedImageFile = null;
    imageInput.value = '';
    attachmentPreview.innerHTML = '';
    attachmentPreview.classList.add('hidden');
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    newChatBtn.disabled = false;
    syncView();
  }
}

async function analyzeBodyType() {
  if (!bodyImageFile) {
    messages.push({ role: 'assistant', text: '체형 분석을 위해 전신 사진 1장을 먼저 선택해주세요.' });
    syncView();
    return;
  }

  bodyAnalyzeBtn.disabled = true;
  bodyUploadBtn.disabled = true;
  isPending = true;

  const descriptor = [
    `키: ${bodyHeight.value || '미입력'}cm`,
    `몸무게: ${bodyWeight.value || '미입력'}kg`,
    `나이: ${bodyAge.value || '미입력'}`,
    `성별: ${bodyGender.value || '미입력'}`,
    `활동량: ${bodyActivity.value || '미입력'}`,
    `불편부위: ${bodyPain.value || '미입력'}`,
    `목표: ${bodyGoal.value || '미입력'}`,
  ].join(', ');

  messages.push({ role: 'user', text: `[AI 체형분석 요청] ${descriptor}` });
  syncView();

  try {
    const formData = new FormData();
    formData.append('image', bodyImageFile);
    formData.append('heightCm', bodyHeight.value || '');
    formData.append('weightKg', bodyWeight.value || '');
    formData.append('age', bodyAge.value || '');
    formData.append('gender', bodyGender.value || '');
    formData.append('activityLevel', bodyActivity.value || '');
    formData.append('painPoints', bodyPain.value || '');
    formData.append('goal', bodyGoal.value || '');

    const res = await fetch('/api/body-analyze', {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || '체형 분석 요청 실패');
    }

    messages.push({ role: 'assistant', text: data.analysis || '체형 분석 결과를 생성하지 못했습니다.' });
    syncView();
  } catch (err) {
    messages.push({ role: 'assistant', text: `체형 분석 오류: ${err.message}` });
    syncView();
  } finally {
    isPending = false;
    bodyAnalyzeBtn.disabled = false;
    bodyUploadBtn.disabled = false;
    syncView();
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && !attachedImageFile) return;
  input.value = '';
  input.style.height = '48px';
  await sendMessage(text);
});

attachBtn.addEventListener('click', () => {
  imageInput.click();
});

imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    attachmentPreview.innerHTML = '<span>이미지 파일만 첨부할 수 있습니다.</span>';
    attachmentPreview.classList.remove('hidden');
    imageInput.value = '';
    attachedImageFile = null;
    return;
  }

  attachedImageFile = file;
  const safeName = file.name.replace(/[<>]/g, '');
  const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
  attachmentPreview.innerHTML = `<span>${safeName} (${sizeMB}MB)</span><button type="button" id="remove-image-btn" class="remove-image-btn">삭제</button>`;
  attachmentPreview.classList.remove('hidden');

  const removeBtn = document.getElementById('remove-image-btn');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      attachedImageFile = null;
      imageInput.value = '';
      attachmentPreview.innerHTML = '';
      attachmentPreview.classList.add('hidden');
    });
  }
});

bodyUploadBtn.addEventListener('click', () => {
  bodyImageInput.click();
});

bodyImageInput.addEventListener('change', () => {
  const file = bodyImageInput.files?.[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    bodyImagePreview.innerHTML = '<span>이미지 파일만 첨부할 수 있습니다.</span>';
    bodyImagePreview.classList.remove('hidden');
    bodyImageInput.value = '';
    bodyImageFile = null;
    return;
  }

  bodyImageFile = file;
  const safeName = file.name.replace(/[<>]/g, '');
  const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
  bodyImagePreview.innerHTML = `<span>${safeName} (${sizeMB}MB)</span><button type="button" id="remove-body-image-btn" class="remove-image-btn">삭제</button>`;
  bodyImagePreview.classList.remove('hidden');

  const removeBtn = document.getElementById('remove-body-image-btn');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      bodyImageFile = null;
      bodyImageInput.value = '';
      bodyImagePreview.innerHTML = '';
      bodyImagePreview.classList.add('hidden');
    });
  }
});

bodyAnalyzeBtn.addEventListener('click', analyzeBodyType);

input.addEventListener('input', () => {
  input.style.height = '48px';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
});

crawlBtn.addEventListener('click', async () => {
  crawlBtn.disabled = true;
  crawlBtn.textContent = '수집 중...';
  try {
    const res = await fetch('/api/crawl', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '크롤링 실패');
    messages.push({
      role: 'assistant',
      text: `버킷그램 데이터 수집 완료: 실제 상품 ${data.productCount}개를 인덱싱했습니다.`,
    });
    syncView();
    await refreshMeta();
  } catch (err) {
    messages.push({ role: 'assistant', text: `크롤링 오류: ${err.message}` });
    syncView();
  } finally {
    crawlBtn.disabled = false;
    crawlBtn.textContent = '버킷그램 데이터 새로 수집';
  }
});

newChatBtn.addEventListener('click', () => {
  messages.length = 0;
  getDefaultMessages().forEach((m) => messages.push(m));
  attachedImageFile = null;
  imageInput.value = '';
  attachmentPreview.innerHTML = '';
  attachmentPreview.classList.add('hidden');
  input.value = '';
  input.style.height = '48px';
  syncView();
});

loadMessagesFromStorage().forEach((m) => messages.push(m));

syncView();
refreshMeta();
