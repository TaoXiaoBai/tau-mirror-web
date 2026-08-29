/**
 * Tool Card - Renders and updates tool execution cards (collapsible)
 */

export class ToolCardRenderer {
  constructor(container) {
    this.container = container;
    this.toolCards = new Map(); // toolCallId -> element
    this._pendingHistoryResults = new Map();
    this._mountTarget = null;
  }

  setMountTarget(target = null) {
    this._mountTarget = target;
  }

  _append(node) {
    (this._mountTarget || this.container).appendChild(node);
  }

  createToolCard(toolExecution) {
    const { toolCallId, toolName, args, status } = toolExecution;

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = toolCallId;

    const argsPreview = this.getArgsPreview(toolName, args);
    const argsJson = this.formatJson(args);
    const isExpanded = (status === 'streaming' || status === 'pending');

    const isEdit = (toolName === 'edit' || toolName === 'Edit') && args && (args.oldText || args.old_text) && (args.newText || args.new_text);

    card.innerHTML = `
      <div class="tool-card-header" onclick="this.parentElement.querySelector('.tool-card-body').classList.toggle('expanded'); this.querySelector('.tool-card-chevron').classList.toggle('expanded')">
        <div class="tool-header-left">
          <span class="tool-card-chevron${isExpanded ? ' expanded' : ''}"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="tool-name">${this.escapeHtml(toolName)}</span>
          ${argsPreview ? `<span class="tool-args-preview">${this.escapeHtml(argsPreview)}</span>` : ''}
        </div>
        <div class="tool-header-right">
          <button class="tool-action-btn copy-output-btn" title="复制工具输出" onclick="event.stopPropagation(); var t=this.closest('.tool-card').querySelector('.tool-output'); if(!t||!t.textContent.trim())return; var s=t.textContent,b=this; (navigator.clipboard?navigator.clipboard.writeText(s):new Promise(function(r){var a=document.createElement('textarea');a.value=s;a.style.cssText='position:fixed;left:-9999px';document.body.appendChild(a);a.select();document.execCommand('copy');document.body.removeChild(a);r()})).then(function(){b.classList.add('copied');setTimeout(function(){b.classList.remove('copied')},1500)})"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
          <div class="tool-status ${status}">${this.getStatusLabel(status)}</div>
        </div>
      </div>
      <div class="tool-card-body${isExpanded ? ' expanded' : ''}">
        ${!isEdit && argsJson ? `<div class="tool-args">${this.escapeHtml(argsJson)}</div>` : ''}
        <div class="tool-output-wrapper">
          <div class="tool-output"></div>
        </div>
      </div>
    `;

    // Insert diff view for Edit tools
    if (isEdit) {
      const diffEl = this.renderDiff(args.oldText || args.old_text, args.newText || args.new_text);
      const body = card.querySelector('.tool-card-body');
      body.insertBefore(diffEl, body.firstChild);
    }

    this._append(card);
    this.toolCards.set(toolCallId, card);
    this.scrollToBottom();

    return card;
  }

  updateToolCard(toolExecution) {
    if (!toolExecution?.toolCallId) return;
    let card = this.toolCards.get(toolExecution.toolCallId);

    if (!card) {
      card = this.createToolCard(toolExecution);
    }

    // Update status
    const statusElement = card.querySelector('.tool-status');
    if (statusElement) {
      statusElement.className = `tool-status ${toolExecution.status}`;
      statusElement.textContent = this.getStatusLabel(toolExecution.status);
    }

    // Auto-expand when streaming
    if (toolExecution.status === 'streaming') {
      const body = card.querySelector('.tool-card-body');
      const chevron = card.querySelector('.tool-card-chevron');
      if (body) body.classList.add('expanded');
      if (chevron) chevron.classList.add('expanded');
    }

    // Update output
    const outputElement = card.querySelector('.tool-output');
    if (outputElement && typeof toolExecution.output === 'string') {
      const next = toolExecution.output;
      const previous = outputElement._rawText || '';
      if (next.startsWith(previous)) {
        const delta = next.slice(previous.length);
        if (delta) outputElement.appendChild(document.createTextNode(delta));
      } else if (next !== previous) {
        outputElement.textContent = next;
      }
      outputElement._rawText = next;
      this.scrollToBottom();
    }
  }

  finalizeToolCard(toolCallId, result, isError) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    // Update status
    const statusElement = card.querySelector('.tool-status');
    if (statusElement) {
      const status = isError ? 'error' : 'complete';
      statusElement.className = `tool-status ${status}`;
      statusElement.textContent = this.getStatusLabel(status);
    }

    // Update output with final result
    const outputElement = card.querySelector('.tool-output');
    if (outputElement && result) {
      const output = this.formatResult(result);
      outputElement.textContent = output;
      outputElement._rawText = output;
    }

    // Collapse completed cards (less noise)
    if (!isError) {
      const body = card.querySelector('.tool-card-body');
      const chevron = card.querySelector('.tool-card-chevron');
      if (body) body.classList.remove('expanded');
      if (chevron) chevron.classList.remove('expanded');
    }
  }

  /**
   * Create a pre-collapsed card for session history using DOM methods (no innerHTML)
   */
  createHistoryCard(toolExecution) {
    const { toolCallId, toolName, args } = toolExecution;

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = toolCallId;

    // Header
    const header = document.createElement('div');
    header.className = 'tool-card-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'tool-header-left';

    const chevron = document.createElement('span');
    chevron.className = 'tool-card-chevron';
    chevron.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg>';
    headerLeft.appendChild(chevron);

    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = toolName;
    headerLeft.appendChild(name);

    const preview = this.getArgsPreview(toolName, args);
    if (preview) {
      const previewEl = document.createElement('span');
      previewEl.className = 'tool-args-preview';
      previewEl.textContent = preview;
      headerLeft.appendChild(previewEl);
    }

    header.appendChild(headerLeft);

    // Right side: copy button + status
    const headerRight = document.createElement('div');
    headerRight.className = 'tool-header-right';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'tool-action-btn copy-output-btn';
    copyBtn.title = '复制工具输出';
    copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const output = card.querySelector('.tool-output');
      const text = output?.textContent || this.formatResult(card._historyResultRaw);
      if (!text.trim()) return;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : new Promise((r) => {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); r();
      })).then(() => {
        copyBtn.classList.add('copied');
        setTimeout(() => copyBtn.classList.remove('copied'), 1500);
      });
    });
    headerRight.appendChild(copyBtn);

    const status = document.createElement('div');
    status.className = 'tool-status complete';
    status.textContent = this.getStatusLabel('complete');
    headerRight.appendChild(status);

    header.appendChild(headerRight);

    // Toggle expand on click. Build the expensive body only when the user
    // actually opens this collapsed history card.
    header.addEventListener('click', () => {
      const expanded = !body.classList.contains('expanded');
      if (expanded) this._materializeHistoryCard(card);
      body.classList.toggle('expanded', expanded);
      chevron.classList.toggle('expanded', expanded);
    });

    card.appendChild(header);

    // Body stays empty while collapsed. Args, edit diffs and large outputs
    // are materialized lazily on first expansion.
    const body = document.createElement('div');
    body.className = 'tool-card-body';
    card._historyArgs = args || {};
    card._historyToolName = toolName;
    card._historyResultRaw = null;
    card._historyMaterialized = false;

    card.appendChild(body);

    this._append(card);
    this.toolCards.set(toolCallId, card);
    const pending = this._pendingHistoryResults.get(toolCallId);
    if (pending) {
      this._pendingHistoryResults.delete(toolCallId);
      this.addHistoryResult(toolCallId, pending.result, pending.isError);
    }

    return card;
  }

  /**
   * Add result to a history card (stays collapsed)
   */
  addHistoryResult(toolCallId, result, isError) {
    const card = this.toolCards.get(toolCallId);
    if (!card) {
      this._pendingHistoryResults.set(toolCallId, { result, isError });
      return;
    }

    if (isError) {
      const statusEl = card.querySelector('.tool-status');
      if (statusEl) {
        statusEl.className = 'tool-status error';
        statusEl.textContent = this.getStatusLabel('error');
      }
    }

    card._historyResultRaw = result || null;
    if (card._historyMaterialized) {
      const outputElement = card.querySelector('.tool-output');
      if (outputElement) outputElement.textContent = this.formatResult(result);
      card._historyResultRaw = null;
    }
  }

  _materializeHistoryCard(card) {
    if (!card || card._historyMaterialized !== false) return;
    const body = card.querySelector('.tool-card-body');
    if (!body) return;
    const args = card._historyArgs || {};
    const toolName = card._historyToolName || '';
    const isEdit = (toolName === 'edit' || toolName === 'Edit') &&
      (args.oldText || args.old_text) && (args.newText || args.new_text);

    if (isEdit) {
      body.appendChild(this.renderDiff(args.oldText || args.old_text, args.newText || args.new_text));
    } else {
      const argsJson = this.formatJson(args);
      if (argsJson) {
        const argsEl = document.createElement('div');
        argsEl.className = 'tool-args';
        argsEl.textContent = argsJson;
        body.appendChild(argsEl);
      }
    }

    const output = document.createElement('div');
    output.className = 'tool-output';
    output.textContent = this.formatResult(card._historyResultRaw);
    body.appendChild(output);
    card._historyResultRaw = null;
    card._historyMaterialized = true;
  }

  getStatusLabel(status) {
    return {
      pending: '等待',
      streaming: '运行中',
      complete: '完成',
      error: '出错',
    }[status] || status || '';
  }

  /** Compact preview for the header line */
  getArgsPreview(toolName, args) {
    if (!args || Object.keys(args).length === 0) return '';

    // Show the most relevant arg inline
    if (args.path) return args.path;
    if (args.command) return args.command.substring(0, 80);
    if (args.query) return args.query.substring(0, 60);
    if (args.url) return args.url;

    // Fallback: first string value
    for (const val of Object.values(args)) {
      if (typeof val === 'string' && val.length > 0) {
        return val.substring(0, 60);
      }
    }
    return '';
  }

  formatJson(obj) {
    try {
      if (Object.keys(obj).length === 0) return '';
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }

  /** Render a simple inline diff for Edit tool */
  renderDiff(oldText, newText) {
    const container = document.createElement('div');
    container.className = 'tool-diff';

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Removed lines
    for (const line of oldLines) {
      const el = document.createElement('div');
      el.className = 'diff-line diff-removed';
      el.textContent = '- ' + line;
      container.appendChild(el);
    }

    // Added lines
    for (const line of newLines) {
      const el = document.createElement('div');
      el.className = 'diff-line diff-added';
      el.textContent = '+ ' + line;
      container.appendChild(el);
    }

    return container;
  }

  formatResult(result) {
    if (!result) return '';

    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map(block => {
          if (block.type === 'text') return block.text;
          return JSON.stringify(block);
        })
        .join('\n');
    }

    return JSON.stringify(result, null, 2);
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    if (!this.container || !this._scrollCallback) return;
    this._scrollCallback();
  }

  setScrollCallback(callback) {
    this._scrollCallback = callback;
  }

  expandAll() {
    this.toolCards.forEach(card => {
      this._materializeHistoryCard(card);
      card.querySelector('.tool-card-body')?.classList.add('expanded');
      card.querySelector('.tool-card-chevron')?.classList.add('expanded');
    });
  }

  collapseAll() {
    this.toolCards.forEach(card => {
      card.querySelector('.tool-card-body')?.classList.remove('expanded');
      card.querySelector('.tool-card-chevron')?.classList.remove('expanded');
    });
  }

  clear() {
    this.toolCards.forEach((card) => card.remove());
    this.toolCards.clear();
    this._pendingHistoryResults.clear();
    this._mountTarget = null;
  }
}
