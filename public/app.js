/**
 * Main App - Ties everything together
 */

import { WebSocketClient } from './websocket-client.js';
import { StateManager } from './state.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer } from './tool-card.js';
import { DialogHandler } from './dialogs.js';
import { SessionSidebar } from './session-sidebar.js';
import { themes, applyTheme, getCurrentTheme } from './themes.js';
import { FileBrowser, getFileIcon } from './file-browser.js';
import { Launcher } from './launcher.js';
import { t, applyDomTranslations, getLocalePreference, setLocalePreference, onLocaleChange, thinkingLevels } from './i18n.js';


// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const state = new StateManager();
const messageRenderer = new MessageRenderer(document.getElementById('messages'));
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages'));
toolCardRenderer.setScrollCallback(() => messageRenderer.scrollToBottom());
const dialogHandler = new DialogHandler(document.getElementById('dialog-container'), wsClient);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list'),
  handleSessionSelect,
  { onSessionDeleted: handleSessionDeleted, onSessionRenamed: handleSessionRenamed }
);

// UI elements
const messageInput = document.getElementById('message-input');
const chatForm = document.getElementById('chat-form');
const sendBtn = document.getElementById('send-btn');
const abortBtn = document.getElementById('abort-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const sidebarEl = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarOverlay = document.getElementById('sidebar-overlay');

const refreshSessionsBtn = document.getElementById('refresh-sessions-btn');
const sessionSearchInput = document.getElementById('session-search-input');
const statusEl = document.getElementById('status');
const statusElapsed = document.getElementById('status-elapsed');
let workPhase = 'idle';
let workStartedAt = 0;
let workElapsedTimer = null;
let activeToolName = '';

const sessionCostEl = document.getElementById('session-cost');
const tokenUsageEl = document.getElementById('token-usage');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
const scrollBottomBadge = document.getElementById('scroll-bottom-badge');
const messagesContainer = document.getElementById('messages');
const mainContainer = messagesContainer?.closest('.main');
const inputAreaEl = document.querySelector('.input-area');
const toastRegion = document.getElementById('toast-region');
applyDomTranslations();
const langSelect = document.getElementById('lang-select');
function refreshLangSelectLabels() {
  if (!langSelect) return;
  for (const opt of langSelect.options) {
    if (opt.value === 'auto') opt.textContent = t('langAuto');
    if (opt.value === 'en') opt.textContent = t('langEn');
    if (opt.value === 'zh') opt.textContent = t('langZh');
  }
}
refreshLangSelectLabels();
if (langSelect) {
  langSelect.value = getLocalePreference();
  langSelect.addEventListener('change', () => {
    setLocalePreference(langSelect.value);
    updateThinkingBtn();
    updateModelLabel();
    updatePlanModeBtn();
    if (messageInput && !historyResumeBar?.classList.contains('hidden')) {
      messageInput.placeholder = t('inputHistoryPlaceholder');
    } else if (messageInput) {
      messageInput.placeholder = t('inputPlaceholder');
    }
  });
}
onLocaleChange(() => {
  applyDomTranslations();
  refreshLangSelectLabels();
  if (langSelect) langSelect.value = getLocalePreference();
  updateModelLabel();
  updateThinkingBtn();
  updatePlanModeBtn();
});
const historyResumeBar = document.getElementById('history-resume-bar');
const historyResumeBtn = document.getElementById('history-resume-btn');
const historyDeleteBtn = document.getElementById('history-delete-btn');

// State tracking
let currentStreamingElement = null;
let currentStreamingText = '';
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0;  // effective value, provider metadata takes priority
let contextWindowSource = 'pi-registry';
let originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let hasNewWhileScrolled = false;
let lastSentMessage = null; // Track to avoid duplicate rendering in mirror mode
let lastUsage = null; // Full usage object for context visualiser
let mirrorActiveSessionFile = null; // The live session file path from the TUI
let viewingActiveSession = true; // Whether we're viewing the live session or a historical one
let historyPreviewSessionFile = null;
let historyPageState = null;
let historyPageAbort = null;
let historyBufferedEntries = [];
let historyBufferedLoading = false;
let isMirrorMode = false; // Set when mirror_sync received
let liveInstances = []; // All running Tau instances [{port, sessionFile, cwd}]
let connectionState = 'connecting';

function updateInputDockHeight() {
  if (!mainContainer || !inputAreaEl) return;
  const height = Math.ceil(inputAreaEl.getBoundingClientRect().height);
  mainContainer.style.setProperty('--input-dock-height', `${Math.max(0, height)}px`);
}

if (inputAreaEl && typeof ResizeObserver === 'function') {
  const inputDockObserver = new ResizeObserver(() => updateInputDockHeight());
  inputDockObserver.observe(inputAreaEl);
}
requestAnimationFrame(updateInputDockHeight);

function sessionPageLocation(filePath) {
  const parts = String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { dirName: parts[parts.length - 2], file: parts[parts.length - 1] };
}

function showToast(message, type = 'info', duration = 2600) {
  if (!toastRegion || !message) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `<span class="toast-dot"></span><span class="toast-message"></span>`;
  toast.querySelector('.toast-message').textContent = message;
  toastRegion.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  const remove = () => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 180);
  };
  toast.addEventListener('click', remove);
  setTimeout(remove, duration);
}

function humanizeError(error) {
  const message = String(error?.message || error || t('opFailed'));
  if (/No API key/i.test(message)) return t('errNoKey');
  if (/Model not found|没有找到模型/i.test(message)) return message.includes('::') ? message : t('errNoModel');
  if (/Pi is busy/i.test(message)) return t('errBusy');
  if (/Failed to fetch|NetworkError|ECONNRESET|ETIMEDOUT/i.test(message)) return t('errNetwork');
  if (/Connection lost|disconnected/i.test(message)) return t('errDisconnected');
  if (/Session file is invalid|outside the Pi session directory/i.test(message)) return t('errBadSession');
  if (/No context available/i.test(message)) return t('errNoContext');
  if (/Plan Mode extension did not respond|Plan Mode extension is not available/i.test(message)) return t('planUnavailableHint');
  if (/There is no plan to execute yet/i.test(message)) return t('planNoPlanExecute');
  if (/There is no plan to refine yet/i.test(message)) return t('planNoPlanRefine');
  if (/Unknown command:\s*(get_providers|save_provider|delete_provider|test_provider|save_model_context)/i.test(message)) return t('errNeedRestart');
  if (/Unknown command/i.test(message)) return t('errNeedRestart');
  return message;
}

function humanizeModelError(error) {
  const message = String(error?.message || error || t('errModelFail'));
  if (/abort/i.test(message) && /user|signal/i.test(message)) return '';
  if (/401|unauthorized|invalid api key|incorrect api key|invalid.?key/i.test(message)) return t('errUnauthorized');
  if (/403|forbidden/i.test(message)) return t('errForbidden');
  if (/unknown route\s*\/?v1\/responses|\/v1\/responses/i.test(message)) return t('errResponsesRoute');
  if (/developer is not one of|messages\.\[.?0.?\]\.role|invalid_request_error/i.test(message) && /developer/i.test(message)) return t('errDeveloperRole');
  if (/404|model.?not.?found|does not exist|unknown model/i.test(message)) return t('errModelUnavailable', { msg: message });
  if (/429|rate limit|too many requests/i.test(message)) return t('errRateLimit');
  if (/402|insufficient|quota|balance|余额不足/i.test(message)) return t('errQuota');
  if (/context.?length|too many tokens|maximum context/i.test(message)) return t('errContext');
  if (/Failed to fetch|NetworkError|ECONNRESET|ETIMEDOUT/i.test(message)) return t('errRelayDown');
  return message;
}

let lastShownErrorKey = '';
function showChatError(raw, options = {}) {
  const text = humanizeModelError(raw);
  if (!text) return;
  if (text === lastShownErrorKey) return;
  lastShownErrorKey = text;
  messageRenderer.renderError(text);
  if (options.toast !== false) showToast(text, 'error', 7000);
  showNewMessageBadge();
}

// File browser
const fileSidebar = document.getElementById('file-sidebar');
const fileSidebarToggle = document.getElementById('file-sidebar-toggle');
const fileSidebarClose = document.getElementById('file-sidebar-close');
const fileSidebarUp = document.getElementById('file-sidebar-up');
const fileList = document.getElementById('file-list');
const fileSidebarPath = document.getElementById('file-sidebar-path');
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput, (filePath) => {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  pendingFilePaths.push({ path: filePath, name, ext });
  renderAttachmentPreviews();
});

fileSidebarToggle.addEventListener('click', () => {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    fileBrowser.load(); // Load session cwd
  }
  localStorage.setItem('tau-file-sidebar', isCollapsed ? 'closed' : 'open');
});

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  localStorage.setItem('tau-file-sidebar', 'closed');
});

fileSidebarUp.addEventListener('click', () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

fetch('/api/health').then(r => r.json()).then(data => {
  const names = { win32: '资源管理器', darwin: '访达', linux: '文件管理器' };
  const name = names[data.platform] || 'file manager';
  document.getElementById('file-sidebar-finder').title = `在 ${name} 中打开`; 
}).catch(() => {});

document.getElementById('file-sidebar-finder').addEventListener('click', () => {
  if (fileBrowser.currentPath) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: fileBrowser.currentPath }),
    });
  }
});

// Restore file sidebar state
if (localStorage.getItem('tau-file-sidebar') === 'open') {
  fileSidebar.classList.remove('collapsed');
  fileBrowser.load();
}


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Sleep / lock / tab-hide all leave the socket looking OPEN. Probe it instead
// of waiting for TCP timeout, and skip a full history redraw when nothing changed.
let _resumeTimer = null;
let _lastWakeCheck = Date.now();
const WAKE_GAP_MS = 25000;

async function resumeAfterSleep(reason = 'resume') {
  if (document.visibilityState === 'hidden') return;
  if (_resumeTimer) {
    clearTimeout(_resumeTimer);
    _resumeTimer = null;
  }
  _lastWakeCheck = Date.now();
  const state = wsClient.ws?.readyState;
  if (state !== WebSocket.OPEN) {
    console.log(`[App] ${reason}: socket not open, reconnecting`);
    wsClient.forceReconnect();
    return;
  }
  const alive = await wsClient.probe(900);
  if (alive) {
    pollInstances();
    return;
  }
  if (document.visibilityState === 'hidden') return;
  console.log(`[App] ${reason}: stale socket, reconnecting`);
  wsClient.forceReconnect();
}

function scheduleResumeCheck(reason, delay = 80) {
  if (_resumeTimer) clearTimeout(_resumeTimer);
  _resumeTimer = setTimeout(() => {
    _resumeTimer = null;
    resumeAfterSleep(reason);
  }, delay);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleResumeCheck('visible');
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted || Date.now() - _lastWakeCheck > WAKE_GAP_MS) {
    scheduleResumeCheck('pageshow');
  }
});
window.addEventListener('online', () => scheduleResumeCheck('online', 0));
setInterval(() => {
  const now = Date.now();
  const gap = now - _lastWakeCheck;
  _lastWakeCheck = now;
  if (gap > WAKE_GAP_MS) scheduleResumeCheck('clock-jump', 0);
}, 4000);

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

let scrollBtnPending = false;
let previousMessagesScrollTop = 0;
let historyPrependInProgress = false;
let userScrollLock = false;

function suspendMessageAutoScroll() {
  userScrollLock = true;
  messageRenderer.cancelAutoScroll();
  isScrolledUp = true;
}
async function loadOlderHistoryPage() {
  if (historyBufferedLoading || historyPageState?.loading) return;
  if (historyBufferedEntries.length > 0) {
    historyBufferedLoading = true;
    const start = Math.max(0, historyBufferedEntries.length - 60);
    const chunk = historyBufferedEntries.splice(start);
    renderSessionHistory(chunk, {
      prepend: true,
      deferOlder: false,
      accountMetrics: false,
      onDone: () => { historyBufferedLoading = false; },
    });
    return;
  }

  const page = historyPageState;
  if (!page?.hasMore || page.loading || page.generation !== renderGeneration) return;
  page.loading = true;
  let renderOwnsLoading = false;
  try {
    const before = page.bootstrap ? '' : `&before=${page.cursor}`;
    const limit = page.bootstrap ? (page.bootstrapLimit || 200) : 120;
    const url = `/api/sessions/${encodeURIComponent(page.dirName)}/${encodeURIComponent(page.file)}?limit=${limit}${before}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (page !== historyPageState || page.generation !== renderGeneration) return;
    page.cursor = Number(data.cursor) || 0;
    page.hasMore = !!data.hasMore;
    if (page.bootstrap) {
      page.bootstrap = false;
      page.loading = false;
      if (page.hasMore) queueMicrotask(() => loadOlderHistoryPage());
      return;
    }
    if (data.entries?.length) {
      renderOwnsLoading = true;
      renderSessionHistory(data.entries, {
        prepend: true,
        onDone: () => {
          if (page === historyPageState) page.loading = false;
        },
      });
    }
  } catch (error) {
    if (error?.name !== 'AbortError' && error?.name !== 'TimeoutError') {
      console.warn('[History] Could not load older page:', error);
    }
  } finally {
    if (!renderOwnsLoading && page === historyPageState) page.loading = false;
  }
}

messagesContainer.addEventListener('scroll', () => {
  const currentTop = messagesContainer.scrollTop;
  const movingUpNow = currentTop + 8 < previousMessagesScrollTop;
  if (movingUpNow && !historyPrependInProgress) suspendMessageAutoScroll();
  if (scrollBtnPending) return;
  scrollBtnPending = true;
  requestAnimationFrame(() => {
    scrollBtnPending = false;
    const threshold = 150;
    const currentTop = messagesContainer.scrollTop;
    const movingUp = currentTop + 8 < previousMessagesScrollTop;
    if (movingUp && !historyPrependInProgress) suspendMessageAutoScroll();
    previousMessagesScrollTop = currentTop;
    if (movingUp && currentTop < 500) loadOlderHistoryPage();
    const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
    if (userScrollLock) {
      // Do not release the lock merely because the user is still within the
      // bottom threshold. A completion/layout event can otherwise look like
      // "at bottom" and let a queued auto-scroll pull the viewport down.
      messageRenderer.isNearBottom = false;
      isScrolledUp = true;
    } else if (atBottom) {
      messageRenderer.isNearBottom = true;
      isScrolledUp = false;
    } else {
      messageRenderer.isNearBottom = false;
      isScrolledUp = true;
    }
    if (messageRenderer.isNearBottom) {
      scrollBottomBtn.classList.add('hidden');
      scrollBottomBadge.classList.add('hidden');
      hasNewWhileScrolled = false;
    } else {
      scrollBottomBtn.classList.remove('hidden');
    }
  });
}, { passive: true });

messagesContainer.addEventListener('wheel', (event) => {
  // Wheel is a reliable user-intent signal and fires before the scroll event.
  // Keep the lock until an intentional downward wheel reaches the bottom.
  if (event.deltaY < 0) suspendMessageAutoScroll();
  if (event.deltaY > 0 && userScrollLock) {
    requestAnimationFrame(() => {
      const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 150;
      if (atBottom) {
        userScrollLock = false;
        messageRenderer.isNearBottom = true;
        isScrolledUp = false;
      }
    });
  }
  if (event.deltaY < 0 && messagesContainer.scrollTop < 500) loadOlderHistoryPage();
}, { passive: true });

messagesContainer.addEventListener('touchmove', (event) => {
  if (event.touches?.length) suspendMessageAutoScroll();
}, { passive: true });

function jumpMessagesToBottom() {
  userScrollLock = false;
  const previous = messagesContainer.style.scrollBehavior;
  messagesContainer.style.scrollBehavior = 'auto';
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  previousMessagesScrollTop = messagesContainer.scrollTop;
  messageRenderer.isNearBottom = true;
  requestAnimationFrame(() => {
    messagesContainer.style.scrollBehavior = previous;
  });
}

scrollBottomBtn.addEventListener('click', () => {
  jumpMessagesToBottom();
  isScrolledUp = false;
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  hasNewWhileScrolled = false;
});

function showNewMessageBadge() {
  if (isScrolledUp) {
    hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener('connected', () => {
  updateConnectionStatus('connected');
  // First paint uses the local registry. Do not hit every provider on connect.
  if (!availableModels.length) setTimeout(() => fetchModelInfo(), 80);
});

wsClient.addEventListener('planModeState', (event) => {
  applyPlanModeState(event.detail);
});

wsClient.addEventListener('tokenSaverState', (event) => {
  const data = event.detail || {};
  tokenSaverEnabled = !!data.enabled;
  if (data.thinkingLevel) currentThinkingLevel = data.thinkingLevel;
  if (typeof updateTokenSaverBtn === 'function') updateTokenSaverBtn();
  updateThinkingBtn();
});

wsClient.addEventListener('disconnected', () => {
  updateConnectionStatus('disconnected');
});

wsClient.addEventListener('reconnectFailed', () => {
  updateConnectionStatus('disconnected');
  showToast('暂时无法连接 Pi，请刷新页面重试', 'error', 5000);
});

wsClient.addEventListener('rpcEvent', (e) => {
  handleRPCEvent(e.detail);
});

wsClient.addEventListener('serverError', (e) => {
  showToast(humanizeError(e.detail.message), 'error', 5000);
});

// Mirror mode: receive full state snapshot on connect
wsClient.addEventListener('mirrorSync', (e) => {
  handleMirrorSync(e.detail);
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event) {
  switch (event.type) {
    case 'agent_start':
      handleAgentStart();
      break;
    case 'agent_end':
      handleAgentEnd(event);
      break;
    case 'message_start':
      handleMessageStart(event.message);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message);
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(event);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(event);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(event);
      break;
    case 'auto_compaction_start':
      handleCompactionStart(event);
      break;
    case 'auto_compaction_end':
      handleCompactionEnd(event);
      break;
    case 'extension_ui_request':
      handleExtensionUIRequest(event);
      break;
    case 'extension_error':
      showToast(`扩展出错：${humanizeError(event.error)}`, 'error', 5000);
      break;
    case 'auto_retry_start':
      showToast('请求失败，正在自动重试…', 'info', 3000);
      break;
    case 'auto_retry_end':
      if (event.success) showToast('自动重试成功', 'success', 2000);
      else if (event.error || event.errorMessage) showChatError(event.error || event.errorMessage);
      break;
    case 'plan_mode_state':
      applyPlanModeState(event.data || event);
      break;
    case 'session_name':
      // Auto-title: update sidebar with new session name
      if (event.name) {
        const activeItem = document.querySelector('.session-item.active .session-title');
        if (activeItem) activeItem.textContent = event.name;
      }
      break;
  }
}

function handleCompactionStart(event) {
  const el = document.createElement('div');
  el.className = 'system-message compaction-message';
  el.id = 'compaction-indicator';
  const reasonMap = { overflow: '上下文溢出', threshold: '上下文接近上限', manual: '手动触发' };
  const reason = reasonMap[event?.reason] || '自动';
  const retry = event?.willRetry ? '，完成后将自动重试' : '';
  el.innerHTML = `<span class="compaction-spinner">⟳</span> 正在整理上下文（${reason}${retry}）…`;
  messagesContainer.appendChild(el);
  messageRenderer.scrollToBottom();
}

function handleCompactionEnd(event) {
  const indicator = document.getElementById('compaction-indicator');
  if (indicator) {
    const reasonMap = { overflow: '溢出恢复', threshold: '阈值整理', manual: '手动整理' };
    const reason = reasonMap[event?.reason] || '';
    const retry = event?.willRetry ? '，即将自动重试上一轮请求' : '';
    indicator.innerHTML = `✓ 上下文已整理${reason ? '（' + reason + '）' : ''}${retry}`;
    indicator.classList.add('compaction-done');
  }
  // Reset token tracking — next message will update
  lastInputTokens = 0;
  updateTokenUsage();
  hideCompactButton();
}

function handleAgentStart() {
  lastShownErrorKey = '';
  state.setStreaming(true);
  setWorkPhase('starting');
  updateUI();
}

function handleAgentEnd(event) {
  const msgs = event?.messages || [];
  const last = [...msgs].reverse().find(m => m.role === 'assistant');
  if (last && last.stopReason === 'error' && last.errorMessage) {
    discardEmptyStreamingBubble();
    showChatError(last.errorMessage);
  }
  state.setStreaming(false);
  setWorkPhase('idle');
  currentStreamingElement = null;
  currentStreamingText = '';
  updateUI();

  // Notify via tab title if unfocused
  if (!hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;

  }
}

let currentStreamingThinking = '';
let pendingThinkingDelta = '';
let pendingTextDelta = '';
let streamingFrame = null;
let answerStreamStarted = false;
const pendingToolUpdates = new Map();
let toolUpdateFrame = null;

function flushStreamingDeltas() {
  if (streamingFrame !== null) {
    cancelAnimationFrame(streamingFrame);
    streamingFrame = null;
  }
  if (!currentStreamingElement) {
    pendingThinkingDelta = '';
    pendingTextDelta = '';
    return;
  }

  if (pendingThinkingDelta) {
    messageRenderer.appendStreamingThinking(currentStreamingElement, pendingThinkingDelta);
    pendingThinkingDelta = '';
  }
  if (pendingTextDelta) {
    if (!answerStreamStarted) {
      answerStreamStarted = true;
      messageRenderer.finishStreamingThinking(currentStreamingElement);
    }
    messageRenderer.appendStreamingMessage(currentStreamingElement, pendingTextDelta);
    pendingTextDelta = '';
  }
  // One scroll calculation per animation frame instead of one per token.
  messageRenderer.scrollToBottom();
}

function scheduleStreamingFlush() {
  if (streamingFrame !== null) return;
  streamingFrame = requestAnimationFrame(flushStreamingDeltas);
}

function resetStreamingDeltas() {
  if (streamingFrame !== null) cancelAnimationFrame(streamingFrame);
  streamingFrame = null;
  pendingThinkingDelta = '';
  pendingTextDelta = '';
  answerStreamStarted = false;
}

function handleMessageStart(message) {
  if (message.role === 'assistant') {
    resetStreamingDeltas();
    currentStreamingText = '';
    currentStreamingThinking = '';
    currentStreamingElement = messageRenderer.renderAssistantMessage(
      { content: '' },
      true
    );
  } else if (message.role === 'user') {
    // In mirror mode, user messages from TUI appear via events
    // Only render if we didn't just send this message ourselves
    if (!lastSentMessage || getMessageText(message) !== lastSentMessage) {
      const content = getMessageText(message);
      if (content) {
        messageRenderer.renderUserMessage({ content });
      }
    }
    lastSentMessage = null;
  }
}

function getMessageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function discardEmptyStreamingBubble() {
  if (!currentStreamingElement) return false;
  const hasContent = !!(currentStreamingText || currentStreamingThinking);
  if (!hasContent) {
    currentStreamingElement.remove();
    currentStreamingElement = null;
    resetStreamingDeltas();
    currentStreamingThinking = '';
    return true;
  }
  return false;
}

function handleMessageUpdate(event) {
  const { assistantMessageEvent } = event;
  if (!assistantMessageEvent) return;

  if (assistantMessageEvent.type === 'error') {
    const err = assistantMessageEvent.error || {};
    if (err.stopReason === 'aborted') return;
    discardEmptyStreamingBubble();
    showChatError(err.errorMessage || err.message || '模型请求失败');
    return;
  }

  if (assistantMessageEvent.type === 'thinking_delta') {
    const delta = assistantMessageEvent.delta || '';
    currentStreamingThinking += delta;
    pendingThinkingDelta += delta;
    setWorkPhase('thinking');
    scheduleStreamingFlush();
  } else if (assistantMessageEvent.type === 'text_delta') {
    const delta = assistantMessageEvent.delta || '';
    currentStreamingText += delta;
    pendingTextDelta += delta;
    setWorkPhase('writing');
    scheduleStreamingFlush();
  }
}

function handleMessageEnd(message) {
  if (message?.role === 'assistant' && message.stopReason === 'error' && message.errorMessage) {
    if (!discardEmptyStreamingBubble() && currentStreamingElement) {
      flushStreamingDeltas();
      messageRenderer.finalizeStreamingMessage(currentStreamingElement, message.usage || null, currentStreamingThinking);
      currentStreamingElement = null;
      currentStreamingThinking = '';
      resetStreamingDeltas();
    }
    showChatError(message.errorMessage);
    return;
  }

  if (currentStreamingElement) {
    flushStreamingDeltas();
    // Pass usage info for cost display
    const usage = message?.usage || null;
    // Pass thinking content so finalize can render the thinking block
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, usage, currentStreamingThinking);
    currentStreamingElement = null;
    currentStreamingThinking = '';
    resetStreamingDeltas();

    // Track session cost and tokens
    if (usage?.cost?.total) {
      sessionTotalCost += usage.cost.total;
    }
    if (usage?.input) {
      lastInputTokens = usage.input + (usage.cacheRead || 0);
      lastUsage = usage;
    }
    updateCostDisplay();
    updateTokenUsage();
    showNewMessageBadge();
  }
}

function handleToolExecutionStart(event) {
  const { toolCallId, toolName, args } = event;

  state.addToolExecution(toolCallId, {
    toolName,
    args,
    status: 'pending',
  });

  activeToolName = toolName || '';
  setWorkPhase('tool');
  toolCardRenderer.createToolCard(state.getToolExecution(toolCallId));
}

function applyToolExecutionUpdate(toolCallId, partialResult) {
  const output = formatToolOutput(partialResult);
  state.updateToolExecution(toolCallId, { status: 'streaming', output });
  toolCardRenderer.updateToolCard(state.getToolExecution(toolCallId));
}

function flushToolExecutionUpdates() {
  toolUpdateFrame = null;
  const updates = [...pendingToolUpdates.entries()];
  pendingToolUpdates.clear();
  for (const [toolCallId, partialResult] of updates) {
    applyToolExecutionUpdate(toolCallId, partialResult);
  }
}

function handleToolExecutionUpdate(event) {
  const { toolCallId, partialResult } = event;
  pendingToolUpdates.set(toolCallId, partialResult);
  if (toolUpdateFrame === null) {
    toolUpdateFrame = requestAnimationFrame(flushToolExecutionUpdates);
  }
}

function handleToolExecutionEnd(event) {
  const { toolCallId, result, isError } = event;
  if (pendingToolUpdates.has(toolCallId)) {
    const partial = pendingToolUpdates.get(toolCallId);
    pendingToolUpdates.delete(toolCallId);
    applyToolExecutionUpdate(toolCallId, partial);
  }
  const output = formatToolOutput(result);

  state.updateToolExecution(toolCallId, {
    status: isError ? 'error' : 'complete',
    output,
    isError,
  });

  toolCardRenderer.finalizeToolCard(toolCallId, result, isError);
  if (state.isStreaming) setWorkPhase(currentStreamingText ? 'writing' : 'starting');
}

function handleExtensionUIRequest(event) {
  switch (event.method) {
    case 'select':
      dialogHandler.showSelect(event);
      break;
    case 'confirm':
      dialogHandler.showConfirm(event);
      break;
    case 'input':
      dialogHandler.showInput(event);
      break;
    case 'editor':
      dialogHandler.showEditor(event);
      break;
    case 'notify':
      dialogHandler.showNotification(event);
      break;
    default:
      console.warn('[App] Unknown extension UI method:', event.method);
  }
}

function formatToolOutput(result) {
  if (!result) return '';

  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
});

// ═══════════════════════════════════════
// Attachments (images + file browser paths)
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn');
const imageInput = document.getElementById('image-input');
const imagePreviews = document.getElementById('image-previews');

let pendingImages = [];     // { data: base64, mimeType }
let pendingFilePaths = [];  // { path, name, ext } — from file browser (populated by callback above)

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function getFileChipIcon(name) {
  return getFileIcon(name || 'file', false);
}

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);

        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Failed to encode image')); return; }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addAttachments(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    try {
      pendingImages.push(await processImageFile(file));
    } catch (e) {
      console.error('[Tau] Image processing failed:', e);
    }
  }
  renderAttachmentPreviews();
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files);
  imageInput.value = '';
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) addAttachments(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  const files = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    files.push(item.getAsFile());
  }
  if (files.length) addAttachments(files);
});

function makeRemoveBtn(onClick) {
  const btn = document.createElement('button');
  btn.className = 'image-preview-remove';
  btn.setAttribute('aria-label', 'Remove');
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderAttachmentPreviews() {
  imagePreviews.innerHTML = '';
  const hasAny = pendingImages.length > 0 || pendingFilePaths.length > 0;
  if (!hasAny) { imagePreviews.classList.add('hidden'); return; }
  imagePreviews.classList.remove('hidden');

  // Binary image chips
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    el.appendChild(thumb);
    el.appendChild(makeRemoveBtn(() => { pendingImages.splice(i, 1); renderAttachmentPreviews(); }));
    imagePreviews.appendChild(el);
  });

  // File browser path chips
  pendingFilePaths.forEach((fp, i) => {
    const el = document.createElement('div');
    const removeBtn = makeRemoveBtn(() => {
      const withSpace = fp.path + ' ';
      messageInput.value = messageInput.value.includes(withSpace)
        ? messageInput.value.replace(withSpace, '')
        : messageInput.value.replace(fp.path, '');
      messageInput.dispatchEvent(new Event('input'));
      pendingFilePaths.splice(i, 1);
      renderAttachmentPreviews();
    });

    if (IMAGE_EXTS.has(fp.ext)) {
      el.className = 'image-preview';
      el.title = fp.path;
      const thumb = document.createElement('img');
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover';
      thumb.src = `/api/file/preview?path=${encodeURIComponent(fp.path)}`;
      thumb.onerror = () => {
        el.classList.add('file-chip');
        thumb.remove();
        const icon = document.createElement('span');
        icon.className = 'file-chip-icon';
        icon.textContent = getFileChipIcon(fp.name);
        const label = document.createElement('span');
        label.className = 'file-chip-name';
        label.textContent = fp.name;
        el.insertBefore(label, removeBtn);
        el.insertBefore(icon, label);
      };
      el.appendChild(thumb);
    } else {
      el.className = 'image-preview file-chip';
      el.title = fp.path;
      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      icon.textContent = getFileChipIcon(fp.ext);
      const label = document.createElement('span');
      label.className = 'file-chip-name';
      label.textContent = fp.name;
      el.appendChild(icon);
      el.appendChild(label);
    }

    el.appendChild(removeBtn);
    imagePreviews.appendChild(el);
  });
}

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

let messageQueue = [];

function sendMessage() {
  const message = messageInput.value.trim();
  if (!message && pendingImages.length === 0) return;

  messageInput.value = '';
  messageInput.style.height = 'auto';

  const cmd = { type: 'prompt', message: message || '(see attached image)' };

  if (pendingImages.length > 0) {
    cmd.images = pendingImages.map(img => {
      console.log(`[Tau] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return { type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' };
    });
    pendingImages = [];
  }

  pendingFilePaths = [];
  renderAttachmentPreviews();

  if (state.isStreaming) {
    // Queue it — show as bubble above input
    messageQueue.push(cmd);
    lastSentMessage = message;
    renderQueuedMessages();
    return;
  }

  lastSentMessage = message;
  messageRenderer.renderUserMessage({ content: message, images: cmd.images });
  wsClient.send(cmd);
}

const queuedMessagesEl = document.getElementById('queued-messages');

function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = '';
  if (messageQueue.length === 0) {
    queuedMessagesEl.classList.add('hidden');
    requestAnimationFrame(updateInputDockHeight);
    return;
  }
  queuedMessagesEl.classList.remove('hidden');
  messageQueue.forEach((cmd, i) => {
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">Queued</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message)}</span>
      <button class="queued-msg-cancel" title="取消排队">×</button>
    `;
    el.querySelector('.queued-msg-cancel').addEventListener('click', () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    queuedMessagesEl.appendChild(el);
  });
  requestAnimationFrame(updateInputDockHeight);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function flushQueue() {
  if (messageQueue.length > 0 && !state.isStreaming) {
    const cmd = messageQueue.shift();
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    renderQueuedMessages();
    wsClient.send(cmd);
  }
}

abortBtn.addEventListener('click', () => {
  wsClient.send({ type: 'abort' });
  showToast(t('stoppedGen'), 'info', 1800);
  setWorkPhase('idle');
});

// ═══════════════════════════════════════
// Command Palette
// ═══════════════════════════════════════

const commandBtn = document.getElementById('command-btn');
const commandPalette = document.getElementById('command-palette');
const commandPaletteOverlay = document.getElementById('command-palette-overlay');
const commandList = document.getElementById('command-list');

const commands = [
  { icon: '🗜️', label: '整理上下文', desc: '压缩较早内容，释放可用空间', action: () => rpcCommand({ type: 'compact' }, '正在整理上下文…') },
  { icon: '📋', label: '导出 HTML', desc: '将当前会话保存为网页文件', action: () => rpcExportHtml() },
  { icon: '📊', label: '会话统计', desc: '查看消息、工具与上下文用量', action: () => showSessionStats() },
  { icon: '⬇️', label: '展开工具记录', desc: '展开本页所有工具调用', action: () => toolCardRenderer.expandAll() },
  { icon: '⬆️', label: '收起工具记录', desc: '收起本页所有工具调用', action: () => toolCardRenderer.collapseAll() },
];

function openCommandPalette() {
  commandList.innerHTML = '';
  commands.forEach(cmd => {
    const el = document.createElement('div');
    el.className = 'command-item';
    el.innerHTML = `
      <div class="command-icon">${cmd.icon}</div>
      <div>
        <div class="command-label">${cmd.label}</div>
        <div class="command-desc">${cmd.desc}</div>
      </div>
    `;
    el.addEventListener('click', () => {
      closeCommandPalette();
      cmd.action();
    });
    commandList.appendChild(el);
  });
  commandPalette.classList.remove('hidden');
  commandPaletteOverlay.classList.remove('hidden');
}

function closeCommandPalette() {
  commandPalette.classList.add('hidden');
  commandPaletteOverlay.classList.add('hidden');
}

commandBtn.addEventListener('click', openCommandPalette);
commandPaletteOverlay.addEventListener('click', closeCommandPalette);

async function rpcCommand(cmd, statusMsg) {
  try {
    if (statusMsg) showToast(statusMsg, 'loading', 1800);
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.success) showToast(humanizeError(data.error), 'error', 4500);
    return data;
  } catch (error) {
    const message = humanizeError(error);
    showToast(message, 'error', 4500);
    return { success: false, error: message };
  }
}

async function rpcExportHtml() {
  const data = await rpcCommand({ type: 'export_html' }, '正在导出…');
  if (data?.success && data.data?.path) {
    showToast('会话已导出', 'success', 2600);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: 'get_session_stats' }, '正在读取统计…');
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      `📊 会话统计`,
      `消息：${s.totalMessages}（你 ${s.userMessages}，Pi ${s.assistantMessages}）`,
      `工具调用：${s.toolCalls}`,
    ];
    if (s.tokens) {
      lines.push(`上下文：约 ${(s.tokens.input / 1000).toFixed(1)}k tokens`);
    }
    messageRenderer.renderSystemMessage(lines.join('\n'));
  }
}

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

const modelDropdown = document.getElementById('model-dropdown');
const modelDropdownBtn = document.getElementById('model-dropdown-btn');
const modelDropdownLabel = document.getElementById('model-dropdown-label');
const modelDropdownKicker = document.getElementById('model-dropdown-kicker');
const modelDropdownMenu = document.getElementById('model-dropdown-menu');
const modelRefreshBtn = document.getElementById('model-refresh-btn');
const thinkingControl = document.getElementById('thinking-control');
const thinkingBtn = document.getElementById('thinking-btn');
const thinkingMenu = document.getElementById('thinking-menu');

let currentModelId = '';
let currentModelProvider = '';
let availableModels = [];
let modelMetadataMode = 'pi-only';
let relayProviders = [];
let relayBackendReady = false;
let modelMenuNotice = null;
let currentThinkingLevel = 'off';
let tokenSaverEnabled = false;
const BUILTIN_MODEL_PROVIDERS = new Set([
  'openai', 'anthropic', 'google', 'google-gemini', 'google-generative-ai',
  'google-vertex', 'amazon-bedrock', 'azure', 'azure-openai', 'groq',
  'mistral', 'openrouter', 'xai', 'grok', 'cerebras', 'github-copilot',
  'opencode', 'cloudflare', 'vercel', 'together', 'fireworks',
]);

function inferRelaysFromModels() {
  const byProvider = new Map();
  for (const model of availableModels) {
    const id = model.provider || '';
    if (!id || BUILTIN_MODEL_PROVIDERS.has(id)) continue;
    if (!byProvider.has(id)) {
      byProvider.set(id, {
        id,
        name: formatProvider(id),
        baseUrl: model.baseUrl || '',
        api: model.api || 'openai-completions',
        apiKeySet: true,
        modelCount: 0,
        sampleModels: [],
        inferred: true,
      });
    }
    const row = byProvider.get(id);
    row.modelCount += 1;
    if (row.sampleModels.length < 4 && model.id) row.sampleModels.push(model.id);
  }
  return [...byProvider.values()];
}

function getManageableRelays() {
  const map = new Map();
  for (const item of inferRelaysFromModels()) map.set(item.id, item);
  for (const item of relayProviders) {
    const prev = map.get(item.id) || {};
    map.set(item.id, {
      ...prev,
      ...item,
      name: item.name || prev.name || item.id,
      modelCount: item.modelCount || prev.modelCount || 0,
      sampleModels: item.sampleModels?.length ? item.sampleModels : prev.sampleModels,
      inferred: false,
    });
  }
  return [...map.values()].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

const THINKING_LEVELS = thinkingLevels;

const MODEL_LABELS = {
  'OAI/gpt-5.6-sol-thinking-none': 'GPT-5.6 Sol · 直答',
  'OAI/gpt-5.6-sol': 'GPT-5.6 Sol',
  'OAI/gpt-5.6-sol-wm': 'GPT-5.6 Sol WM',
  'OAI/gpt-5.6-luna': 'GPT-5.6 Luna',
  'ds/deepseek-v4-flash': 'DeepSeek V4 Flash',
  'ds/deepseek-v4-pro': 'DeepSeek V4 Pro',
  'glm-5-2': 'GLM-5.2',
};

const MODEL_HINTS = {
  'OAI/gpt-5.6-sol-thinking-none': '不启用思考，响应更直接',
  'OAI/gpt-5.6-sol': '通用主力模型',
  'OAI/gpt-5.6-sol-wm': 'Sol 的 WM 版本',
  'OAI/gpt-5.6-luna': 'Luna 版本',
  'ds/deepseek-v4-flash': '百万上下文，速度优先',
  'ds/deepseek-v4-pro': '百万上下文，深度任务',
  'glm-5-2': '百万上下文',
};

function getModelKey(model) {
  return `${model?.provider || ''}\x1e${model?.id || ''}`;
}

function getCurrentModelKey() {
  return `${currentModelProvider}\x1e${currentModelId}`;
}

function getCurrentModel() {
  return availableModels.find(model => getModelKey(model) === getCurrentModelKey());
}

function formatProvider(provider) {
  const names = {
    'ccswitch-cl': 'CC Switch · cl',
    'newapi-zhyxulei': 'NewAPI',
    'tavern-openai': 'Tavern',
    'newapi-futureppo': 'FuturePPO',
  };
  const relay = relayProviders.find(item => item.id === provider);
  return names[provider] || relay?.name || provider || t('unknownProvider');
}

function formatModelName(model) {
  if (!model) return '未知模型';
  if (MODEL_LABELS[model.id]) return MODEL_LABELS[model.id];
  const name = model.name && model.name !== model.id ? model.name : model.id;
  return String(name || '未知模型').replace(/^CC Switch CL\s*[·•-]\s*/i, '');
}

function formatContextSize(value) {
  if (!value) return '';
  if (value >= 1000000) return `${(value / 1000000).toFixed(value % 1000000 ? 1 : 0)}M`;
  return `${Math.round(value / 1000)}K`;
}

function contextSourceCopy(model) {
  if (model?.contextSource === 'custom') {
    return { short: t('ctxCustom'), detail: t('ctxCustomDetail') };
  }
  if (model?.contextSource === 'provider') {
    return { short: t('ctxProvider'), detail: t('ctxProviderDetail') };
  }
  if (model?.contextSource === 'official') {
    return { short: t('ctxOfficial'), detail: t('ctxOfficialDetail') };
  }
  if (model?.contextSource === 'config') {
    return { short: t('ctxConfig'), detail: t('ctxConfigDetail') };
  }
  if (model?.contextSource === 'unknown-error') {
    return { short: t('ctxUnknown'), detail: t('ctxUnknownErr') };
  }
  if (model?.contextSource === 'unknown') {
    return { short: t('ctxUnknown'), detail: t('ctxUnknownDetail') };
  }
  return { short: t('ctxPi'), detail: t('ctxPiDetail') };
}

function applyContextWindow(model) {
  contextWindowSize = model?.contextWindow || 0;
  contextWindowSource = model?.contextSource || (model?.contextWindow ? 'pi-registry' : 'unknown');
  updateTokenUsage();
}

function updateThinkingBtn() {
  const model = getCurrentModel();
  const unsupported = model?.reasoning === false;
  const level = THINKING_LEVELS().find(item => item.id === currentThinkingLevel) || THINKING_LEVELS()[0];
  thinkingBtn.textContent = unsupported ? t('thinkNA') : t('thinkLabel', { label: level.label });
  thinkingBtn.classList.toggle('off', currentThinkingLevel === 'off' || unsupported);
  thinkingBtn.classList.toggle('unavailable', unsupported);
  thinkingBtn.title = unsupported ? t('thinkTitleNA') : t('thinkTitle', { label: level.label });
  thinkingBtn.setAttribute('aria-disabled', String(unsupported));
}

let modelInfoInflight = null;

async function fetchModelInfo(options = {}) {
  if (modelInfoInflight && !options.refreshProviderMetadata) return modelInfoInflight;
  const task = loadModelInfo(options);
  modelInfoInflight = task;
  try {
    return await task;
  } finally {
    if (modelInfoInflight === task) modelInfoInflight = null;
  }
}

async function loadModelInfo(options = {}) {
  try {
    const needProviders = options.refreshProviderMetadata === true || options.includeProviders === true;
    const [modelsResp, stateResp, providersResp] = await Promise.all([
      fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'get_available_models',
          refreshProviderMetadata: options.refreshProviderMetadata === true,
        }),
      }),
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_state' }) }),
      needProviders
        ? fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_providers' }) }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!modelsResp.ok || !stateResp.ok) throw new Error('Failed to fetch models');
    const modelsData = await modelsResp.json();
    const stateData = await stateResp.json();
    if (providersResp && providersResp.ok) {
      try {
        const providersData = await providersResp.json();
        if (providersData?.success && Array.isArray(providersData.data?.providers)) {
          relayProviders = providersData.data.providers;
          relayBackendReady = true;
        } else {
          relayBackendReady = false;
        }
      } catch {}
    }

    if (modelsData.success && Array.isArray(modelsData.data?.models)) {
      availableModels = modelsData.data.models;
      modelMetadataMode = modelsData.data.metadataMode || 'pi-only';
    }
    if (stateData.success && stateData.data?.model) {
      currentModelId = stateData.data.model.id || '';
      currentModelProvider = stateData.data.model.provider || '';
    }
    if (stateData.success && stateData.data?.thinkingLevel) {
      currentThinkingLevel = stateData.data.thinkingLevel;
    }
    if (stateData.success && stateData.data?.planMode) {
      applyPlanModeState(stateData.data.planMode);
    }

    const model = getCurrentModel();
    applyContextWindow(model);
    updateModelLabel();
    updateThinkingBtn();

    if (options.showStatus) {
      const customCount = availableModels.filter(model => model.contextSource === 'custom').length;
      const liveCount = availableModels.filter(model => model.contextSource === 'provider').length;
      const officialCount = availableModels.filter(model => model.contextSource === 'official').length;
      const unknownCount = availableModels.filter(model => String(model.contextSource || '').startsWith('unknown')).length;
      const detail = customCount || liveCount || officialCount || unknownCount
        ? t('modelsLive', { custom: customCount, live: liveCount, official: officialCount, unknown: unknownCount })
        : '';
      showToast(t('modelsLoaded', { n: availableModels.length, detail }), 'success', 3600);
    }
  } catch (error) {
    if (options.showStatus) showToast(t('modelsLoadFail'), 'error', 4200);
  }
}

function updateModelLabel() {
  const model = getCurrentModel();
  const modelName = model ? formatModelName(model) : (currentModelId || t('pickModel'));
  const provider = currentModelProvider ? formatProvider(currentModelProvider) : t('model');
  if (modelDropdownLabel) modelDropdownLabel.textContent = modelName;
  if (modelDropdownKicker) modelDropdownKicker.textContent = provider;
  if (modelDropdownBtn) {
    modelDropdownBtn.title = model ? t('currentModel', { provider, name: modelName }) : t('switchModel');
  }
  updateThinkingBtn();
}

function toggleModelDropdown() {
  if (modelDropdownMenu.classList.contains('hidden')) openModelDropdown();
  else closeModelDropdown();
}

function openModelDropdown() {
  closeThinkingMenu();
  closePlanModeMenu();
  if (!relayProviders.length) loadRelayProviders();
  modelDropdownMenu.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'model-dropdown-head';
  header.innerHTML = `<strong>${t('chooseModel')}</strong><span>${t('modelsAvailable', { n: availableModels.length })}</span>`;
  modelDropdownMenu.appendChild(header);
  if (modelMenuNotice?.text) {
    const notice = document.createElement('div');
    notice.className = `model-menu-notice ${modelMenuNotice.kind || 'success'}`;
    notice.textContent = modelMenuNotice.text;
    modelDropdownMenu.appendChild(notice);
    modelMenuNotice = null;
  }

  const search = document.createElement('input');
  search.className = 'model-dropdown-search';
  search.placeholder = t('searchModels');
  search.type = 'search';
  search.setAttribute('aria-label', t('searchModels'));
  modelDropdownMenu.appendChild(search);

  const relayBar = document.createElement('div');
  relayBar.className = 'model-relay-bar';
  modelDropdownMenu.appendChild(relayBar);

  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'model-dropdown-items';
  itemsContainer.setAttribute('role', 'listbox');
  modelDropdownMenu.appendChild(itemsContainer);

  function paintRelayBar() {
    relayBar.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'model-relay-bar-title';
    title.textContent = t('relayBarTitle');
    relayBar.appendChild(title);
    if (!relayBackendReady) {
      const warn = document.createElement('div');
      warn.className = 'model-relay-empty';
      warn.textContent = t('errNeedRestart');
      relayBar.appendChild(warn);
    }

    const relays = getManageableRelays();
    if (!relays.length) {
      const empty = document.createElement('div');
      empty.className = 'model-relay-empty';
      empty.textContent = t('noRelaysHint');
      relayBar.appendChild(empty);
    } else {
      relays.forEach((relay) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'model-relay-row';
        const copy = document.createElement('span');
        copy.className = 'model-relay-row-copy';
        const name = document.createElement('strong');
        name.textContent = relay.name || relay.id;
        const url = document.createElement('small');
        url.textContent = relay.baseUrl || relay.id;
        copy.append(name, url);
        const meta = document.createElement('span');
        meta.className = 'model-relay-row-meta';
        meta.textContent = t('nModels', { n: relay.modelCount || 0 });
        const edit = document.createElement('span');
        edit.className = 'model-relay-row-edit';
        edit.textContent = t('editRelay');
        row.append(copy, meta, edit);
        row.addEventListener('click', (event) => {
          event.stopPropagation();
          showRelayEditor(relay);
        });
        relayBar.appendChild(row);
      });
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'model-relay-add';
    addBtn.textContent = t('addRelay');
    addBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      showRelayEditor(null);
    });
    relayBar.appendChild(addBtn);
  }

  paintRelayBar();
  loadRelayProviders().then(() => {
    if (!modelDropdownMenu.classList.contains('hidden') && !modelDropdownMenu.querySelector('.relay-editor')) {
      relaysById = new Map(getManageableRelays().map(item => [item.id, item]));
      paintRelayBar();
      renderItems(search.value);
    }
  });

  const MODEL_LIST_PREVIEW = 8;
  let relaysById = new Map(getManageableRelays().map(item => [item.id, item]));

  function buildModelItem(model, currentKey) {
    const isActive = getModelKey(model) === currentKey;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `model-dropdown-item${isActive ? ' active' : ''}`;
    el.dataset.modelKey = getModelKey(model);
    el.dataset.provider = model.provider || '';
    el.dataset.modelId = model.id || '';
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', String(isActive));

    const copy = document.createElement('span');
    copy.className = 'model-dropdown-item-copy';
    const name = document.createElement('span');
    name.className = 'model-dropdown-item-name';
    name.textContent = formatModelName(model);
    const hint = document.createElement('span');
    hint.className = 'model-dropdown-item-id';
    hint.textContent = MODEL_HINTS[model.id] || model.id || '';
    copy.append(name, hint);

    const meta = document.createElement('span');
    meta.className = 'model-dropdown-item-meta';
    const source = contextSourceCopy(model);
    const contextBadge = document.createElement('span');
    contextBadge.className = `model-context-badge context-${model.contextSource || (model.contextWindow ? 'pi-registry' : 'unknown')}`;
    contextBadge.dataset.action = 'edit-context';
    contextBadge.textContent = model.contextWindow
      ? formatContextSize(model.contextWindow)
      : source.short;
    contextBadge.title = `${source.detail}${t('ctxClickEdit')}`;
    contextBadge.setAttribute('role', 'button');
    meta.appendChild(contextBadge);
    if (model.input?.includes('image')) {
      const badge = document.createElement('span');
      badge.textContent = t('tagImage');
      meta.appendChild(badge);
    }
    if (model.reasoning) {
      const badge = document.createElement('span');
      badge.textContent = t('tagThink');
      meta.appendChild(badge);
    }
    if (isActive) {
      const check = document.createElement('span');
      check.className = 'model-active-check';
      check.textContent = '✓';
      meta.appendChild(check);
    }
    el.append(copy, meta);
    return el;
  }

  function renderItems(filter) {
    const query = (filter || '').trim().toLowerCase();
    const providerRank = { 'ccswitch-cl': 0, 'newapi-zhyxulei': 1, 'tavern-openai': 2, 'newapi-futureppo': 3 };
    const groups = new Map();
    for (const model of availableModels) {
      if (query) {
        const haystack = `${model.id || ''} ${model.name || ''} ${model.provider || ''} ${formatModelName(model)}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      const provider = model.provider || 'unknown';
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider).push(model);
    }
    const providers = [...groups.keys()].sort((a, b) =>
      (providerRank[a] ?? 9) - (providerRank[b] ?? 9)
      || formatProvider(a).localeCompare(formatProvider(b))
    );

    const frag = document.createDocumentFragment();
    if (providers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-dropdown-empty';
      empty.textContent = availableModels.length ? t('noMatchModels') : t('noModelsYet');
      frag.appendChild(empty);
      itemsContainer.replaceChildren(frag);
      return;
    }

    const currentKey = getCurrentModelKey();
    for (const provider of providers) {
      const models = groups.get(provider);
      models.sort((a, b) => formatModelName(a).localeCompare(formatModelName(b)));
      const heading = document.createElement('div');
      heading.className = 'model-dropdown-provider';
      const relay = relaysById.get(provider);
      const meta = document.createElement('span');
      meta.className = 'model-dropdown-provider-meta';
      meta.append(document.createTextNode(String(models.length)));
      if (relay) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'model-dropdown-provider-edit';
        edit.dataset.relayId = relay.id;
        edit.textContent = t('editRelay');
        meta.appendChild(edit);
      }
      const name = document.createElement('span');
      name.textContent = formatProvider(provider);
      heading.append(name, meta);
      frag.appendChild(heading);

      const limit = query ? models.length : Math.min(models.length, MODEL_LIST_PREVIEW);
      for (let i = 0; i < limit; i++) frag.appendChild(buildModelItem(models[i], currentKey));
      if (!query && models.length > MODEL_LIST_PREVIEW) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'model-dropdown-more';
        more.dataset.provider = provider;
        more.textContent = t('showMoreModels', { n: models.length });
        frag.appendChild(more);
      }
    }
    itemsContainer.replaceChildren(frag);
  }

  itemsContainer.addEventListener('click', async (event) => {
    const contextBadge = event.target.closest('[data-action="edit-context"]');
    if (contextBadge) {
      event.stopPropagation();
      const item = contextBadge.closest('.model-dropdown-item');
      const model = availableModels.find(entry => getModelKey(entry) === item?.dataset.modelKey);
      if (model) await editModelContext(model);
      return;
    }
    const edit = event.target.closest('.model-dropdown-provider-edit');
    if (edit) {
      event.stopPropagation();
      const relay = relaysById.get(edit.dataset.relayId);
      if (relay) showRelayEditor(relay);
      return;
    }
    const more = event.target.closest('.model-dropdown-more');
    if (more) {
      event.stopPropagation();
      const provider = more.dataset.provider;
      const models = availableModels
        .filter(model => (model.provider || 'unknown') === provider)
        .sort((a, b) => formatModelName(a).localeCompare(formatModelName(b)));
      const currentKey = getCurrentModelKey();
      const frag = document.createDocumentFragment();
      for (const model of models) frag.appendChild(buildModelItem(model, currentKey));
      more.replaceWith(frag);
      return;
    }
    const item = event.target.closest('.model-dropdown-item');
    if (!item) return;
    closeModelDropdown();
    const model = availableModels.find(entry => getModelKey(entry) === item.dataset.modelKey)
      || { provider: item.dataset.provider, id: item.dataset.modelId };
    const display = formatModelName(model);
    const result = await rpcCommand(
      { type: 'set_model', provider: model.provider, modelId: model.id },
      t('switchingTo', { name: display })
    );
    if (!result?.success) {
      await fetchModelInfo();
      return;
    }
    currentModelId = model.id;
    currentModelProvider = model.provider || '';
    applyContextWindow(model);
    updateModelLabel();
    showToast(t('switchedTo', { name: display }), 'success', 2600);
  });

  renderItems('');
  let searchTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderItems(search.value), 80);
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeModelDropdown();
      event.stopPropagation();
    } else if (event.key === 'Enter') {
      const first = itemsContainer.querySelector('.model-dropdown-item');
      if (first) first.click();
    }
  });

  modelDropdownMenu.classList.remove('hidden');
  modelDropdown.classList.add('open');
  modelDropdownBtn.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => search.focus());
}

function closeModelDropdown() {
  modelDropdownMenu.classList.add('hidden');
  modelDropdown.classList.remove('open');
  modelDropdownBtn.setAttribute('aria-expanded', 'false');
}

modelDropdownBtn.addEventListener('click', event => {
  event.stopPropagation();
  toggleModelDropdown();
});

// Refresh the model list from live relay providers. The server fetches each
// relay's /v1/models and registers discovered models (and drops stale ones),
// so no Pi config reload is needed here.
async function refreshModels() {
  if (!modelRefreshBtn || modelRefreshBtn.disabled) return;
  modelRefreshBtn.disabled = true;
  modelRefreshBtn.classList.add('spinning');
  showToast(t('syncingRelays'), 'loading', 1500);
  await fetchModelInfo({ showStatus: true, refreshProviderMetadata: true });
  modelRefreshBtn.disabled = false;
  modelRefreshBtn.classList.remove('spinning');
}

// Plan Mode is a three-state backend-owned feature: off, read-only planning,
// and plan execution. The browser never flips it optimistically.
let planModeState = { available: false, mode: 'unavailable', enabled: false, executing: false, awaitingAction: false, todos: [] };
let planModeBusy = false;
const planControl = document.getElementById('plan-control');
const planModeBtn = document.getElementById('plan-mode-btn');
const planModeMenu = document.getElementById('plan-mode-menu');

function normalizePlanModeState(value) {
  const state = value && typeof value === 'object' ? value : {};
  const mode = state.mode || (state.executing ? 'executing' : state.enabled ? 'planning' : state.available === false ? 'unavailable' : 'off');
  return {
    available: state.available !== false,
    mode,
    enabled: mode === 'planning',
    executing: mode === 'executing',
    awaitingAction: !!state.awaitingAction,
    todos: Array.isArray(state.todos) ? state.todos : [],
    error: state.error || '',
  };
}

function applyPlanModeState(value) {
  planModeState = normalizePlanModeState(value);
  updatePlanModeBtn();
  if (!planModeMenu?.classList.contains('hidden')) renderPlanModeMenu();
}

function planProgress() {
  const total = planModeState.todos.length;
  const done = planModeState.todos.filter(item => item?.completed).length;
  return { done, total };
}

function updatePlanModeBtn() {
  if (!planModeBtn) return;
  const { done, total } = planProgress();
  let label = t('planOff');
  let title = t('planHintOff');
  if (!planModeState.available) {
    label = t('planUnavailable');
    title = t('planUnavailableHint');
  } else if (planModeState.executing) {
    label = total ? t('planExecutingProgress', { done, total }) : t('planExecuting');
    title = t('planExecutingHint');
  } else if (planModeState.enabled) {
    label = planModeState.awaitingAction ? t('planReady') : t('planOn');
    title = planModeState.awaitingAction ? t('planReadyHint') : t('planHintOn');
  }
  planModeBtn.textContent = planModeBusy ? t('planSwitching') : label;
  planModeBtn.title = title;
  planModeBtn.disabled = planModeBusy;
  planModeBtn.classList.toggle('active', planModeState.enabled);
  planModeBtn.classList.toggle('executing', planModeState.executing);
  planModeBtn.classList.toggle('attention', planModeState.awaitingAction);
  planModeBtn.classList.toggle('unavailable', !planModeState.available);
  planModeBtn.setAttribute('aria-pressed', String(planModeState.enabled));
}

function closePlanModeMenu() {
  planModeMenu?.classList.add('hidden');
  planControl?.classList.remove('open');
  planModeBtn?.setAttribute('aria-expanded', 'false');
}

function planMenuAction(action, label, detail, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `plan-menu-item${options.primary ? ' primary' : ''}${options.danger ? ' danger' : ''}`;
  button.setAttribute('role', 'menuitem');
  button.innerHTML = `<span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span>${options.checked ? '<span class="thinking-check">✓</span>' : ''}`;
  button.addEventListener('click', async event => {
    event.stopPropagation();
    if (action === 'refine') {
      renderPlanRefineForm();
      return;
    }
    closePlanModeMenu();
    await setPlanModeAction(action);
  });
  return button;
}

function renderPlanRefineForm() {
  if (!planModeMenu) return;
  planModeMenu.innerHTML = `
    <div class="plan-menu-head"><strong>${escapeHtml(t('planRefine'))}</strong><small>${escapeHtml(t('planRefineHint'))}</small></div>
    <textarea class="plan-refine-input" id="plan-refine-input" rows="4" placeholder="${escapeHtml(t('planRefinePlaceholder'))}"></textarea>
    <div class="plan-refine-actions">
      <button type="button" class="plan-menu-back">${escapeHtml(t('cancel'))}</button>
      <button type="button" class="plan-menu-submit">${escapeHtml(t('planSendRefine'))}</button>
    </div>`;
  const input = planModeMenu.querySelector('#plan-refine-input');
  planModeMenu.querySelector('.plan-menu-back')?.addEventListener('click', event => {
    event.stopPropagation();
    renderPlanModeMenu();
  });
  planModeMenu.querySelector('.plan-menu-submit')?.addEventListener('click', async event => {
    event.stopPropagation();
    const instruction = input?.value.trim();
    if (!instruction) {
      input?.focus();
      return;
    }
    closePlanModeMenu();
    await setPlanModeAction('refine', { instruction });
  });
  requestAnimationFrame(() => input?.focus());
}

function renderPlanModeMenu() {
  if (!planModeMenu) return;
  planModeMenu.innerHTML = '';
  const { done, total } = planProgress();
  const head = document.createElement('div');
  head.className = 'plan-menu-head';
  head.innerHTML = `<strong>${escapeHtml(t('planMenuTitle'))}</strong><small>${escapeHtml(
    !planModeState.available ? t('planUnavailableHint')
      : planModeState.executing ? t('planProgressDetail', { done, total })
      : planModeState.enabled ? t('planPlanningDetail') : t('planOffDetail')
  )}</small>`;
  planModeMenu.appendChild(head);

  if (!planModeState.available) {
    const retry = planMenuAction('get_state', t('planRetry'), t('planRetryHint'), { primary: true });
    planModeMenu.appendChild(retry);
    return;
  }
  if (planModeState.mode === 'off') {
    planModeMenu.appendChild(planMenuAction('enable', t('planEnter'), t('planEnterHint'), { primary: true }));
    return;
  }
  if (planModeState.executing) {
    planModeMenu.appendChild(planMenuAction('enable', t('planBackPlanning'), t('planBackPlanningHint')));
    planModeMenu.appendChild(planMenuAction('disable', t('planStop'), t('planStopHint'), { danger: true }));
    return;
  }
  if (total > 0) {
    planModeMenu.appendChild(planMenuAction('execute', t('planExecute'), t('planExecuteHint', { n: total }), { primary: true }));
    planModeMenu.appendChild(planMenuAction('stay', t('planStay'), t('planStayHint'), { checked: !planModeState.awaitingAction }));
    planModeMenu.appendChild(planMenuAction('refine', t('planRefine'), t('planRefineHint')));
  }
  planModeMenu.appendChild(planMenuAction('disable', t('planExit'), t('planExitHint'), { danger: true }));
}

async function setPlanModeAction(action, extra = {}) {
  if (planModeBusy) return false;
  planModeBusy = true;
  updatePlanModeBtn();
  const data = await rpcCommand({ type: 'set_plan_mode', action, ...extra }, t('togglingPlan'));
  planModeBusy = false;
  if (data?.success && data.data) {
    applyPlanModeState(data.data);
    if (action !== 'get_state') showToast(t('planStateUpdated'), 'success', 2000);
    return true;
  }
  updatePlanModeBtn();
  return false;
}

planModeBtn?.addEventListener('click', event => {
  event.stopPropagation();
  closeModelDropdown();
  closeThinkingMenu();
  if (planModeMenu.classList.contains('hidden')) {
    renderPlanModeMenu();
    planModeMenu.classList.remove('hidden');
    planControl.classList.add('open');
    planModeBtn.setAttribute('aria-expanded', 'true');
  } else {
    closePlanModeMenu();
  }
});
updatePlanModeBtn();

modelRefreshBtn?.addEventListener('click', event => {
  event.stopPropagation();
  closeModelDropdown();
  closeThinkingMenu();
  refreshModels();
});

function openThinkingMenu() {
  closePlanModeMenu();
  const model = getCurrentModel();
  if (model?.reasoning === false) {
    showToast('当前模型为直答模式，无需设置思考强度', 'info', 2600);
    return;
  }
  closeModelDropdown();
  thinkingMenu.innerHTML = `<div class="thinking-menu-title">${t('thinkMenuTitle')}</div>`;
  THINKING_LEVELS().forEach(level => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `thinking-menu-item${level.id === currentThinkingLevel ? ' active' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(level.id === currentThinkingLevel));
    item.innerHTML = `<span><strong>${level.label}</strong><small>${level.hint}</small></span><span class="thinking-check">${level.id === currentThinkingLevel ? '✓' : ''}</span>`;
    item.addEventListener('click', async () => {
      closeThinkingMenu();
      const data = await rpcCommand({ type: 'set_thinking_level', level: level.id }, `正在设置为${level.label}思考…`);
      if (data?.success) {
        currentThinkingLevel = level.id;
        updateThinkingBtn();
        showToast(`思考强度：${level.label}`, 'success', 2200);
      }
    });
    thinkingMenu.appendChild(item);
  });
  thinkingMenu.classList.remove('hidden');
  thinkingControl.classList.add('open');
  thinkingBtn.setAttribute('aria-expanded', 'true');
}

function closeThinkingMenu() {
  thinkingMenu.classList.add('hidden');
  thinkingControl.classList.remove('open');
  thinkingBtn.setAttribute('aria-expanded', 'false');
}

thinkingBtn.addEventListener('click', event => {
  event.stopPropagation();
  if (thinkingMenu.classList.contains('hidden')) openThinkingMenu();
  else closeThinkingMenu();
});

document.addEventListener('click', event => {
  if (!modelDropdown.contains(event.target)) closeModelDropdown();
  if (!thinkingControl.contains(event.target)) closeThinkingMenu();
  if (planControl && !planControl.contains(event.target)) closePlanModeMenu();
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    if (planModeMenu && !planModeMenu.classList.contains('hidden')) {
      closePlanModeMenu();
      return;
    }
    // Close palettes/panels first
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (!commandPalette.classList.contains('hidden')) {
      closeCommandPalette();
      return;
    }
    if (!modelDropdownMenu.classList.contains('hidden')) {
      closeModelDropdown();
      return;
    }
    if (!thinkingMenu.classList.contains('hidden')) {
      closeThinkingMenu();
      return;
    }

    if (state.isStreaming) {
      wsClient.send({ type: 'abort' });
      showToast(t('stoppedGen'), 'info', 1800);
      setWorkPhase('idle');
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener('click', toggleSidebar);

sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



const newSessionBtn = document.getElementById('new-session-btn');
newSessionBtn.addEventListener('click', newSession);

refreshSessionsBtn.addEventListener('click', () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add('spinning');
  sidebar.loadSessions().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove('spinning'), 600);
    if (isMirrorMode) updateMirrorLiveIndicator();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

// Session search
sessionSearchInput.addEventListener('input', () => {
  sidebar.setSearchQuery(sessionSearchInput.value);
});

async function newSession() {
  if (newSessionBtn.disabled) return;
  newSessionBtn.disabled = true;
  newSessionBtn.setAttribute('aria-busy', 'true');
  try {
    const result = await rpcCommand({ type: 'new_session' }, t('newSessionWorking'));
    if (!result?.success) return;

    renderGeneration++;
    historyPageState = null;
    historyBufferedEntries = [];
    historyBufferedLoading = false;
    if (historyPageAbort) historyPageAbort.abort();
    historyPageAbort = null;
    historyPreviewSessionFile = null;
    sessionTotalCost = 0;
    lastInputTokens = 0;
    lastUsage = null;
    state.reset();
    messageRenderer.clear();
    toolCardRenderer.clear();
    messageRenderer.renderWelcome();
    sidebar.clearActive();
    viewingActiveSession = true;
    updateMirrorInputState();
    updateCostDisplay();
    updateTokenUsage();
    showToast(t('newSessionOk'), 'success', 2400);
    if (isMobile()) {
      sidebarEl.classList.add('collapsed');
      sidebarOverlay.classList.remove('visible');
    }
    if (!isMobile()) messageInput.focus();
  } finally {
    newSessionBtn.disabled = false;
    newSessionBtn.removeAttribute('aria-busy');
  }
}

async function handleSessionSelect(session, project) {
  if (!session?.filePath) return;
  sidebar.setActive(session.filePath);
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

function handleSessionRenamed(ok, _session, message) {
  if (message) showToast(message, ok ? 'success' : 'error', ok ? 2400 : 4200);
}

function handleSessionDeleted(ok, session, message) {
  if (!ok) {
    if (message) showToast(message, 'error', 4200);
    return;
  }
  if (message) showToast(message, 'success', 2400);
  const deletedPath = session?.filePath;
  const viewingDeleted =
    deletedPath &&
    (historyPreviewSessionFile === deletedPath || sidebar.activeSessionFile === deletedPath);
  if (!viewingDeleted) return;

  historyPreviewSessionFile = null;
  viewingActiveSession = true;
  historyResumeBar?.classList.add('hidden');
  if (isMirrorMode && mirrorActiveSessionFile) {
    sidebar.setActive(mirrorActiveSessionFile);
    updateMirrorInputState();
    wsClient.send({ type: 'mirror_sync_request' });
    return;
  }
  messageRenderer.clear();
  toolCardRenderer.clear();
  messageRenderer.renderWelcome();
  updateMirrorInputState();
}

async function switchSession(sessionFile, session = null, project = null) {
  try {
    renderGeneration++;
    const myGeneration = renderGeneration;
    if (historyPageAbort) historyPageAbort.abort();
    historyPageAbort = null;
    historyPageState = null;
    historyBufferedEntries = [];
    historyBufferedLoading = false;
    historyPreviewSessionFile = sessionFile || null;
    // Clear any streaming state from previous session to prevent bleed
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';
    resetStreamingDeltas();
    if (toolUpdateFrame !== null) cancelAnimationFrame(toolUpdateFrame);
    toolUpdateFrame = null;
    pendingToolUpdates.clear();
    
    state.reset();
    messageRenderer.clear();
    toolCardRenderer.clear();

    // A running session will immediately provide its mirror snapshot. Do not
    // parse the history file first and then throw that DOM away on mirror_sync.
    if (isMirrorMode && sessionFile) {
      const currentPort = Number(new URL(wsClient.url).port || location.port || 0);
      const otherInstance = liveInstances.find((item) =>
        item.sessionFile === sessionFile && Number(item.port) !== currentPort
      );
      if (otherInstance) {
        const protocol = document.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsClient.disconnect();
        wsClient.url = `${protocol}//${location.hostname}:${otherInstance.port}/ws`;
        wsClient.forceReconnect();
        mirrorActiveSessionFile = sessionFile;
        historyPreviewSessionFile = null;
        viewingActiveSession = true;
        updateMirrorInputState();
        return;
      }
      if (sessionFile === mirrorActiveSessionFile) {
        historyPreviewSessionFile = null;
        viewingActiveSession = true;
        updateMirrorInputState();
        wsClient.send({ type: 'mirror_sync_request' });
        return;
      }
    }

    if (sessionFile && session) {
      messageRenderer.renderSystemMessage('正在读取会话…');

      const dirName = project?.dirName;
      const file = session.file;
      console.log('[App] Loading history:', { dirName, file, sessionFile });

      if (dirName && file) {
        let controller = null;
        try {
          controller = new AbortController();
          historyPageAbort = controller;
          const url = `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(file)}?limit=120`;
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (myGeneration !== renderGeneration) return;
          console.log('[App] History page entries:', data.entries?.length || 0);

          historyPageState = {
            dirName,
            file,
            cursor: Number(data.cursor) || 0,
            hasMore: !!data.hasMore,
            loading: true,
            generation: myGeneration,
          };
          messageRenderer.clear();
          toolCardRenderer.clear();
          renderSessionHistory(data.entries || [], {
            onDone: () => {
              if (historyPageState?.generation === myGeneration) historyPageState.loading = false;
            },
          });
        } catch (e) {
          if (e?.name !== 'AbortError') {
            console.error('[App] History fetch error:', e);
            showToast(t('historyLoadFail'), 'error', 4200);
          }
        } finally {
          if (historyPageAbort === controller) historyPageAbort = null;
        }
      } else {
        console.log('[App] Skipped history load: dirName or file missing');
      }
    } else {
      messageRenderer.renderWelcome();
    }

    // Historical previews are read-only in mirror mode. Running sessions
    // returned above and never pay for this second session-file render.
    if (isMirrorMode) {
      viewingActiveSession = false;
      updateMirrorInputState();
    } else {
      const res = await fetch('/api/sessions/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionFile }),
      });

      if (!res.ok) {
        const err = await res.json();
        showToast(`切换会话失败：${humanizeError(err.error)}`, 'error', 4500);
      }
    }
  } catch (error) {
    console.error('[App] Failed to switch session:', error);
    showToast('切换会话失败，请稍后重试', 'error', 4500);
  }
}

// ═══════════════════════════════════════
// Mirror mode sync
// ═══════════════════════════════════════

let lastSyncSessionFile = null;
let lastSyncEntryCount = 0;
let lastSyncEntrySig = '';
let renderGeneration = 0;

function entrySignature(entry) {
  if (!entry) return '';
  const msg = entry.message || {};
  const content = Array.isArray(msg.content) ? msg.content : [];
  const last = content[content.length - 1];
  const text = typeof last?.text === 'string' ? last.text : '';
  return [entry.type || '', msg.role || '', content.length, text.length, text.slice(-24)].join(':');
}

function rememberSyncHint(data, entries = data.entries || []) {
  lastSyncSessionFile = data.sessionFile || null;
  lastSyncEntryCount = entries.length;
  const last = entries[entries.length - 1];
  lastSyncEntrySig = data.entrySig || entrySignature(last);
  wsClient.resumeHint = {
    sessionFile: lastSyncSessionFile,
    entryCount: lastSyncEntryCount,
    entrySig: lastSyncEntrySig,
  };
}

function handleMirrorSync(data) {
  console.log('[Mirror] Received state snapshot:', data.entries?.length, 'entries');
  isMirrorMode = true;
  if (data.planMode) applyPlanModeState(data.planMode);

  // Track the active session
  mirrorActiveSessionFile = data.sessionFile || null;
  historyPreviewSessionFile = null;
  viewingActiveSession = true;
  if (historyResumeBtn) {
    historyResumeBtn.disabled = false;
    historyResumeBtn.removeAttribute('aria-busy');
    historyResumeBtn.textContent = '继续对话';
  }
  updateMirrorInputState();
  updateMirrorLiveIndicator();

  // Update model display
  if (data.model) {
    currentModelId = data.model.id || '';
    currentModelProvider = data.model.provider || '';
    updateModelLabel();
    applyContextWindow(getCurrentModel() || data.model);
  }

  // Update thinking level
  if (data.thinkingLevel) {
    currentThinkingLevel = data.thinkingLevel;
    updateThinkingBtn();
  }

  if (data.tokenSaverEnabled !== undefined) {
    tokenSaverEnabled = !!data.tokenSaverEnabled;
    if (typeof updateTokenSaverBtn === 'function') updateTokenSaverBtn();
  }

  const entries = data.entries || [];
  const incomingSig = data.entrySig || entrySignature(entries[entries.length - 1]);

  // Fast reconciliation: skip re-render if same session with same tail.
  if (
    lastSyncSessionFile === data.sessionFile &&
    lastSyncEntryCount === entries.length &&
    lastSyncEntrySig === incomingSig &&
    messagesContainer.children.length > 0
  ) {
    console.log('[Mirror] Session unchanged on reconnect, skipping re-render');
    rememberSyncHint(data, entries);
    updateCostDisplay();
    updateTokenUsage();
    return;
  }

  // Cancel any in-flight renderSessionHistory batch loop
  renderGeneration++;

  // Clear and render message history
  historyPageState = null;
  historyBufferedEntries = [];
  historyBufferedLoading = false;
  if (historyPageAbort) historyPageAbort.abort();
  historyPageAbort = null;
  messageRenderer.clear();
  toolCardRenderer.clear();
  sessionTotalCost = 0;
  lastInputTokens = 0;

  const livePage = sessionPageLocation(data.sessionFile);
  if (livePage) {
    historyPageState = {
      ...livePage,
      cursor: 0,
      hasMore: true,
      loading: false,
      bootstrap: true,
      bootstrapLimit: 1,
      generation: renderGeneration,
    };
  }

  if (entries.length > 0) {
    renderSessionHistory(entries);
  } else {
    messageRenderer.renderWelcome();
  }

  rememberSyncHint(data, entries);

  updateCostDisplay();
  updateTokenUsage();
}

wsClient.addEventListener('mirrorHelloOk', (e) => {
  const data = e.detail || {};
  isMirrorMode = true;
  if (data.sessionFile) mirrorActiveSessionFile = data.sessionFile;
  viewingActiveSession = true;
  if (data.model) {
    currentModelId = data.model.id || currentModelId;
    currentModelProvider = data.model.provider || currentModelProvider;
    updateModelLabel();
    applyContextWindow(getCurrentModel() || data.model);
  }
  if (data.thinkingLevel) {
    currentThinkingLevel = data.thinkingLevel;
    updateThinkingBtn();
  }
  if (data.planMode) applyPlanModeState(data.planMode);
  // Older Tau backends omit Plan Mode from mirror_hello_ok.
  else setPlanModeAction('get_state');
  lastSyncSessionFile = data.sessionFile || lastSyncSessionFile;
  lastSyncEntryCount = data.entryCount ?? lastSyncEntryCount;
  lastSyncEntrySig = data.entrySig || lastSyncEntrySig;
  wsClient.resumeHint = {
    sessionFile: lastSyncSessionFile,
    entryCount: lastSyncEntryCount,
    entrySig: lastSyncEntrySig,
  };
  updateMirrorInputState();
  updateMirrorLiveIndicator();
  updateCostDisplay();
  updateTokenUsage();
});

// Mark all live sessions in the sidebar with a green dot
function updateMirrorLiveIndicator() {
  const liveFiles = new Set(liveInstances.map(i => i.sessionFile));
  // Also include the current mirror session
  if (mirrorActiveSessionFile) liveFiles.add(mirrorActiveSessionFile);

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('mirror-live', liveFiles.has(el.dataset.filePath));
  });
}

// Poll for running instances to mark all live sessions
let pollInFlight = false;
let liveInstancesSignature = '';
async function pollInstances() {
  if (document.visibilityState === 'hidden') return;
  if (pollInFlight) return;
  if (!wsClient.ws || wsClient.ws.readyState !== WebSocket.OPEN) return;
  pollInFlight = true;
  try {
    const res = await fetch('/api/instances', { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const data = await res.json();
      const nextInstances = data.instances || [];
      const signature = nextInstances
        .map((item) => `${item.port || ''}:${item.sessionFile || ''}`)
        .sort()
        .join('|');
      if (signature !== liveInstancesSignature) {
        liveInstancesSignature = signature;
        liveInstances = nextInstances;
        updateMirrorLiveIndicator();
      }
    }
  } catch {} finally {
    pollInFlight = false;
  }
}

// Poll every 12 seconds. Visibility checks and the WebSocket heartbeat already
// handle wake/reconnect, so a 5-second DOM/status poll was unnecessary load.
setInterval(pollInstances, 12000);
pollInstances();

// Enable/disable input based on whether we're viewing the live session
function updateMirrorInputState() {
  if (!isMirrorMode) return;

  const inputArea = document.querySelector('.input-area');
  const canResume = !viewingActiveSession && !!historyPreviewSessionFile;
  historyResumeBar?.classList.toggle('hidden', !canResume);

  if (viewingActiveSession) {
    messageInput.disabled = false;
    messageInput.placeholder = '输入任务…  Enter 发送，Shift + Enter 换行';
    inputArea?.classList.remove('mirror-readonly');
  } else {
    messageInput.disabled = true;
    messageInput.placeholder = '点击上方“继续对话”，恢复上下文后即可输入';
    inputArea?.classList.add('mirror-readonly');
  }
}

historyDeleteBtn?.addEventListener('click', async () => {
  const sessionFile = historyPreviewSessionFile;
  if (!sessionFile || historyDeleteBtn.disabled) return;
  let session = null;
  for (const project of sidebar.projects || []) {
    session = (project.sessions || []).find((item) => item.filePath === sessionFile);
    if (session) break;
  }
  await sidebar.deleteSession(session || { filePath: sessionFile }, null);
});

historyResumeBtn?.addEventListener('click', async () => {
  const sessionFile = historyPreviewSessionFile;
  if (!sessionFile || historyResumeBtn.disabled) return;

  historyResumeBtn.disabled = true;
  historyResumeBtn.setAttribute('aria-busy', 'true');
  historyResumeBtn.textContent = '正在恢复…';

  const result = await rpcCommand(
    { type: 'resume_session', sessionFile },
    '正在恢复完整上下文…'
  );
  if (result?.success) {
    historyResumeBtn.textContent = '正在切换…';
    showToast('历史对话已恢复，正在重新连接', 'success', 3200);
  } else {
    historyResumeBtn.disabled = false;
    historyResumeBtn.removeAttribute('aria-busy');
    historyResumeBtn.textContent = '继续对话';
  }
});

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

const HISTORY_VISIBLE_TAIL = 36;

function scheduleHistoryWork(callback, background = false) {
  if (background && typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => callback(), { timeout: 120 });
    return;
  }
  requestAnimationFrame(() => setTimeout(callback, background ? 8 : 0));
}

function renderSessionHistory(entries, options = {}) {
  const prepend = !!options.prepend;
  const deferOlder = options.deferOlder !== false;
  const accountMetrics = options.accountMetrics !== false;
  const myGeneration = renderGeneration;
  let userCount = 0, assistantCount = 0, toolCardCount = 0, toolResultCount = 0;
  const messages = entries.filter((entry) => entry.type === 'message' && entry.message);

  // Metrics are cheap to aggregate from JSON and should not depend on whether
  // a message has been materialized into DOM yet.
  if (accountMetrics) {
    for (const entry of messages) {
      const usage = entry.message?.usage;
      if (usage?.cost?.total) sessionTotalCost += usage.cost.total;
    }
    if (!prepend) {
      const latestUsage = [...messages].reverse().find((entry) => entry.message?.usage?.input)?.message?.usage;
      if (latestUsage?.input) {
        lastInputTokens = latestUsage.input + (latestUsage.cacheRead || 0);
        lastUsage = latestUsage;
      }
    }
  }

  const setMountTarget = (target) => {
    messageRenderer.setMountTarget(target);
    toolCardRenderer.setMountTarget(target);
  };
  const clearMountTarget = () => {
    messageRenderer.setMountTarget(null);
    toolCardRenderer.setMountTarget(null);
  };

  function renderOne(entry, trackLatestUsage) {
    const msg = entry.message;
    if (msg.role === 'user') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const images = Array.isArray(msg.content)
        ? msg.content.filter((b) => b.type === 'image').map((b) => ({
            data: b.source?.data || b.data || '',
            mimeType: b.source?.media_type || b.media_type || 'image/png',
          }))
        : [];
      if (content || images.length > 0) {
        userCount++;
        messageRenderer.renderUserMessage({ content: content || '', images: images.length > 0 ? images : undefined }, true);
      }
      return;
    }

    if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const textBlocks = content.filter((b) => b.type === 'text');
      const thinkingBlocks = content.filter((b) => b.type === 'thinking');
      const toolCalls = content.filter((b) => b.type === 'toolCall');
      const contentBlocks = content.filter((b) => b.type === 'text' || b.type === 'thinking');
      const text = textBlocks.map((b) => b.text).join('\n');

      if (msg.stopReason === 'error' && msg.errorMessage) {
        assistantCount++;
        if (text || thinkingBlocks.length > 0) {
          messageRenderer.renderAssistantMessage({ content: contentBlocks.length > 0 ? contentBlocks : text, usage: msg.usage }, false, true);
        }
        messageRenderer.renderError(humanizeModelError(msg.errorMessage), true);
      } else if (text || thinkingBlocks.length > 0) {
        assistantCount++;
        messageRenderer.renderAssistantMessage({ content: contentBlocks.length > 0 ? contentBlocks : text, usage: msg.usage }, false, true);
      }

      for (const tc of toolCalls) {
        toolCardCount++;
        toolCardRenderer.createHistoryCard({ toolCallId: tc.id, toolName: tc.name, args: tc.arguments || {} });
      }
      return;
    }

    if (msg.role === 'toolResult') {
      toolResultCount++;
      toolCardRenderer.addHistoryResult(msg.toolCallId, { content: msg.content || [] }, msg.isError);
    }
  }

  function processRange(start, end, target, config, done) {
    let index = start;
    const background = !!config.background;
    const budget = background ? 5 : 7;
    function batch() {
      if (myGeneration !== renderGeneration) {
        clearMountTarget();
        return;
      }
      const deadline = performance.now() + budget;
      setMountTarget(target);
      while (index < end) {
        renderOne(messages[index], !!config.trackLatestUsage);
        index++;
        if (performance.now() >= deadline) break;
      }
      clearMountTarget();
      if (index < end) scheduleHistoryWork(batch, background);
      else done();
    }
    batch();
  }

  function updateSummary() {
    updateCostDisplay();
    updateTokenUsage();
  }

  function insertBeforePreservingPosition(fragment, beforeNode) {
    const anchor = beforeNode || messagesContainer.firstChild;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const previousAnchorMode = messagesContainer.style.overflowAnchor;
    historyPrependInProgress = true;
    messagesContainer.style.overflowAnchor = 'none';
    messagesContainer.insertBefore(fragment, anchor || null);
    if (anchor && Number.isFinite(anchorTop)) {
      messagesContainer.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      previousMessagesScrollTop = messagesContainer.scrollTop;
    }
    requestAnimationFrame(() => {
      messagesContainer.style.overflowAnchor = previousAnchorMode;
      historyPrependInProgress = false;
    });
  }

  function complete() {
    updateSummary();
    messageRenderer.flushPendingMath();
    options.onDone?.();
    console.log(`[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`);
  }

  if (messages.length === 0) {
    options.onReady?.();
    complete();
    return;
  }

  if (prepend) {
    const fragment = document.createDocumentFragment();
    processRange(0, messages.length, fragment, { background: true, trackLatestUsage: false }, () => {
      if (myGeneration !== renderGeneration) return;
      insertBeforePreservingPosition(fragment, options.beforeNode || messagesContainer.firstChild);
      options.onReady?.();
      complete();
    });
    return;
  }

  const tailStart = Math.max(0, messages.length - HISTORY_VISIBLE_TAIL);
  if (deferOlder && tailStart > 0) {
    historyBufferedEntries = messages.slice(0, tailStart);
  }
  const tailFragment = document.createDocumentFragment();
  processRange(tailStart, messages.length, tailFragment, { background: false, trackLatestUsage: true }, () => {
    if (myGeneration !== renderGeneration) return;
    const tailAnchor = tailFragment.firstChild;
    messagesContainer.appendChild(tailFragment);
    jumpMessagesToBottom();
    updateSummary();
    options.onReady?.();
    messageRenderer.flushPendingMath();

    if (tailStart === 0 || deferOlder) {
      complete();
      return;
    }

    const olderFragment = document.createDocumentFragment();
    processRange(0, tailStart, olderFragment, { background: true, trackLatestUsage: false }, () => {
      if (myGeneration !== renderGeneration) return;
      insertBeforePreservingPosition(olderFragment, tailAnchor);
      complete();
    });
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}:${String(rem).padStart(2, '0')}`;
}

function workStatusCopy(phase) {
  if (phase === 'thinking') return t('workThinking');
  if (phase === 'writing') return t('workWriting');
  if (phase === 'tool') return activeToolName ? t('workToolNamed', { name: activeToolName }) : t('workTool');
  if (phase === 'starting') return t('workStarting');
  return '';
}

function setWorkPhase(phase) {
  if (phase === workPhase && phase !== 'tool') return;
  workPhase = phase;
  const inputArea = document.querySelector('.input-area');
  if (phase === 'idle') {
    workStartedAt = 0;
    activeToolName = '';
    if (workElapsedTimer) {
      clearInterval(workElapsedTimer);
      workElapsedTimer = null;
    }
    statusEl?.classList.remove('working', 'thinking', 'writing', 'tool', 'starting');
    inputArea?.classList.remove('working');
    statusElapsed?.classList.add('hidden');
    if (statusElapsed) statusElapsed.textContent = '';
    if (hasFocus) document.title = originalTitle;
    return;
  }
  if (!workStartedAt) workStartedAt = Date.now();
  statusEl?.classList.remove('thinking', 'writing', 'tool', 'starting');
  statusEl?.classList.add('working', phase);
  inputArea?.classList.add('working');
  if (statusText) {
    statusText.textContent = workStatusCopy(phase) || t('piWorking');
    statusText.title = t('escStop');
  }
  if (statusElapsed) {
    statusElapsed.classList.remove('hidden');
    statusElapsed.textContent = formatElapsed(Date.now() - workStartedAt);
  }
  if (!workElapsedTimer) {
    workElapsedTimer = setInterval(() => {
      if (!workStartedAt || !statusElapsed) return;
      statusElapsed.textContent = formatElapsed(Date.now() - workStartedAt);
    }, 1000);
  }
  if (!hasFocus) document.title = `● ${workStatusCopy(phase)} · ${originalTitle}`;
}

function updateCostDisplay() {
  if (sessionTotalCost > 0) {
    sessionCostEl.textContent = `$${sessionTotalCost.toFixed(4)}`;
    sessionCostEl.classList.add('visible');
  } else {
    sessionCostEl.classList.remove('visible');
  }
}

function updateTokenUsage() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    tokenUsageEl.textContent = pct === 0 ? '<1%' : `${pct}%`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
    if (pct >= 80) {
      tokenUsageEl.classList.add('critical');
    } else if (pct >= 60) {
      tokenUsageEl.classList.add('warning');
    }
    const sourceLabel = contextSourceCopy({ contextSource: contextWindowSource }).detail;
    tokenUsageEl.title = t('ctxTitle', {
      used: `${(lastInputTokens / 1000).toFixed(1)}K`,
      total: formatContextSize(contextWindowSize),
      source: sourceLabel,
    });
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    tokenUsageEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
    hideCompactButton();
  } else {
    tokenUsageEl.classList.remove('warning', 'critical');
    hideCompactButton();
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.type = 'button';
  btn.textContent = t('compactBtn');
  btn.title = t('compactBtnTitle');
  btn.setAttribute('aria-label', t('compactBtnTitle'));
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-working');
    btn.textContent = t('compactWorkingShort');
    const result = await rpcCommand({ type: 'compact' }, t('compactWorking'));
    if (result?.success) hideCompactButton();
    else {
      btn.disabled = false;
      btn.classList.remove('is-working');
      btn.textContent = t('compactBtn');
    }
  });
  // Keep the action in the same fixed-height group as the usage pill. This
  // prevents the critical state from pushing the status cluster out of line.
  const group = tokenUsageEl.closest('.context-usage-group') || tokenUsageEl.parentElement;
  group.appendChild(btn);
}

function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await fetchModelInfo();
}

let tailscaleUrl = '';

function updateConnectionStatus(status) {
  const previous = connectionState;
  connectionState = status;
  statusIndicator.className = `status-indicator ${status}`;

  if (status === 'connected') {
    if (workPhase === 'idle') {
      statusText.textContent = tailscaleUrl ? `${t('connected')} · TS` : t('connected');
      statusText.title = tailscaleUrl || t('connectedPi');
    }
    if (previous === 'disconnected') showToast(t('reconnected'), 'success', 2200);
    if (!tailscaleUrl) {
      // Delay health check to avoid competing with mirror_sync during reconnect
      setTimeout(() => {
        fetch('/api/health').then(r => r.json()).then(data => {
          if (data.tailscaleUrl) {
            tailscaleUrl = data.tailscaleUrl;
            statusText.textContent = `${t('connected')} · TS`;
            statusText.title = tailscaleUrl;
          }
        }).catch(() => {});
      }, 3000);
    }
  } else if (status === 'disconnected') {
    statusText.textContent = t('disconnected');
    statusText.title = t('waitingReconnect');
    if (previous === 'connected') showToast(t('reconnecting'), 'warning', 3200);
  }
}

function updateUI() {
  const isStreaming = state.isStreaming;

  if (isStreaming) {
    statusIndicator.classList.add('streaming');
    statusIndicator.classList.remove('connected');
    statusText.textContent = workStatusCopy(workPhase) || t('piWorking');
    statusText.title = t('escStop');
  } else {
    statusIndicator.classList.remove('streaming');
    statusIndicator.classList.toggle('connected', connectionState === 'connected');
    statusText.textContent = connectionState === 'connected' ? (tailscaleUrl ? `${t('connected')} · TS` : t('connected')) : t('disconnected');
  }

  messageInput.disabled = false;
  sendBtn.disabled = false;

  if (isStreaming) {
    abortBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    flushQueue();
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  console.log('[App] Session switched');
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const themeGrid = document.getElementById('theme-grid');


const toggleAutoCompact = document.getElementById('toggle-auto-compact');
const btnThinkingLevel = document.getElementById('btn-thinking-level');
const toggleShowThinking = document.getElementById('toggle-show-thinking');
const tokenSaverBtn = document.getElementById('toggle-token-saver');

function updateTokenSaverBtn() {
  tokenSaverBtn.className = `settings-toggle${tokenSaverEnabled ? ' on' : ''}`;
  tokenSaverBtn.title = t(tokenSaverEnabled ? 'tokenSaverOn' : 'tokenSaverOff');
}
updateTokenSaverBtn();

function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span><span class="swatch-name">${theme.name}</span>`;
    btn.title = `使用${theme.name}主题`;
    btn.addEventListener('click', () => {
      applyTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

async function openSettings() {
  buildThemeGrid();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');

  // Fetch current state for toggles
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state' }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      if (s.tokenSaverEnabled !== undefined) {
        tokenSaverEnabled = !!s.tokenSaverEnabled;
        localStorage.setItem('tau-token-saver', String(tokenSaverEnabled));
        updateTokenSaverBtn();
      }

      // Thinking level
      currentThinkingLevel = s.thinkingLevel || 'off';
      const level = THINKING_LEVELS().find(item => item.id === currentThinkingLevel) || THINKING_LEVELS()[0];
      btnThinkingLevel.textContent = level.label;
      updateThinkingBtn();
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', () => openSettings());
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Token saver is intentionally conservative: it does not rewrite prompts or
// truncate history. It disables reasoning tokens and restores the previous level.
tokenSaverBtn.addEventListener('click', async () => {
  const result = await rpcCommand({ type: 'set_token_saver', enabled: !tokenSaverEnabled }, t('tokenSaverWorking'));
  if (result?.success && result.data) {
    tokenSaverEnabled = !!result.data.enabled;
    localStorage.setItem('tau-token-saver', String(tokenSaverEnabled));
    currentThinkingLevel = result.data.thinkingLevel || currentThinkingLevel;
    updateTokenSaverBtn();
    updateThinkingBtn();
    showToast(t(tokenSaverEnabled ? 'tokenSaverOn' : 'tokenSaverOff'), 'success', 2200);
  }
});

// Auto-compaction toggle
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  const data = await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
  if (data?.success) showToast(`自动整理已${isOn ? '关闭' : '开启'}`, 'success', 2000);
});

// Thinking level cycle (settings panel button)
btnThinkingLevel.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' }, '正在调整思考强度…');
  if (data?.success && data.data?.level) {
    currentThinkingLevel = data.data.level;
    const level = THINKING_LEVELS().find(item => item.id === currentThinkingLevel) || THINKING_LEVELS()[0];
    btnThinkingLevel.textContent = level.label;
    updateThinkingBtn();
    showToast(`思考强度：${level.label}`, 'success', 2000);
  }
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('tau-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  localStorage.setItem('tau-show-thinking', !isOn);
});

// Auth toggle
const toggleAuth = document.getElementById('toggle-auth');
const authSection = document.getElementById('settings-auth-section');

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});

// ═══════════════════════════════════════
// Provider settings
// ═══════════════════════════════════════

let editingRelayId = null;

async function loadRelayProviders() {
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_providers' }),
    });
    const data = await resp.json();
    if (data?.success && Array.isArray(data.data?.providers)) {
      relayProviders = data.data.providers;
      relayBackendReady = true;
    } else {
      relayBackendReady = false;
    }
  } catch {
    relayBackendReady = false;
  }
}

function parseContextInput(raw) {
  const text = String(raw || '').trim().toLowerCase().replace(/,/g, '');
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!match) return NaN;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return NaN;
  if (match[2] === 'm') return Math.round(value * 1000000);
  if (match[2] === 'k') return Math.round(value * 1000);
  return Math.round(value);
}

async function editModelContext(model) {
  const source = contextSourceCopy(model);
  const official = model.officialContextWindow ? formatContextSize(model.officialContextWindow) : t('ctxNone');
  const relay = model.providerContextWindow ? formatContextSize(model.providerContextWindow) : t('ctxNone');
  const current = model.contextWindow ? formatContextSize(model.contextWindow) : t('ctxUnknown');
  const hint = [
    t('ctxEditLead', { name: formatModelName(model) }),
    t('ctxEditCurrent', { value: current, source: source.short }),
    t('ctxEditOfficial', { value: official }),
    t('ctxEditRelay', { value: relay }),
    t('ctxEditHint'),
  ].join('\n');
  const entered = window.prompt(hint, model.contextWindow ? String(model.contextWindow) : '');
  if (entered === null) return;
  const reset = !String(entered).trim();
  const nextWindow = reset ? null : parseContextInput(entered);
  if (!reset && !Number.isFinite(nextWindow)) {
    showToast(t('ctxEditInvalid'), 'error', 3600);
    return;
  }
  const data = await rpcCommand({
    type: 'save_model_context',
    provider: model.provider,
    modelId: model.id,
    contextWindow: nextWindow,
    reset,
  }, reset ? t('ctxResetting') : t('ctxSaving'));
  if (!data?.success) return;
  await fetchModelInfo({ refreshProviderMetadata: true });
  showToast(reset ? t('ctxResetOk', { name: formatModelName(model) }) : t('ctxSaved', {
    name: formatModelName(model),
    value: formatContextSize(data.data?.contextWindow || nextWindow),
  }), 'success', 2800);
}

function slugifyRelayId(name) {
  const ascii = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii) return ascii.slice(0, 32);
  return `relay-${Date.now().toString(36)}`;
}

function showRelayEditor(provider) {
  if (!modelDropdownMenu) return;
  closeThinkingMenu();
  editingRelayId = provider?.id || '';
  const isNew = !provider;
  const api = provider?.api || 'openai-completions';
  modelDropdown.classList.add('open');
  modelDropdownBtn.setAttribute('aria-expanded', 'true');
  modelDropdownMenu.classList.remove('hidden');
  modelDropdownMenu.innerHTML = `
    <div class="relay-editor in-model-menu">
      <div class="relay-editor-title">${isNew ? t('addRelayTitle') : t('editRelayTitle', { name: escapeHtml(provider.name || provider.id) })}</div>
      <p class="settings-lead">${t('relayLead')}</p>
      <label class="relay-field">
        <span>${t('name')}</span>
        <input id="relay-name" class="settings-input relay-input" placeholder="${escapeHtml(t('namePh'))}" value="${escapeHtml(provider?.name || '')}" />
      </label>
      <label class="relay-field">
        <span>${t('apiUrl')}</span>
        <input id="relay-url" class="settings-input relay-input" placeholder="https://api.example.com/v1" value="${escapeHtml(provider?.baseUrl || '')}" />
      </label>
      <label class="relay-field">
        <span>${t('apiKey')}</span>
        <input id="relay-key" class="settings-input relay-input" type="password" placeholder="${escapeHtml(provider?.apiKeySet ? t('keySaved') : t('keyPh'))}" value="" autocomplete="off" />
      </label>
      <details class="relay-advanced">
        <summary>${t('advanced')}</summary>
        <label class="relay-field">
          <span>${t('internalId')}</span>
          <input id="relay-id" class="settings-input relay-input" ${isNew ? '' : 'readonly'} placeholder="${escapeHtml(t('idPh'))}" value="${escapeHtml(provider?.id || '')}" />
        </label>
        <label class="relay-field">
          <span>${t('apiType')}</span>
          <select id="relay-api" class="settings-input relay-input">
            <option value="openai-completions" ${api === 'openai-completions' ? 'selected' : ''}>${t('apiCompat')}</option>
            <option value="openai-responses" ${api === 'openai-responses' ? 'selected' : ''}>OpenAI Responses</option>
            <option value="anthropic-messages" ${api === 'anthropic-messages' ? 'selected' : ''}>Anthropic Messages</option>
          </select>
        </label>
      </details>
      <div class="relay-actions">
        <button type="button" class="relay-btn" id="relay-test-btn">${t('testFirst')}</button>
        <button type="button" class="relay-btn primary" id="relay-save-btn">${t('saveSync')}</button>
        ${isNew ? '' : `<button type="button" class="relay-btn danger" id="relay-delete-btn">${t('delete')}</button>`}
        <button type="button" class="relay-btn ghost" id="relay-cancel-btn">${t('cancel')}</button>
      </div>
      <div class="relay-status" id="relay-status"></div>
    </div>
  `;
  const nameInput = document.getElementById('relay-name');
  const idInput = document.getElementById('relay-id');
  if (isNew && nameInput && idInput) {
    nameInput.addEventListener('input', () => {
      if (!idInput.dataset.manual) idInput.value = slugifyRelayId(nameInput.value);
    });
    idInput.addEventListener('input', () => { idInput.dataset.manual = '1'; });
  }
  document.getElementById('relay-test-btn')?.addEventListener('click', testRelayFromEditor);
  document.getElementById('relay-save-btn')?.addEventListener('click', saveRelayFromEditor);
  document.getElementById('relay-delete-btn')?.addEventListener('click', deleteRelayFromEditor);
  document.getElementById('relay-cancel-btn')?.addEventListener('click', () => openModelDropdown());
  nameInput?.focus();
}

function readRelayEditor() {
  return {
    id: document.getElementById('relay-id')?.value.trim() || '',
    name: document.getElementById('relay-name')?.value.trim() || '',
    baseUrl: document.getElementById('relay-url')?.value.trim() || '',
    apiKey: document.getElementById('relay-key')?.value.trim() || '',
    api: document.getElementById('relay-api')?.value || 'openai-completions',
  };
}

function setRelayStatus(text, kind = 'info') {
  const el = document.getElementById('relay-status');
  if (!el) return;
  el.className = `relay-status ${kind}`;
  el.textContent = text || '';
}

async function testRelayFromEditor() {
  const form = readRelayEditor();
  if (!form.baseUrl) {
    setRelayStatus(t('needUrl'), 'error');
    return;
  }
  setRelayStatus(t('testingRelay'), 'info');
  const data = await rpcCommand({
    type: 'test_provider',
    id: form.id,
    baseUrl: form.baseUrl,
    apiKey: form.apiKey || undefined,
  });
  if (!data?.success) {
    setRelayStatus(humanizeError(data?.error) || t('testFail'), 'error');
    return;
  }
  const sample = (data.data.models || []).slice(0, 4).map(m => m.id).join(' / ');
  setRelayStatus(t('testOk', { n: data.data.count, sample: sample ? t('testOkSample', { sample }) : '' }), 'success');
}

async function saveRelayFromEditor() {
  const form = readRelayEditor();
  if (!form.baseUrl) {
    setRelayStatus(t('needUrl'), 'error');
    return;
  }
  if (!form.id) {
    form.id = slugifyRelayId(form.name || form.baseUrl);
    const idInput = document.getElementById('relay-id');
    if (idInput) idInput.value = form.id;
  }
  setRelayStatus(t('savingRelay'), 'info');
  const data = await rpcCommand({
    type: 'save_provider',
    ...form,
    name: form.name || form.id,
    fetchModels: true,
    apiKey: form.apiKey || undefined,
  });
  if (!data?.success) {
    setRelayStatus(humanizeError(data?.error) || t('saveFail'), 'error');
    return;
  }
  const saved = data.data.provider;
  if (data.data.fetchError) {
    showToast(t('savedNoModels', { name: saved.name || saved.id }), 'warning', 4200);
    setRelayStatus(t('savedNoModelsDetail', { err: data.data.fetchError }), 'error');
  } else {
    showToast(t('savedOk', { name: saved.name || saved.id, n: saved.modelCount || 0 }), 'success', 3600);
  }
  await loadRelayProviders();
  await fetchModelInfo({ showStatus: false, refreshProviderMetadata: true });
  openModelDropdown();
}

function dropProviderLocally(id) {
  const before = availableModels.length;
  relayProviders = relayProviders.filter((item) => item.id !== id);
  availableModels = availableModels.filter((model) => model.provider !== id);
  if (currentModelProvider === id) {
    currentModelId = '';
    currentModelProvider = '';
    updateModelLabel();
  }
  return before - availableModels.length;
}

async function deleteRelayFromEditor() {
  const form = readRelayEditor();
  if (!form.id) return;
  const name = form.name || form.id;
  if (!confirm(t('confirmDelete', { name }))) return;
  const deleteBtn = document.getElementById('relay-delete-btn');
  const saveBtn = document.getElementById('relay-save-btn');
  const testBtn = document.getElementById('relay-test-btn');
  if (deleteBtn) deleteBtn.disabled = true;
  if (saveBtn) saveBtn.disabled = true;
  if (testBtn) testBtn.disabled = true;
  setRelayStatus(t('deletingRelay', { name }), 'info');
  const data = await rpcCommand({ type: 'delete_provider', id: form.id });
  if (!data?.success) {
    if (deleteBtn) deleteBtn.disabled = false;
    if (saveBtn) saveBtn.disabled = false;
    if (testBtn) testBtn.disabled = false;
    setRelayStatus(humanizeError(data?.error) || t('deleteFail'), 'error');
    return;
  }
  const removed = dropProviderLocally(form.id);
  const message = t('deletedBanner', { name, n: removed });
  modelMenuNotice = { kind: 'success', text: message };
  showToast(message, 'success', 3200);
  if (modelDropdownMenu) {
    modelDropdownMenu.innerHTML = `
      <div class="relay-editor in-model-menu">
        <div class="model-menu-notice success">${escapeHtml(message)}</div>
        <div class="relay-actions">
          <button type="button" class="relay-btn primary" id="relay-deleted-back">${escapeHtml(t('backToRelays'))}</button>
        </div>
      </div>
    `;
    document.getElementById('relay-deleted-back')?.addEventListener('click', (event) => {
      event.stopPropagation();
      openModelDropdown();
    });
  }
  await loadRelayProviders();
  await fetchModelInfo({ showStatus: false, refreshProviderMetadata: true });
  dropProviderLocally(form.id);
}

// Restore saved theme
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);

// ═══════════════════════════════════════
// Context Window Visualiser
// ═══════════════════════════════════════

const contextViz = document.getElementById('context-viz');
const contextBar = document.getElementById('context-bar');
const contextLegend = document.getElementById('context-legend');
const contextVizUsed = document.getElementById('context-viz-used');
const contextVizTotal = document.getElementById('context-viz-total');


function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function updateContextViz() {
  if (!lastUsage || !contextWindowSize) return;

  const input = lastUsage.input || 0;
  const cacheRead = lastUsage.cacheRead || 0;
  const cacheWrite = lastUsage.cacheWrite || 0;
  const output = lastUsage.output || 0;
  const total = contextWindowSize;

  // Input tokens include cache — break it down
  // "input" from API = fresh (uncached) input tokens
  // "cacheRead" = tokens served from cache (system prompt, earlier messages)
  const freshInput = input;
  const totalUsed = freshInput + cacheRead;
  const free = Math.max(0, total - totalUsed);

  const segments = [
    { key: 'cache', label: '缓存', tokens: cacheRead, color: 'cache' },
    { key: 'messages', label: '消息', tokens: freshInput, color: 'messages' },
    { key: 'free', label: '可用', tokens: free, color: 'free' },
  ];

  // Build bar
  contextBar.innerHTML = '';
  for (const seg of segments) {
    if (seg.tokens <= 0) continue;
    const pct = (seg.tokens / total) * 100;
    const el = document.createElement('div');
    el.className = `context-bar-segment ${seg.color}`;
    el.style.width = `${pct}%`;
    el.title = `${seg.label}: ${formatTokens(seg.tokens)}`;
    contextBar.appendChild(el);
  }

  // Build legend
  contextLegend.innerHTML = '';
  for (const seg of segments) {
    const item = document.createElement('div');
    item.className = 'context-legend-item';
    item.innerHTML = `
      <span class="context-legend-left">
        <span class="context-legend-dot ${seg.color}"></span>
        ${seg.label}
      </span>
      <span class="context-legend-value">${formatTokens(seg.tokens)}</span>
    `;
    contextLegend.appendChild(item);
  }

  // Footer
  const pct = Math.round((totalUsed / total) * 100);
  contextVizUsed.textContent = `已使用 ${pct}%`;
  contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
}

// Toggle on click
tokenUsageEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = contextViz.classList.contains('hidden');
  if (isHidden) {
    updateContextViz();
    contextViz.classList.remove('hidden');
  } else {
    contextViz.classList.add('hidden');
  }
});

// Close on click outside
document.addEventListener('click', (e) => {
  if (!contextViz.contains(e.target) && e.target !== tokenUsageEl) {
    contextViz.classList.add('hidden');
  }
});

// ═══════════════════════════════════════
// Voice Input
// ═══════════════════════════════════════

const micBtn = document.getElementById('mic-btn');
let recognition = null;
let isRecording = false;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'zh-CN';

  let finalTranscript = '';
  let interimTranscript = '';

  recognition.addEventListener('result', (e) => {
    interimTranscript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interimTranscript += e.results[i][0].transcript;
      }
    }
    // Show live transcription in the input
    messageInput.value = finalTranscript + interimTranscript;
    messageInput.dispatchEvent(new Event('input'));
  });

  recognition.addEventListener('end', () => {
    if (isRecording) {
      // Stopped unexpectedly — clean up
      stopRecording();
    }
  });

  recognition.addEventListener('error', (e) => {
    console.error('[Voice] Error:', e.error);
    showToast('没有听清，请检查麦克风权限后重试', 'warning', 3200);
    stopRecording();
  });

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  function startRecording() {
    finalTranscript = messageInput.value; // Append to existing text
    interimTranscript = '';
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.title = '停止语音输入';
    recognition.start();
    messageInput.focus();
  }

  function stopRecording() {
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.title = '语音输入';
    try { recognition.stop(); } catch {}
    // Commit final transcript
    messageInput.value = finalTranscript;
    messageInput.dispatchEvent(new Event('input'));
    messageInput.focus();
  }
} else {
  // No speech recognition support — hide mic button
  micBtn.style.display = 'none';
}



// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, move cost + token usage above input
if (isMobile()) {
  sidebarEl.classList.add('collapsed');

  const mobileBar = document.getElementById('mobile-model-bar');
  const sessionCost = document.getElementById('session-cost');
  const tokenUsage = document.getElementById('token-usage');
  if (mobileBar && sessionCost && tokenUsage) {
    mobileBar.appendChild(sessionCost);
    mobileBar.appendChild(tokenUsage);
  }

  // Start collapsed
  mobileBar.classList.add('collapsed');

  // Toggle via chevron
  const contextToggle = document.getElementById('mobile-context-toggle');
  contextToggle.addEventListener('click', () => {
    mobileBar.classList.toggle('collapsed');
    contextToggle.classList.toggle('flipped', !mobileBar.classList.contains('collapsed'));
  });
}

// Launcher
const launcherEl = document.getElementById('launcher');
const launcher = new Launcher(launcherEl, async (projectPath) => {
  try {
    const res = await fetch('/api/projects/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath }),
    });
    const data = await res.json();
    if (data.ok) {
      // Refresh the launcher to show the new active instance
      setTimeout(() => launcher.load(), 2000);
    }
  } catch (e) {
    console.error('[Launcher] Failed to launch:', e);
  }
});

// Check if launcher should show (projects configured)
async function initLauncher() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (data.projects && data.projects.length > 0) {
      launcher.projects = data.projects;
      launcher.render();
      // Show launcher by default, add a nav link in the sidebar
      addLauncherNav();
    }
  } catch {}
}

function addLauncherNav() {
  const modeToggle = document.getElementById('mode-toggle');
  if (!modeToggle || modeToggle.querySelector('.mode-link-launcher')) return;

  const launcherLink = document.createElement('span');
  launcherLink.className = 'mode-link mode-link-launcher';
  launcherLink.title = '项目';
  launcherLink.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  launcherLink.addEventListener('click', () => {
    showLauncher();
  });
  modeToggle.appendChild(launcherLink);
}

function showLauncher() {
  launcherEl.classList.remove('hidden');
  messagesContainer.style.display = 'none';
  document.querySelector('.input-area').style.display = 'none';
  document.querySelector('.welcome')?.remove();

  // Update nav state
  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link-launcher')?.classList.add('active');

  launcher.load();
}

function hideLauncher() {
  launcherEl.classList.add('hidden');
  messagesContainer.style.display = '';
  document.querySelector('.input-area').style.display = '';

  // Update nav state
  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link:first-child')?.classList.add('active');
}

// Make the tau icon in sidebar switch back to chat
document.querySelector('.mode-link:first-child')?.addEventListener('click', () => {
  hideLauncher();
});

wsClient.connect();
messageRenderer.renderWelcome();
sidebar.loadSessions().then(() => {
  if (isMirrorMode) updateMirrorLiveIndicator();
});
initLauncher();

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('🚀 Tau initialized');
