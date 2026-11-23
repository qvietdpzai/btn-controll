'use strict';

const TOKEN_KEY = 'btn-controll.token';
const MAX_LOG = 300;

const state = {
  demo: false,
  token: '',
  buttons: [],
  health: null,
  healthAt: 0,
  demoAt: 0,
  status: 'connecting',
  source: null,
  retry: null,
  globalLog: [],
  expanded: new Set(),
};

const $ = (selector, root = document) => root.querySelector(selector);

const DEMO_LINES = {
  uptime: [
    '[out]  14:22:01 up 12 days,  3:41,  2 users,  load average: 0.42, 0.31, 0.28',
  ],
  disk: [
    '[out] Filesystem      Size  Used Avail Use% Mounted on',
    '[out] /dev/nvme0n1p2  452G  128G  301G  30% /',
    '[out] tmpfs            16G     0   16G   0% /dev/shm',
  ],
  memory: [
    '[out]                total        used        free      shared  buff/cache   available',
    '[out] Mem:            31Gi        12Gi       4.2Gi       512Mi        15Gi        18Gi',
    '[out] Swap:          8.0Gi          0B       8.0Gi',
  ],
  'ping-github': [
    '[out] PING github.com (140.82.112.4) 56(84) bytes of data.',
    '[out] 64 bytes from 140.82.112.4: icmp_seq=1 ttl=52 time=18.4 ms',
    '[out] 64 bytes from 140.82.112.4: icmp_seq=2 ttl=52 time=17.9 ms',
    '[out] 64 bytes from 140.82.112.4: icmp_seq=3 ttl=52 time=18.1 ms',
    '[out] --- github.com ping statistics ---',
    '[out] 3 packets transmitted, 3 received, 0% packet loss',
  ],
  'btn-launcher': [
    '[out] btn-launcher 0.1.0',
    '[out] runtime: linux-x86_64',
    '[out] profile: default',
    '[out] ready',
  ],
};

document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  state.token = localStorage.getItem(TOKEN_KEY) || '';
  state.demoAt = Date.now();
  bind();
  updateUptime();
  setInterval(updateUptime, 1000);

  try {
    state.health = await request('api/health', { auth: false });
    state.healthAt = Date.now();
    state.demo = false;
    $('#demo-banner').hidden = true;
    if (state.health.version) $('#app-version').textContent = state.health.version;
  } catch (error) {
    enterDemo();
    return;
  }

  if (!state.token) {
    setStatus('locked');
    render();
    openTokenDialog('Dán token để tải danh sách nút.');
    return;
  }

  try {
    await loadButtons();
    setStatus('live');
    connect();
  } catch (error) {
    setStatus('locked');
    handleApiError(error);
  }
}

function bind() {
  $('#token-btn').addEventListener('click', () => openTokenDialog());
  $('#refresh-btn').addEventListener('click', refresh);
  $('#clear-log').addEventListener('click', clearLog);
  $('#grid').addEventListener('click', onGridClick);
  $('#token-form').addEventListener('submit', onTokenSubmit);
  $('#token-cancel').addEventListener('click', closeTokenDialog);
}

/* ------------------------------------------------------------------ API */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  const { auth = true, method = 'GET', body } = options;
  const headers = { Accept: 'application/json' };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      signal: controller.signal,
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const text = (await response.text()).trim();
      if (text) detail = text.slice(0, 300);
    } catch (_) {
      /* ignore */
    }
    if (response.status === 401) detail = 'Token không đúng hoặc đã hết hạn.';
    throw new HttpError(response.status, detail);
  }

  if (response.status === 204) return null;
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response.text();
}

async function loadButtons() {
  const data = await request('api/buttons');
  if (!Array.isArray(data)) throw new Error('Phản hồi API không hợp lệ.');
  state.buttons = data.map(normalize);
  state.expanded.clear();
  render();
}

function normalize(button) {
  return {
    id: String(button.id),
    label: String(button.label ?? button.id),
    description: String(button.description ?? ''),
    confirm: Boolean(button.confirm),
    running: Boolean(button.running),
    last_exit: button.last_exit ?? null,
    last_started: button.last_started ?? null,
    last_finished: button.last_finished ?? null,
    runs: Number(button.runs ?? 0),
    log: Array.isArray(button.log) ? button.log.map(String) : [],
  };
}

function connect() {
  disconnect();
  if (!state.token || state.demo) return;

  const source = new EventSource(`api/events?token=${encodeURIComponent(state.token)}`);
  state.source = source;

  source.addEventListener('open', () => setStatus('live'));
  source.addEventListener('update', (event) => {
    try {
      onEvent(JSON.parse(event.data));
    } catch (_) {
      /* ignore malformed frame */
    }
  });
  source.addEventListener('error', () => {
    source.close();
    if (state.source !== source) return;
    state.source = null;
    setStatus('offline');
    if (state.retry) return;
    state.retry = setTimeout(async () => {
      state.retry = null;
      try {
        await request('api/buttons');
        connect();
      } catch (error) {
        handleApiError(error);
      }
    }, 3500);
  });
}

function disconnect() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  if (state.retry) {
    clearTimeout(state.retry);
    state.retry = null;
  }
}

function onEvent(message) {
  if (message.type === 'button' && message.button) {
    const index = state.buttons.findIndex((item) => item.id === message.button.id);
    if (index !== -1) {
      state.buttons[index] = normalize(message.button);
      render();
      if (state.buttons[index].running) state.expanded.add(state.buttons[index].id);
    }
  } else if (message.type === 'log') {
    appendGlobal({ line: message.line, id: message.id, at: message.at });
  }
}

/* --------------------------------------------------------------- actions */

async function refresh() {
  if (state.demo) {
    toast('Đang ở demo mode — chạy cargo run để có backend thật.', 'error');
    return;
  }
  try {
    await loadButtons();
    toast('Đã tải lại.', 'ok');
  } catch (error) {
    handleApiError(error);
  }
}

async function onGridClick(event) {
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;
  const card = actionEl.closest('.card');
  if (!card) return;
  const button = state.buttons.find((item) => item.id === card.dataset.id);
  if (!button) return;

  const action = actionEl.dataset.action;
  if (action === 'run') {
    await runButton(button);
  } else if (action === 'stop') {
    await stopButton(button);
  } else if (action === 'log') {
    if (state.expanded.has(button.id)) state.expanded.delete(button.id);
    else state.expanded.add(button.id);
    renderGrid();
  }
}

async function runButton(button) {
  if (button.running) return;
  if (button.confirm && !window.confirm(`Chạy "${button.label}"?`)) return;

  if (state.demo) {
    demoRun(button);
    return;
  }

  try {
    const updated = await request(`api/buttons/${encodeURIComponent(button.id)}/run`, {
      method: 'POST',
    });
    Object.assign(button, normalize(updated));
    state.expanded.add(button.id);
    render();
    toast(`Đã chạy ${button.label}.`, 'ok');
  } catch (error) {
    handleApiError(error);
  }
}

async function stopButton(button) {
  if (!button.running) return;

  if (state.demo) {
    button.running = false;
    button.last_finished = now();
    button.log.push('⏹ stop requested (demo)');
    appendGlobal({ line: '⏹ stop requested (demo)', id: button.id, at: now() });
    render();
    return;
  }

  try {
    await request(`api/buttons/${encodeURIComponent(button.id)}/stop`, { method: 'POST' });
    toast(`Đã gửi lệnh dừng ${button.label}.`, 'ok');
  } catch (error) {
    handleApiError(error);
  }
}

async function demoRun(button) {
  button.running = true;
  button.runs += 1;
  button.last_started = now();
  button.last_exit = null;
  button.last_finished = null;
  button.log = [];
  state.expanded.add(button.id);

  appendGlobal({ line: `▶ ${button.id} (demo)`, id: button.id, at: now() });
  render();

  const lines = DEMO_LINES[button.id] || ['[out] xin chào từ chế độ demo'];
  for (const line of lines) {
    await sleep(320 + Math.random() * 380);
    if (!button.running) break;
    button.log.push(line);
    appendGlobal({ line, id: button.id, at: now() });
    renderGrid();
    renderStats();
  }

  await sleep(220);
  button.running = false;
  button.last_finished = now();
  button.last_exit = 0;
  button.log.push('■ exited with code 0');
  appendGlobal({ line: '■ exited with code 0', id: button.id, at: now() });
  render();
  toast(`${button.label}: xong.`, 'ok');
}

/* --------------------------------------------------------------- helpers */

function handleApiError(error) {
  if (error instanceof HttpError && error.status === 401) {
    setStatus('locked');
    openTokenDialog('Token không đúng. Kiểm tra console của server.');
    return;
  }
  toast(error?.message || 'Có lỗi xảy ra.', 'error');
}

async function onTokenSubmit(event) {
  event.preventDefault();
  const token = $('#token-input').value.trim();
  if (!token) {
    $('#token-hint').textContent = 'Token không được để trống.';
    return;
  }
  await applyToken(token);
}

async function applyToken(token) {
  state.token = token;
  localStorage.setItem(TOKEN_KEY, token);
  closeTokenDialog();

  try {
    state.health = await request('api/health', { auth: false });
    state.healthAt = Date.now();
    state.demo = false;
    $('#demo-banner').hidden = true;
    await loadButtons();
    setStatus('live');
    connect();
    toast('Đã kết nối.', 'ok');
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      setStatus('locked');
      openTokenDialog('Token không đúng. Thử lại nhé.');
    } else {
      enterDemo();
    }
  }
}

function openTokenDialog(message = '') {
  const dialog = $('#token-dialog');
  $('#token-input').value = state.token;
  $('#token-hint').textContent = message;
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $('#token-input').focus(), 30);
}

function closeTokenDialog() {
  const dialog = $('#token-dialog');
  if (dialog.open) dialog.close();
}

function clearLog() {
  state.globalLog = [];
  renderGlobalLog();
}

function enterDemo() {
  state.demo = true;
  state.demoAt = Date.now();
  state.health = { ok: true, version: '0.1.0', buttons: 5, uptime_secs: 0 };
  state.healthAt = Date.now();
  state.buttons = demoButtons();
  $('#demo-banner').hidden = false;
  setStatus('demo');
  render();
  appendGlobal({ line: '[demo] không tìm thấy backend — đang mô phỏng trong trình duyệt.', id: null, at: now() });
  appendGlobal({ line: '[demo] chạy "cargo run" rồi mở http://127.0.0.1:8787 để điều khiển thật.', id: null, at: now() });
}

function demoButtons() {
  return [
    {
      id: 'uptime',
      label: 'System status',
      description: 'Xem máy đã chạy bao lâu và tải trung bình.',
      confirm: false,
    },
    {
      id: 'disk',
      label: 'Disk usage',
      description: 'Dung lượng còn trống của các ổ đĩa.',
      confirm: false,
    },
    {
      id: 'memory',
      label: 'Memory',
      description: 'RAM và swap đang dùng.',
      confirm: false,
    },
    {
      id: 'ping-github',
      label: 'Ping GitHub',
      description: 'Bốn gói ICMP tới github.com.',
      confirm: false,
    },
    {
      id: 'btn-launcher',
      label: 'BTN Launcher',
      description: 'Nút điều khiển thật: đổi program/args trong buttons.json.',
      confirm: true,
    },
  ].map((button) =>
    normalize({
      ...button,
      running: false,
      runs: 0,
      last_exit: null,
      last_started: null,
      last_finished: null,
      log: [],
    })
  );
}

function setStatus(status) {
  state.status = status;
  const pill = $('#status');
  pill.dataset.state = status;
  $('#status-text').textContent = status === 'demo' ? 'demo mode' : status;
}

function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${kind}`.trim();
  clearTimeout(node._timer);
  node._timer = setTimeout(() => {
    node.className = 'toast';
  }, 3200);
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtUptime(total) {
  const seconds = Math.max(0, Math.floor(total));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

function fmtRelative(timestamp) {
  if (!timestamp) return '—';
  const delta = now() - timestamp;
  if (delta < 10) return 'vừa xong';
  if (delta < 60) return `${delta}s trước`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m trước`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h trước`;
  return new Date(timestamp * 1000).toLocaleDateString('vi-VN');
}

function fmtClock(timestamp) {
  return new Date((timestamp || now()) * 1000).toLocaleTimeString('vi-VN', { hour12: false });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function levelOf(line) {
  if (line.startsWith('[err]') || line.startsWith('!')) return 'lv-err';
  if (line.startsWith('■ exited with code 0')) return 'lv-ok';
  if (line.startsWith('■') || line.startsWith('⏱') || line.startsWith('⏹')) return 'lv-warn';
  return '';
}

/* ---------------------------------------------------------------- render */

function render() {
  renderStats();
  renderGrid();
}

function updateUptime() {
  const stat = $('#stat-uptime');
  if (!stat) return;
  let base = 0;
  if (state.demo) base = (Date.now() - state.demoAt) / 1000;
  else if (state.health) base = state.health.uptime_secs + (Date.now() - state.healthAt) / 1000;
  stat.textContent = fmtUptime(base);
}

function renderStats() {
  $('#stat-buttons').textContent = String(state.buttons.length);
  $('#stat-running').textContent = String(state.buttons.filter((button) => button.running).length);
  $('#stat-runs').textContent = String(state.buttons.reduce((sum, button) => sum + button.runs, 0));
  updateUptime();
}

function renderGrid() {
  const grid = $('#grid');
  $('#count-label').textContent = `${state.buttons.length} configured`;

  if (!state.buttons.length) {
    const message = state.demo
      ? 'Chưa có nút nào.'
      : state.token
        ? 'Không tải được danh sách nút. Thử tải lại trang.'
        : 'Cần token để tải danh sách nút.';
    grid.innerHTML = `
      <div class="empty">
        <strong>Chưa có nút nào</strong>
        ${escapeHtml(message)}
        ${state.token ? '' : '<br><br><button class="btn primary" data-action="token">Nhập token</button>'}
      </div>`;
    if (!state.token) {
      const tokenButton = grid.querySelector('[data-action="token"]');
      if (tokenButton) tokenButton.addEventListener('click', () => openTokenDialog());
    }
    return;
  }

  grid.innerHTML = state.buttons.map(cardHtml).join('');

  for (const id of state.expanded) {
    const log = grid.querySelector(`[data-log="${cssEscape(id)}"]`);
    if (log) log.scrollTop = log.scrollHeight;
  }
}

function cardHtml(button) {
  const visibleLog = state.expanded.has(button.id);
  const dotClass = button.running ? 'is-running' : button.last_exit != null && button.last_exit !== 0 ? 'is-failed' : '';

  return `
    <article class="card ${button.running ? 'is-running' : ''}" data-id="${escapeHtml(button.id)}">
      <div class="card-head">
        <span class="dot ${dotClass}" aria-hidden="true"></span>
        <h3 title="${escapeHtml(button.label)}">${escapeHtml(button.label)}</h3>
        ${badgeHtml(button)}
      </div>
      <p class="card-desc">${escapeHtml(button.description || 'Không có mô tả.')}</p>
      <dl class="meta">
        <div><dt>RUNS</dt><dd>${button.runs}</dd></div>
        <div><dt>LAST RUN</dt><dd>${escapeHtml(fmtRelative(button.last_started))}</dd></div>
      </dl>
      <div class="actions">
        <button class="btn primary" data-action="run" ${button.running ? 'disabled' : ''}>Run</button>
        <button class="btn danger" data-action="stop" ${button.running ? '' : 'disabled'}>Stop</button>
        <button class="btn ghost small" data-action="log">${visibleLog ? 'Hide log' : 'Log'}</button>
      </div>
      ${
        visibleLog
          ? `<pre class="card-log" data-log="${escapeHtml(button.id)}">${escapeHtml(
              button.log.length ? button.log.join('\n') : 'Chưa có log.'
            )}</pre>`
          : ''
      }
    </article>`;
}

function badgeHtml(button) {
  if (button.running) return '<span class="badge run">running</span>';
  if (button.last_exit === 0) return '<span class="badge ok">ok</span>';
  if (button.last_exit != null) return `<span class="badge err">exit ${button.last_exit}</span>`;
  if (button.last_finished) return '<span class="badge">done</span>';
  return '<span class="badge">idle</span>';
}

function appendGlobal(entry) {
  state.globalLog.push({
    line: String(entry.line ?? ''),
    at: Number(entry.at ?? now()),
    id: entry.id ?? null,
  });
  if (state.globalLog.length > MAX_LOG) state.globalLog.shift();
  renderGlobalLog();
}

function renderGlobalLog() {
  const box = $('#log');
  if (!state.globalLog.length) {
    box.innerHTML = '<div class="log-empty">Chưa có log. Bấm Run để bắt đầu.</div>';
    return;
  }

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  box.innerHTML = state.globalLog
    .map((entry) => {
      const prefix = entry.id ? `[${entry.id}] ` : '';
      return `<div class="log-line ${levelOf(entry.line)}">
        <span class="log-time">${escapeHtml(fmtClock(entry.at))}</span>
        <span class="log-body">${escapeHtml(prefix + entry.line)}</span>
      </div>`;
    })
    .join('');

  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}
