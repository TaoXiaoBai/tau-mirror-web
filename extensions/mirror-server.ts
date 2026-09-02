/**
 * Mirror Server Extension
 * 
 * Starts a WebSocket + HTTP server inside the running Pi process,
 * allowing a browser to connect and mirror the TUI session in real-time.
 * 
 * - Forwards all Pi events to connected browser clients
 * - Accepts commands from the browser and executes them via the extension API
 * - Serves static files for the Tau web UI
 * - Sends full state snapshot on client connect (messages, model, etc.)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";

// Load tau settings from ~/.pi/agent/settings.json (falls back to env vars)
function loadTauSettings(): { port: number; host: string; autoStart: boolean; user: string; pass: string; authEnabled?: boolean; projectsDir?: string } {
  let settings: any = {};
  try {
    const settingsPath = path.join(process.env.HOME || "~", ".pi/agent/settings.json");
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")).tau || {};
  } catch {}
  return {
    port: parseInt(process.env.TAU_MIRROR_PORT || settings.port || "3001"),
    host: process.env.TAU_HOST || settings.host || "0.0.0.0",
    autoStart: !(
      process.env.TAU_DISABLED === "1" || process.env.TAU_DISABLED === "true" ||
      settings.disabled === true
    ),
    user: process.env.TAU_USER || settings.user || "",
    pass: process.env.TAU_PASS || settings.pass || "",
    authEnabled: settings.authEnabled,
    projectsDir: process.env.TAU_PROJECTS_DIR || settings.projectsDir,
  };
}

const TAU_SETTINGS = loadTauSettings();
const PORT = TAU_SETTINGS.port;
const HOST = TAU_SETTINGS.host;
const TAU_AUTO_START = TAU_SETTINGS.autoStart;
const AUTH_USER = TAU_SETTINGS.user;
const AUTH_PASS = TAU_SETTINGS.pass;
const AUTH_CONFIGURED = !!(AUTH_USER && AUTH_PASS);
let authEnabled = AUTH_CONFIGURED && TAU_SETTINGS.authEnabled !== false;
// @ts-ignore — __dirname is provided by jiti at runtime
const STATIC_DIR = process.env.TAU_STATIC_DIR || findPublicDir();
const STATIC_ROOT = path.resolve(STATIC_DIR);
const STATIC_DIR_PREFIX = STATIC_ROOT.endsWith(path.sep) ? STATIC_ROOT : `${STATIC_ROOT}${path.sep}`;
const MAX_FILE_PREVIEW = 8 * 1024 * 1024;

function safeStaticPath(urlPath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const candidate = path.resolve(STATIC_ROOT, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  return candidate === STATIC_ROOT || candidate.startsWith(STATIC_DIR_PREFIX) ? candidate : null;
}

function setSecurityHeaders(res: http.ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function findPublicDir(): string {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (dir: string) => {
      const normalized = path.resolve(dir);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push(normalized);
    };

    // 1) Common extension-relative paths
    addCandidate(path.resolve(__dirname, "public"));
    addCandidate(path.resolve(__dirname, "../public"));

    // 2) Installed package path (for npm-installed extension execution)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkgPath = require.resolve("tau-mirror/package.json");
      addCandidate(path.join(path.dirname(pkgPath), "public"));
    } catch {}

    // 3) Development fallback from current working directory
    addCandidate(path.resolve(process.cwd(), "public"));
    addCandidate(path.resolve(process.cwd(), "node_modules/tau-mirror/public"));

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
    }

    // Keep previous fallback behavior
    return path.resolve(process.cwd(), "public");
}
const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(USER_HOME, ".pi", "agent");
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_AGENT_DIR, "sessions");
const INSTANCES_DIR = path.join(USER_HOME, ".pi", "tau-instances");
const MODELS_JSON_PATH = path.join(PI_AGENT_DIR, "models.json");
const BUILTIN_PROVIDERS = new Set([
  "openai", "anthropic", "google", "google-gemini", "google-generative-ai",
  "google-vertex", "amazon-bedrock", "azure", "azure-openai", "groq",
  "mistral", "openrouter", "xai", "grok", "cerebras", "github-copilot",
  "opencode", "cloudflare", "vercel", "together", "fireworks",
]);
const RELAY_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

function normalizeRelayApi(baseUrl?: string, api?: string): string {
  const requested = RELAY_APIS.has(String(api || "")) ? String(api) : "openai-completions";
  if (requested === "anthropic-messages") return requested;
  const host = String(baseUrl || "").toLowerCase();
  const officialOpenAI = /api\.openai\.com/.test(host);
  // Relays almost never implement /v1/responses. Keep that only for official OpenAI.
  if (requested === "openai-responses" && !officialOpenAI) return "openai-completions";
  return requested;
}

function isOfficialOpenAI(baseUrl?: string): boolean {
  return /api\.openai\.com/i.test(String(baseUrl || ""));
}

function defaultRelayCompat(baseUrl?: string, api?: string, existing?: any) {
  const next = existing && typeof existing === "object" ? { ...existing } : {};
  if (!isOfficialOpenAI(baseUrl) && String(api || "openai-completions") !== "anthropic-messages") {
    next.supportsDeveloperRole = false;
  }
  return next;
}

function migrateRelayProtocols(file: { providers: Record<string, any> }): boolean {
  let changed = false;
  for (const cfg of Object.values(file.providers || {})) {
    if (!cfg || typeof cfg !== "object") continue;
    const nextApi = normalizeRelayApi(cfg.baseUrl, cfg.api);
    if (cfg.api !== nextApi) {
      cfg.api = nextApi;
      changed = true;
    }
    const nextCompat = defaultRelayCompat(cfg.baseUrl, cfg.api, cfg.compat);
    if (JSON.stringify(cfg.compat || {}) !== JSON.stringify(nextCompat)) {
      cfg.compat = nextCompat;
      changed = true;
    }
  }
  return changed;
}

let modelsFileCache: { mtimeMs: number; data: { providers: Record<string, any> } } | null = null;

function readModelsFile(): { providers: Record<string, any> } {
  try {
    if (!fs.existsSync(MODELS_JSON_PATH)) {
      modelsFileCache = null;
      return { providers: {} };
    }
    const stat = fs.statSync(MODELS_JSON_PATH);
    if (modelsFileCache && modelsFileCache.mtimeMs === stat.mtimeMs) return modelsFileCache.data;
    const parsed = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return { providers: {} };
    if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
    modelsFileCache = { mtimeMs: stat.mtimeMs, data: parsed };
    return parsed;
  } catch {
    return { providers: {} };
  }
}

function writeModelsFile(data: { providers: Record<string, any> }) {
  fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
  if (fs.existsSync(MODELS_JSON_PATH)) {
    fs.copyFileSync(MODELS_JSON_PATH, `${MODELS_JSON_PATH}.bak`);
  }
  const payload = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${MODELS_JSON_PATH}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  try {
    fs.renameSync(tmp, MODELS_JSON_PATH);
  } catch {
    fs.writeFileSync(MODELS_JSON_PATH, payload, "utf8");
    try { fs.unlinkSync(tmp); } catch {}
  }
  try {
    modelsFileCache = { mtimeMs: fs.statSync(MODELS_JSON_PATH).mtimeMs, data };
  } catch {
    modelsFileCache = null;
  }
}

function normalizeModelId(id: unknown): string {
  // Keep leading slashes (/CN/...) and internal slashes exactly.
  return String(id ?? "").trim();
}

function maskApiKey(key?: string): { set: boolean; hint: string } {
  if (!key) return { set: false, hint: "" };
  if (key.startsWith("$") || key.startsWith("${")) return { set: true, hint: key };
  if (key.startsWith("!")) return { set: true, hint: "（命令获取）" };
  return { set: true, hint: key.length > 8 ? `••••${key.slice(-4)}` : "••••" };
}

function resolveConfiguredApiKey(value?: string): string {
  if (!value) return "";
  if (value.startsWith("$$") || value.startsWith("$!")) return value.slice(1);
  const envMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/) || value.match(/^\$([A-Z0-9_]+)$/);
  if (envMatch) return process.env[envMatch[1]] || "";
  return value;
}

function isRelayProvider(providerId: string, cfg?: any): boolean {
  if (!providerId || BUILTIN_PROVIDERS.has(providerId)) return false;
  const api = String(cfg?.api || "openai-completions");
  return !!cfg?.baseUrl && RELAY_APIS.has(api);
}

function summarizeProvider(id: string, cfg: any) {
  const models = Array.isArray(cfg?.models) ? cfg.models : [];
  const key = maskApiKey(cfg?.apiKey);
  return {
    id,
    name: cfg?.name || id,
    baseUrl: cfg?.baseUrl || "",
    api: cfg?.api || "openai-completions",
    authHeader: cfg?.authHeader !== false,
    compat: cfg?.compat || {},
    apiKeySet: key.set,
    apiKeyHint: key.hint,
    modelCount: models.length,
    sampleModels: models.slice(0, 8).map((m: any) => normalizeModelId(m?.id)).filter(Boolean),
    liveSync: isRelayProvider(id, cfg),
  };
}

async function fetchRelayModelRecords(baseUrl: string, apiKey?: string, extraHeaders?: Record<string, string>) {
  const url = String(baseUrl || "").replace(/\/+$/, "");
  if (!url) throw new Error("供应商没有配置 API 地址");
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(extraHeaders || {}),
  };
  if (apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${url}/models`, { headers, signal: controller.signal });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.text()).slice(0, 240); } catch {}
      throw new Error(`供应商模型接口返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
    }
    const payload: any = await response.json();
    const records = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    return records
      .map((item: any) => {
        const id = normalizeModelId(item?.id ?? item?.name ?? item?.model);
        return id ? { id, name: String(item?.name || item?.id || id).trim(), raw: item } : null;
      })
      .filter(Boolean) as Array<{ id: string; name: string; raw: any }>;
  } finally {
    clearTimeout(timeout);
  }
}

// Instance registry — tracks all running Tau servers
function registerInstance(port: number, sessionFile: string, cwd: string) {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
  const info = { port, pid: process.pid, sessionFile, cwd, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(INSTANCES_DIR, `${process.pid}.json`), JSON.stringify(info));
}

function updateInstanceSession(sessionFile: string) {
  const file = path.join(INSTANCES_DIR, `${process.pid}.json`);
  if (!fs.existsSync(file)) return;
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    info.sessionFile = sessionFile;
    fs.writeFileSync(file, JSON.stringify(info));
  } catch {}
}

function unregisterInstance() {
  try { fs.unlinkSync(path.join(INSTANCES_DIR, `${process.pid}.json`)); } catch {}
}

function getRunningInstances(): Array<{ port: number; pid: number; sessionFile: string; cwd: string }> {
  if (!fs.existsSync(INSTANCES_DIR)) return [];
  const instances: any[] = [];
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Check if process is still alive
      try {
        process.kill(info.pid, 0);
        instances.push(info);
      } catch {
        // Process dead — clean up stale file
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
      }
    } catch {}
  }
  return instances;
}

/**
 * Kill zombie Tau instances — processes that are alive but orphaned
 * (e.g. tmux pane was killed without session_shutdown firing).
 * A zombie is detected by checking if the process has a controlling terminal.
 * If it doesn't, the HTTP server is the only thing keeping it alive.
 */
function cleanupZombieInstances() {
  if (process.platform === "win32") return;
  if (!fs.existsSync(INSTANCES_DIR)) return;
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Skip our own process
      if (info.pid === process.pid) continue;
      // Check if process is alive
      try {
        process.kill(info.pid, 0);
      } catch {
        // Already dead — clean up
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
        continue;
      }
      // Use shared zombie detection
      if (isZombieProcess(info.pid)) {
        console.log(`[Mirror] Killing zombie Tau instance (PID ${info.pid}, port ${info.port})`);
        process.kill(info.pid, "SIGTERM");
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
      }
    } catch {}
  }
}

function isZombieProcess(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    const { execSync } = require("node:child_process");
    const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: "utf8" }).trim();
    return !tty || tty === "??" || tty === "-";
  } catch {
    return true;
  }
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function saveTauSetting(key: string, value: any) {
  const settingsPath = path.join(process.env.HOME || "~", ".pi/agent/settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!settings.tau) settings.tau = {};
    settings.tau[key] = value;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {}
}

function checkBasicAuth(req: http.IncomingMessage): boolean {
  if (!authEnabled) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  if (colon === -1) return false;
  return decoded.slice(0, colon) === AUTH_USER && decoded.slice(colon + 1) === AUTH_PASS;
}

function sendAuthRequired(res: http.ServerResponse) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Tau"',
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export default function (pi: ExtensionAPI) {
  try {
    const file = readModelsFile();
    if (migrateRelayProtocols(file)) writeModelsFile(file);
  } catch (e: any) {
    console.warn(`[Mirror] Could not migrate relay protocols: ${e?.message || e}`);
  }

  // Extension event/tool contexts intentionally do not expose session control
  // methods. Register a command so the WebSocket layer can request the same
  // supported reload path as Pi's interactive command context.
  pi.registerCommand("tau-reload-models", {
    description: "Reload Pi settings and model providers for Tau",
    handler: async (_args, ctx) => {
      // Reload invalidates this entire extension closure. Do not execute any
      // extension code after the await (including notifications via old ctx).
      await ctx.reload();
      return;
    },
  });

  function resolveAllowedSessionPath(candidate: string): string | null {
    if (!candidate) return null;
    const resolved = path.resolve(candidate);
    const root = path.resolve(SESSIONS_DIR);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (path.extname(resolved).toLowerCase() !== ".jsonl" || !fs.existsSync(resolved)) return null;
    // Reject symlink escapes: the real target must still live inside the
    // sessions directory. Keep returning the resolved (not real) path so the
    // session replacement uses the path the browser actually selected.
    try {
      const real = fs.realpathSync(resolved);
      const realRelative = path.relative(root, real);
      if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) return null;
    } catch {
      return null;
    }
    return resolved;
  }

  function sanitizeSessionName(name: string): string {
    return String(name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  }

  type SessionNameCacheEntry = {
    size: number;
    mtimeMs: number;
    name: string | null;
  };
  const SESSION_NAME_CACHE_PATH = path.join(PI_AGENT_DIR, "tau-session-names-v1.json");
  const MAX_SESSION_NAME_CACHE_ENTRIES = 5000;
  const sessionNameCache = new Map<string, SessionNameCacheEntry>();
  let sessionNameCacheDirty = false;
  let sessionNameCacheTimer: NodeJS.Timeout | null = null;

  function sessionCacheKey(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  function loadSessionNameCache(): void {
    try {
      const stat = fs.statSync(SESSION_NAME_CACHE_PATH);
      if (stat.size > 4 * 1024 * 1024) return;
      const payload = JSON.parse(fs.readFileSync(SESSION_NAME_CACHE_PATH, "utf8"));
      if (payload?.version !== 1 || !Array.isArray(payload.entries)) return;
      for (const item of payload.entries.slice(-MAX_SESSION_NAME_CACHE_ENTRIES)) {
        if (!item || typeof item.path !== "string" || typeof item.size !== "number" || typeof item.mtimeMs !== "number") continue;
        const name = item.name === null ? null : typeof item.name === "string" ? item.name : null;
        sessionNameCache.set(sessionCacheKey(item.path), { size: item.size, mtimeMs: item.mtimeMs, name });
      }
    } catch {}
  }

  function persistSessionNameCache(): void {
    if (sessionNameCacheTimer) {
      clearTimeout(sessionNameCacheTimer);
      sessionNameCacheTimer = null;
    }
    if (!sessionNameCacheDirty) return;
    sessionNameCacheDirty = false;
    try {
      fs.mkdirSync(path.dirname(SESSION_NAME_CACHE_PATH), { recursive: true });
      const entries = Array.from(sessionNameCache.entries())
        .slice(-MAX_SESSION_NAME_CACHE_ENTRIES)
        .map(([filePath, value]) => ({ path: filePath, ...value }));
      // This file is only an optimization. A partial write after a crash is
      // ignored on next startup and rebuilt from the authoritative JSONL files.
      fs.writeFileSync(SESSION_NAME_CACHE_PATH, JSON.stringify({ version: 1, entries }), "utf8");
    } catch (error: any) {
      sessionNameCacheDirty = true;
      console.warn(`[Mirror] Could not persist session-name cache: ${error?.message || error}`);
    }
  }

  function scheduleSessionNameCachePersist(): void {
    if (sessionNameCacheTimer) return;
    sessionNameCacheTimer = setTimeout(persistSessionNameCache, 250);
    sessionNameCacheTimer.unref?.();
  }

  function cacheSessionName(filePath: string, stat: fs.Stats, name: string | null): void {
    const key = sessionCacheKey(filePath);
    const current = sessionNameCache.get(key);
    if (current?.size === stat.size && current.mtimeMs === stat.mtimeMs && current.name === name) return;
    // Refresh insertion order so pruning retains recently used sessions.
    sessionNameCache.delete(key);
    sessionNameCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, name });
    while (sessionNameCache.size > MAX_SESSION_NAME_CACHE_ENTRIES) {
      const oldest = sessionNameCache.keys().next().value;
      if (typeof oldest !== "string") break;
      sessionNameCache.delete(oldest);
    }
    sessionNameCacheDirty = true;
    scheduleSessionNameCachePersist();
  }

  loadSessionNameCache();

  type SessionTailInfo = { name: string | null; lastEntryId: string | null };

  function sessionPathsEqual(a: string | undefined | null, b: string | undefined | null): boolean {
    if (!a || !b) return false;
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  /**
   * Read JSONL records backwards until the latest session_info is found.
   *
   * A fixed-size tail is not sufficient: after a rename, a long assistant/tool
   * response can move the name megabytes away from EOF. That made Tau fall back
   * to an older title after Pi or the computer restarted. This scanner reads
   * in blocks and retains only the one JSONL record crossing a block boundary.
   */
  function inspectSessionFileTail(filePath: string): SessionTailInfo {
    const fd = fs.openSync(filePath, "r");
    try {
      const stat = fs.fstatSync(fd);
      const blockSize = 64 * 1024;
      let position = stat.size;
      let carry = Buffer.alloc(0);
      let lastEntryId: string | null = null;

      const inspectLine = (line: Buffer): string | null | undefined => {
        const text = line.toString("utf8").replace(/\r$/, "").trim();
        if (!text) return undefined;
        try {
          const entry = JSON.parse(text);
          if (lastEntryId === null && typeof entry?.id === "string") lastEntryId = entry.id;
          if (entry?.type === "session_info") {
            return typeof entry.name === "string" ? entry.name.trim() : "";
          }
        } catch {}
        return undefined;
      };

      while (position > 0) {
        const size = Math.min(blockSize, position);
        position -= size;
        const chunk = Buffer.allocUnsafe(size);
        fs.readSync(fd, chunk, 0, size, position);
        const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
        let lineEnd = data.length;
        // A final newline terminates the preceding record; it is not an extra
        // record. Move past it before searching for the previous separator.
        if (lineEnd > 0 && data[lineEnd - 1] === 10) lineEnd--;

        let firstSeparator = -1;
        for (let i = lineEnd - 1; i >= 0; i--) {
          if (data[i] !== 10) continue;
          if (firstSeparator < 0) firstSeparator = i;
          const found = inspectLine(data.subarray(i + 1, lineEnd));
          if (found !== undefined) return { name: found, lastEntryId };
          lineEnd = i;
        }

        if (position === 0) {
          const found = inspectLine(data.subarray(0, lineEnd));
          if (found !== undefined) return { name: found, lastEntryId };
          carry = Buffer.alloc(0);
        } else {
          // Keep only the leading partial record. Complete records were already
          // inspected above and must not be parsed again with the prior block.
          const carryEnd = firstSeparator >= 0 ? firstSeparator : lineEnd;
          carry = Buffer.from(data.subarray(0, carryEnd));
        }
      }

      return { name: null, lastEntryId };
    } finally {
      fs.closeSync(fd);
    }
  }

  async function inspectSessionFileTailAsync(filePath: string): Promise<SessionTailInfo> {
    const handle = await fs.promises.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const blockSize = 64 * 1024;
      let position = stat.size;
      let carry = Buffer.alloc(0);
      let lastEntryId: string | null = null;
      let scannedBlocks = 0;

      const inspectLine = (line: Buffer): string | null | undefined => {
        const text = line.toString("utf8").replace(/\r$/, "").trim();
        if (!text) return undefined;
        try {
          const entry = JSON.parse(text);
          if (lastEntryId === null && typeof entry?.id === "string") lastEntryId = entry.id;
          if (entry?.type === "session_info") {
            return typeof entry.name === "string" ? entry.name.trim() : "";
          }
        } catch {}
        return undefined;
      };

      while (position > 0) {
        const size = Math.min(blockSize, position);
        position -= size;
        const chunk = Buffer.allocUnsafe(size);
        await handle.read(chunk, 0, size, position);
        // Large JSON parsing and Buffer concatenation are still CPU work. Yield
        // periodically so streaming/UI events are not starved on a cold scan.
        if (++scannedBlocks % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
        let lineEnd = data.length;
        if (lineEnd > 0 && data[lineEnd - 1] === 10) lineEnd--;

        let firstSeparator = -1;
        for (let i = lineEnd - 1; i >= 0; i--) {
          if (data[i] !== 10) continue;
          if (firstSeparator < 0) firstSeparator = i;
          const found = inspectLine(data.subarray(i + 1, lineEnd));
          if (found !== undefined) return { name: found, lastEntryId };
          lineEnd = i;
        }

        if (position === 0) {
          const found = inspectLine(data.subarray(0, lineEnd));
          if (found !== undefined) return { name: found, lastEntryId };
          carry = Buffer.alloc(0);
        } else {
          const carryEnd = firstSeparator >= 0 ? firstSeparator : lineEnd;
          carry = Buffer.from(data.subarray(0, carryEnd));
        }
      }
      return { name: null, lastEntryId };
    } finally {
      await handle.close();
    }
  }

  function readLatestSessionName(filePath: string): string | null {
    const stat = fs.statSync(filePath);
    const cached = sessionNameCache.get(sessionCacheKey(filePath));
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.name;
    const name = inspectSessionFileTail(filePath).name;
    cacheSessionName(filePath, stat, name);
    return name;
  }

  async function inspectAppendedSessionNames(
    filePath: string,
    start: number,
    end: number,
  ): Promise<{ validBoundary: boolean; found: boolean; name: string | null }> {
    const handle = await fs.promises.open(filePath, "r");
    try {
      if (start > 0) {
        const boundary = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(boundary, 0, 1, start - 1);
        if (bytesRead !== 1 || boundary[0] !== 10) return { validBoundary: false, found: false, name: null };
      }

      const blockSize = 64 * 1024;
      let position = start;
      let pending = Buffer.alloc(0);
      let found = false;
      let name: string | null = null;
      while (position < end) {
        const size = Math.min(blockSize, end - position);
        const chunk = Buffer.allocUnsafe(size);
        const { bytesRead } = await handle.read(chunk, 0, size, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        const data = pending.length
          ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        let lineStart = 0;
        for (let i = 0; i < data.length; i++) {
          if (data[i] !== 10) continue;
          const line = data.subarray(lineStart, i).toString("utf8").replace(/\r$/, "");
          lineStart = i + 1;
          try {
            const entry = JSON.parse(line);
            if (entry?.type === "session_info") {
              found = true;
              name = typeof entry.name === "string" ? entry.name.trim() : "";
            }
          } catch {}
        }
        pending = Buffer.from(data.subarray(lineStart));
      }
      // The stat snapshot can end at a complete final line even without LF.
      // Parse it only when all requested bytes were read.
      if (position === end && pending.length > 0) {
        try {
          const entry = JSON.parse(pending.toString("utf8").replace(/\r$/, ""));
          if (entry?.type === "session_info") {
            found = true;
            name = typeof entry.name === "string" ? entry.name.trim() : "";
          }
        } catch {}
      }
      return { validBoundary: true, found, name };
    } finally {
      await handle.close();
    }
  }

  async function readLatestSessionNameForList(filePath: string): Promise<string | null> {
    const stat = await fs.promises.stat(filePath);
    const cached = sessionNameCache.get(sessionCacheKey(filePath));
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.name;

    if (cached && stat.size > cached.size) {
      const appended = await inspectAppendedSessionNames(filePath, cached.size, stat.size);
      if (appended.validBoundary) {
        const name = appended.found ? appended.name : cached.name;
        cacheSessionName(filePath, stat, name);
        return name;
      }
    }

    // Cold cache reads use asynchronous file I/O so listing long sessions does
    // not pause Pi's WebSocket events or token streaming. Truncation, in-place
    // edits, and invalid append boundaries intentionally take this safe path.
    const name = (await inspectSessionFileTailAsync(filePath)).name;
    cacheSessionName(filePath, stat, name);
    return name;
  }

  function rememberCurrentSessionName(filePath: string, name: string): void {
    const stat = fs.statSync(filePath);
    cacheSessionName(filePath, stat, name);
  }

  function flushSessionFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    const fd = fs.openSync(filePath, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  function appendSessionInfoToFile(filePath: string, name: string): string {
    const { lastEntryId } = inspectSessionFileTail(filePath);
    const entry = {
      type: "session_info",
      id: randomBytes(4).toString("hex"),
      parentId: lastEntryId,
      timestamp: new Date().toISOString(),
      name,
    };
    const fd = fs.openSync(filePath, "a");
    try {
      fs.writeSync(fd, JSON.stringify(entry) + "\n", undefined, "utf8");
      // Do not report success while the rename exists only in the OS write cache.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Verify independently before populating the cache. A stale cache must
    // never be able to turn an unsuccessful disk write into reported success.
    const verified = inspectSessionFileTail(filePath).name;
    if (verified !== name) throw new Error("rename_verify_failed");
    rememberCurrentSessionName(filePath, name);
    return name;
  }

  async function proxyRenameToOwner(port: number, filePath: string, name: string): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Tau-Rename-Owner": "1",
    };
    if (authEnabled && AUTH_CONFIGURED) {
      headers.Authorization = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString("base64")}`;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/rename`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filePath, name }),
        signal: AbortSignal.timeout(5000),
      });
      const data: any = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) throw new Error(data?.error || "owner_unavailable");
      return sanitizeSessionName(data.name) || name;
    } catch (error: any) {
      if (error?.message && error.message !== "owner_unavailable") {
        console.warn(`[Mirror] Live session rename proxy failed on port ${port}: ${error.message}`);
      }
      throw new Error("owner_unavailable");
    }
  }

  async function renameSessionFile(
    filePath: string,
    rawName: string,
    ownerRequest = false,
  ): Promise<{ name: string; live: boolean; ownerPid?: number }> {
    const name = sanitizeSessionName(rawName);
    if (!name) throw new Error("empty");

    const currentFile = latestCtx?.sessionManager.getSessionFile();
    if (runtimeActive && sessionPathsEqual(currentFile, filePath)) {
      pi.setSessionName(name);
      if (pi.getSessionName() !== name) throw new Error("rename_verify_failed");
      flushSessionFile(filePath);
      const verified = inspectSessionFileTail(filePath).name;
      if (verified !== name) throw new Error("rename_verify_failed");
      rememberCurrentSessionName(filePath, name);
      return { name, live: true, ownerPid: process.pid };
    }

    // Never append behind another live SessionManager's back. Its in-memory
    // leaf would not include the rename and a later rewrite could discard it.
    if (ownerRequest) throw new Error("owner_mismatch");

    const owner = getRunningInstances().find((instance) =>
      instance.pid !== process.pid && sessionPathsEqual(instance.sessionFile, filePath)
    );
    if (owner) {
      const saved = await proxyRenameToOwner(owner.port, filePath, name);
      if (readLatestSessionName(filePath) !== saved) throw new Error("rename_verify_failed");
      return { name: saved, live: true, ownerPid: owner.pid };
    }

    appendSessionInfoToFile(filePath, name);
    return { name, live: false };
  }

  pi.registerCommand("tau-new", {
    description: "Create a new Pi session selected from Tau",
    handler: async (_args, ctx) => {
      try {
        await ctx.waitForIdle();
        await ctx.newSession();
      } catch (e: any) {
        console.error("[Mirror] New session failed:", e?.message || e);
        ctx.ui.notify(`Tau 新建会话失败：${e?.message || e}`, "error");
      }
    },
  });

  // Session replacement is available only on a command context. The browser
  // asks the event context to queue this command, then reconnects after Pi has
  // rebound the selected historical session.
  pi.registerCommand("tau-resume", {
    description: "Resume a Pi session selected from Tau",
    handler: async (args, ctx) => {
      let decoded = "";
      try {
        decoded = Buffer.from(args.trim(), "base64url").toString("utf8");
      } catch {}
      const sessionPath = resolveAllowedSessionPath(decoded);
      if (!sessionPath) {
        ctx.ui.notify("Tau 无法继续该会话：会话路径无效", "error");
        return;
      }
      try {
        await ctx.waitForIdle();
        await ctx.switchSession(sessionPath);
      } catch (e: any) {
        console.error("[Mirror] Session switch failed:", e?.message || e);
        ctx.ui.notify(`Tau 切换会话失败：${e?.message || e}`, "error");
      }
    },
  });

  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const clients = new Set<WebSocket>();

  // Store latest context reference for use in command handlers. Session-bound
  // API calls must stop as soon as Pi begins replacing/reloading the session;
  // callbacks from closing sockets can otherwise outlive this extension ctx.
  let latestCtx: ExtensionContext | null = null;
  let runtimeActive = true;
  let runtimeGeneration = 0;

  // Provider metadata is intentionally fetched only for providers explicitly
  // opted in here. This avoids silently calling every configured endpoint when
  // a browser opens Tau. Credentials are resolved by Pi and never sent to the UI.
  const LIVE_MODEL_METADATA_PROVIDERS = new Set<string>();
  // Providers whose /v1/models response is the authoritative model list.
  // Tau re-fetches it on refresh, registers discovered models back into Pi, and
  // drops stale entries so the web list follows the relay exactly.
  // Custom providers from models.json are included automatically so /CN models
  // and newly added relays stay selectable without editing this set.
  const LIVE_MODEL_SYNC_ALWAYS = new Set(["newapi-futureppo", "ccswitch-cl"]);
  const MANUAL_MODEL_PROVIDERS = new Set(["tavern-openai", "newapi-zhyxulei"]);

  function getLiveSyncProviders(): Set<string> {
    const file = readModelsFile();
    const ids = new Set<string>(LIVE_MODEL_SYNC_ALWAYS);
    for (const [id, cfg] of Object.entries(file.providers || {})) {
      if (MANUAL_MODEL_PROVIDERS.has(id)) continue;
      if (isRelayProvider(id, cfg)) ids.add(id);
    }
    return ids;
  }
  const providerMetadataCache = new Map<string, { fetchedAt: number; models: Map<string, any>; error?: string }>();
  const PROVIDER_METADATA_TTL = 5 * 60 * 1000;

  function readPositiveNumber(value: unknown): number | undefined {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  function firstPositive(...values: unknown[]): number | undefined {
    for (const value of values) {
      const parsed = readPositiveNumber(value);
      if (parsed) return parsed;
    }
    return undefined;
  }

  // Leftover numbers Tau used to invent. Never treat these as a user choice
  // when a real official or relay value exists.
  const INVENTED_CONTEXT_DEFAULTS = new Set([128000, 16384, 258000, 1000000]);

  type ModelInputType = "text" | "image";
  type OfficialModelInfo = {
    contextWindow?: number;
    maxTokens?: number;
    name?: string;
    reasoning?: boolean;
    input?: ModelInputType[];
  };
  let officialCatalog: Map<string, OfficialModelInfo[]> | null = null;
  const OFFICIAL_PRIMARY_FILES = [
    "openai.json", "openai-codex.json", "anthropic.json", "google.json", "google-vertex.json",
    "xai.json", "deepseek.json", "mistral.json", "groq.json", "moonshotai.json", "moonshotai-cn.json",
    "minimax.json", "minimax-cn.json", "zai.json", "zai-coding-cn.json", "kimi-coding.json", "xiaomi.json",
  ];
  const GENERIC_MODEL_IDS = new Set([
    "auto", "default", "latest", "chat", "image", "video", "embedding", "moderation", "router",
  ]);

  function isDistinctiveModelId(id: string): boolean {
    const value = String(id || "").toLowerCase();
    if (!value || GENERIC_MODEL_IDS.has(value)) return false;
    return /\d/.test(value) || value.length >= 10;
  }

  function loadOfficialCatalog(): Map<string, OfficialModelInfo> {
    if (officialCatalog) return officialCatalog;
    officialCatalog = new Map();
    const dirs: string[] = [];
    try {
      const pkg = require.resolve("@earendil-works/pi-ai/package.json");
      dirs.push(path.join(path.dirname(pkg), "dist", "providers", "data"));
    } catch {}
    try {
      const pkg = require.resolve("@earendil-works/pi-coding-agent/package.json");
      dirs.push(path.join(path.dirname(pkg), "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"));
    } catch {}
    dirs.push(path.join(USER_HOME, "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"));
    const dir = dirs.find((item) => fs.existsSync(item));
    if (!dir) return officialCatalog;
    // Only vendor catalogs. Skip aggregator dumps (OpenRouter / Vercel / Cloudflare)
    // so first paint does not parse 200KB+ of someone else's model list.
    const files = OFFICIAL_PRIMARY_FILES.filter((file) => fs.existsSync(path.join(dir, file)));
    for (const file of files) {
      const primary = true;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        const walk = (node: any) => {
          if (!node || typeof node !== "object") return;
          if (typeof node.id === "string" && (node.contextWindow || node.context_window)) {
            const rec: OfficialModelInfo = {
              contextWindow: readPositiveNumber(node.contextWindow ?? node.context_window),
              maxTokens: readPositiveNumber(node.maxTokens ?? node.max_tokens),
              name: node.name,
              reasoning: typeof node.reasoning === "boolean" ? node.reasoning : undefined,
              input: normalizeModelInput(node.input),
            };
            const id = String(node.id);
            const addKey = (key: string) => {
              if (!key || GENERIC_MODEL_IDS.has(key.toLowerCase())) return;
              const lower = key.toLowerCase();
              const current = officialCatalog!.get(lower) || [];
              // The same ID may exist under several official APIs (for example
              // OpenAI and Codex). Keep all records and union capabilities.
              if (!current.includes(rec)) current.push(rec);
              officialCatalog!.set(lower, current);
            };
            addKey(id);
            const last = id.split(/[\/:]/).filter(Boolean).pop() || "";
            if (last && last !== id && isDistinctiveModelId(last) && (primary || last === id)) addKey(last);
            return;
          }
          for (const value of Object.values(node)) walk(value);
        };
        walk(data);
      } catch {}
    }
    return officialCatalog;
  }

  function officialIdCandidates(modelId: string): string[] {
    const raw = normalizeModelId(modelId);
    const out: string[] = [];
    const add = (value: string) => {
      if (value && !out.includes(value)) out.push(value);
    };
    add(raw);
    const trimmed = raw.replace(/^\/+/, "");
    add(trimmed);
    const parts = trimmed.split(/[\/:]/).filter(Boolean);
    const last = parts[parts.length - 1] || trimmed;
    if (parts.length > 1 && isDistinctiveModelId(last)) add(last);
    const strippedNone = last.replace(/-thinking-none$/i, "");
    const strippedThinking = last.replace(/-thinking(-[a-z0-9]+)?$/i, "");
    if (strippedNone !== last && isDistinctiveModelId(strippedNone)) add(strippedNone);
    if (strippedThinking !== last && isDistinctiveModelId(strippedThinking)) add(strippedThinking);
    return out;
  }

  function lookupOfficialModel(modelId: string): OfficialModelInfo | undefined {
    const catalog = loadOfficialCatalog();
    for (const key of officialIdCandidates(modelId)) {
      const hits = catalog.get(key.toLowerCase());
      if (!hits?.length) continue;
      const first = hits[0];
      return {
        contextWindow: first.contextWindow,
        maxTokens: first.maxTokens,
        name: first.name,
        reasoning: hits.some((item) => item.reasoning === true)
          ? true
          : hits.every((item) => item.reasoning === false)
            ? false
            : first.reasoning,
        input: hits.some((item) => item.input?.includes("image"))
          ? ["text", "image"]
          : first.input,
      };
    }
    return undefined;
  }

  function fileModelEntry(provider: string, modelId: string): any | undefined {
    const cfg = readModelsFile().providers?.[provider];
    if (!cfg) return undefined;
    const id = normalizeModelId(modelId);
    const models = Array.isArray(cfg.models) ? cfg.models : [];
    const direct = models.find((item: any) => normalizeModelId(item?.id) === id);
    if (direct) return direct;
    const overrides = cfg.modelOverrides && typeof cfg.modelOverrides === "object" ? cfg.modelOverrides : {};
    if (overrides[id] || overrides[modelId]) return { id, ...(overrides[id] || overrides[modelId]), fromOverride: true };
    return undefined;
  }

  function resolveModelContext(modelId: string, existing: any, upstream: any, error?: string) {
    const official = lookupOfficialModel(modelId);
    const officialContextWindow = official?.contextWindow;
    const providerContextWindow = upstreamContextWindow(upstream);
    const configured = readPositiveNumber(existing?.contextWindow);
    const markedCustom = !!(existing?.contextCustom && configured);
    const implicitCustom = !!(configured && officialContextWindow && configured !== officialContextWindow && !INVENTED_CONTEXT_DEFAULTS.has(configured));
    const customContextWindow = markedCustom || implicitCustom ? configured : undefined;

    if (customContextWindow) {
      return {
        contextWindow: customContextWindow,
        contextSource: "custom",
        customContextWindow,
        providerContextWindow,
        officialContextWindow,
      };
    }
    if (providerContextWindow) {
      return {
        contextWindow: providerContextWindow,
        contextSource: "provider",
        customContextWindow: undefined,
        providerContextWindow,
        officialContextWindow,
      };
    }
    if (officialContextWindow) {
      return {
        contextWindow: officialContextWindow,
        contextSource: "official",
        customContextWindow: undefined,
        providerContextWindow,
        officialContextWindow,
      };
    }
    if (configured && !INVENTED_CONTEXT_DEFAULTS.has(configured)) {
      return {
        contextWindow: configured,
        contextSource: "config",
        customContextWindow: undefined,
        providerContextWindow,
        officialContextWindow,
      };
    }
    return {
      contextWindow: undefined,
      contextSource: error ? "unknown-error" : "unknown",
      customContextWindow: undefined,
      providerContextWindow,
      officialContextWindow,
    };
  }

  function upstreamContextWindow(model: any): number | undefined {
    if (!model || typeof model !== "object") return undefined;
    return firstPositive(
      model.context_window,
      model.contextWindow,
      model.context_length,
      model.contextLength,
      model.max_context_length,
      model.max_model_len,
      model.max_input_tokens,
      model.input_token_limit,
      model.n_ctx,
      model.max_position_embeddings,
      model?.info?.context_length,
      model?.info?.context_window,
      model?.meta?.context_length,
      model?.capabilities?.context_window,
    );
  }

  function upstreamMaxTokens(model: any): number | undefined {
    if (!model || typeof model !== "object") return undefined;
    return firstPositive(
      model.max_output_tokens,
      model.maxOutputTokens,
      model.max_completion_tokens,
      model.max_tokens,
      model.maxTokens,
      model?.info?.max_tokens,
    );
  }

  function upstreamReasoning(model: any): boolean | undefined {
    if (!model || typeof model !== "object") return undefined;
    if (typeof model.reasoning === "boolean") return model.reasoning;
    if (typeof model.supports_reasoning === "boolean") return model.supports_reasoning;
    if (typeof model.thinking === "boolean") return model.thinking;
    return undefined;
  }

  function normalizeModelInput(raw: any): ModelInputType[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const values = raw.map((item: any) => String(item).toLowerCase());
    const input: ModelInputType[] = [];
    if (values.some((item: string) => item.includes("text"))) input.push("text");
    if (values.some((item: string) => item.includes("image") || item.includes("vision"))) input.push("image");
    return input.length > 0 ? input : undefined;
  }

  function capabilityFlag(value: any): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      if (["true", "yes", "supported", "enabled", "available"].includes(normalized)) return true;
      if (["false", "no", "unsupported", "disabled", "unavailable"].includes(normalized)) return false;
    }
    if (value && typeof value === "object") {
      return capabilityFlag(value.supported ?? value.enabled ?? value.available);
    }
    return undefined;
  }

  function upstreamImageSupport(model: any): boolean | undefined {
    if (!model || typeof model !== "object") return undefined;
    const input = normalizeModelInput(
      model.input ?? model.input_modalities ?? model.modalities?.input ?? model.architecture?.input_modalities,
    );

    const explicit = [
      model.supports_images,
      model.supports_image,
      model.supports_vision,
      model.vision,
      model.capabilities?.image,
      model.capabilities?.vision,
      model.capabilities?.image_input,
      model.features?.vision,
    ];
    for (const value of explicit) {
      const flag = capabilityFlag(value);
      if (flag !== undefined) return flag;
    }
    if (input?.includes("image")) return true;
    // A provider returning only ["text"] is not an explicit denial. Many
    // OpenAI-compatible /models endpoints expose an incomplete modality list.
    return undefined;
  }

  function inferredModelInput(modelId: string): ModelInputType[] | undefined {
    const id = normalizeModelId(modelId).toLowerCase();
    const last = id.split(/[\/:]/).filter(Boolean).pop() || id;
    if (/embedding|moderation|rerank|speech|tts|transcri|audio-only/.test(last)) return undefined;
    const multimodal =
      /(?:^|[-_.])(vision|vl)(?:$|[-_.])/.test(last) ||
      /^gemini-/.test(last) ||
      /^claude-(?:3|4|5|haiku|sonnet|opus|fable)/.test(last) ||
      /^gpt-(?:4o|4\.1|5(?:[.-]|$))/.test(last) ||
      /^grok-(?:4|5)(?:[.-]|$)/.test(last) ||
      /^kimi-k(?:2\.[5-9]|[3-9])(?:[.-]|$)/.test(last) ||
      /^glm-(?:4v|5v)/.test(last) ||
      /^qwen(?:2|3)?(?:[.-])?vl(?:[.-]|$)/.test(last);
    return multimodal ? ["text", "image"] : undefined;
  }

  function resolveModelInput(modelId: string, existing: any, upstream: any): ModelInputType[] {
    const configured = normalizeModelInput(existing?.input);
    if ((existing?.inputCustom === true || existing?.inputProviderExplicit === true) && configured) return configured;

    const explicitUpstream = upstreamImageSupport(upstream);
    if (explicitUpstream === false) return ["text"];

    const official = lookupOfficialModel(modelId)?.input;
    const inferred = inferredModelInput(modelId);
    const supportsImage =
      explicitUpstream === true ||
      configured?.includes("image") === true ||
      official?.includes("image") === true ||
      inferred?.includes("image") === true;
    return supportsImage ? ["text", "image"] : ["text"];
  }

  async function fetchProviderModelMetadata(ctx: ExtensionContext, provider: string, sampleModel: any, force = false) {
    const cached = providerMetadataCache.get(provider);
    if (!force && cached && Date.now() - cached.fetchedAt < PROVIDER_METADATA_TTL) return cached;

    try {
      const fileCfg = readModelsFile().providers?.[provider] || {};
      let baseUrl = "";
      let apiKey = "";
      let headers: Record<string, string> = { Accept: "application/json" };

      if (sampleModel) {
        try {
          const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(sampleModel);
          if (resolved.ok) {
            baseUrl = String(resolved.baseUrl || sampleModel.baseUrl || "");
            apiKey = resolved.apiKey || "";
            headers = { ...headers, ...(resolved.headers || {}) };
          }
        } catch {}
      }
      if (!baseUrl) baseUrl = String(fileCfg.baseUrl || sampleModel?.baseUrl || "");
      if (!apiKey) apiKey = resolveConfiguredApiKey(fileCfg.apiKey);
      if (fileCfg.headers && typeof fileCfg.headers === "object") {
        headers = { ...headers, ...fileCfg.headers };
      }
      baseUrl = baseUrl.replace(/\/+$/, "");
      if (!baseUrl) throw new Error("供应商没有配置 API 地址");
      if (apiKey && !headers.Authorization && !headers.authorization) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const records = await fetchRelayModelRecords(baseUrl, apiKey, headers);
      const result = {
        fetchedAt: Date.now(),
        models: new Map(records.map((item) => [item.id, item.raw])),
      };
      providerMetadataCache.set(provider, result);
      return result;
    } catch (e: any) {
      // Keep the error concise and secret-free. Never include headers or command output.
      const result = {
        fetchedAt: Date.now(),
        models: new Map<string, any>(),
        error: e?.name === "AbortError" ? "供应商模型接口超时" : (e?.message || "供应商模型接口不可用"),
      };
      providerMetadataCache.set(provider, result);
      return result;
    }
  }

  function liveModelConfig(id: string, existing: any, upstream: any, error?: string) {
    const official = lookupOfficialModel(id);
    const resolved = resolveModelContext(id, existing, upstream, error);
    const maxTokens = upstreamMaxTokens(upstream) || official?.maxTokens || existing?.maxTokens;
    return {
      id,
      name: existing?.name || official?.name || String(upstream?.name || id),
      reasoning: upstreamReasoning(upstream) ?? existing?.reasoning ?? official?.reasoning ?? true,
      input: resolveModelInput(id, existing, upstream),
      cost: existing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(resolved.contextWindow ? { contextWindow: resolved.contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      contextSource: resolved.contextSource,
      customContextWindow: resolved.customContextWindow,
      providerContextWindow: resolved.providerContextWindow,
      officialContextWindow: resolved.officialContextWindow,
    };
  }

  function toPiModelConfig(model: any) {
    const official = lookupOfficialModel(model.id);
    return {
      id: normalizeModelId(model.id),
      name: model.name || official?.name || normalizeModelId(model.id),
      reasoning: model.reasoning ?? official?.reasoning ?? true,
      input: resolveModelInput(model.id, model, null),
      cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: readPositiveNumber(model.contextWindow) || official?.contextWindow || 128000,
      maxTokens: readPositiveNumber(model.maxTokens) || official?.maxTokens || 16384,
      ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      ...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
      ...(model.headers ? { headers: model.headers } : {}),
      ...(model.compat ? { compat: model.compat } : {}),
    };
  }

  function repairSavedModelCapabilities(): void {
    const file = readModelsFile();
    const changedProviders: Array<[string, any]> = [];
    let changed = false;
    for (const [provider, cfg] of Object.entries(file.providers || {})) {
      if (!cfg || !Array.isArray(cfg.models)) continue;
      let providerChanged = false;
      for (const model of cfg.models) {
        if (!model?.id) continue;
        const resolvedInput = resolveModelInput(model.id, model, null);
        const currentInput = normalizeModelInput(model.input) || [];
        if (JSON.stringify(currentInput) === JSON.stringify(resolvedInput)) continue;
        model.input = resolvedInput;
        providerChanged = true;
        changed = true;
      }
      if (providerChanged) changedProviders.push([provider, cfg]);
    }
    if (!changed) return;

    writeModelsFile(file);
    for (const [provider, cfg] of changedProviders) {
      try {
        pi.registerProvider(provider, {
          name: cfg.name || provider,
          baseUrl: cfg.baseUrl,
          api: normalizeRelayApi(cfg.baseUrl, cfg.api),
          apiKey: cfg.apiKey,
          authHeader: cfg.authHeader !== false,
          compat: defaultRelayCompat(cfg.baseUrl, cfg.api, cfg.compat),
          headers: cfg.headers,
          models: cfg.models.filter((model: any) => model?.id).map(toPiModelConfig),
        });
      } catch (error: any) {
        console.warn(`[Mirror] Could not apply repaired capabilities for ${provider}: ${error?.message || error}`);
      }
    }
    console.log(`[Mirror] Repaired model capabilities for ${changedProviders.length} provider(s)`);
  }

  repairSavedModelCapabilities();

  // Full model-list sync for providers: fetch /v1/models, register the
  // discovered models into Pi so they stay selectable, then return a display
  // list that exactly mirrors the provider (adds new, removes stale).
  async function syncOneLiveProvider(
    ctx: ExtensionContext,
    provider: string,
    models: any[],
    file: { providers: Record<string, any> },
    force: boolean,
  ): Promise<any[]> {
    try {
      const cfg = file.providers?.[provider] || {};
      const sample = models.find((model) => model.provider === provider) || (cfg.models?.[0]
        ? { provider, id: normalizeModelId(cfg.models[0].id), baseUrl: cfg.baseUrl }
        : { provider, id: "default", baseUrl: cfg.baseUrl });

      const meta = await fetchProviderModelMetadata(ctx, provider, sample, force);
      const providerModels = models.filter((model) => model.provider === provider);
      if (meta.models.size === 0) {
        const fallback = providerModels.length > 0
          ? providerModels
          : (cfg.models || []).map((model: any) => ({
              provider,
              id: normalizeModelId(model.id),
              name: model.name || normalizeModelId(model.id),
              reasoning: model.reasoning,
              input: model.input,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
            }));
        return fallback.filter((model: any) => model.id).map((model: any) => {
          const fileEntry = fileModelEntry(provider, model.id) || model;
          const resolved = resolveModelContext(model.id, fileEntry, null, meta.error);
          return {
            ...model,
            ...resolved,
            input: resolveModelInput(model.id, fileEntry, null),
            providerMetadataError: meta.error,
            providerMetadataCheckedAt: meta.fetchedAt,
          };
        });
      }

      const existingById = new Map(providerModels.map((model) => [normalizeModelId(model.id), model]));
      const configs = [...meta.models.entries()].map(([id, upstream]) => {
        const fileEntry = fileModelEntry(provider, id) || existingById.get(id);
        return liveModelConfig(id, fileEntry, upstream);
      });
      try {
        if (providerModels.length > 0) {
          pi.registerProvider(provider, {
            api: normalizeRelayApi(cfg.baseUrl, cfg.api),
            compat: defaultRelayCompat(cfg.baseUrl, cfg.api, cfg.compat),
            models: configs.map(toPiModelConfig),
          });
        } else {
          pi.registerProvider(provider, {
            name: cfg.name || provider,
            baseUrl: cfg.baseUrl,
            api: normalizeRelayApi(cfg.baseUrl, cfg.api),
            apiKey: cfg.apiKey,
            authHeader: cfg.authHeader !== false,
            compat: defaultRelayCompat(cfg.baseUrl, cfg.api, cfg.compat),
            headers: cfg.headers,
            models: configs.map(toPiModelConfig),
          });
        }
      } catch (e: any) {
        console.warn(`[Mirror] Could not register live models for ${provider}: ${e?.message || e}`);
      }

      return [...meta.models.entries()].map(([id, upstream]) => {
        const existing = existingById.get(id);
        const fileEntry = fileModelEntry(provider, id) || existing;
        const config = liveModelConfig(id, fileEntry, upstream);
        return {
          ...(existing || {}),
          ...config,
          provider,
          providerMetadataCheckedAt: meta.fetchedAt,
          providerMetadataError: meta.error,
        };
      });
    } catch (e: any) {
      console.warn(`[Mirror] Live sync failed for ${provider}: ${e?.message || e}`);
      return models.filter((model) => model.provider === provider);
    }
  }

  async function syncLiveModels(ctx: ExtensionContext, models: any[], force = false) {
    const liveSyncProviders = getLiveSyncProviders();
    const file = readModelsFile();
    const syncProviders = [...liveSyncProviders];
    const localOnly = models.filter((model) => !liveSyncProviders.has(model.provider));
    const chunks = await Promise.all(
      syncProviders.map((provider) => syncOneLiveProvider(ctx, provider, models, file, force)),
    );
    return [...localOnly, ...chunks.flat()];
  }

  async function enrichModelsWithProviderMetadata(ctx: ExtensionContext, models: any[], force = false) {
    const byProvider = new Map<string, any[]>();
    for (const model of models) {
      if (!LIVE_MODEL_METADATA_PROVIDERS.has(model.provider)) continue;
      if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
      byProvider.get(model.provider)!.push(model);
    }

    const metadata = new Map<string, Awaited<ReturnType<typeof fetchProviderModelMetadata>>>();
    await Promise.all([...byProvider.entries()].map(async ([provider, providerModels]) => {
      metadata.set(provider, await fetchProviderModelMetadata(ctx, provider, providerModels[0], force));
    }));

    return models.map((model: any) => {
      if (getLiveSyncProviders().has(model.provider)) return model;
      const fileEntry = fileModelEntry(model.provider, model.id);
      const providerResult = LIVE_MODEL_METADATA_PROVIDERS.has(model.provider)
        ? metadata.get(model.provider)
        : undefined;
      const upstream = providerResult?.models.get(String(model.id));
      const resolved = resolveModelContext(
        model.id,
        fileEntry || model,
        upstream,
        providerResult?.error,
      );
      const input = resolveModelInput(model.id, fileEntry || model, upstream);
      if (!LIVE_MODEL_METADATA_PROVIDERS.has(model.provider) && !fileEntry && !resolved.officialContextWindow) {
        return { ...model, ...resolved, input, contextSource: resolved.contextWindow ? "pi-registry" : resolved.contextSource };
      }
      return {
        ...model,
        ...resolved,
        input,
        providerMetadataCheckedAt: providerResult?.fetchedAt,
        providerMetadataError: providerResult?.error,
      };
    });
  }

  let tokenSaverEnabled = false;
  let tokenSaverPreviousThinking = "medium";
  // HTTP RPC requests are handled concurrently. Serialize model changes so
  // two quick clicks cannot finish out of order and leave Pi on the older one.
  let modelChangeQueue: Promise<void> = Promise.resolve();

  async function waitForRuntimeIdle(ctx: ExtensionContext, timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (runtimeActive && !ctx.isIdle() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return runtimeActive && ctx.isIdle();
  }

  async function setModelSerially(model: any): Promise<boolean> {
    const operation = modelChangeQueue.then(() => pi.setModel(model));
    modelChangeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  // Pending authoritative Plan Mode requests. The plan extension replies on the
  // shared event bus with the same requestId; Tau never guesses the next state.
  const pendingPlanRequests = new Map<string, (state: any) => void>();

  // ═══════════════════════════════════════
  // Helper: send to one client
  // ═══════════════════════════════════════
  function sendTo(ws: WebSocket, data: any) {
    if (ws.readyState === WebSocket.OPEN) {
      // Never drop command responses: callers are waiting for these IDs.
      ws.send(JSON.stringify(data));
    }
  }

  // ═══════════════════════════════════════
  // Helper: broadcast to all clients
  // ═══════════════════════════════════════
  function broadcast(data: any) {
    const json = JSON.stringify(data);
    const eventType = data?.type === "event" ? data.event?.type : data?.type;
    const droppable = eventType === "message_update" || eventType === "tool_execution_update";
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        // Only intermediate streaming frames may be dropped for a slow tab.
        // Lifecycle events and command/state messages must always arrive.
        if (droppable && (client as any).bufferedAmount > 4 * 1024 * 1024) continue;
        client.send(json);
      }
    }
  }

  function broadcastSessionSnapshot(ctx: ExtensionContext) {
    buildStateSnapshot(ctx).then((snapshot) => broadcast(snapshot)).catch((error) => {
      console.warn(`[Mirror] Could not broadcast session snapshot: ${error?.message || error}`);
    });
  }
  // connection/session changes because its startup broadcast may precede Tau's
  // listener. Control requests resolve only after an authoritative reply.
  let planModeState: any = { available: false, mode: "unavailable", enabled: false, executing: false, awaitingAction: false, todos: [] };
  pi.events.on("tau-plan-mode:state", (state: any) => {
    planModeState = state && typeof state === "object"
      ? { available: true, mode: state.executing ? "executing" : state.enabled ? "planning" : "off", awaitingAction: false, todos: [], ...state }
      : planModeState;
    broadcast({ type: "plan_mode_state", data: planModeState });
    const requestId = String(state?.requestId || "");
    const resolve = requestId ? pendingPlanRequests.get(requestId) : undefined;
    if (resolve) {
      pendingPlanRequests.delete(requestId);
      resolve(planModeState);
    }
  });

  function isStaleExtensionError(error: unknown): boolean {
    // Avoid instanceof: errors crossing loader/module realms need not share the
    // same Error constructor.
    return String((error as any)?.message || error).includes("extension ctx is stale");
  }

  function safeRuntimeEmit(event: string, payload: any): boolean {
    if (!runtimeActive) return false;
    try {
      pi.events.emit(event, payload);
      return true;
    } catch (error) {
      // Pi marks the old API stale before/while reload teardown runs. Socket
      // close/error callbacks can race that transition, so runtimeActive alone
      // cannot make an emit safe. Treat staleness as teardown, never as an
      // uncaught process-level error.
      if (isStaleExtensionError(error)) {
        runtimeActive = false;
        latestCtx = null;
        return false;
      }
      console.error(`[Mirror] Failed to emit ${event}:`, error);
      return false;
    }
  }

  function requestPlanMode(action: string, extra: Record<string, any> = {}, timeoutMs = 1400): Promise<any> {
    const unavailable = (error: string) => ({ available: false, mode: "unavailable", enabled: false, executing: false, awaitingAction: false, todos: [], error });
    if (!runtimeActive) {
      return Promise.resolve(unavailable("Tau session runtime is shutting down"));
    }
    const requestId = randomBytes(8).toString("hex");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPlanRequests.delete(requestId);
        resolve(unavailable("Plan Mode extension did not respond"));
      }, timeoutMs);
      pendingPlanRequests.set(requestId, (state) => {
        clearTimeout(timer);
        resolve(state);
      });
      if (!safeRuntimeEmit("tau-plan-mode:control", { action, requestId, ...extra })) {
        clearTimeout(timer);
        pendingPlanRequests.delete(requestId);
        resolve(unavailable("Tau session runtime is shutting down"));
      }
    });
  }

  function publishPlanClientCount() {
    // WebSocket close/error events can arrive asynchronously after Pi has
    // invalidated this extension, even before session_shutdown updates our
    // local flags. safeRuntimeEmit handles both sides of that race.
    safeRuntimeEmit("tau-plan-mode:clients", clients.size);
  }

  let mirrorUrl = "";
  let tailscaleUrl = "";

  // ═══════════════════════════════════════
  // Helper: stop the server
  // ═══════════════════════════════════════
  function stopServer() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (wss) {
      for (const client of clients) {
        // Terminate immediately (no close handshake) so the underlying sockets
        // release the listening port before the replacement server rebinds it.
        try { client.terminate(); } catch { try { client.close(); } catch {} }
      }
      clients.clear();
      publishPlanClientCount();
      try { wss.close(); } catch {}
      wss = null;
    }
    if (server) {
      // Release the port promptly after a session switch. Without this the
      // next server can hit EADDRINUSE and drift to another port, breaking
      // the browser reconnect (it dials the original port).
      try { (server as any).closeAllConnections?.(); } catch {}
      try { (server as any).closeIdleConnections?.(); } catch {}
      server.close();
      server = null;
    }
    unregisterInstance();
    mirrorUrl = "";
    tailscaleUrl = "";
  }

  // ═══════════════════════════════════════
  // /tau-stop and /tau-start commands
  // ═══════════════════════════════════════
  pi.registerCommand("taustop", {
    description: "Stop the Tau mirror server",
    handler: async (_args, ctx) => {
      if (!server) {
        ctx.ui.notify("Tau is not running", "warning");
        return;
      }
      stopServer();
      ctx.ui.setStatus("mirror", "");
      ctx.ui.notify("Tau mirror server stopped", "info");
      console.log("[Mirror] Server stopped via /taustop");
    },
  });

  pi.registerCommand("taustart", {
    description: "Start the Tau mirror server",
    handler: async (_args, ctx) => {
      if (server) {
        ctx.ui.notify(`Tau is already running at ${mirrorUrl}`, "warning");
        return;
      }
      startServer(ctx);
      ctx.ui.notify("Tau mirror server starting...", "info");
    },
  });

  // ═══════════════════════════════════════
  // /qr command — show QR code to connect
  // ═══════════════════════════════════════
  pi.registerCommand("tau", {
    description: "Open Tau web UI in browser",
    handler: async (_args, ctx) => {
      if (!mirrorUrl) {
        ctx.ui.notify("Mirror server not running yet", "warning");
        return;
      }
      const { exec } = require("node:child_process");
      exec(`open "${mirrorUrl}"`);
      ctx.ui.notify(`Opened ${mirrorUrl}`, "info");
    },
  });

  pi.registerCommand("qr", {
    description: "Show QR code for Tau mirror URL",
    handler: async (_args, ctx) => {
      if (!mirrorUrl) {
        ctx.ui.notify("Mirror server not running yet", "warning");
        return;
      }
      const qrPageUrl = `${mirrorUrl}/api/qr`;
      ctx.ui.notify(`Tau: ${mirrorUrl}  •  QR: ${qrPageUrl}`, "info");
      // Open in default browser
      const { exec } = require("node:child_process");
      exec(`open "${qrPageUrl}"`);
    },
  });

  // ═══════════════════════════════════════
  // Event forwarding — subscribe to all Pi events
  // ═══════════════════════════════════════
  const eventTypes = [
    "agent_start", "agent_end",
    "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "model_select", "thinking_level_select",
  ] as const;

  for (const eventType of eventTypes) {
    pi.on(eventType as any, async (event: any, ctx: ExtensionContext) => {
      latestCtx = ctx;

      // Forward only the event payload needed by the browser. Pi's
      // message_update also carries the complete accumulated assistant message;
      // broadcasting that on every delta creates quadratic JSON/network work.
      if (eventType === "message_update") {
        broadcast({ type: "event", event: {
          type: eventType,
          assistantMessageEvent: event?.assistantMessageEvent,
        } });
      } else if (eventType === "model_select") {
        // Model switches can originate in either the TUI or the browser. Include
        // the effective thinking level because Pi may clamp/change it as part of
        // the model switch before emitting model_select.
        broadcast({ type: "event", event: {
          type: eventType,
          ...event,
          thinkingLevel: pi.getThinkingLevel(),
          contextUsage: ctx.getContextUsage(),
        } });
      } else if (eventType === "thinking_level_select") {
        broadcast({ type: "event", event: {
          type: eventType,
          ...event,
          contextUsage: ctx.getContextUsage(),
        } });
      } else {
    });
  }

  // Compaction events use the session-level names in the extension API
  pi.on("session_before_compact" as any, async (event: any, ctx: ExtensionContext) => {
    latestCtx = ctx;
    broadcast({ type: "event", event: {
      type: "auto_compaction_start",
      reason: event.reason,       // "manual" | "threshold" | "overflow"
      willRetry: event.willRetry,
    }});
  });

  pi.on("session_compact" as any, async (event: any, ctx: ExtensionContext) => {
    latestCtx = ctx;
    broadcast({ type: "event", event: {
      type: "auto_compaction_end",
      reason: event.reason,
      willRetry: event.willRetry,
      fromExtension: event.fromExtension,
    }});
  });

  // Auto-retry events (session-level, registered via pi.on with cast)
  pi.on("auto_retry_start" as any, async (event: any, ctx: ExtensionContext) => {
    latestCtx = ctx;
    broadcast({ type: "event", event: { type: "auto_retry_start", ...event } });
  });
  pi.on("auto_retry_end" as any, async (event: any, ctx: ExtensionContext) => {
    latestCtx = ctx;
    broadcast({ type: "event", event: { type: "auto_retry_end", ...event } });
  });

  // Also capture context from session events
  // Auto-title: collect user messages and generate a title after a few turns
  let turnCount = 0;
  let titleSet = false;
  let userMessages: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    runtimeActive = true;
    const generation = ++runtimeGeneration;
    latestCtx = ctx;
    turnCount = 0;
    titleSet = false;
    userMessages = [];
    // Update instance registry with new session file
    updateInstanceSession(ctx.sessionManager.getSessionFile() || "");
    // Existing browser sockets can survive an in-process session replacement.
    // Push a full authoritative snapshot so every tab changes session exactly
    // once even when the connection itself never closes.
    queueMicrotask(() => {
      if (!runtimeActive || generation !== runtimeGeneration || latestCtx !== ctx) return;
      broadcastSessionSnapshot(ctx);
    });
    // Extensions receive session_start in load order. Defer one tick so the
    // Plan extension has restored this session before Tau requests its state.
    setTimeout(() => {
      if (!runtimeActive || generation !== runtimeGeneration) return;
      requestPlanMode("get_state").then((state) => {
        if (!runtimeActive || generation !== runtimeGeneration) return;
        planModeState = state;
        broadcast({ type: "plan_mode_state", data: state });
      });
    }, 0);
  });

  // This is the authoritative notification for /name and every
  // pi.setSessionName() call, including names edited from Tau.
  pi.on("session_info_changed", async (event, ctx) => {
    latestCtx = ctx;
    titleSet = !!event.name;
    broadcast({ type: "event", event: { type: "session_name", name: event.name || "" } });
  });

  pi.on("turn_start", async (_event, _ctx) => {
    turnCount++;
  });

  // Capture user messages for title generation via message_start
  pi.on("message_start", async (event, _ctx) => {
    if (titleSet) return;
    const msg = event.message;
    if (!msg || msg.role !== "user") return;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const tb = content.find((b: any) => b.type === "text");
      if (tb) text = tb.text;
    }
    if (text) userMessages.push(text.substring(0, 300));
  });

  pi.on("turn_end", async (_event, _ctx) => {
    if (titleSet || turnCount < 2) return;

    const sessionName = pi.getSessionName();
    if (sessionName && sessionName !== "New Session" && sessionName !== "Untitled") {
      titleSet = true;
      return;
    }

    // Generate title from collected messages
    const title = generateSessionTitle(userMessages);
    if (title) {
      pi.setSessionName(title);
      titleSet = true;
      // Broadcast to connected clients
      broadcast({ type: "event", event: { type: "session_name", name: title } });
    }
  });

  function generateSessionTitle(messages: string[]): string | null {
    if (messages.length === 0) return null;

    // Find first substantive message (skip greetings and memory instructions)
    const greetings = /^(hey|hello|hi|morning|good morning|howdy|yo|sup)[\s!.:,]*$/i;
    const memoryInstructions = /read (your |the )?(memory|seed|persona|working) files/i;

    let bestMessage = "";
    for (const msg of messages) {
      const cleaned = msg.trim();
      if (greetings.test(cleaned)) continue;
      if (memoryInstructions.test(cleaned)) continue;
      if (cleaned.length < 10) continue;
      bestMessage = cleaned;
      break;
    }

    if (!bestMessage) {
      // Fall back to first message with any content
      bestMessage = messages.find(m => m.trim().length > 0) || "";
    }

    if (!bestMessage) return null;

    // Extract a clean title: first sentence or clause, max ~60 chars
    let title = bestMessage
      .replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, "")
      .replace(/\n.*/s, "") // first line only
      .trim();

    // Take first sentence
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) {
      title = title.substring(0, sentenceEnd);
    }

    // Truncate cleanly
    if (title.length > 60) {
      const spaceIdx = title.lastIndexOf(" ", 57);
      title = title.substring(0, spaceIdx > 20 ? spaceIdx : 57) + "…";
    }

    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title;
  }

  function entrySignature(entry: any): string {
    if (!entry) return "";
    const msg = entry.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const last = content[content.length - 1];
    const text = typeof last?.text === "string" ? last.text : "";
    return [entry.type || "", msg.role || "", content.length, text.length, text.slice(-24)].join(":");
  }

  function prepareSyncEntries(ctx: ExtensionContext) {
    // For very long sessions, only send the tail to avoid transmitting
    // tens of MB over WebSocket, which freezes both the server (JSON.stringify)
    // and the browser (JSON.parse + DOM rendering).
    let entries = ctx.sessionManager.getEntries();
    const MAX_SYNC_ENTRIES = 80;
    if (entries.length > MAX_SYNC_ENTRIES) {
      entries = entries.slice(-MAX_SYNC_ENTRIES);
    }

    const MAX_ENTRY_TEXT_LEN = 30000;
    return entries.map((entry: any) => {
      if (entry.type !== "message" || !entry.message) return entry;
      const msg = entry.message;
      if (!Array.isArray(msg.content)) return entry;

      let modified = false;
      const trimmedContent = msg.content.map((block: any) => {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > MAX_ENTRY_TEXT_LEN) {
          modified = true;
          return { ...block, text: block.text.slice(0, MAX_ENTRY_TEXT_LEN) + `\n\n…[内容过长，已截断显示前 ${Math.round(MAX_ENTRY_TEXT_LEN / 1000)}K 字符，共 ${Math.round(block.text.length / 1000)}K 字符]` };
        }
        return block;
      });

      if (!modified) return entry;
      return { ...entry, message: { ...msg, content: trimmedContent } };
    });
  }

  // ═══════════════════════════════════════
  // Build state snapshot for new connections
  // ═══════════════════════════════════════
  async function buildStateSnapshot(ctx: ExtensionContext) {
    const entries = prepareSyncEntries(ctx);
    const model = ctx.model;
    const thinkingLevel = pi.getThinkingLevel();
    const sessionName = pi.getSessionName();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const contextUsage = ctx.getContextUsage();

    return {
      type: "mirror_sync",
      entries,
      model,
      thinkingLevel,
      tokenSaverEnabled,
      sessionName,
      sessionFile,
      isStreaming: !ctx.isIdle(),
      contextUsage,
      planMode: planModeState,
      entryCount: entries.length,
      entrySig: entrySignature(entries[entries.length - 1]),
    };
  }

  // ═══════════════════════════════════════
  // Handle commands from browser clients
  // ═══════════════════════════════════════
  async function handleCommand(ws: WebSocket, command: any) {
    const id = command.id;
    if (!runtimeActive) return;
    const ctx = latestCtx;

    const success = (cmd: string, data?: any) => {
      const resp: any = { type: "response", command: cmd, success: true, id };
      if (data !== undefined) resp.data = data;
      return resp;
    };

    const error = (cmd: string, message: string) => {
      return { type: "response", command: cmd, success: false, error: message, id };
    };

    try {
      switch (command.type) {
        case "ping": {
          sendTo(ws, { type: "pong", t: command.t || Date.now() });
          break;
        }

        case "mirror_hello": {
          (ws as any).helloHandled = true;
          if ((ws as any).helloWait) {
            clearTimeout((ws as any).helloWait);
            (ws as any).helloWait = null;
          }
          if (!ctx) {
            sendTo(ws, { type: "mirror_sync", entries: [], model: null, entryCount: 0, entrySig: "" });
            break;
          }
          const entries = prepareSyncEntries(ctx);
          const sessionFile = ctx.sessionManager.getSessionFile();
          const entryCount = entries.length;
          const entrySig = entrySignature(entries[entries.length - 1]);
          const same =
            !!command.sessionFile &&
            command.sessionFile === sessionFile &&
            Number(command.entryCount) === entryCount &&
            command.entrySig === entrySig;
          if (same) {
            sendTo(ws, {
              type: "mirror_hello_ok",
              sessionFile,
              model: ctx.model,
              thinkingLevel: pi.getThinkingLevel(),
              tokenSaverEnabled,
              isStreaming: !ctx.isIdle(),
              contextUsage: ctx.getContextUsage(),
              planMode: planModeState,
              entryCount,
              entrySig,
            });
          } else {
            sendTo(ws, await buildStateSnapshot(ctx));
          }
          break;
        }

        // ─── Prompting ───
        case "prompt": {
          if (ctx && !ctx.isIdle()) {
            const behavior = command.streamingBehavior || "steer";
            if (behavior === "steer") {
              pi.sendUserMessage(command.message, { deliverAs: "steer" });
            } else {
              pi.sendUserMessage(command.message, { deliverAs: "followUp" });
            }
          } else {
            // Build content with optional images
            if (command.images?.length) {
              const validMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
              const content: any[] = [{ type: "text", text: command.message || "(see attached image)" }];
              for (const img of command.images) {
                if (!img.data || typeof img.data !== "string") {
                  console.error("[mirror-server] Skipping image: missing or invalid data");
                  continue;
                }
                // Strip data URL prefix if accidentally included
                const data = img.data.includes(",") ? img.data.split(",")[1] : img.data;
                const mimeType = (validMimes.includes(img.mimeType) ? img.mimeType : "image/png") as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
                console.log(`[mirror-server] Image: mimeType=${mimeType}, dataLen=${data.length}, rawMimeType=${img.mimeType}`);
                const imageBlock = {
                  type: "image" as const,
                  data: data,
                  mimeType: mimeType,
                };
                // Defensive: verify mimeType is actually set (debug crash where it was missing)
                if (!imageBlock.mimeType) {
                  console.error(`[mirror-server] BUG: mimeType is falsy after assignment! img.mimeType=${img.mimeType}, falling back to image/png`);
                  imageBlock.mimeType = "image/png";
                }
                content.push(imageBlock);
              }
              // Only send content array if we actually have images, otherwise just text
              const hasImages = content.some((c: any) => c.type === "image");
              if (hasImages) {
                pi.sendUserMessage(content);
              } else {
                pi.sendUserMessage(command.message);
              }
            } else {
              pi.sendUserMessage(command.message);
            }
          }
          sendTo(ws, success("prompt"));
          break;
        }

        case "steer": {
          pi.sendUserMessage(command.message, { deliverAs: "steer" });
          sendTo(ws, success("steer"));
          break;
        }

        case "follow_up": {
          pi.sendUserMessage(command.message, { deliverAs: "followUp" });
          sendTo(ws, success("follow_up"));
          break;
        }

        case "abort": {
          if (ctx) ctx.abort();
          sendTo(ws, success("abort"));
          break;
        }

        case "get_plan_mode": {
          const state = await requestPlanMode("get_state");
          planModeState = state;
          sendTo(ws, success("get_plan_mode", state));
          break;
        }

        case "set_plan_mode":
        case "toggle_plan_mode": {
          if (!ctx) {
            sendTo(ws, error(command.type, "No context available"));
            break;
          }
          const action = command.type === "toggle_plan_mode" ? "toggle" : String(command.action || "get_state");
          if (!ctx.isIdle() && action !== "get_state") {
            sendTo(ws, error(command.type, "Pi is busy; wait until the current response finishes"));
            break;
          }
          const allowed = new Set(["get_state", "enable", "disable", "toggle", "execute", "stay", "refine", "pause_for_model_switch", "resume"]);
          if (!allowed.has(action)) {
            sendTo(ws, error(command.type, "Unknown Plan Mode action"));
            break;
          }
          const state = await requestPlanMode(action, { instruction: String(command.instruction || "") });
          planModeState = state;
          if (!state.available || state.error) {
            sendTo(ws, error(command.type, state.error || "Plan Mode extension is not available"));
          } else {
            sendTo(ws, success(command.type, state));
          }
          break;
        }

        // ─── State ───
        case "get_state": {
          if (!ctx) {
            sendTo(ws, error("get_state", "No context available"));
            break;
          }
          const model = ctx.model;
          const state = {
            model,
            thinkingLevel: pi.getThinkingLevel(),
            tokenSaverEnabled,
            isStreaming: !ctx.isIdle(),
            contextUsage: ctx.getContextUsage(),
            sessionFile: ctx.sessionManager.getSessionFile(),
            sessionName: pi.getSessionName(),
            autoCompactionEnabled: true, // Extension can't easily check this
            planMode: planModeState,
          };
          sendTo(ws, success("get_state", state));
          break;
        }

        case "get_messages": {
          if (!ctx) {
            sendTo(ws, error("get_messages", "No context available"));
            break;
          }
          const entries = ctx.sessionManager.getEntries();
          sendTo(ws, success("get_messages", { entries }));
          break;
        }

        case "new_session": {
          if (!ctx) {
            sendTo(ws, error("new_session", "No context available"));
            break;
          }
          if (!ctx.isIdle()) {
            sendTo(ws, error("new_session", "Pi is busy; wait until the current response finishes"));
            break;
          }
          // Acknowledge before ctx.newSession() shuts down this extension and
          // closes the current WebSocket. The command supplies the required
          // command-capable context without creating a user-visible message.
          sendTo(ws, success("new_session", { switching: true }));
          pi.sendUserMessage("/tau-new", { expandPromptTemplates: true });
          break;
        }

        case "resume_session": {
          if (!ctx) {
            sendTo(ws, error("resume_session", "No context available"));
            break;
          }
          if (!ctx.isIdle()) {
            sendTo(ws, error("resume_session", "Pi is busy; wait until the current response finishes"));
            break;
          }
          const sessionPath = resolveAllowedSessionPath(String(command.sessionFile || ""));
          if (!sessionPath) {
            sendTo(ws, error("resume_session", "Session file is invalid or outside the Pi session directory"));
            break;
          }

          // Tell every connected tab which session will become authoritative.
          // The old server may close immediately after the command is queued.
          sendTo(ws, { type: "session_switch", sessionFile: sessionPath, switching: true });
          sendTo(ws, success("resume_session", { switching: true, sessionFile: sessionPath }));
          const encodedPath = Buffer.from(sessionPath, "utf8").toString("base64url");
          pi.sendUserMessage(`/tau-resume ${encodedPath}`, { expandPromptTemplates: true });
          break;
        }

        // ─── Model ───
        case "get_available_models": {
          if (!ctx) {
            sendTo(ws, error("get_available_models", "No context available"));
            break;
          }
          const registryModels = await ctx.modelRegistry.getAvailable();
          const force = command.refreshProviderMetadata === true;
          let models = registryModels;
          try {
            if (force) {
              models = await syncLiveModels(ctx, registryModels, true);
              models = await enrichModelsWithProviderMetadata(ctx, models, true);
            } else {
              models = registryModels.map((model: any) => {
                const fileEntry = fileModelEntry(model.provider, model.id);
                const resolved = resolveModelContext(model.id, fileEntry || model, null);
                return { ...model, ...resolved };
              });
            }
          } catch (e: any) {
            console.warn(`[Mirror] Model sync failed: ${e?.message || e}`);
            models = registryModels;
          }
          sendTo(ws, success("get_available_models", {
            models,
            metadataMode: force ? "provider-first" : "local-first",
          }));
          break;
        }

        case "reload_models": {
          if (!ctx) {
            sendTo(ws, error("reload_models", "No context available"));
            break;
          }
          if (!ctx.isIdle()) {
            sendTo(ws, error("reload_models", "Pi is busy; wait until the current response finishes"));
            break;
          }

          // Reloading the session re-reads settings.json/models.json and the
          // extension itself. Send the acknowledgement first because the
          // normal session_shutdown event closes this WebSocket by design.
          sendTo(ws, success("reload_models", { reloading: true }));
          // Event/tool contexts cannot call ctx.reload() directly. Queue the
          // extension command above so Pi creates a command-capable context.
          pi.sendUserMessage("/tau-reload-models", {
            expandPromptTemplates: true,
          });
          break;
        }

        case "set_model": {
          if (!ctx) {
            sendTo(ws, error("set_model", "No context available"));
            break;
          }
          const models = await ctx.modelRegistry.getAvailable();
          const wantedProvider = String(command.provider || "");
          const wantedId = normalizeModelId(command.modelId);
          const model = models.find(
            (m: any) => m.provider === wantedProvider && normalizeModelId(m.id) === wantedId
          );
          if (!model) {
            const sameProvider = models.filter((m: any) => m.provider === wantedProvider).map((m: any) => m.id);
            sendTo(ws, error("set_model", sameProvider.length
              ? `没有找到模型 ${wantedProvider} :: ${wantedId}`
              : `没有找到模型 ${wantedProvider} :: ${wantedId}（该供应商尚未加载）`));
            break;
          }
          const wasBusy = !ctx.isIdle();
          // Refresh Plan Mode ownership before deciding whether an active turn
          // may be interrupted; the cached broadcast can lag by a tick.
          if (wasBusy) {
            const currentPlanState = await requestPlanMode("get_state", {}, 800);
            if (currentPlanState.available && !currentPlanState.error) {
              planModeState = currentPlanState;
            }
          }
          const planWasActive = planModeState.enabled === true || planModeState.executing === true;
          if (wasBusy && !planWasActive) {
            sendTo(ws, error("set_model", "Pi is busy; model hot-switching is available only while Plan Mode is active"));
            break;
          }

          // During Plan Mode, preserve the plan but abort the in-flight provider
          // turn so the new model can take over immediately. Pause automatic
          // Plan continuation first, otherwise agent_settled can race us and
          // start another turn on the old model.
          if (wasBusy) {
            const paused = await requestPlanMode("pause_for_model_switch", {}, 1200);
            if (!paused.available || paused.error) {
              sendTo(ws, error("set_model", `Could not pause Plan Mode for model switch: ${paused.error || "Plan Mode unavailable"}`));
              break;
            }
            planModeState = paused;
            ctx.abort();
            if (!await waitForRuntimeIdle(ctx)) {
              // Release the Plan extension's continuation lock even though the
              // switch could not proceed.
              await requestPlanMode("resume", {}, 2500);
              sendTo(ws, error("set_model", "Timed out waiting for the interrupted Plan Mode turn to stop"));
              break;
            }
          }

          // pi.setModel is already session-scoped. Saving a startup default is
          // a separate explicit Pi action, so never rewrite settings.json here.
          const ok = await setModelSerially(model);
          if (!ok) {
            if (wasBusy && planWasActive) await requestPlanMode("resume", {}, 2500);
            sendTo(ws, error("set_model", "No API key for this model"));
            break;
          }

          let resumedPlan = false;
          let resumeWarning = "";
          if (wasBusy && planWasActive) {
            // Allow abort/agent_end lifecycle handlers to finish persisting any
            // progress before the continuation turn reads the remaining steps.
            await new Promise((resolve) => setTimeout(resolve, 0));
            const resumed = await requestPlanMode("resume", {}, 2500);
            if (!resumed.available || resumed.error) {
              resumeWarning = resumed.error || "Plan Mode unavailable";
            } else {
              planModeState = resumed;
              resumedPlan = true;
            }
          }

          // Return Pi's authoritative post-switch state rather than the
          // browser's requested catalogue object. A rare resume failure is a
          // warning, not a false claim that the already-completed switch failed.
          sendTo(ws, success("set_model", {
            model: ctx.model || model,
            thinkingLevel: pi.getThinkingLevel(),
            resumedPlan,
            resumeWarning: resumeWarning || undefined,
            planMode: planModeState,
          }));
          break;
        }

        case "cycle_model": {
          // Extension API doesn't have cycleModel directly
          // Workaround: get available models, find current, pick next
          if (!ctx) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const availModels = await ctx.modelRegistry.getAvailable();
          const currentModel = ctx.model;
          if (!currentModel || availModels.length <= 1) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const idx = availModels.findIndex(
            (m: any) => m.provider === currentModel.provider && m.id === currentModel.id
          );
          const nextModel = availModels[(idx + 1) % availModels.length];
          const changed = await setModelSerially(nextModel);
          if (!changed) {
            sendTo(ws, error("cycle_model", "No API key for this model"));
            break;
          }
          sendTo(ws, success("cycle_model", {
            model: nextModel,
            thinkingLevel: pi.getThinkingLevel(),
          }));
          break;
        }

        // ─── Thinking ───
        case "cycle_thinking_level": {
          if (tokenSaverEnabled) {
            sendTo(ws, success("cycle_thinking_level", { level: "off" }));
            break;
          }
          const levels = ["off", "minimal", "low", "medium", "high"];
          const current = pi.getThinkingLevel();
          const idx = levels.indexOf(current);
          const next = levels[(idx + 1) % levels.length];
          pi.setThinkingLevel(next as any);
          const actual = pi.getThinkingLevel();
          sendTo(ws, success("cycle_thinking_level", { level: actual }));
          break;
        }

        case "set_thinking_level": {
          if (tokenSaverEnabled) {
            sendTo(ws, success("set_thinking_level", { level: "off" }));
            break;
          }
          pi.setThinkingLevel(command.level);
          sendTo(ws, success("set_thinking_level", { level: pi.getThinkingLevel() }));
          break;
        }

        case "set_token_saver": {
          const enabled = command.enabled === true;
          if (enabled && !tokenSaverEnabled) {
            tokenSaverPreviousThinking = pi.getThinkingLevel();
            if (tokenSaverPreviousThinking !== "off") {
              pi.setThinkingLevel("off");
            }
          } else if (!enabled && tokenSaverEnabled) {
            pi.setThinkingLevel(tokenSaverPreviousThinking || "off");
          }
          tokenSaverEnabled = enabled;
          const data = { enabled: tokenSaverEnabled, thinkingLevel: pi.getThinkingLevel() };
          broadcast({ type: "token_saver_state", data });
          sendTo(ws, success("set_token_saver", data));
          break;
        }

        // ─── Session ───
        case "get_session_stats": {
          if (!ctx) {
            sendTo(ws, error("get_session_stats", "No context available"));
            break;
          }
          const usage = ctx.getContextUsage();
          const entries = ctx.sessionManager.getEntries();
          let userMessages = 0, assistantMessages = 0, toolCalls = 0;
          for (const e of entries) {
            if (e.type === "message") {
              if (e.message?.role === "user") userMessages++;
              else if (e.message?.role === "assistant") assistantMessages++;
              else if (e.message?.role === "toolResult") toolCalls++;
            }
          }
          sendTo(ws, success("get_session_stats", {
            sessionFile: ctx.sessionManager.getSessionFile(),
            userMessages,
            assistantMessages,
            toolCalls,
            totalMessages: entries.length,
            tokens: usage ? { input: usage.tokens, total: usage.tokens } : null,
          }));
          break;
        }

        case "set_session_name": {
          const name = sanitizeSessionName(command.name);
          if (!name) {
            sendTo(ws, error("set_session_name", "empty"));
            break;
          }
          const sessionPath = command.sessionFile ? resolveAllowedSessionPath(String(command.sessionFile)) : null;
          if (command.sessionFile && !sessionPath) {
            sendTo(ws, error("set_session_name", "invalid"));
            break;
          }
          const currentSessionPath = sessionPath || latestCtx?.sessionManager.getSessionFile();
          if (!currentSessionPath) {
            sendTo(ws, error("set_session_name", "no_session"));
            break;
          }
          const result = await renameSessionFile(currentSessionPath, name);
          sendTo(ws, success("set_session_name", result));
          break;
        }

        case "set_auto_compaction": {
          // Extension can't easily toggle auto-compaction
          // Just acknowledge
          sendTo(ws, success("set_auto_compaction"));
          break;
        }

        case "compact": {
          if (ctx) {
            // Broadcast compaction start to all clients
            broadcast({ type: "auto_compaction_start" });
            ctx.compact({
              customInstructions: command.customInstructions,
              onComplete: (result: any) => {
                broadcast({ type: "auto_compaction_end", summary: result?.summary });
              },
              onError: (err: any) => {
                broadcast({ type: "auto_compaction_end", summary: `Error: ${err.message}` });
              },
            });
          }
          sendTo(ws, success("compact"));
          break;
        }

        case "export_html": {
          if (!ctx) {
            sendTo(ws, error("export_html", "No context available"));
            break;
          }
          try {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) throw new Error("No session file to export");
            const { execSync } = require("node:child_process");
            const args = command.outputPath
              ? `"${sessionFile}" "${command.outputPath}"`
              : `"${sessionFile}"`;
            const output = execSync(`pi --export ${args}`, { cwd: process.cwd(), timeout: 30000, encoding: "utf-8" });
            // pi prints the output path
            const result = output.trim().split("\n").pop() || sessionFile.replace(".jsonl", ".html");
            sendTo(ws, success("export_html", { path: result }));
          } catch (e: any) {
            sendTo(ws, error("export_html", e.message));
          }
          break;
        }

        // ─── Commands & Files ───
        // ─── Sync ───
        case "mirror_sync_request": {
          if (ctx) {
            const snapshot = await buildStateSnapshot(ctx);
            sendTo(ws, snapshot);
          } else {
            sendTo(ws, { type: "mirror_sync", entries: [], model: null });
          }
          break;
        }

        // ─── Auth ───
        case "get_auth": {
          sendTo(ws, success("get_auth", { configured: AUTH_CONFIGURED, enabled: authEnabled }));
          break;
        }

        case "set_auth": {
          if (!AUTH_CONFIGURED) {
            sendTo(ws, error("set_auth", "No credentials configured. Set tau.user and tau.pass in settings.json"));
            break;
          }
          authEnabled = !!command.enabled;
          saveTauSetting("authEnabled", authEnabled);
          broadcast({ type: "event", event: { type: "auth_changed", enabled: authEnabled } });
          sendTo(ws, success("set_auth", { enabled: authEnabled }));
          break;
        }

        case "get_providers": {
          const file = readModelsFile();
          const providers = Object.entries(file.providers || {}).map(([id, cfg]) => summarizeProvider(id, cfg));
          sendTo(ws, success("get_providers", { providers, path: MODELS_JSON_PATH }));
          break;
        }

        case "test_provider": {
          const baseUrl = String(command.baseUrl || "").trim();
          const existing = readModelsFile().providers?.[String(command.id || "")] || {};
          const apiKey = command.apiKey ? String(command.apiKey) : resolveConfiguredApiKey(existing.apiKey);
          try {
            const records = await fetchRelayModelRecords(baseUrl, apiKey, command.headers);
            sendTo(ws, success("test_provider", {
              ok: true,
              count: records.length,
              models: records.slice(0, 40).map((item) => ({ id: item.id, name: item.name })),
            }));
          } catch (e: any) {
            sendTo(ws, error("test_provider", e?.name === "AbortError" ? "连接供应商超时" : (e?.message || "无法连接供应商")));
          }
          break;
        }

        case "save_provider": {
          const id = String(command.id || "").trim();
          if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)) {
            sendTo(ws, error("save_provider", "供应商 ID 只能用字母开头，并包含字母、数字、下划线或短横线"));
            break;
          }
          if (BUILTIN_PROVIDERS.has(id)) {
            sendTo(ws, error("save_provider", "不能覆盖 Pi 内置供应商，请换一个 ID"));
            break;
          }
          const baseUrl = String(command.baseUrl || "").trim();
          if (!/^https?:\/\//i.test(baseUrl)) {
            sendTo(ws, error("save_provider", "请填写以 http:// 或 https:// 开头的 API 地址"));
            break;
          }
          const api = normalizeRelayApi(baseUrl, command.api);
          const file = readModelsFile();
          const previous = file.providers[id] || {};
          const apiKey = command.apiKey ? String(command.apiKey) : previous.apiKey;
          if (!apiKey) {
            sendTo(ws, error("save_provider", "请填写 API Key"));
            break;
          }
          const compat = defaultRelayCompat(
            baseUrl,
            api,
            command.compat && typeof command.compat === "object"
              ? command.compat
              : previous.compat || {
                  supportsReasoningEffort: true,
                  maxTokensField: "max_tokens",
                },
          );
          let models = Array.isArray(previous.models) ? previous.models : [];
          let fetchError = "";
          if (command.fetchModels !== false) {
            try {
              const records = await fetchRelayModelRecords(baseUrl, resolveConfiguredApiKey(apiKey), command.headers);
              if (records.length > 0) {
                const existingById = new Map(models.map((m: any) => [normalizeModelId(m.id), m]));
                models = records.map((item) => {
                  const prev = existingById.get(item.id);
                  const official = lookupOfficialModel(item.id);
                  const resolved = resolveModelContext(item.id, prev, item.raw);
                  const maxTokens = upstreamMaxTokens(item.raw) || official?.maxTokens || prev?.maxTokens;
                  const persistWindow = resolved.customContextWindow || upstreamContextWindow(item.raw);
                  const explicitImageSupport = upstreamImageSupport(item.raw);
                  return {
                    id: item.id,
                    name: prev?.name || official?.name || item.name || item.id,
                    reasoning: upstreamReasoning(item.raw) ?? prev?.reasoning ?? official?.reasoning ?? true,
                    input: resolveModelInput(item.id, prev, item.raw),
                    ...(explicitImageSupport === false ? { inputProviderExplicit: true } : {}),
                    ...(persistWindow ? { contextWindow: persistWindow } : {}),
                    ...(maxTokens ? { maxTokens } : {}),
                    ...(resolved.customContextWindow ? { contextCustom: true } : {}),
                  };
                });
              }
            } catch (e: any) {
              fetchError = e?.message || "拉取模型列表失败";
            }
          }
          const nextCfg = {
            ...previous,
            name: String(command.name || previous.name || id),
            baseUrl: baseUrl.replace(/\/+$/, ""),
            api,
            apiKey,
            authHeader: command.authHeader !== false,
            compat,
            models,
          };
          if (command.headers && typeof command.headers === "object") nextCfg.headers = command.headers;
          file.providers[id] = nextCfg;
          writeModelsFile(file);
          providerMetadataCache.delete(id);
          try {
            pi.registerProvider(id, {
              name: nextCfg.name,
              baseUrl: nextCfg.baseUrl,
              api: nextCfg.api,
              apiKey: nextCfg.apiKey,
              authHeader: nextCfg.authHeader,
              compat: nextCfg.compat,
              headers: nextCfg.headers,
              models: (nextCfg.models || []).map(toPiModelConfig),
            });
          } catch (e: any) {
            console.warn(`[Mirror] Could not register provider ${id}: ${e?.message || e}`);
          }
          sendTo(ws, success("save_provider", {
            provider: summarizeProvider(id, nextCfg),
            fetchError: fetchError || undefined,
          }));
          break;
        }

        case "delete_provider": {
          const id = String(command.id || "").trim();
          if (!id) {
            sendTo(ws, error("delete_provider", "缺少供应商 ID"));
            break;
          }
          const file = readModelsFile();
          if (!file.providers[id]) {
            sendTo(ws, error("delete_provider", `没有找到供应商 ${id}`));
            break;
          }
          delete file.providers[id];
          writeModelsFile(file);
          providerMetadataCache.delete(id);
          try { pi.unregisterProvider(id); } catch {}
          sendTo(ws, success("delete_provider", { id }));
          break;
        }

        case "save_model_context": {
          const provider = String(command.provider || "").trim();
          const modelId = normalizeModelId(command.modelId || command.id);
          if (!provider || !modelId) {
            sendTo(ws, error("save_model_context", "缺少供应商或模型 ID"));
            break;
          }
          if (BUILTIN_PROVIDERS.has(provider)) {
            sendTo(ws, error("save_model_context", "内置供应商请在 models.json 里改 modelOverrides"));
            break;
          }
          const file = readModelsFile();
          const cfg = file.providers[provider];
          if (!cfg) {
            sendTo(ws, error("save_model_context", `没有找到供应商 ${provider}`));
            break;
          }
          const reset = command.reset === true || command.contextWindow === null || command.contextWindow === "";
          const nextWindow = reset ? undefined : readPositiveNumber(command.contextWindow);
          if (!reset && !nextWindow) {
            sendTo(ws, error("save_model_context", "请填写大于 0 的上下文长度"));
            break;
          }
          const models = Array.isArray(cfg.models) ? [...cfg.models] : [];
          const idx = models.findIndex((item: any) => normalizeModelId(item?.id) === modelId);
          const prev = idx >= 0 ? models[idx] : { id: modelId };
          const next = { ...prev, id: modelId };
          if (reset) {
            delete next.contextCustom;
            delete next.contextWindow;
          } else {
            next.contextWindow = nextWindow;
            next.contextCustom = true;
          }
          if (idx >= 0) models[idx] = next;
          else models.push(next);
          cfg.models = models;
          file.providers[provider] = cfg;
          writeModelsFile(file);
          providerMetadataCache.delete(provider);
          const resolved = resolveModelContext(modelId, next, null);
          try {
            const registered = (cfg.models || []).map(toPiModelConfig);
            if (registered.length > 0) {
              pi.registerProvider(provider, {
                api: normalizeRelayApi(cfg.baseUrl, cfg.api),
                compat: defaultRelayCompat(cfg.baseUrl, cfg.api, cfg.compat),
                models: registered,
              });
            }
          } catch (e: any) {
            console.warn(`[Mirror] Could not re-register ${provider} after context edit: ${e?.message || e}`);
          }
          sendTo(ws, success("save_model_context", {
            provider,
            modelId,
            ...resolved,
          }));
          break;
        }

        default: {
          sendTo(ws, error(command.type, `Unknown command: ${command.type}`));
        }
      }
    } catch (e: any) {
      sendTo(ws, error(command.type || "unknown", e.message || String(e)));
    }
  }

  // ═══════════════════════════════════════
  // Static file server
  // ═══════════════════════════════════════
  function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
    setSecurityHeaders(res);
    let urlPath = req.url || "/";

    // Auth gate — exempt /api/health for monitoring
    if (authEnabled && urlPath !== "/api/health" && !checkBasicAuth(req)) {
      sendAuthRequired(res);
      return;
    }

    // Handle API routes
    if (urlPath.startsWith("/api/")) {
      handleApiRoute(req, res, urlPath);
      return;
    }

    // Strip query params
    urlPath = urlPath.split("?")[0];

    // Default to index.html
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = safeStaticPath(urlPath);
    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Check file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const etag = `W/"${stats.size}-${stats.mtimeMs.toFixed(0)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      const immutable = ext === ".woff2" || ext === ".woff" || filePath.includes(`${path.sep}vendor${path.sep}`);
      // App code changes together with the extension during /reload. Revalidate
      // HTML/JS immediately so an old browser bundle does not speak an outdated
      // model-selection protocol to the new server.
      const cacheControl = ext === ".html" || ext === ".js"
        ? "no-cache"
        : immutable
          ? "public, max-age=604800, immutable"
          : "public, max-age=300";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
        ETag: etag,
      });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ═══════════════════════════════════════
  // API routes (sessions list, etc.)
  // ═══════════════════════════════════════
  function handleApiRoute(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
    setSecurityHeaders(res);
    // The control plane is same-origin by default. Do not expose wildcard CORS.
    const origin = req.headers.origin;
    const host = req.headers.host || "localhost";
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin || `http://${host}`);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (urlPath === "/api/qr") {
      if (!mirrorUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Server not ready" }));
        return;
      }
      const qrPromises = [QRCode.toDataURL(mirrorUrl, { width: 256, margin: 2 })];
      if (tailscaleUrl) qrPromises.push(QRCode.toDataURL(tailscaleUrl, { width: 256, margin: 2 }));
      Promise.all(qrPromises).then((dataUrls: string[]) => {
        const tsSection = tailscaleUrl && dataUrls[1]
          ? `<p style="margin-top:24px;color:rgba(255,255,255,0.3);font-size:11px">TAILSCALE</p><img src="${dataUrls[1]}" width="256" height="256" alt="Tailscale QR"><a href="${tailscaleUrl}">${tailscaleUrl}</a>`
          : "";
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width"><title>Tau — Connect</title>
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#131316;color:#fff;font-family:-apple-system,sans-serif}
img{border-radius:12px}a{color:#b87a5c;font-size:18px;margin-top:16px}p{color:rgba(255,255,255,0.5);font-size:13px;margin-top:8px}</style>
</head><body><p style="color:rgba(255,255,255,0.3);font-size:11px">LAN</p><img src="${dataUrls[0]}" width="256" height="256" alt="QR Code"><a href="${mirrorUrl}">${mirrorUrl}</a>${tsSection}<p style="margin-top:16px">Scan to open Tau on your phone</p></body></html>`);
      }).catch((e: any) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    if (urlPath === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: "mirror", mirrorUrl, tailscaleUrl: tailscaleUrl || undefined, platform: process.platform }));
      return;
    }

    // File preview — serve image bytes for thumbnail display in the browser
    if ((urlPath === "/api/file/preview" || urlPath.startsWith("/api/file/preview?")) && req.method === "GET") {
      const previewUrl = new URL(`http://localhost${req.url}`);
      const filePath = previewUrl.searchParams.get("path");
      if (!filePath) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "path required" }));
        return;
      }
      const IMAGE_PREVIEW_MIMES: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
      };
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mimeType = IMAGE_PREVIEW_MIMES[ext];
      if (!mimeType) {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a previewable image" }));
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new Error("Not a file");
        if (stat.size > MAX_FILE_PREVIEW) throw new Error("File too large");
        res.writeHead(200, { "Content-Type": mimeType, "Cache-Control": "max-age=60" });
        fs.createReadStream(filePath).pipe(res);
      } catch (err: any) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (urlPath === "/api/instances") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ instances: getRunningInstances() }));
      return;
    }

    if (urlPath === "/api/projects" && req.method === "GET") {
      serveProjectsList(res);
      return;
    }

    if (urlPath === "/api/projects/launch" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { path: projectPath } = JSON.parse(body);
          if (!projectPath || typeof projectPath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "path required" }));
            return;
          }
          // Resolve ~ in path
          const resolved = projectPath.startsWith("~")
            ? path.join(process.env.HOME || "", projectPath.slice(1))
            : projectPath;
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Directory not found" }));
            return;
          }
          const { execSync } = require("node:child_process");
          const escaped = resolved.replace(/'/g, "'\\''");
          execSync(`osascript -e 'tell app "iTerm2" to create window with default profile command "cd '"'"'${escaped}'"'"' && pi"'`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (urlPath === "/api/sessions" && req.method === "GET") {
      serveSessionsList(res);
      return;
    }

    // Full-text search across sessions
    if (urlPath.startsWith("/api/search") && req.method === "GET") {
      const searchUrl = new URL(`http://localhost${req.url}`);
      const q = searchUrl.searchParams.get("q") || "";
      serveSearch(res, q, req);
      return;
    }

    // File browser: list directory
    if (urlPath === "/api/files" || urlPath.startsWith("/api/files?")) {
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      try {
        const filesUrl = new URL(`http://localhost${req.url}`);
        const explicitPath = filesUrl.searchParams.get("path");
        let dirPath = explicitPath || process.cwd();
        if (!explicitPath && latestCtx) {
          try {
            const entries = latestCtx.sessionManager.getEntries();
            const sessionEntry = entries.find((e: any) => e.type === "session");
            if (sessionEntry?.cwd) dirPath = sessionEntry.cwd;
          } catch {}
        }
        serveFileList(res, dirPath);
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // File browser: open file natively
    if (urlPath === "/api/open" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { filePath: fp } = JSON.parse(body);
          if (!fp || typeof fp !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          const { execFile } = await import("node:child_process");
          if (process.platform === "win32") {
            const { exec } = await import("node:child_process");
            const safe = fp.replace(/'/g, "''").replace(/"/g, '');
            exec(`powershell -NoProfile -WindowStyle Hidden -Command "& { $wsh = New-Object -ComObject WScript.Shell; $wsh.Run('explorer \\"${safe}\\"', 1, $false) }"`, (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          } else if (process.platform === "darwin") {
            execFile("open", [fp], (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          } else {
            execFile("xdg-open", [fp], (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Session file endpoint: /api/sessions/:dirName/:file
    const sessionUrl = new URL(`http://localhost${req.url || urlPath}`);
    const sessionMatch = sessionUrl.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const beforeRaw = sessionUrl.searchParams.get("before");
      const limitRaw = sessionUrl.searchParams.get("limit");
      const before = beforeRaw === null ? undefined : Number(beforeRaw);
      const limit = Math.max(20, Math.min(200, Number(limitRaw) || 120));
      serveSessionFilePage(
        res,
        decodeURIComponent(sessionMatch[1]),
        decodeURIComponent(sessionMatch[2]),
        Number.isFinite(before) ? before : undefined,
        limit,
      );
      return;
    }

    // RPC proxy — handle via WebSocket command handler
    if (urlPath === "/api/rpc" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const command = JSON.parse(body);
          // Create a fake WebSocket-like object to capture the response
          const responsePromise = new Promise<any>((resolve) => {
            const fakeWs = {
              readyState: WebSocket.OPEN,
              send: (data: string) => resolve(JSON.parse(data)),
            } as any;
            handleCommand(fakeWs, command);
          });
          const response = await responsePromise;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Session switch — in mirror mode, this is a no-op (session is controlled by TUI)
    if (urlPath === "/api/sessions/switch" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, mirror: true, note: "Session switching is controlled by the TUI in mirror mode" }));
      return;
    }

    // Session delete — only jsonl files inside the Pi sessions directory.
    if (urlPath === "/api/sessions/delete" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { filePath } = JSON.parse(body);
          const sessionPath = resolveAllowedSessionPath(String(filePath || ""));
          if (!sessionPath) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid" }));
            return;
          }
          const currentFile = latestCtx?.sessionManager.getSessionFile();
          const isLive =
            (currentFile && path.resolve(currentFile) === sessionPath) ||
            getRunningInstances().some((inst) => {
              try { return path.resolve(inst.sessionFile || "") === sessionPath; }
              catch { return false; }
            });
          if (isLive) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "live" }));
            return;
          }
          fs.unlinkSync(sessionPath);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || "delete_failed" }));
        }
      });
      return;
    }

    if (urlPath === "/api/sessions/rename" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { filePath, name } = JSON.parse(body);
          const sessionPath = resolveAllowedSessionPath(String(filePath || ""));
          if (!sessionPath) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid" }));
            return;
          }
          const ownerRequest = req.headers["x-tau-rename-owner"] === "1";
          const result = await renameSessionFile(sessionPath, String(name || ""), ownerRequest);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (err: any) {
          const message = err?.message || "rename_failed";
          const code = message === "empty" ? 400 : message === "owner_unavailable" ? 409 : 500;
          res.writeHead(code, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ error: message }));
        }
      });
      return;
    }

    // Memoryd check
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ═══════════════════════════════════════
  // Sessions list endpoint
  // ═══════════════════════════════════════
  function getTmuxSessionFiles(): Set<string> {
    if (process.platform === "win32") return new Set();
    try {
      const { execSync } = require("node:child_process");
      // Get tmux pane PIDs
      const paneOutput = execSync("tmux list-panes -a -F '#{pane_pid}' 2>/dev/null", { encoding: "utf8" });
      const tmuxFiles = new Set<string>();

      for (const shellPid of paneOutput.trim().split("\n").filter(Boolean)) {
        try {
          // Find Pi (node) processes that are children of tmux shells
          const children = execSync(`pgrep -P ${shellPid} 2>/dev/null`, { encoding: "utf8" });
          for (const pid of children.trim().split("\n").filter(Boolean)) {
            // Check what .jsonl files this process has open
            const lsofOut = execSync(`lsof -p ${pid} 2>/dev/null | grep '\\.jsonl'`, { encoding: "utf8" });
            for (const line of lsofOut.trim().split("\n").filter(Boolean)) {
              const match = line.match(/\/.+\.jsonl$/);
              if (match) tmuxFiles.add(match[0]);
            }
          }
        } catch { /* no match */ }
      }
      return tmuxFiles;
    } catch {
      return new Set();
    }
  }

  function serveProjectsList(res: http.ServerResponse) {
    const projectsDir = TAU_SETTINGS.projectsDir;
    if (!projectsDir) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [] }));
      return;
    }

    const resolved = projectsDir.startsWith("~")
      ? path.join(process.env.HOME || "", projectsDir.slice(1))
      : projectsDir;

    if (!fs.existsSync(resolved)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [], error: "Directory not found" }));
      return;
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const instances = getRunningInstances();

      // Build session count + recency map from session history
      const sessionInfo = new Map<string, { count: number; lastActive: number }>();
      if (fs.existsSync(SESSIONS_DIR)) {
        for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
          // Check if this session dir maps to a subdirectory of the projects folder
          if (!decodedPath.startsWith(resolved + "/") && !decodedPath.startsWith(resolved)) continue;

          const sessionDir = path.join(SESSIONS_DIR, dir.name);
          const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
          let lastMtime = 0;
          for (const f of files) {
            try {
              const stat = fs.statSync(path.join(sessionDir, f));
              if (stat.mtimeMs > lastMtime) lastMtime = stat.mtimeMs;
            } catch {}
          }
          sessionInfo.set(decodedPath, { count: files.length, lastActive: lastMtime });
        }
      }

      const projects = entries
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => {
          const fullPath = path.join(resolved, e.name);
          const info = sessionInfo.get(fullPath) || { count: 0, lastActive: 0 };
          const isActive = instances.some(i => i.cwd === fullPath);
          return {
            name: e.name,
            path: fullPath,
            sessionCount: info.count,
            lastActive: info.lastActive || null,
            active: isActive,
          };
        });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  async function serveSessionsList(res: http.ServerResponse) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ projects: [] }));
        return;
      }

      const tmuxFiles = getTmuxSessionFiles();
      const readline = await import("node:readline");
      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
      const projects: any[] = [];

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");

        const sessions: any[] = [];

        for (const file of files) {
          try {
            const filePath = path.join(projectDir, file);
            const parsed = await parseSessionFile(filePath, readline);
            if (parsed) {
              const stat = fs.statSync(filePath);
              const isTmux = tmuxFiles.has(filePath);
              sessions.push({ ...parsed, file, filePath, mtime: stat.mtimeMs, ...(isTmux && { tmux: true }) });
            }
          } catch { /* skip */ }
        }

        sessions.sort((a, b) => b.mtime - a.mtime);

        if (sessions.length > 0) {
          projects.push({ path: decodedPath, dirName: dir.name, sessions });
        }
      }

      projects.sort((a, b) => {
        const aTime = a.sessions[0]?.mtime || 0;
        const bTime = b.sessions[0]?.mtime || 0;
        return bTime - aTime;
      });

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ projects }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Session history is read backwards in pages. This keeps a long JSONL file
  // from being fully parsed + serialized on the server and fully JSON.parsed
  // by the browser before the newest messages become usable.
  function serveSessionFilePage(
    res: http.ServerResponse,
    dirName: string,
    file: string,
    before: number | undefined,
    limit: number,
  ) {
    const candidate = path.join(SESSIONS_DIR, dirName, file);
    const filePath = resolveAllowedSessionPath(candidate);

    if (!filePath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    let fd: number | null = null;
    try {
      const stat = fs.statSync(filePath);
      const end = Math.max(0, Math.min(stat.size, before ?? stat.size));
      const blockSize = 64 * 1024;
      let pos = end;
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let newlineCount = 0;
      fd = fs.openSync(filePath, "r");

      // One extra newline is needed because the first line in a backwards-read
      // buffer may be partial. Single huge JSONL entries are still supported.
      while (pos > 0 && newlineCount < limit + 1) {
        const size = Math.min(blockSize, pos);
        pos -= size;
        const chunk = Buffer.allocUnsafe(size);
        fs.readSync(fd, chunk, 0, size, pos);
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] === 10) newlineCount++;
        }
        chunks.unshift(chunk);
        totalBytes += chunk.length;
      }
      const data = Buffer.concat(chunks, totalBytes);

      const lines: Array<{ start: number; text: string }> = [];
      let startsAtLineBoundary = pos === 0;
      if (!startsAtLineBoundary && pos > 0) {
        const previous = Buffer.allocUnsafe(1);
        fs.readSync(fd, previous, 0, 1, pos - 1);
        startsAtLineBoundary = previous[0] === 10;
      }
      let lineStart = 0;
      for (let i = 0; i <= data.length; i++) {
        const atEnd = i === data.length;
        if (!atEnd && data[i] !== 10) continue;
        // If the buffer starts in the middle of a line, discard that fragment.
        const partialAtStart = !startsAtLineBoundary && lineStart === 0;
        const hasBytes = i > lineStart;
        if (!partialAtStart && hasBytes) {
          const text = data.subarray(lineStart, i).toString("utf8").replace(/\r$/, "");
          if (text.trim()) lines.push({ start: pos + lineStart, text });
        }
        lineStart = i + 1;
      }

      const selected = lines.slice(-limit);
      const entries: any[] = [];
      for (const line of selected) {
        try { entries.push(JSON.parse(line.text)); } catch {}
      }
      const cursor = selected.length > 0 ? selected[0].start : 0;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({
        entries,
        cursor,
        hasMore: cursor > 0,
        fileSize: stat.size,
      }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e?.message || "history_read_failed" }));
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }

  // ═══════════════════════════════════════
  // Parse session file header
  // ═══════════════════════════════════════
  async function parseSessionFile(filePath: string, readline: any) {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let header: any = null;
    let firstMessage: string | null = null;
    let sessionName: string | null = null;
    let userMessageCount = 0;
    let lineCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;

      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") header = entry;
        else if (entry.type === "session_info" && entry.name) sessionName = entry.name;
        else if (entry.type === "message" && entry.message?.role === "user") {
          userMessageCount++;
          if (!firstMessage) {
            const content = entry.message.content;
            if (typeof content === "string") firstMessage = content.substring(0, 120);
            else if (Array.isArray(content)) {
              const tb = content.find((b: any) => b.type === "text");
              if (tb) firstMessage = tb.text.substring(0, 120);
            }
          }
        }
      } catch { /* skip */ }

      if (lineCount > 50 && firstMessage) break;
    }

    rl.close();
    stream.destroy();

    const latestName = await readLatestSessionNameForList(filePath);
    if (latestName !== null) sessionName = latestName || null;

    if (!header?.id) return null;
    if (userMessageCount <= 1 && lineCount <= 8) return null; // pipe mode

    return {
      id: header.id,
      timestamp: header.timestamp || "",
      name: sessionName,
      firstMessage,
      cwd: header.cwd || null,
    };
  }

  // ═══════════════════════════════════════
  // File browser
  // ═══════════════════════════════════════

  const IGNORED_NAMES = new Set([
    "node_modules", ".git", "__pycache__", ".DS_Store", ".Trash",
    ".next", ".nuxt", "dist", "build", ".cache", ".turbo",
    "venv", ".venv", "env", ".env.local",
    ".pi", "coverage", ".nyc_output", ".parcel-cache",
  ]);

  function serveFileList(res: http.ServerResponse, dirPath: string) {
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a directory" }));
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items: any[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (IGNORED_NAMES.has(entry.name)) continue;

        try {
          const fullPath = path.join(dirPath, entry.name);
          const stat = fs.statSync(fullPath);

          items.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: entry.isDirectory() ? null : stat.size,
            mtime: stat.mtimeMs,
          });
        } catch { /* skip inaccessible */ }
      }

      // Directories first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: dirPath, items }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════
  // Full-text search
  // ═══════════════════════════════════════

  async function serveSearch(res: http.ServerResponse, query: string, req?: http.IncomingMessage) {
    try {
      if (!query || query.length < 2) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const q = query.toLowerCase();
      const readline = await import("node:readline");
      const results: any[] = [];
      const MAX_RESULTS = 30;

      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        if (results.length >= MAX_RESULTS) break;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));

        for (const file of files) {
          if (req?.destroyed || res.destroyed) return;
          if (results.length >= MAX_RESULTS) break;

          try {
            const filePath = path.join(projectDir, file);
            const stream = fs.createReadStream(filePath, { encoding: "utf8" });
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

            let sessionId = "";
            let sessionName = "";
            let sessionTimestamp = "";
            let firstMessage = "";
            const matches: any[] = [];

            for await (const line of rl) {
              if (req?.destroyed || res.destroyed) {
                rl.close();
                stream.destroy();
                return;
              }
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);

                if (entry.type === "session") {
                  sessionId = entry.id;
                  sessionTimestamp = entry.timestamp || "";
                }
                if (entry.type === "session_info" && entry.name) {
                  sessionName = entry.name;
                }
                if (entry.type === "message") {
                  const content = entry.message?.content;
                  let text = "";
                  if (typeof content === "string") text = content;
                  else if (Array.isArray(content)) {
                    text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
                  }

                  if (!firstMessage && entry.message?.role === "user" && text) {
                    firstMessage = text.substring(0, 120);
                  }

                  if (text && text.toLowerCase().includes(q)) {
                    // Extract a snippet around the match
                    const idx = text.toLowerCase().indexOf(q);
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(text.length, idx + q.length + 60);
                    const snippet = (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length ? "…" : "");

                    matches.push({
                      role: entry.message?.role || "unknown",
                      snippet: snippet.replace(/\n/g, " "),
                    });

                    if (matches.length >= 3) break; // max 3 matches per session
                  }
                }
              } catch { /* skip line */ }
            }

            rl.close();
            stream.destroy();

            const latestName = await readLatestSessionNameForList(filePath);
            if (latestName !== null) sessionName = latestName;

            if (matches.length > 0) {
              results.push({
                filePath,
                project: decodedPath,
                sessionId,
                sessionName,
                sessionTimestamp,
                firstMessage,
                matches,
              });
            }
          } catch { /* skip file */ }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════
  // Start server function (reusable)
  // ═══════════════════════════════════════
  function startServer(ctx: ExtensionContext) {
    if (server) return; // Already running

    // Clean up zombie instances from killed tmux panes etc.
    cleanupZombieInstances();

    server = http.createServer(serveStaticFile);
    wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      if (authEnabled && !checkBasicAuth(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"Tau\"\r\n\r\n");
        socket.destroy();
        return;
      }
      if (request.url === "/ws") {
        wss!.handleUpgrade(request, socket, head, (ws) => {
          wss!.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on("connection", (ws) => {
      console.log("[Mirror] Browser client connected");
      clients.add(ws);
      publishPlanClientCount();
      requestPlanMode("get_state").then((state) => {
        planModeState = state;
        sendTo(ws, { type: "plan_mode_state", data: state });
      });
      (ws as any).isAlive = true;

      ws.on("pong", () => {
        (ws as any).isAlive = true;
      });

      // Send initial state
      sendTo(ws, { type: "state", isStreaming: false, mode: "mirror" });

      // Give a returning tab a moment to send mirror_hello. If the session
      // tail is unchanged we skip shipping the full history again.
      (ws as any).helloWait = setTimeout(() => {
        (ws as any).helloWait = null;
        if ((ws as any).helloHandled || !latestCtx) return;
        buildStateSnapshot(latestCtx).then((snapshot) => {
          if ((ws as any).helloHandled) return;
          sendTo(ws, snapshot);
        });
      }, 80);

      ws.on("message", (data) => {
        try {
          const command = JSON.parse(data.toString());
          handleCommand(ws, command);
        } catch (e) {
          console.error("[Mirror] Failed to parse client message:", e);
        }
      });

      ws.on("close", () => {
        console.log("[Mirror] Browser client disconnected");
        if ((ws as any).helloWait) {
          clearTimeout((ws as any).helloWait);
          (ws as any).helloWait = null;
        }
        clients.delete(ws);
        publishPlanClientCount();
      });

      ws.on("error", (e) => {
        console.error("[Mirror] Client error:", e);
        clients.delete(ws);
        publishPlanClientCount();
      });
    });

    // Heartbeat keeps mobile/Tailscale sessions alive and removes stale clients.
    heartbeatTimer = setInterval(() => {
      for (const client of clients) {
        if (client.readyState !== WebSocket.OPEN) {
          clients.delete(client);
          publishPlanClientCount();
          continue;
        }

        if (!(client as any).isAlive) {
          try { client.terminate(); } catch {}
          clients.delete(client);
          publishPlanClientCount();
          continue;
        }

        (client as any).isAlive = false;
        try { client.ping(); } catch {}
      }
    }, 20000);

    const tryListen = (port: number, maxAttempts = 10, samePortRetries = 5) => {
      server!.listen(port, HOST, () => {
        onListening(port);
      });
      server!.once("error", (err: any) => {
        if (err.code !== "EADDRINUSE") {
          console.error(`[Mirror] Failed to start server:`, err.message);
          return;
        }
        // Check if a stale Tau instance owns this port and kill it
        const instances = getRunningInstances();
        const stale = instances.find(i => i.port === port && i.pid !== process.pid);
        if (stale && isZombieProcess(stale.pid)) {
          console.log(`[Mirror] Port ${port} in use by stale Tau instance (PID ${stale.pid}), killing...`);
          try { process.kill(stale.pid, "SIGTERM"); } catch {}
          // Wait briefly then retry the same port
          setTimeout(() => {
            server!.removeAllListeners("error");
            tryListen(port, maxAttempts, samePortRetries);
          }, 500);
          return;
        }
        // A Tau server in this same process may still be releasing the port
        // after a session switch. Retry the original port before drifting to
        // a new one; the browser reconnects to the original port.
        if (port === PORT && samePortRetries > 0) {
          console.log(`[Mirror] Port ${port} busy, retrying same port (${samePortRetries} attempts left)...`);
          setTimeout(() => {
            server!.removeAllListeners("error");
            tryListen(port, maxAttempts, samePortRetries - 1);
          }, 150);
          return;
        }
        if (port < PORT + maxAttempts) {
          console.log(`[Mirror] Port ${port} in use, trying ${port + 1}...`);
          server!.removeAllListeners("error");
          tryListen(port + 1, maxAttempts, samePortRetries);
        } else {
          console.error(`[Mirror] Failed to start server: ${err.message} (port ${port})`);
        }
      });
    };

    const onListening = (port: number) => {
      const isLoopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

      let localIp = "localhost";
      let tailscaleIp = "";

      if (!isLoopback) {
        // Get local IP for display — prefer en0/en1 (WiFi/Ethernet) over bridges/VPNs
        const nets = require("node:os").networkInterfaces();
        let fallbackIp = "";
        const preferred = ["en0", "en1"];
        for (const name of preferred) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal) {
              localIp = net.address;
              break;
            }
          }
          if (localIp !== "localhost") break;
        }
        if (localIp === "localhost") {
          for (const name of Object.keys(nets)) {
            if (name.startsWith("bridge") || name.startsWith("utun") || name.startsWith("lo")) continue;
            for (const net of nets[name] || []) {
              if (net.family === "IPv4" && !net.internal && (net.address.startsWith("192.168.") || net.address.startsWith("10."))) {
                localIp = net.address;
                break;
              }
            }
            if (localIp !== "localhost") break;
          }
        }
        if (localIp === "localhost" && fallbackIp) localIp = fallbackIp;

        // Detect Tailscale IP (100.x.x.x CGNAT range)
        for (const name of Object.keys(nets)) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal && net.address.startsWith("100.")) {
              tailscaleIp = net.address;
              break;
            }
          }
          if (tailscaleIp) break;
        }
      }

      mirrorUrl = `http://${localIp}:${port}`;
      tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : "";
      console.log(`[Mirror] Tau mirror server running on ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ""}`);
      ctx.ui.setStatus("mirror", `Mirror: ${localIp}:${port}${tailscaleIp ? ` • TS: ${tailscaleIp}:${port}` : ""}`);

      // Register this instance
      const sessionFile = ctx.sessionManager.getSessionFile() || "";
      registerInstance(port, sessionFile, ctx.cwd || process.cwd());

      ctx.ui.notify(`Tau mirror: ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ""}  •  /qr for QR code`, "info");
    };

    tryListen(PORT);
  }

  // ═══════════════════════════════════════
  // Auto-start on session begin
  // ═══════════════════════════════════════
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;

    // Skip mirror startup in subagent child processes
    // (pi-subagents sets PI_SUBAGENT_CHILD=1; child processes loading Tau
    // should not attempt to start their own mirror server)
    if (process.env.PI_SUBAGENT_CHILD === "1") {
      console.log("[Mirror] Subagent child process detected (PI_SUBAGENT_CHILD=1), skipping auto-start.");
      return;
    }

    if (!TAU_AUTO_START) {
      console.log("[Mirror] Tau auto-start disabled (TAU_DISABLED=1). Use /tau-start to start manually.");
      return;
    }

    startServer(ctx);
  });

  // ═══════════════════════════════════════
  // Cleanup on shutdown
  // ═══════════════════════════════════════
  pi.on("session_shutdown", async () => {
    // Invalidate first: terminate()/close() schedules WebSocket callbacks, and
    // none of those callbacks may touch the old pi API after this hook returns.
    runtimeActive = false;
    runtimeGeneration++;
    latestCtx = null;
    persistSessionNameCache();
    stopServer();
    console.log("[Mirror] Server shut down");
  });
}
