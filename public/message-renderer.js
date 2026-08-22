/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { renderMarkdown, renderUserMarkdown } from './markdown.js';
import { t } from './i18n.js';

function findStableMarkdownEnd(src) {
  // Only lock finished fences and tables. Lists / paragraphs can still grow,
  // so splitting them would change the live layout.
  let lastSafe = 0;
  let inFence = false;
  let inTable = false;
  let lineStart = 0;
  const len = src.length;
  for (let i = 0; i <= len; i++) {
    if (i !== len && src.charCodeAt(i) !== 10) continue;
    const line = src.slice(lineStart, i);
    const next = i === len ? len : i + 1;
    const trimmed = line.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      inTable = false;
      if (!inFence) lastSafe = next;
      lineStart = next;
      continue;
    }
    if (inFence) {
      lineStart = next;
      continue;
    }
    const isTable = trimmed.startsWith('|') && trimmed.endsWith('|');
    if (isTable) {
      inTable = true;
      lineStart = next;
      continue;
    }
    if (inTable) {
      inTable = false;
      lastSafe = lineStart;
    }
    lineStart = next;
  }
  return lastSafe > 0 && lastSafe < src.length ? lastSafe : 0;
}

let katexLoader = null;
function loadKatex() {
  if (typeof renderMathInElement === 'function') return Promise.resolve();
  if (katexLoader) return katexLoader;
  katexLoader = new Promise((resolve) => {
    const done = () => resolve();
    if (!document.querySelector('link[data-katex]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'vendor/katex/katex.min.css';
      css.dataset.katex = '1';
      document.head.appendChild(css);
    }
    const finish = () => {
      if (typeof renderMathInElement === 'function') {
        done();
        return;
      }
      const auto = document.createElement('script');
      auto.src = 'vendor/katex/contrib/auto-render.min.js';
      auto.onload = done;
      auto.onerror = done;
      document.head.appendChild(auto);
    };
    if (typeof katex !== 'undefined') {
      finish();
      return;
    }
    const js = document.createElement('script');
    js.src = 'vendor/katex/katex.min.js';
    js.onload = finish;
    js.onerror = done;
    document.head.appendChild(js);
  });
  return katexLoader;
}

export class MessageRenderer {
  constructor(container) {
    this.container = container;
    this.isNearBottom = true;
    this._thinkingTimers = new Map();
    this._scrollPending = false;

    this.container.addEventListener('scroll', () => {
      if (this._scrollPending) return;
      this._scrollPending = true;
      requestAnimationFrame(() => {
        this._scrollPending = false;
        const threshold = 100;
        this.isNearBottom =
          this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
      });
    }, { passive: true });
  }

  clear() {
    for (const timer of this._thinkingTimers.values()) clearInterval(timer);
    this._thinkingTimers.clear();
    this.container.innerHTML = '';
  }

  /**
   * Render KaTeX math in the given element if the library is loaded.
   * Safe to call on streaming/escaped content — KaTeX only processes $...$ patterns.
   */
  _renderMath(element) {
    const paint = () => {
      if (typeof renderMathInElement !== 'function') return;
      try {
        renderMathInElement(element, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch {}
    };
    if (typeof renderMathInElement === 'function') {
      paint();
      return;
    }
    loadKatex().then(paint);
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/tau-192.png" alt="Tau" class="tau-icon-welcome"></div>
        <p>${t('welcomeHi')}</p>
        <p class="hint">${t('welcomeHint')}</p>
        <div class="shortcuts-hint">
          <span><kbd>/</kbd> ${t('shortcutFocus')}</span>
          <span><kbd>Esc</kbd> ${t('shortcutStop')}</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;

    let imagesHtml = '';
    if (message.images && message.images.length > 0) {
      imagesHtml = '<div class="message-images">' +
        message.images.map(img => {
          const src = img.data.startsWith('data:') ? img.data : `data:${img.mimeType || 'image/png'};base64,${img.data}`;
          return `<img class="message-image" src="${src}" alt="已添加的图片" />`;
        }).join('') +
        '</div>';
    }

    div.innerHTML = `
      <div class="message-content">${imagesHtml}${renderUserMarkdown(message.content)}</div>
      <button class="message-copy-btn" aria-label="复制消息"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    `;
    this._setupCopyBtn(div);
    this.container.appendChild(div);
    if (isHistory) {
      div.dataset.pendingMath = '1';
    } else {
      this._renderMath(div);
      this.scrollToBottom();
    }
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message assistant${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message.id || 'streaming';

    let contentHtml = '';
    let usageHtml = '';

    if (typeof message.content === 'string') {
      contentHtml = isStreaming ? this.escapeHtml(message.content) : renderMarkdown(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          contentHtml += isStreaming ? this.escapeHtml(block.text) : renderMarkdown(block.text);
        } else if (block.type === 'thinking') {
          contentHtml += this.renderThinkingBlock(block.thinking);
        }
      }
    }

    // Usage/cost info
    if (message.usage && message.usage.cost) {
      const cost = message.usage.cost.total;
      if (cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }

    const streamingClass = isStreaming ? ' streaming' : '';

    div.innerHTML = `
      <div class="message-content${streamingClass}">${contentHtml}</div>
      ${usageHtml}
      ${!isStreaming ? '<button class="message-copy-btn" aria-label="复制消息"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' : ''}
    `;

    if (!isStreaming) {
      this._setupCopyBtn(div);
    }
    this.container.appendChild(div);
    // Defer heavy KaTeX math rendering for history messages — it gets batched
    // after all DOM nodes are built (see flushPendingMath), avoiding per-message
    // layout thrash during initial history load.
    if (!isStreaming) {
      if (isHistory) {
        div.dataset.pendingMath = '1';
      } else {
        this._renderMath(div);
      }
    }
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking) {
    const id = 'thinking-' + Math.random().toString(36).slice(2, 8);
    return `<div class="thinking-block">
<div class="thinking-toggle" onclick="var c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded')">
<span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
<span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> 思考过程</span>
</div>
<div class="thinking-content" id="${id}">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  _ensureStreamingThinking(messageElement) {
    let thinkingDiv = messageElement.querySelector('.streaming-thinking');
    if (thinkingDiv) return thinkingDiv;

    const contentDiv = messageElement.querySelector('.message-content');
    if (!contentDiv) return null;
    thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'thinking-block streaming-thinking is-active';
    thinkingDiv.dataset.startedAt = String(performance.now());
    thinkingDiv.innerHTML = `
      <button type="button" class="thinking-toggle expanded" aria-expanded="true">
        <span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
        <span class="thinking-live-dot" aria-hidden="true"></span>
        <span class="thinking-label"><span class="thinking-label-text">正在思考</span><span class="thinking-duration">0.0 秒</span></span>
      </button>
      <div class="thinking-content expanded" role="status" aria-live="off"></div>`;

    const toggle = thinkingDiv.querySelector('.thinking-toggle');
    const content = thinkingDiv.querySelector('.thinking-content');
    toggle?.addEventListener('click', () => {
      const expanded = !content.classList.contains('expanded');
      content.classList.toggle('expanded', expanded);
      toggle.classList.toggle('expanded', expanded);
      toggle.setAttribute('aria-expanded', String(expanded));
      thinkingDiv.dataset.userToggled = 'true';
    });

    const updateElapsed = () => {
      if (!thinkingDiv.isConnected) {
        const staleTimer = this._thinkingTimers.get(thinkingDiv);
        if (staleTimer) clearInterval(staleTimer);
        this._thinkingTimers.delete(thinkingDiv);
        return;
      }
      const elapsed = Math.max(0, performance.now() - Number(thinkingDiv.dataset.startedAt || performance.now()));
      const duration = thinkingDiv.querySelector('.thinking-duration');
      if (duration) duration.textContent = `${(elapsed / 1000).toFixed(1)} 秒`;
    };
    const timer = setInterval(updateElapsed, 250);
    this._thinkingTimers.set(thinkingDiv, timer);
    contentDiv.prepend(thinkingDiv);
    return thinkingDiv;
  }

  appendStreamingThinking(messageElement, delta) {
    if (!delta) return;
    const thinkingDiv = this._ensureStreamingThinking(messageElement);
    const contentEl = thinkingDiv?.querySelector('.thinking-content');
    if (!contentEl) return;
    contentEl.appendChild(document.createTextNode(delta));
    // Keep the newest reasoning visible inside the compact scroll area. This is
    // called once per animation frame by app.js, not once per transport chunk.
    contentEl.scrollTop = contentEl.scrollHeight;
  }

  finishStreamingThinking(messageElement) {
    const thinkingDiv = messageElement?.querySelector('.streaming-thinking');
    if (!thinkingDiv || !thinkingDiv.classList.contains('is-active')) return;
    thinkingDiv.classList.remove('is-active');
    const timer = this._thinkingTimers.get(thinkingDiv);
    if (timer) clearInterval(timer);
    this._thinkingTimers.delete(thinkingDiv);

    const label = thinkingDiv.querySelector('.thinking-label-text');
    if (label) label.textContent = '思考完成';
    const startedAt = Number(thinkingDiv.dataset.startedAt || performance.now());
    const elapsed = Math.max(0, performance.now() - startedAt);
    const duration = thinkingDiv.querySelector('.thinking-duration');
    if (duration) duration.textContent = `${(elapsed / 1000).toFixed(1)} 秒`;

    // Collapse automatically when the answer starts, unless the user already
    // chose an expansion state while watching the live reasoning.
    if (thinkingDiv.dataset.userToggled !== 'true') {
      const toggle = thinkingDiv.querySelector('.thinking-toggle');
      const content = thinkingDiv.querySelector('.thinking-content');
      toggle?.classList.remove('expanded');
      toggle?.setAttribute('aria-expanded', 'false');
      content?.classList.remove('expanded');
    }
  }

  appendStreamingMessage(messageElement, delta) {
    if (!delta) return;
    const contentDiv = messageElement.querySelector('.message-content');
    if (!contentDiv) return;
    let textNode = contentDiv.querySelector('.streaming-text');
    if (!textNode) {
      textNode = document.createElement('div');
      textNode.className = 'streaming-text';
      textNode.dataset.raw = '';
      contentDiv.appendChild(textNode);
    }
    textNode.dataset.raw = (textNode.dataset.raw || '') + delta;
    this._paintStreamingMarkdown(textNode);
  }

  _paintStreamingMarkdown(textNode) {
    let src = textNode.dataset.raw || '';
    const fenceCount = (src.match(/^```/gm) || []).length;
    if (fenceCount % 2 !== 0) src += '\n```';

    const stableEnd = findStableMarkdownEnd(src);
    let stableEl = textNode.querySelector(':scope > .stream-stable');
    let liveEl = textNode.querySelector(':scope > .stream-live');
    if (!stableEl || !liveEl) {
      textNode.replaceChildren();
      stableEl = document.createElement('div');
      stableEl.className = 'stream-stable';
      liveEl = document.createElement('div');
      liveEl.className = 'stream-live';
      textNode.append(stableEl, liveEl);
    }

    if (Number(textNode.dataset.stableEnd || 0) !== stableEnd) {
      stableEl.innerHTML = stableEnd > 0 ? renderMarkdown(src.slice(0, stableEnd)) : '';
      textNode.dataset.stableEnd = String(stableEnd);
    }
    liveEl.innerHTML = renderMarkdown(src.slice(stableEnd));
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = '') {
    this.finishStreamingThinking(messageElement);
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.classList.remove('streaming');
      // Get the raw answer text without accidentally folding live reasoning
      // into the final answer when a response contains thinking only.
      const streamingText = contentDiv.querySelector('.streaming-text');
      const hasThinkingBlock = !!contentDiv.querySelector('.streaming-thinking');
      const rawText = streamingText ? (streamingText.dataset.raw || streamingText.textContent) : hasThinkingBlock ? '' : contentDiv.textContent;
      
      // Rebuild with thinking block (if any) + markdown text
      let html = '';
      if (thinking) {
        html += this.renderThinkingBlock(thinking);
      }
      html += renderMarkdown(rawText);
      contentDiv.innerHTML = html;
      // Render math after markdown is applied
      this._renderMath(contentDiv);
    }

    // Add copy button after streaming finishes
    if (!messageElement.querySelector('.message-copy-btn')) {
      const btn = document.createElement('button');
      btn.className = 'message-copy-btn';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      messageElement.appendChild(btn);
      this._setupCopyBtn(messageElement);
    }

    // Add usage info if available
    if (usage && usage.cost && usage.cost.total > 0) {
      if (!messageElement.querySelector('.message-usage')) {
        const span = document.createElement('span');
        span.className = 'message-usage';
        span.textContent = `$${usage.cost.total.toFixed(4)}`;
        messageElement.appendChild(span);
      }
    }
  }

  renderSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = text;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage) {
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();
    const div = document.createElement('div');
    div.className = 'error-message';
    div.setAttribute('role', 'alert');
    const title = document.createElement('div');
    title.className = 'error-message-title';
    title.textContent = t('errTitle');
    const body = document.createElement('div');
    body.className = 'error-message-body';
    body.textContent = errorMessage;
    const hint = document.createElement('div');
    hint.className = 'error-message-hint';
    hint.textContent = t('errHint');
    div.append(title, body, hint);
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector('.message-copy-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const content = messageEl.querySelector('.message-content');
      if (!content) return;
      const text = content.textContent;
      // Fallback for non-HTTPS (LAN access)
      const copyText = (t) => {
        if (navigator.clipboard) return navigator.clipboard.writeText(t);
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve();
      };
      copyText(text).then(() => {
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.isNearBottom) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }

  /**
   * Batch-render deferred KaTeX math for history messages.
   * Called once after the full session history is built into the DOM.
   * Uses setTimeout(0) chunks so the UI thread stays responsive while math
   * is processed across many messages.
   */
  flushPendingMath() {
    const pending = this.container.querySelectorAll('[data-pending-math="1"]');
    if (pending.length === 0) return;
    loadKatex().then(() => {
      let i = 0;
      const step = () => {
        const deadline = performance.now() + 8;
        while (i < pending.length && performance.now() < deadline) {
          const el = pending[i];
          el.removeAttribute('data-pending-math');
          this._renderMath(el);
          i++;
        }
        if (i < pending.length) setTimeout(step, 12);
      };
      step();
    });
  }
}
