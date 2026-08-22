<div align="center">

# Tau Mirror Web

**English** · [简体中文](./README.zh-CN.md)

Browser UI for the [Pi](https://github.com/earendil-works/pi) coding agent.

The GitHub page opens this English README by default.  
Chinese readers: open [README.zh-CN.md](./README.zh-CN.md).

The web app itself follows your system language (`zh*` → Chinese, otherwise English). You can change it later in **Settings**.

</div>

## What it is

Tau runs **inside** your existing Pi process. There is no extra server to start. The extension opens a small HTTP + WebSocket server, then mirrors the same session in the browser — messages, tools, thinking, and model state stay in sync with the terminal.

This repository is a maintained fork focused on:

- Visible model / relay errors in the chat
- Adding OpenAI-compatible **relay providers** from the web UI
- Model IDs that start with `/CN/...`
- Interface language that follows the OS / browser locale

## Install

From this repo:

```bash
pi install git:github.com/TaoXiaoBai/tau-mirror-web
```

Or clone and point Pi at the local files:

```bash
git clone https://github.com/TaoXiaoBai/tau-mirror-web.git
cd tau-mirror-web
```

Then add the extension path in `~/.pi/agent/settings.json`, or run:

```bash
# Windows PowerShell
$env:TAU_STATIC_DIR = (Resolve-Path .\public)
pi
```

## Use

1. Start `pi` as usual.
2. Open the URL in the status bar (default `http://localhost:3001`).
3. Type in the terminal or the browser. Both stay on the same session.

`/qr` prints a QR code for your phone.

## Features

### Chat
- Live streaming, markdown, math, copy, image paste / drop
- Tool cards and thinking blocks
- Failed model calls show up in the thread, not as an empty bubble
- Queue a follow-up while Pi is still answering

### Relays
- Open the **model menu** (top left)
- Each relay group has **Edit**; the footer is **Add a relay**
- Test the connection, then save and sync `/v1/models`
- Leading slashes in model IDs are kept (`/CN/gpt-4o` stays `/CN/gpt-4o`)

### Sessions
- History sidebar, search, resume a past session
- Context usage bar and optional auto-compaction

### Language
- First visit: detect `navigator.languages`
- Chinese locales get the Chinese UI
- Everyone else gets English
- Override anytime in Settings → Language

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TAU_MIRROR_PORT` | `3001` | HTTP port |
| `TAU_HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for localhost only) |
| `TAU_STATIC_DIR` | bundled `public/` | Override UI files |
| `TAU_DISABLED` | `0` | `1` skips auto-start |
| `TAU_USER` / `TAU_PASS` | empty | HTTP Basic Auth |

Optional block in `~/.pi/agent/settings.json`:

```json
{
  "tau": {
    "port": 3001,
    "user": "pi",
    "pass": "change-me"
  }
}
```

Commands: `/tau-stop`, `/tau-start`, `/qr`, `/tau`.

Relay providers are stored in `~/.pi/agent/models.json`. Saving from the web UI writes that file and registers the models with Pi. Restart Pi after upgrading the extension so the new backend commands load.

## How it works

```
Pi TUI  <──>  Pi process (tau extension: HTTP + WS :3001)  <──>  Browser
```

The extension subscribes to Pi events and forwards them to every connected tab. Browser commands go back through the same extension API.

## License

MIT. Based on [deflating/tau](https://github.com/deflating/tau).
