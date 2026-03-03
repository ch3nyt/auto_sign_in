const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

// ──────────────────────────────────────────────
// 讀取並套用已儲存設定
// ──────────────────────────────────────────────
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) return;

  if (settings.uid) document.getElementById('uid').value = settings.uid;
  if (settings.password) document.getElementById('password').value = settings.password;

  const schedule = settings.schedule || {};
  for (const day of DAYS) {
    const daySetting = schedule[day] || {};

    const signInTime = daySetting.signIn;
    const signOutTime = daySetting.signOut;

    const signInInput = document.getElementById(`sign-in-${day}`);
    const signOutInput = document.getElementById(`sign-out-${day}`);
    const signInCheck = document.querySelector(`.skip-check[data-day="${day}"][data-type="signIn"]`);
    const signOutCheck = document.querySelector(`.skip-check[data-day="${day}"][data-type="signOut"]`);

    if (signInTime === null || signInTime === undefined) {
      signInCheck.checked = true;
      signInInput.disabled = true;
    } else {
      signInInput.value = signInTime;
    }

    if (signOutTime === null || signOutTime === undefined) {
      signOutCheck.checked = true;
      signOutInput.disabled = true;
    } else {
      signOutInput.value = signOutTime;
    }
  }
}

// ──────────────────────────────────────────────
// 日期工具
// ──────────────────────────────────────────────
function todayDateStr() {
  return new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
}

// ──────────────────────────────────────────────
// 讀取並顯示今日狀態
// ──────────────────────────────────────────────
async function loadTodayStatus() {
  const { today } = await chrome.storage.local.get('today');
  // 如果儲存的是昨天（或更早）的資料，視為空白
  const valid = today && today.date === todayDateStr() ? today : null;
  updateStatusUI(valid);
}

function updateStatusUI(today) {
  const signInEl = document.getElementById('status-sign-in');
  const signOutEl = document.getElementById('status-sign-out');
  const dateEl = document.getElementById('status-date');

  if (dateEl) {
    dateEl.textContent = today ? today.date : todayDateStr();
  }

  if (!today) {
    signInEl.textContent = '—';
    signInEl.className = 'status-value';
    signOutEl.textContent = '—';
    signOutEl.className = 'status-value';
    return;
  }

  renderStatus(signInEl, today.signIn);
  renderStatus(signOutEl, today.signOut);
}

function renderStatus(el, data) {
  if (!data) {
    el.textContent = '—';
    el.className = 'status-value';
    return;
  }

  if (data.disabled) {
    el.textContent = '已停用（今日）';
    el.className = 'status-value disabled';
  } else if (data.done && data.success) {
    const time = data.timestamp ? formatTimestamp(data.timestamp) : '';
    el.textContent = `✓ 完成　${time}`;
    el.className = 'status-value done';
  } else if (data.done && !data.success) {
    el.textContent = `✗ 失敗：${data.error || '未知錯誤'}`;
    el.className = 'status-value failed';
  } else {
    el.textContent = `待執行`;
    el.className = 'status-value pending';
  }
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ──────────────────────────────────────────────
// 儲存設定
// ──────────────────────────────────────────────
async function saveSettings() {
  const uid = document.getElementById('uid').value.trim();
  const password = document.getElementById('password').value;

  if (!uid || !password) {
    showMsg('請填入員工編號與密碼', 'error');
    return;
  }

  if (uid.length !== 8) {
    showMsg('員工編號必須為 8 碼', 'error');
    return;
  }

  const schedule = {};
  for (const day of DAYS) {
    const signInCheck = document.querySelector(`.skip-check[data-day="${day}"][data-type="signIn"]`);
    const signOutCheck = document.querySelector(`.skip-check[data-day="${day}"][data-type="signOut"]`);
    const signInInput = document.getElementById(`sign-in-${day}`);
    const signOutInput = document.getElementById(`sign-out-${day}`);

    const signInVal = signInCheck.checked ? null : signInInput.value.trim();
    const signOutVal = signOutCheck.checked ? null : signOutInput.value.trim();

    if (signInVal !== null && !isValidTime(signInVal)) {
      showMsg(`格式錯誤：${['週一','週二','週三','週四','週五'][DAYS.indexOf(day)]} 上班時間請輸入 HH:MM`, 'error');
      return;
    }
    if (signOutVal !== null && !isValidTime(signOutVal)) {
      showMsg(`格式錯誤：${['週一','週二','週三','週四','週五'][DAYS.indexOf(day)]} 下班時間請輸入 HH:MM`, 'error');
      return;
    }

    schedule[day] = { signIn: signInVal || null, signOut: signOutVal || null };
  }

  const settings = { uid, password, schedule };
  await chrome.storage.local.set({ settings });

  // 通知 background 重建 alarms
  chrome.runtime.sendMessage({ type: 'save-settings', settings });

  showMsg('設定已儲存，排程已更新！', 'success');
}

function showMsg(text, type) {
  const el = document.getElementById('save-msg');
  el.textContent = text;
  el.className = `save-msg ${type}`;
  setTimeout(() => {
    el.textContent = '';
    el.className = 'save-msg';
  }, 3000);
}

// ──────────────────────────────────────────────
// 時間格式驗證（HH:MM，24 小時制）
// ──────────────────────────────────────────────
function isValidTime(val) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(val);
}

// 自動補冒號：輸入滿 2 位數字時插入 ":"
function bindTimeAutoFormat() {
  document.querySelectorAll('.time-input').forEach(input => {
    input.addEventListener('input', () => {
      let v = input.value.replace(/[^0-9:]/g, '');
      if (v.length === 2 && !v.includes(':')) v += ':';
      input.value = v;
      input.classList.toggle('invalid', v.length === 5 && !isValidTime(v));
    });
    input.addEventListener('blur', () => {
      const v = input.value;
      if (v && !isValidTime(v)) {
        input.classList.add('invalid');
      } else {
        input.classList.remove('invalid');
      }
    });
  });
}

// ──────────────────────────────────────────────
// 跳過 Checkbox 控制時間輸入框
// ──────────────────────────────────────────────
function bindSkipCheckboxes() {
  document.querySelectorAll('.skip-check').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      const { day, type } = checkbox.dataset;
      const prefix = type === 'signIn' ? 'sign-in' : 'sign-out';
      const timeInput = document.getElementById(`${prefix}-${day}`);
      timeInput.disabled = checkbox.checked;
    });
  });
}

// ──────────────────────────────────────────────
// 立即執行按鈕（強制打卡，忽略今日已完成狀態）
// ──────────────────────────────────────────────
function bindRunButtons() {
  document.getElementById('run-sign-in').addEventListener('click', () => triggerAction('sign-in'));
  document.getElementById('run-sign-out').addEventListener('click', () => triggerAction('sign-out'));
}

async function triggerAction(action) {
  const btnId = action === 'sign-in' ? 'run-sign-in' : 'run-sign-out';
  const btn = document.getElementById(btnId);
  btn.disabled = true;
  btn.textContent = '執行中…';

  chrome.runtime.sendMessage({ type: 'force-perform', action });
}

// 監聽 storage 變化，當 background 更新今日狀態後自動刷新 UI 並恢復按鈕
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.today) {
    const newToday = changes.today.newValue;
    const valid = newToday && newToday.date === todayDateStr() ? newToday : null;
    updateStatusUI(valid);
    document.getElementById('run-sign-in').disabled = false;
    document.getElementById('run-sign-in').textContent = '立即執行';
    document.getElementById('run-sign-out').disabled = false;
    document.getElementById('run-sign-out').textContent = '立即執行';
  }
});

// ──────────────────────────────────────────────
// 初始化
// ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  bindSkipCheckboxes();
  bindRunButtons();
  bindTimeAutoFormat();
  await loadSettings();
  await loadTodayStatus();
  document.getElementById('save-btn').addEventListener('click', saveSettings);
});
