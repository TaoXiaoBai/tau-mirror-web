/**
 * WebSocket Client - Handles connection to backend WebSocket server
 */

export class WebSocketClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = Infinity;
    this.reconnectDelay = 2000;
    this.maxReconnectDelay = 30000;
    this.isIntentionallyClosed = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connectionState = 'idle';
    this.socketId = 0;
    this.lastPongAt = 0;
    this.resumeHint = null;
    this.probeInFlight = null;
    this.lastForceAt = 0;
  }

  _abandonSocket() {
    const ws = this.ws;
    this.ws = null;
    this.stopHeartbeat();
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(4000, 'replaced');
      }
    } catch {}
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.isIntentionallyClosed = false;
    this.connectionState = 'connecting';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._abandonSocket();
    const id = ++this.socketId;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (id !== this.socketId || this.ws !== ws) return;
      console.log('[WS] Connected');
      this.reconnectAttempts = 0;
      this.connectionState = 'open';
      this.lastPongAt = Date.now();
      try { ws.send(JSON.stringify({ type: 'mirror_hello', ...(this.resumeHint || {}) })); } catch {}
      this.startHeartbeat();
      this.dispatchEvent(new CustomEvent('connected'));
    };

    ws.onmessage = (event) => {
      if (id !== this.socketId || this.ws !== ws) return;
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    };

    ws.onerror = (error) => {
      if (id !== this.socketId || this.ws !== ws) return;
      console.error('[WS] Error:', error);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    };

    ws.onclose = (event) => {
      if (id !== this.socketId || this.ws !== ws) return;
      console.log(`[WS] Disconnected (code=${event.code}, reason=${event.reason || 'n/a'})`);
      this.stopHeartbeat();
      this.ws = null;
      this.connectionState = 'closed';
      this.dispatchEvent(new CustomEvent('disconnected'));

      if (!this.isIntentionallyClosed) {
        this.attemptReconnect();
      }
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.connectionState = 'closed';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._abandonSocket();
  }

  // Drop a possibly-dead socket immediately. After sleep, close() on a
  // zombie OPEN socket can sit in CLOSING until TCP times out.
  forceReconnect() {
    const now = Date.now();
    if (now - this.lastForceAt < 500) return;
    this.lastForceAt = now;
    this.reconnectAttempts = 0;
    this.isIntentionallyClosed = false;
    this.connectionState = 'closed';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._abandonSocket();
    this.connect();
  }

  attemptReconnect() {
    if (this.isIntentionallyClosed) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnection attempts reached');
      this.dispatchEvent(new CustomEvent('reconnectFailed'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.maxReconnectDelay, this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1));

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.lastPongAt && Date.now() - this.lastPongAt > 28000) {
        console.log('[WS] Heartbeat stalled, reconnecting');
        this.forceReconnect();
        return;
      }
      this.sendPing();
    }, 12000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendPing() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }

  probe(timeout = 1200) {
    if (this.probeInFlight) return this.probeInFlight;
    this.probeInFlight = new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve(false);
        return;
      }
      const onPong = () => finish(true);
      const timer = setTimeout(() => finish(false), timeout);
      const finish = (ok) => {
        clearTimeout(timer);
        this.removeEventListener('pong', onPong);
        this.probeInFlight = null;
        resolve(ok);
      };
      this.addEventListener('pong', onPong);
      if (!this.sendPing()) finish(false);
    });
    return this.probeInFlight;
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.error('[WS] Cannot send, not connected');
    }
  }

  handleMessage(message) {
    // Emit events based on message type
    switch (message.type) {
      case 'event':
        this.dispatchEvent(new CustomEvent('rpcEvent', { detail: message.event }));
        break;
      case 'state':
        this.dispatchEvent(new CustomEvent('stateUpdate', { detail: message }));
        break;
      case 'work_state':
        this.dispatchEvent(new CustomEvent('workState', { detail: message.data || message }));
        break;
      case 'error':
        this.dispatchEvent(new CustomEvent('serverError', { detail: message }));
        break;
      case 'session_switch':
        this.resumeHint = null;
        this.dispatchEvent(new CustomEvent('sessionSwitch', { detail: message }));
        break;
      case 'mirror_sync':
        this.dispatchEvent(new CustomEvent('mirrorSync', { detail: message }));
        break;
      case 'pong':
        this.lastPongAt = Date.now();
        this.dispatchEvent(new CustomEvent('pong', { detail: message }));
        break;
      case 'mirror_hello_ok':
        this.lastPongAt = Date.now();
        this.dispatchEvent(new CustomEvent('mirrorHelloOk', { detail: message }));
        break;
      case 'plan_mode_state':
        this.dispatchEvent(new CustomEvent('planModeState', { detail: message.data || message }));
        break;
      case 'token_saver_state':
        this.dispatchEvent(new CustomEvent('tokenSaverState', { detail: message.data || message }));
        break;

      default:
        console.warn('[WS] Unknown message type:', message.type);
    }
  }
}
