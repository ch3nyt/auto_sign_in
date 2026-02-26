// ──────────────────────────────────────────────
// 工具：等待 DOM 元素出現（MutationObserver + timeout）
// ──────────────────────────────────────────────
function waitForElement(selector, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`等待元素超時：${selector}`));
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ──────────────────────────────────────────────
// 工具：等待頁面 URL 改變（代表成功登入跳轉）
// ──────────────────────────────────────────────
function waitForUrlChange(originalUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(check);
      reject(new Error('等待頁面跳轉超時'));
    }, timeoutMs);

    const check = setInterval(() => {
      if (window.location.href !== originalUrl) {
        clearTimeout(timer);
        clearInterval(check);
        resolve(window.location.href);
      }
    }, 300);
  });
}

// ──────────────────────────────────────────────
// 工具：同時等待兩個 selector，取先出現者
// 若 timeoutMs 內都未出現則 resolve(null)（不 reject）
// ──────────────────────────────────────────────
function waitForEither(selector1, selector2, timeoutMs = 12000) {
  return new Promise(resolve => {
    // 立即先查一次
    const immediate1 = document.querySelector(selector1);
    if (immediate1) return resolve({ which: 1, el: immediate1 });
    const immediate2 = document.querySelector(selector2);
    if (immediate2) return resolve({ which: 2, el: immediate2 });

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      resolve(result);
    };

    const timer = setTimeout(() => done(null), timeoutMs);

    const observer = new MutationObserver(() => {
      const el1 = document.querySelector(selector1);
      if (el1) return done({ which: 1, el: el1 });
      const el2 = document.querySelector(selector2);
      if (el2) return done({ which: 2, el: el2 });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ──────────────────────────────────────────────
// 工具：短暫延遲（ms）
// ──────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────
// 偵測是否有「我要簽到」或「我要簽退」按鈕
// ──────────────────────────────────────────────
function findActionButton(action) {
  const title = action === 'sign-in' ? '我要簽到' : '我要簽退';
  return document.querySelector(`span.clip_text[title="${title}"]`);
}

// ──────────────────────────────────────────────
// 偵測登入失敗訊息
// ──────────────────────────────────────────────
function detectLoginError() {
  const body = document.body.innerText || '';
  if (body.includes('帳號或密碼錯誤') || body.includes('登入失敗') || body.includes('密碼錯誤')) {
    return true;
  }
  return false;
}

// ──────────────────────────────────────────────
// 登入流程（填帳密 → 點送出 → 等待跳轉）
// ──────────────────────────────────────────────
async function doLogin(uid, password, title) {
  console.log('[content] 進入登入流程...');

  // 等待登入表單（可能因跳轉而稍慢出現）
  let uidInput, keyInput;
  try {
    uidInput = await waitForElement('#UID', 10000);
    keyInput = await waitForElement('#KEY', 5000);
  } catch (e) {
    throw new Error('等待登入表單超時，頁面可能異常');
  }

  // 模擬使用者輸入（觸發框架的 input/change 事件）
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

  nativeSetter.call(uidInput, uid);
  uidInput.dispatchEvent(new Event('input', { bubbles: true }));
  uidInput.dispatchEvent(new Event('change', { bubbles: true }));

  nativeSetter.call(keyInput, password);
  keyInput.dispatchEvent(new Event('input', { bubbles: true }));
  keyInput.dispatchEvent(new Event('change', { bubbles: true }));

  await sleep(500);

  // 找登入按鈕
  let loginBtn =
    document.querySelector('button[type="submit"]') ||
    document.querySelector('input[type="submit"]') ||
    document.querySelector('.cxl-btn[type="submit"]') ||
    document.querySelector('button.cxl-btn');

  if (!loginBtn) {
    const allBtns = document.querySelectorAll('button, input[type="button"], input[type="submit"]');
    for (const btn of allBtns) {
      if ((btn.textContent || btn.value || '').includes('登入')) {
        loginBtn = btn;
        break;
      }
    }
  }

  if (!loginBtn) {
    throw new Error('找不到登入按鈕，請確認頁面結構');
  }

  const originalUrl = window.location.href;
  loginBtn.click();
  console.log('[content] 已點擊登入按鈕，等待頁面跳轉...');

  // 等待 URL 改變或打卡按鈕直接出現
  try {
    await Promise.race([
      waitForUrlChange(originalUrl, 15000),
      waitForElement(`span.clip_text[title="${title}"]`, 15000),
    ]);
  } catch (e) {
    if (detectLoginError()) throw new Error('帳號或密碼錯誤，登入失敗');
    throw new Error('登入後等待頁面超時');
  }

  await sleep(1000);

  if (detectLoginError()) throw new Error('帳號或密碼錯誤，登入失敗');
}

// ──────────────────────────────────────────────
// 主要自動化流程
// ──────────────────────────────────────────────
async function performSignAction(action, uid, password) {
  const title = action === 'sign-in' ? '我要簽到' : '我要簽退';
  const actionSelector = `span.clip_text[title="${title}"]`;

  // 步驟 1：等待頁面穩定（含可能的跳轉延遲）
  await sleep(1500);

  // 步驟 2：同時偵測「打卡按鈕」或「登入表單」，取先出現者
  // 若目標網頁跳轉至登入頁，登入表單會在跳轉完成後出現，此處持續等待不報錯
  console.log('[content] 偵測頁面狀態（打卡按鈕 或 登入表單）...');
  const found = await waitForEither(actionSelector, '#UID', 12000);

  if (found && found.which === 1) {
    // 已登入，直接點擊打卡按鈕
    console.log(`[content] 已登入，找到「${title}」按鈕，準備點擊...`);
    found.el.click();
  } else {
    // 未登入（found.which === 2）或等待超時（found === null）皆嘗試登入流程
    if (!found) {
      console.log('[content] 未偵測到明確狀態，嘗試執行登入流程...');
    } else {
      console.log('[content] 偵測到登入表單，執行登入...');
    }

    await doLogin(uid, password, title);

    // 登入後找打卡按鈕
    let actionBtn;
    try {
      actionBtn = await waitForElement(actionSelector, 10000);
    } catch (e) {
      throw new Error(`登入後仍找不到「${title}」按鈕`);
    }

    console.log(`[content] 找到「${title}」按鈕，準備點擊...`);
    actionBtn.click();
  }

  // 步驟 3：給 SPA 時間更新狀態
  await sleep(1500);
  console.log(`[content] 「${title}」操作完成。`);
}

// ──────────────────────────────────────────────
// cathaylife 登入頁：填帳密並點擊「密碼登入」
// 必須在頁面 unload 前回傳 response，因此先 sendResponse 再 click
// ──────────────────────────────────────────────
async function doLoginOnCathayPage(uid, password, sendResponse) {
  try {
    const uidInput = await waitForElement('#UID', 8000);
    const keyInput = await waitForElement('#KEY', 5000);

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

    nativeSetter.call(uidInput, uid);
    uidInput.dispatchEvent(new Event('input', { bubbles: true }));
    uidInput.dispatchEvent(new Event('change', { bubbles: true }));

    nativeSetter.call(keyInput, password);
    keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    keyInput.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(500);

    // 優先找 cathaylife 頁面的「密碼登入」按鈕
    const loginBtn =
      document.querySelector('#btnLogin') ||
      document.querySelector('button[type="button"].cxl-btn') ||
      document.querySelector('button[type="submit"]') ||
      document.querySelector('button.cxl-btn');

    if (!loginBtn) throw new Error('找不到「密碼登入」按鈕（#btnLogin）');

    // 先回傳 response，確保頁面跳轉前 background 已收到訊息
    sendResponse({ ok: true });
    loginBtn.click();
    console.log('[content] 已點擊「密碼登入」，等待跳轉回打卡頁...');
  } catch (err) {
    console.error('[content] do-login 失敗：', err.message);
    sendResponse({ ok: false, error: err.message });
  }
}

// ──────────────────────────────────────────────
// 監聽來自 background 的指令
// ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'do-login') {
    // 用於 cathaylife 跨 domain 登入頁（background 偵測到後注入）
    doLoginOnCathayPage(message.uid, message.password, sendResponse);
    return true; // 非同步回應
  }

  if (message.type === 'perform-action') {
    const { action, uid, password } = message;
    performSignAction(action, uid, password)
      .then(() => {
        chrome.runtime.sendMessage({ type: 'action-result', success: true });
      })
      .catch(err => {
        console.error('[content] 操作失敗：', err.message);
        chrome.runtime.sendMessage({ type: 'action-result', success: false, error: err.message });
      });
  }
});
