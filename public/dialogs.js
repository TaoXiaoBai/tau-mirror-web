/**
 * Dialogs - Handles extension UI dialogs
 */

import { t } from './i18n.js';

export class DialogHandler {
  constructor(container, wsClient, options = {}) {
    this.container = container;
    this.wsClient = wsClient;
    this.currentDialog = null;
    this.timeoutId = null;
    this.onLayoutChange = typeof options.onLayoutChange === 'function'
      ? options.onLayoutChange
      : () => {};
  }

  showSelect(request) {
    this.cancelCurrentDialog();

    const { id, title, options, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog dialog-select';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'false');
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || t('selectPlease'))}</div>
      <div class="dialog-options" id="dialog-options"></div>
      <div class="dialog-actions">
        <button id="dialog-cancel">${t('cancel')}</button>
      </div>
    `;

    const optionsContainer = dialog.querySelector('#dialog-options');
    
    (options || []).forEach(option => {
      const optionDiv = document.createElement('div');
      optionDiv.className = 'dialog-option';
      optionDiv.textContent = option;
      optionDiv.onclick = () => {
        this.respond(id, { value: option });
      };
      optionsContainer.appendChild(optionDiv);
    });

    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id);
  }

  showConfirm(request) {
    this.cancelCurrentDialog();

    const { id, title, message, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog dialog-confirm';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'false');
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || t('confirmPlease'))}</div>
      ${message ? `<div class="dialog-message">${this.escapeHtml(message)}</div>` : ''}
      <div class="dialog-actions">
        <button id="dialog-no">${t('cancel')}</button>
        <button id="dialog-yes">${t('confirm')}</button>
      </div>
    `;

    dialog.querySelector('#dialog-yes').onclick = () => {
      this.respond(id, { confirmed: true });
    };

    dialog.querySelector('#dialog-no').onclick = () => {
      this.respond(id, { confirmed: false });
    };

    this.showDialog(dialog, timeout, id);
  }

  showInput(request) {
    this.cancelCurrentDialog();

    const { id, title, message, placeholder, prefill, allowEmpty, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog dialog-input-prompt';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'false');
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || t('inputPlease'))}</div>
      ${message ? `<div class="dialog-message">${this.escapeHtml(message)}</div>` : ''}
      <input type="text" class="dialog-input" id="dialog-input" placeholder="${this.escapeHtml(placeholder || '')}" value="${this.escapeHtml(prefill || '')}" />
      <div class="dialog-actions">
        <button id="dialog-cancel">${t('cancel')}</button>
        <button id="dialog-submit">${t('submit')}</button>
      </div>
    `;

    const input = dialog.querySelector('#dialog-input');
    
    const submit = () => {
      const value = input.value.trim();
      this.respond(id, value || allowEmpty ? { value } : { cancelled: true });
    };

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submit();
    });

    dialog.querySelector('#dialog-submit').onclick = submit;
    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id);

    // Focus/select after layout settles without jumping the message viewport.
    setTimeout(() => {
      input.focus({ preventScroll: true });
      input.select();
    }, 100);
  }

  showEditor(request) {
    this.cancelCurrentDialog();

    const { id, title, prefill, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog dialog-editor';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'false');
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || t('editPlease'))}</div>
      <textarea class="dialog-textarea" id="dialog-textarea">${this.escapeHtml(prefill || '')}</textarea>
      <div class="dialog-actions">
        <button id="dialog-cancel">${t('cancel')}</button>
        <button id="dialog-save">${t('save')}</button>
      </div>
    `;

    const textarea = dialog.querySelector('#dialog-textarea');

    dialog.querySelector('#dialog-save').onclick = () => {
      const value = textarea.value;
      this.respond(id, value ? { value } : { cancelled: true });
    };

    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id);

    // Focus textarea after a short delay without moving the chat scroller.
    setTimeout(() => textarea.focus({ preventScroll: true }), 100);
  }

  showNotification(request) {
    const { message, notifyType } = request;
    
    const region = document.getElementById('toast-region');
    if (!region) return;
    const notification = document.createElement('div');
    const type = notifyType === 'error' ? 'error' : notifyType === 'warning' ? 'warning' : 'info';
    notification.className = `toast ${type}`;
    notification.setAttribute('role', type === 'error' ? 'alert' : 'status');
    notification.innerHTML = '<span class="toast-dot"></span><span class="toast-message"></span>';
    notification.querySelector('.toast-message').textContent = message;
    region.appendChild(notification);
    requestAnimationFrame(() => notification.classList.add('visible'));
    setTimeout(() => {
      notification.classList.remove('visible');
      setTimeout(() => notification.remove(), 180);
    }, 4200);
  }

  showDialog(dialogElement, timeout, requestId) {
    this.currentDialog = dialogElement;
    this.container.replaceChildren(dialogElement);
    this.container.classList.remove('hidden');
    this.container.dataset.requestId = String(requestId || '');
    this.onLayoutChange(true);

    // Set up timeout if specified
    if (timeout) {
      this.timeoutId = setTimeout(() => {
        this.respond(requestId, { cancelled: true });
      }, timeout);
    }
  }

  cancelCurrentDialog() {
    const id = this.container.dataset.requestId;
    if (this.currentDialog && id) {
      this.respond(id, { cancelled: true });
      return true;
    }
    this.clearCurrentDialog();
    return false;
  }

  clearCurrentDialog() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    
    this.container.replaceChildren();
    this.container.classList.add('hidden');
    delete this.container.dataset.requestId;
    this.currentDialog = null;
    this.onLayoutChange(false);
  }

  respond(id, response) {
    this.clearCurrentDialog();
    if (String(id || '').startsWith('tau-local-dialog-')) {
      this.container.dispatchEvent(new CustomEvent('tau-local-dialog-response', {
        detail: { id, response },
      }));
      return;
    }
    this.wsClient.send({
      type: 'extension_ui_response',
      id,
      ...response
    });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
