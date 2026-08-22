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

function readModelsFile(): { providers: Record<string, any> } {
  try {
    if (!fs.existsSync(MODELS_JSON_PATH)) return { providers: {} };
    const parsed = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return { providers: {} };
    if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
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
}

function normalizeModelId(id: unknown): string {
  // Keep leading slashes (HFY /CN/...) and internal slashes exactly.
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
  // Extension event/tool contexts intentionally do not expose session control
  // methods. Register a command so the WebSocket layer can request the same
  // supported reload path as Pi's interactive command context.
  pi.registerCommand("tau-reload-models", {
    description: "Reload Pi settings and model providers for Tau",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  function resolveAllowedSessionPath(candidate: string): string | null {
    if (!candidate) return null;
    const resolved = path.resolve(candidate);
    const root = path.resolve(SESSIONS_DIR);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (path.extname(resolved).toLowerCase() !== ".jsonl" || !fs.existsSync(resolved)) return null;
    return resolved;
  }

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
      await ctx.waitForIdle();
      await ctx.switchSession(sessionPath);
    },
  });

  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const clients = new Set<WebSocket>();

  // Store latest context reference for use in command handlers
  let latestCtx: ExtensionContext | null = null;

  // Provider metadata is intentionally fetched only for providers explicitly
  // opted in here. This avoids silently calling every configured endpoint when
  // a browser opens Tau. Credentials are resolved by Pi and never sent to the UI.
  const LIVE_MODEL_METADATA_PROVIDERS = new Set<string>();
  // Providers whose /v1/models response is the authoritative model list.
  // Tau re-fetches it on refresh, registers discovered models back into Pi, and
  // drops stale entries so the web list follows the relay exactly.
  // Custom 中转站 from models.json are included automatically so HFY /CN models
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
  const LIVE_MODEL_DEFAULTS = {
    contextWindow: 1000000,
    maxTokens: 32768,
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
  };
  const LIVE_MODEL_PROFILES = new Map<string, { contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: ("text" | "image")[] }>([
    ["newapi-futureppo/glm-5-2", { contextWindow: 1000000, maxTokens: 32768, reasoning: true, input: ["text", "image"] }],
    // The cl endpoint omits context_window for its GPT-5.6 aliases.
    ["ccswitch-cl/OAI/gpt-5.6-sol-thinking-none", { contextWindow: 258000 }],
    ["ccswitch-cl/OAI/gpt-5.6-sol", { contextWindow: 258000 }],
    ["ccswitch-cl/OAI/gpt-5.6-luna", { contextWindow: 258000 }],
  ]);
  // The cl endpoint currently omits context_window for its GPT-5.6 aliases.
  // Keep Tau and Pi aligned on the 258K profile while still allowing a future
  // explicit provider value to take precedence automatically.
  const MODEL_CONTEXT_PROFILES = new Map<string, number>([
    ["ccswitch-cl/OAI/gpt-5.6-sol-thinking-none", 258000],
    ["ccswitch-cl/OAI/gpt-5.6-sol", 258000],
    ["ccswitch-cl/OAI/gpt-5.6-sol-wm", 258000],
    ["ccswitch-cl/OAI/gpt-5.6-luna", 258000],
  ]);
  const providerMetadataCache = new Map<string, { fetchedAt: number; models: Map<string, any>; error?: string }>();
  const PROVIDER_METADATA_TTL = 5 * 60 * 1000;

  function readPositiveNumber(value: unknown): number | undefined {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  function upstreamContextWindow(model: any): number | undefined {
    return readPositiveNumber(
      model?.context_window ??
      model?.contextWindow ??
      model?.max_context_length ??
      model?.max_input_tokens ??
      model?.input_token_limit
    );
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

  function liveModelConfig(provider: string, id: string, existing?: any) {
    if (existing) {
      return {
        id,
        name: existing.name || id,
        reasoning: existing.reasoning,
        input: existing.input,
        cost: existing.cost,
        contextWindow: existing.contextWindow,
        maxTokens: existing.maxTokens,
      };
    }
    const profile = LIVE_MODEL_PROFILES.get(`${provider}/${id}`) || {};
    return {
      id,
      name: id,
      reasoning: profile.reasoning ?? LIVE_MODEL_DEFAULTS.reasoning,
      input: profile.input ?? LIVE_MODEL_DEFAULTS.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: profile.contextWindow ?? LIVE_MODEL_DEFAULTS.contextWindow,
      maxTokens: profile.maxTokens ?? LIVE_MODEL_DEFAULTS.maxTokens,
    };
  }

  // Full model-list sync for relay providers: fetch /v1/models, register the
  // discovered models into Pi so they stay selectable, then return a display
  // list that exactly mirrors the relay (adds new, removes stale).
  async function syncLiveModels(ctx: ExtensionContext, models: any[], force = false) {
    const liveSyncProviders = getLiveSyncProviders();
    const result: any[] = models.filter((model) => !liveSyncProviders.has(model.provider));
    const file = readModelsFile();
    const syncProviders = [...liveSyncProviders];

    for (const provider of syncProviders) {
      try {
      const cfg = file.providers?.[provider] || {};
      const sample = models.find((model) => model.provider === provider) || (cfg.models?.[0]
        ? { provider, id: normalizeModelId(cfg.models[0].id), baseUrl: cfg.baseUrl }
        : { provider, id: "default", baseUrl: cfg.baseUrl });

      const meta = await fetchProviderModelMetadata(ctx, provider, sample, force);
      const providerModels = models.filter((model) => model.provider === provider);
      if (meta.models.size === 0) {
        // Relay unreachable: keep the configured models and surface the error.
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
        result.push(...fallback.filter((model: any) => model.id).map((model: any) => ({
          ...model,
          contextSource: "config-fallback-error",
          configuredContextWindow: model.contextWindow,
          providerMetadataError: meta.error,
          providerMetadataCheckedAt: meta.fetchedAt,
        })));
        continue;
      }

      const existingById = new Map(providerModels.map((model) => [normalizeModelId(model.id), model]));
      const configs = [...meta.models.keys()].map((id) => liveModelConfig(provider, id, existingById.get(id)));
      try {
        // If the provider is already in Pi, only replace the model list.
        // Passing baseUrl/apiKey here can wipe /login credentials.
        if (providerModels.length > 0) {
          pi.registerProvider(provider, { models: configs });
        } else {
          pi.registerProvider(provider, {
            name: cfg.name || provider,
            baseUrl: cfg.baseUrl,
            api: cfg.api || "openai-completions",
            apiKey: cfg.apiKey,
            authHeader: cfg.authHeader !== false,
            compat: cfg.compat,
            headers: cfg.headers,
            models: configs,
          });
        }
      } catch (e: any) {
        console.warn(`[Mirror] Could not register live models for ${provider}: ${e?.message || e}`);
      }

      for (const [id, upstream] of meta.models) {
        const existing = existingById.get(id);
        const profile = LIVE_MODEL_PROFILES.get(`${provider}/${id}`) || {};
        const providerContextWindow = upstreamContextWindow(upstream);
        const configuredContextWindow = existing?.contextWindow ?? profile.contextWindow ?? LIVE_MODEL_DEFAULTS.contextWindow;
        const displayContextWindow = providerContextWindow || profile.contextWindow || existing?.contextWindow || LIVE_MODEL_DEFAULTS.contextWindow;
        result.push({
          ...(existing || {}),
          provider,
          id,
          name: existing?.name || id,
          reasoning: profile.reasoning ?? existing?.reasoning ?? LIVE_MODEL_DEFAULTS.reasoning,
          input: profile.input ?? existing?.input ?? LIVE_MODEL_DEFAULTS.input,
          cost: existing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: displayContextWindow,
          configuredContextWindow,
          providerContextWindow,
          profileContextWindow: profile.contextWindow,
          maxTokens: profile.maxTokens ?? existing?.maxTokens ?? LIVE_MODEL_DEFAULTS.maxTokens,
          contextSource: providerContextWindow
            ? "provider"
            : profile.contextWindow
              ? "official-profile"
              : existing
                ? "config-fallback-omitted"
                : "config-fallback-missing",
          providerMetadataCheckedAt: meta.fetchedAt,
          providerMetadataError: meta.error,
        });
      }
      } catch (e: any) {
        console.warn(`[Mirror] Live sync failed for ${provider}: ${e?.message || e}`);
        if (!result.some((model) => model.provider === provider)) {
          result.push(...models.filter((model) => model.provider === provider));
        }
      }
    }
    return result;
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
      if (!LIVE_MODEL_METADATA_PROVIDERS.has(model.provider)) {
        return { ...model, contextSource: "pi-registry", configuredContextWindow: model.contextWindow };
      }
      const providerResult = metadata.get(model.provider);
      const upstream = providerResult?.models.get(String(model.id));
      const providerContextWindow = upstreamContextWindow(upstream);
      const configuredContextWindow = model.contextWindow;
      const profileContextWindow = MODEL_CONTEXT_PROFILES.get(`${model.provider}/${model.id}`);
      return {
        ...model,
        // Explicit provider metadata always wins. A maintained model profile is
        // used only when the provider omits the field; Pi's configured value is
        // the final fallback.
        contextWindow: providerContextWindow || profileContextWindow || configuredContextWindow,
        configuredContextWindow,
        providerContextWindow,
        profileContextWindow,
        contextSource: providerContextWindow
          ? "provider"
          : profileContextWindow
            ? "official-profile"
            : providerResult?.error
              ? "config-fallback-error"
              : upstream
                ? "config-fallback-omitted"
                : "config-fallback-missing",
        providerMetadataCheckedAt: providerResult?.fetchedAt,
        providerMetadataError: providerResult?.error,
      };
    });
  }

  function captureDefaultPreferences() {
    try {
      const settingsPath = path.join(PI_AGENT_DIR, "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      return {
        defaultProvider: settings.defaultProvider,
        defaultModel: settings.defaultModel,
        defaultThinkingLevel: settings.defaultThinkingLevel,
      };
    } catch {
      return null;
    }
  }

  function restoreDefaultPreferences(preferences: ReturnType<typeof captureDefaultPreferences>) {
    if (!preferences) return;
    try {
      const settingsPath = path.join(PI_AGENT_DIR, "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const) {
        if (preferences[key] === undefined) delete settings[key];
        else settings[key] = preferences[key];
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (e: any) {
      console.warn(`[Mirror] Could not restore Pi defaults after a temporary web selection: ${e?.message || e}`);
    }
  }

  // Pending RPC-style requests from browser (id -> resolver)
  const pendingRequests = new Map<string, (response: any) => void>();

  // ═══════════════════════════════════════
  // Helper: send to one client
  // ═══════════════════════════════════════
  function sendTo(ws: WebSocket, data: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // ═══════════════════════════════════════
  // Helper: broadcast to all clients
  // ═══════════════════════════════════════
  function broadcast(data: any) {
    const json = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  // Plan mode mirror state. The official plan-mode extension publishes its
  // state on the shared event bus; cache it for get_state and relay updates to
  // every browser client so the web toggle stays in sync.
  let planModeState: any = null;
  pi.events.on("tau-plan-mode:state", (state: any) => {
    planModeState = state;
    broadcast({ type: "plan_mode_state", data: state });
  });

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
        client.close();
      }
      clients.clear();
      wss.close();
      wss = null;
    }
    if (server) {
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
    "model_select",
  ] as const;

  for (const eventType of eventTypes) {
    pi.on(eventType as any, async (event: any, ctx: ExtensionContext) => {
      latestCtx = ctx;

      // Forward event to all connected browser clients
      // Wrap in { type: "event", event: ... } to match the existing frontend protocol
      broadcast({ type: "event", event: { type: eventType, ...event } });
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
    latestCtx = ctx;
    turnCount = 0;
    titleSet = false;
    userMessages = [];
    // Update instance registry with new session file
    updateInstanceSession(ctx.sessionManager.getSessionFile() || "");
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

  // ═══════════════════════════════════════
  // Build state snapshot for new connections
  // ═══════════════════════════════════════
  async function buildStateSnapshot(ctx: ExtensionContext) {
    // Get session entries for message history
    let entries = ctx.sessionManager.getEntries();

    // For very long sessions, only send the tail to avoid transmitting
    // tens of MB over WebSocket, which freezes both the server (JSON.stringify)
    // and the browser (JSON.parse + DOM rendering).  Keep enough context
    // so the user can see recent conversation.
    const MAX_SYNC_ENTRIES = 200;
    if (entries.length > MAX_SYNC_ENTRIES) {
      entries = entries.slice(-MAX_SYNC_ENTRIES);
    }

    // Trim oversized entries to prevent browser freeze on parse + render.
    // Tool results with huge output (>30KB text) are truncated with a notice.
    const MAX_ENTRY_TEXT_LEN = 30000;
    entries = entries.map((entry: any) => {
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

    // Get model info
    const model = ctx.model;
    const thinkingLevel = pi.getThinkingLevel();
    const sessionName = pi.getSessionName();
    const sessionFile = ctx.sessionManager.getSessionFile();

    // Context usage
    const contextUsage = ctx.getContextUsage();

    return {
      type: "mirror_sync",
      entries,
      model,
      thinkingLevel,
      sessionName,
      sessionFile,
      isStreaming: !ctx.isIdle(),
      contextUsage,
    };
  }

  // ═══════════════════════════════════════
  // Handle commands from browser clients
  // ═══════════════════════════════════════
  async function handleCommand(ws: WebSocket, command: any) {
    const id = command.id;
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

        case "toggle_plan_mode": {
          // The official plan-mode extension listens on the shared event bus.
          // Emit instead of sending "/plan" as a visible chat message.
          pi.events.emit("tau-plan-mode:toggle");
          sendTo(ws, success("toggle_plan_mode", {}));
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
            isStreaming: !ctx.isIdle(),
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

          // Acknowledge before replacement shuts down this extension instance.
          sendTo(ws, success("resume_session", { switching: true }));
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
            models = await syncLiveModels(ctx, registryModels, force);
            models = await enrichModelsWithProviderMetadata(ctx, models, force);
          } catch (e: any) {
            console.warn(`[Mirror] Model sync failed: ${e?.message || e}`);
            models = registryModels;
          }
          sendTo(ws, success("get_available_models", {
            models,
            metadataMode: "provider-first",
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
              : `没有找到模型 ${wantedProvider} :: ${wantedId}（该中转站尚未加载）`));
            break;
          }
          const defaults = captureDefaultPreferences();
          let ok = false;
          try {
            ok = await pi.setModel(model);
          } finally {
            // Web model switching is session-scoped. Do not silently rewrite
            // the user's normal Pi startup model.
            restoreDefaultPreferences(defaults);
          }
          if (!ok) {
            sendTo(ws, error("set_model", "No API key for this model"));
            break;
          }
          sendTo(ws, success("set_model", model));
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
          const defaults = captureDefaultPreferences();
          let changed = false;
          try {
            changed = await pi.setModel(nextModel);
          } finally {
            restoreDefaultPreferences(defaults);
          }
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
          const levels = ["off", "minimal", "low", "medium", "high"];
          const current = pi.getThinkingLevel();
          const idx = levels.indexOf(current);
          const next = levels[(idx + 1) % levels.length];
          const defaults = captureDefaultPreferences();
          try {
            pi.setThinkingLevel(next as any);
          } finally {
            restoreDefaultPreferences(defaults);
          }
          const actual = pi.getThinkingLevel();
          sendTo(ws, success("cycle_thinking_level", { level: actual }));
          break;
        }

        case "set_thinking_level": {
          const defaults = captureDefaultPreferences();
          try {
            pi.setThinkingLevel(command.level);
          } finally {
            restoreDefaultPreferences(defaults);
          }
          sendTo(ws, success("set_thinking_level"));
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
          const name = command.name?.trim();
          if (!name) {
            sendTo(ws, error("set_session_name", "Name cannot be empty"));
            break;
          }
          pi.setSessionName(name);
          sendTo(ws, success("set_session_name"));
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
            sendTo(ws, error("test_provider", e?.name === "AbortError" ? "连接中转站超时" : (e?.message || "无法连接中转站")));
          }
          break;
        }

        case "save_provider": {
          const id = String(command.id || "").trim();
          if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)) {
            sendTo(ws, error("save_provider", "中转站 ID 只能用字母开头，并包含字母、数字、下划线或短横线"));
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
          const api = RELAY_APIS.has(command.api) ? command.api : "openai-completions";
          const file = readModelsFile();
          const previous = file.providers[id] || {};
          const apiKey = command.apiKey ? String(command.apiKey) : previous.apiKey;
          if (!apiKey) {
            sendTo(ws, error("save_provider", "请填写 API Key"));
            break;
          }
          const compat = command.compat && typeof command.compat === "object"
            ? command.compat
            : previous.compat || {
                supportsDeveloperRole: false,
                supportsReasoningEffort: true,
                maxTokensField: "max_tokens",
              };
          let models = Array.isArray(previous.models) ? previous.models : [];
          let fetchError = "";
          if (command.fetchModels !== false) {
            try {
              const records = await fetchRelayModelRecords(baseUrl, resolveConfiguredApiKey(apiKey), command.headers);
              if (records.length > 0) {
                const existingById = new Map(models.map((m: any) => [normalizeModelId(m.id), m]));
                models = records.map((item) => {
                  const prev = existingById.get(item.id);
                  return {
                    id: item.id,
                    name: prev?.name || item.name || item.id,
                    reasoning: prev?.reasoning ?? true,
                    input: prev?.input || ["text"],
                    contextWindow: prev?.contextWindow || 128000,
                    maxTokens: prev?.maxTokens || 16384,
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
              models: (nextCfg.models || []).map((m: any) => ({
                id: normalizeModelId(m.id),
                name: m.name || normalizeModelId(m.id),
                reasoning: m.reasoning ?? true,
                input: m.input || ["text"],
                cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: m.contextWindow || 128000,
                maxTokens: m.maxTokens || 16384,
              })),
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
            sendTo(ws, error("delete_provider", "缺少中转站 ID"));
            break;
          }
          const file = readModelsFile();
          if (!file.providers[id]) {
            sendTo(ws, error("delete_provider", `没有找到中转站 ${id}`));
            break;
          }
          delete file.providers[id];
          writeModelsFile(file);
          providerMetadataCache.delete(id);
          try { pi.unregisterProvider(id); } catch {}
          sendTo(ws, success("delete_provider", { id }));
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

    const filePath = path.join(STATIC_DIR, urlPath);

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

      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ═══════════════════════════════════════
  // API routes (sessions list, etc.)
  // ═══════════════════════════════════════
  function handleApiRoute(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
      serveSearch(res, q);
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
    const sessionMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      serveSessionFile(res, sessionMatch[1], sessionMatch[2]);
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

    // Session delete
    if (urlPath === "/api/sessions/delete" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { filePath } = JSON.parse(body);
          if (!filePath || typeof filePath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          if (!fs.existsSync(filePath)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          fs.unlinkSync(filePath);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
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

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ═══════════════════════════════════════
  // Session file endpoint
  // ═══════════════════════════════════════
  function serveSessionFile(res: http.ServerResponse, dirName: string, file: string) {
    const filePath = path.join(SESSIONS_DIR, dirName, file);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    const entries: any[] = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    let buffer = "";

    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          try { entries.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        try { entries.push(JSON.parse(buffer)); } catch { /* skip */ }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries }));
    });

    stream.on("error", (e: Error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
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

  async function serveSearch(res: http.ServerResponse, query: string) {
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
      (ws as any).isAlive = true;

      ws.on("pong", () => {
        (ws as any).isAlive = true;
      });

      // Send initial state
      sendTo(ws, { type: "state", isStreaming: false, mode: "mirror" });

      // Immediately send state snapshot
      if (latestCtx) {
        buildStateSnapshot(latestCtx).then((snapshot) => {
          sendTo(ws, snapshot);
        });
      }

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
        clients.delete(ws);
      });

      ws.on("error", (e) => {
        console.error("[Mirror] Client error:", e);
        clients.delete(ws);
      });
    });

    // Heartbeat keeps mobile/Tailscale sessions alive and removes stale clients.
    heartbeatTimer = setInterval(() => {
      for (const client of clients) {
        if (client.readyState !== WebSocket.OPEN) {
          clients.delete(client);
          continue;
        }

        if (!(client as any).isAlive) {
          try { client.terminate(); } catch {}
          clients.delete(client);
          continue;
        }

        (client as any).isAlive = false;
        try { client.ping(); } catch {}
      }
    }, 20000);

    const tryListen = (port: number, maxAttempts = 10) => {
      server!.listen(port, HOST, () => {
        onListening(port);
      });
      server!.once("error", (err: any) => {
        if (err.code === "EADDRINUSE" && port < PORT + maxAttempts) {
          // Check if a stale Tau instance owns this port and kill it
          const instances = getRunningInstances();
          const stale = instances.find(i => i.port === port && i.pid !== process.pid);
          if (stale && isZombieProcess(stale.pid)) {
            console.log(`[Mirror] Port ${port} in use by stale Tau instance (PID ${stale.pid}), killing...`);
            try { process.kill(stale.pid, "SIGTERM"); } catch {}
            // Wait briefly then retry the same port
            setTimeout(() => {
              server!.removeAllListeners("error");
              tryListen(port, maxAttempts);
            }, 500);
            return;
          }
          console.log(`[Mirror] Port ${port} in use, trying ${port + 1}...`);
          server!.removeAllListeners("error");
          tryListen(port + 1, maxAttempts);
        } else {
          console.error(`[Mirror] Failed to start server:`, err.message);
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
    stopServer();
    console.log("[Mirror] Server shut down");
  });
}
