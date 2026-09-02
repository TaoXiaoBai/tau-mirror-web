<div align="center">

# Tau Mirror Web

**English** · [简体中文](./README.zh-CN.md)

A browser interface for the [Pi](https://github.com/earendil-works/pi) coding agent.

Run Pi in the terminal, open Tau in a browser, and continue the same conversation from your desktop or phone.

</div>

## In one sentence

Tau Mirror Web is a lightweight HTTP + WebSocket extension that mirrors a running Pi session in the browser. It does not replace Pi and it does not create a separate agent process: the terminal and browser use the same Pi session, model, tools, and events.

## Why use it?

- Keep Pi running in your normal terminal workflow.
- Read and send messages from a more comfortable browser UI.
- Open the same session on a phone with `/qr`.
- Inspect tool calls, thinking blocks, context usage, and errors instead of guessing what happened.
- Configure OpenAI-compatible providers without editing model configuration by hand.
- Continue historical sessions while keeping the complete history available.

## Quick start

### Install from GitHub

```bash
pi install git:github.com/TaoXiaoBai/tau-mirror-web
```

Start Pi normally, then open the URL shown by Tau. The default address is:

```text
http://localhost:3001
```

### Run a local checkout

```bash
git clone https://github.com/TaoXiaoBai/tau-mirror-web.git
cd tau-mirror-web
```

In Windows PowerShell, point Pi at the local web files before starting it:

```powershell
$env:TAU_STATIC_DIR = (Resolve-Path .\public)
pi
```

You can also configure the extension path in `~/.pi/agent/settings.json`.

### Use a phone

Run `/qr` in Pi and scan the displayed QR code. The phone must be able to reach the computer running Pi. If you expose Tau beyond localhost, read the security notes below first.

## What is included

### Conversation UI

- Streaming assistant responses
- Markdown and mathematical formulas
- Copy buttons and image paste / drop
- Thinking blocks and tool cards
- Errors displayed directly in the conversation
- Queued follow-up messages while Pi is working
- Jump-to-latest control with stable history scrolling
- Lazy loading for older history and expensive content

### Models and providers

The model picker is also the provider manager:

1. Open the model menu.
2. Choose **Add a provider**, or select **Edit** beside an existing provider.
3. Enter the base URL and API key.
4. Test and save the provider.
5. Tau fetches its models and makes them available to Pi.

OpenAI-compatible endpoints are supported. Leading-slash model IDs are preserved, so an ID such as `/CN/gpt-4o` remains exactly `/CN/gpt-4o`.

### Plan Mode

The web UI mirrors Pi's authoritative Plan Mode state. It supports planning, execution, stopping, staying in plan mode, and refining a plan. Tool permissions change with the real backend state rather than an optimistic browser-only toggle.

### Save tokens

**Save tokens** is available in the top toolbar and in **Settings → Conversation**.

It is intentionally conservative: enabling it turns thinking off and remembers the previous thinking level. Disabling it restores that level. It does not truncate history, rewrite prompts, disable tools, or force a provider-specific output limit.

### Sessions

- Browse and search historical sessions.
- Restore a previous session when you want to continue it.
- Rename historical sessions persistently.
- Delete only stopped historical `.jsonl` sessions from the allowed Pi sessions directory.
- Keep the full history available through paging instead of silently truncating it.

### Appearance and language

The six color themes remain selectable. **Settings → Appearance → Color mode** can keep the selected theme, follow the operating system, stay light/dark, or switch by local time. Time mode uses a dark theme from 19:00 to 07:00 and restores the preferred light theme during the day.

On first visit, the UI follows the browser / system language. Chinese locales use Simplified Chinese; other locales use English. Change the preference later in **Settings → Language**.

## Configuration

Tau can be configured with environment variables or the optional `tau` block in `~/.pi/agent/settings.json`.

| Environment variable | Default | Description |
|---|---:|---|
| `TAU_MIRROR_PORT` | `3001` | HTTP and WebSocket port |
| `TAU_HOST` | `127.0.0.1` | Bind address; set `0.0.0.0` explicitly for authenticated LAN access |
| `TAU_STATIC_DIR` | bundled `public/` | Use a different directory for the web UI |
| `TAU_DISABLED` | `0` | Set to `1` to disable automatic startup |
| `TAU_USER` / `TAU_PASS` | empty | Enable HTTP Basic Authentication |

Example:

```json
{
  "tau": {
    "port": 3001,
    "user": "pi",
    "pass": "change-me"
  }
}
```

Useful Pi commands:

```text
/tau        Show or open Tau
/tau-start  Start the mirror server
/tau-stop   Stop the mirror server
/qr         Print a QR code for another device
```

Providers configured through the web UI are stored in:

```text
~/.pi/agent/models.json
```

After upgrading the extension, fully restart Pi so backend and RPC changes are loaded. `/reload` is not sufficient for new backend behavior.

## Security and network access

Tau runs inside your Pi process and can expose access to your conversations and tools. It binds to loopback by default:

```powershell
$env:TAU_HOST = "127.0.0.1"
```

If you bind to `0.0.0.0` or access Tau from another device:

- Set `TAU_USER` and `TAU_PASS`, or configure equivalent credentials in Pi settings. Without enabled authentication, Tau refuses the requested non-loopback address and safely falls back to `127.0.0.1`.
- Use a trusted private network.
- Do not forward the port to the public internet without an additional secure proxy and authentication layer.
- Treat the browser URL and QR code as access to your Pi session.

Session file operations are restricted to `.jsonl` files inside Pi's sessions directory. Running sessions cannot be deleted. File browsing, previews, and native open actions are jailed to the active workspace. HTTP and WebSocket requests are origin-checked and size-limited.

The optional `extensions/imessage-bridge.ts` requires `BB_PASSWORD` and `BB_PHONE` environment variables; it contains no default credentials or personal recipient.

## How it works

```text
Pi TUI  <──>  Pi process + Tau extension (HTTP / WebSocket)  <──>  Browser
```

The extension subscribes to Pi events and broadcasts state and streaming updates to connected browser tabs. Browser actions are sent back through the extension and Pi's normal APIs, so the terminal and web UI remain two views of one session.

## Troubleshooting

### The page is blank or shows old UI

- Hard-refresh the page with `Ctrl+F5`.
- Close and reopen the browser tab.
- If backend behavior changed, fully quit and restart Pi.

### The browser cannot connect

- Confirm Pi is running.
- Open the address printed by `/tau`.
- Check that the port is not blocked by Windows Firewall.
- For phone access, confirm both devices are on a reachable network.

### A provider is not visible

Open the model picker and use **Refresh models**. Check the provider base URL, API key, and `/v1/models` compatibility. Existing providers in `models.json` remain editable from the picker.

### A long session feels slow

Tau loads the newest messages first and fetches older history on demand. This keeps the first usable paint fast while preserving complete history. Very large images or tool results may take longer when opened.

## Development

The main project directories are:

```text
extensions/   Pi extension and HTTP/WebSocket server
public/       Browser UI
plan-mode/    Plan Mode integration
```

For a local UI checkout:

```powershell
$env:TAU_STATIC_DIR = (Resolve-Path .\public)
pi
```

## License

MIT. Based on [deflating/tau](https://github.com/deflating/tau).
