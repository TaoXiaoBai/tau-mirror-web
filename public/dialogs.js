/**
 * Dialogs - Handles extension UI dialogs
 */

export class DialogHandler {
  constructor(container, wsClient) {
    this.container = container;
    this.wsClient = wsClient;
    this.currentDialog = null;
    this.timeoutId = null;
  }

  showSelect(request) {
    this.clearCurrentDialog();

    const { id, title, options, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || '请选择')}</div>
      <div class="dialog-options" id="dialog-options"></div>
      <div class="dialog-actions">
        <button id="dialog-cancel">取消</button>
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
    this.clearCurrentDialog();

    const { id, title, message, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || '请确认')}</div>
      ${message ? `<div class="dialog-message">${this.escapeHtml(message)}</div>` : ''}
      <div class="dialog-actions">
        <button id="dialog-no">取消</button>
        <button id="dialog-yes">确认</button>
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
    this.clearCurrentDialog();

    const { id, title, placeholder, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || '请输入')}</div>
      <input type="text" class="dialog-input" id="dialog-input" placeholder="${this.escapeHtml(placeholder || '')}" />
      <div class="dialog-actions">
        <button id="dialog-cancel">取消</button>
        <button id="dialog-submit">提交</button>
      </div>
    `;

    const input = dialog.querySelector('#dialog-input');
    
    const submit = () => {
      const value = input.value.trim();
      this.respond(id, value ? { value } : { cancelled: true });
    };

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submit();
    });

    dialog.querySelector('#dialog-submit').onclick = submit;
    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id);
    
    // Focus input after a short delay
    setTimeout(() => input.focus(), 100);
  }

  showEditor(request) {
    this.clearCurrentDialog();

    const { id, title, prefill, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || '编辑内容')}</div>
      <textarea class="dialog-textarea" id="dialog-textarea">${this.escapeHtml(prefill || '')}</textarea>
      <div class="dialog-actions">
        <button id="dialog-cancel">取消</button>
        <button id="dialog-save">保存</button>
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
    
    // Focus textarea after a short delay
    setTimeout(() => textarea.focus(), 100);
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
    this.container.innerHTML = '';
    this.container.appendChild(dialogElement);
    this.container.classList.remove('hidden');

    // Set up timeout if specified
    if (timeout) {
      this.timeoutId = setTimeout(() => {
        this.respond(requestId, { cancelled: true });
      }, timeout);
    }
  }

  clearCurrentDialog() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    
    this.container.innerHTML = '';
    this.container.classList.add('hidden');
    this.currentDialog = null;
  }

  respond(id, response) {
    this.clearCurrentDialog();
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
