const TARGET_URL = 'https://go.linyuan.com.tw/FKWeb/servlet/HttpDispatcher/FKZ5_3000/prompt';

// day string → JS getDay() 對應（0=日, 1=一, ..., 6=六）
const DAY_MAP = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5 };
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

// ──────────────────────────────────────────────
// 計算下一次觸發的 timestamp（ms）
// ──────────────────────────────────────────────
function nextTriggerMs(targetDayOfWeek, timeStr) {
  const [hh, mm] = timeStr.split(':').map(Number);
  const now = new Date();
  const result = new Date(now);
  result.setSeconds(0, 0);
  result.setHours(hh, mm, 0, 0);

  const currentDay = now.getDay(); // 0(日)~6(六)
  let daysUntil = (targetDayOfWeek - currentDay + 7) % 7;

  // 今天同一天但時間已過，推到下週
  if (daysUntil === 0 && result <= now) {
    daysUntil = 7;
  }

  result.setDate(result.getDate() + daysUntil);
  return result.getTime();
}

// ──────────────────────────────────────────────
// 重建所有 Alarms
// ──────────────────────────────────────────────
async function rebuildAlarms(settings) {
  // 清除所有舊 alarms
  await chrome.alarms.clearAll();

  if (!settings || !settings.schedule) return;

  const schedule = settings.schedule;
  for (const day of DAYS) {
    const dayNum = DAY_MAP[day];
    const daySetting = schedule[day] || {};

    if (daySetting.signIn) {
      const whenMs = nextTriggerMs(dayNum, daySetting.signIn);
      chrome.alarms.create(`sign-in-${day}`, {
        when: whenMs,
        periodInMinutes: 7 * 24 * 60, // 每週重複
      });
      console.log(`[Alarm] sign-in-${day} 設定於 ${new Date(whenMs).toLocaleString()}`);
    }

    if (daySetting.signOut) {
      const whenMs = nextTriggerMs(dayNum, daySetting.signOut);
      chrome.alarms.create(`sign-out-${day}`, {
        when: whenMs,
        periodInMinutes: 7 * 24 * 60,
      });
      console.log(`[Alarm] sign-out-${day} 設定於 ${new Date(whenMs).toLocaleString()}`);
    }
  }
}

// ──────────────────────────────────────────────
// 今日狀態管理
// ──────────────────────────────────────────────
function todayDateStr() {
  return new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
}

async function getToday() {
  const { today } = await chrome.storage.local.get('today');
  if (today && today.date === todayDateStr()) return today;
  // 新的一天，重置
  const fresh = {
    date: todayDateStr(),
    signIn: { done: false, timestamp: null, success: null, error: null, disabled: false },
    signOut: { done: false, timestamp: null, success: null, error: null, disabled: false },
  };
  await chrome.storage.local.set({ today: fresh });
  return fresh;
}

async function markTodayDone(action, success, error = null) {
  const today = await getToday();
  const key = action === 'sign-in' ? 'signIn' : 'signOut';
  today[key] = {
    done: true,
    timestamp: Date.now(),
    success,
    error: error || null,
    disabled: false,
  };
  await chrome.storage.local.set({ today });
}

// ──────────────────────────────────────────────
// 等待 Tab 完成載入
// ──────────────────────────────────────────────
function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab 載入超時'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ──────────────────────────────────────────────
// 判斷是否落在 cathaylife 登入頁
// ──────────────────────────────────────────────
function isLoginUrl(url) {
  return url && url.includes('w3.cathaylife.com.tw');
}

// ──────────────────────────────────────────────
// 等待 Tab 載入指定 domain 並 complete
// ──────────────────────────────────────────────
function waitForTabToLoadDomain(tabId, domain, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`等待跳轉至 ${domain} 超時（可能帳密錯誤）`));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo, tab) {
      if (
        updatedTabId === tabId &&
        changeInfo.status === 'complete' &&
        tab.url &&
        tab.url.includes(domain)
      ) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab.url);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ──────────────────────────────────────────────
// 送出 do-login 指令並等待 content script 回應
// ──────────────────────────────────────────────
function sendDoLogin(tabId, uid, password) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('do-login 指令回應超時')),
      15000
    );
    chrome.tabs.sendMessage(tabId, { type: 'do-login', uid, password }, response => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && !response.ok) {
        reject(new Error(response.error || '登入填表失敗'));
      } else {
        resolve();
      }
    });
  });
}

// ──────────────────────────────────────────────
// 注入 content.js 並等待打卡結果
// ──────────────────────────────────────────────
async function injectAndRun(tab, action, uid, password) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js'],
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Content script 回應超時（30s）'));
    }, 30000);

    function listener(message, sender) {
      if (sender.tab && sender.tab.id === tab.id && message.type === 'action-result') {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message);
      }
    }

    chrome.runtime.onMessage.addListener(listener);

    // 傳送指令給 content script
    chrome.tabs.sendMessage(tab.id, { type: 'perform-action', action, uid, password });
  });
}

// ──────────────────────────────────────────────
// 執行自動化動作
// ──────────────────────────────────────────────
async function performAction(action, force = false) {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings || !settings.uid || !settings.password) {
    console.warn(`[${action}] 帳號密碼未設定，跳過。`);
    await markTodayDone(action, false, '帳號密碼未設定');
    return;
  }

  const today = await getToday();
  const key = action === 'sign-in' ? 'signIn' : 'signOut';
  if (!force && today[key].done) {
    console.log(`[${action}] 今日已完成，跳過。`);
    return;
  }

  console.log(`[${action}] 開始執行...`);

  let tab;
  try {
    tab = await chrome.tabs.create({ url: TARGET_URL, active: false });
    await waitForTabComplete(tab.id);

    // 偵測是否被導向 cathaylife 登入頁（跨 domain）
    const tabInfo = await chrome.tabs.get(tab.id);
    if (isLoginUrl(tabInfo.url)) {
      console.log(`[${action}] 偵測到 cathaylife 登入頁，執行兩段式登入...`);

      // 第一段：注入 content.js 到登入頁，填表並點擊登入
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      await sendDoLogin(tab.id, settings.uid, settings.password);

      // 第二段：等待 tab 跳回 go.linyuan.com.tw 並完成載入
      await waitForTabToLoadDomain(tab.id, 'go.linyuan.com.tw', 25000);

      // 第三段：強制導向打卡頁，避免 SSO 跳回主頁而非目標頁
      await chrome.tabs.update(tab.id, { url: TARGET_URL });
      await waitForTabComplete(tab.id, 15000);
      // SPA 渲染穩定
      await new Promise(r => setTimeout(r, 1500));
    }

    // 注入 content.js 到打卡頁並執行動作
    const result = await injectAndRun(tab, action, settings.uid, settings.password);

    if (result.success) {
      console.log(`[${action}] 成功！`);
      await markTodayDone(action, true);
      chrome.notifications.create(`notif-${action}-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icon128.png',
        title: action === 'sign-in' ? '✅ 上班簽到成功' : '✅ 下班簽退成功',
        message: `已於 ${new Date().toLocaleTimeString()} 自動完成打卡。`,
      });
    } else {
      throw new Error(result.error || '未知錯誤');
    }
  } catch (err) {
    console.error(`[${action}] 失敗：`, err.message);
    await markTodayDone(action, false, err.message);
    chrome.notifications.create(`notif-${action}-err-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: action === 'sign-in' ? '❌ 上班簽到失敗' : '❌ 下班簽退失敗',
      message: err.message,
    });
  }
}

// ──────────────────────────────────────────────
// 初始化：安裝 / 啟動時建立 alarms
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// 午夜自動重置 Alarm（每日 00:00）
// ──────────────────────────────────────────────
function createMidnightAlarm() {
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0); // 次日 00:00:00
  chrome.alarms.create('daily-reset', {
    when: midnight.getTime(),
    periodInMinutes: 24 * 60,
  });
}

async function initialize() {
  const { settings } = await chrome.storage.local.get('settings');
  await rebuildAlarms(settings || null);
  createMidnightAlarm();

  // 確保今日狀態存在（若跨日則重置）
  await getToday();
}

chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);

// ──────────────────────────────────────────────
// 監聽 Alarm 觸發
// ──────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  const name = alarm.name; // e.g. "sign-in-mon", "sign-out-fri", "daily-reset"
  if (name.startsWith('sign-in-')) {
    await performAction('sign-in');
  } else if (name.startsWith('sign-out-')) {
    await performAction('sign-out');
  } else if (name === 'daily-reset') {
    const fresh = {
      date: todayDateStr(),
      signIn: { done: false, timestamp: null, success: null, error: null },
      signOut: { done: false, timestamp: null, success: null, error: null },
    };
    await chrome.storage.local.set({ today: fresh });
    console.log('[daily-reset] 今日打卡狀態已重置');
  }
});

// ──────────────────────────────────────────────
// 監聽 Popup 訊息
// ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'save-settings') {
    // 儲存設定後重建 alarms
    rebuildAlarms(message.settings).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'force-perform') {
    // 手動立即執行，忽略今日已完成的狀態
    performAction(message.action, true);
    sendResponse({ ok: true });
  }
});
