import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../browser/control-service.js";
import { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import { loadConfig } from "../config/config.js";
import { GatewayClient } from "../gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import {
  addAllowlistEntry,
  analyzeArgvCommand,
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  requiresExecApproval,
  normalizeExecApprovals,
  recordAllowlistUse,
  resolveExecApprovals,
  resolveSafeBins,
  ensureExecApprovals,
  readExecApprovalsSnapshot,
  resolveExecApprovalsSocketPath,
  saveExecApprovals,
  type ExecAsk,
  type ExecSecurity,
  type ExecApprovalsFile,
  type ExecAllowlistEntry,
  type ExecCommandSegment,
} from "../infra/exec-approvals.js";
import {
  requestExecHostViaSocket,
  type ExecHostRequest,
  type ExecHostResponse,
  type ExecHostRunResult,
} from "../infra/exec-host.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { ensureSynurexCliOnPath } from "../infra/path-env.js";
import { detectMime } from "../media/mime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { VERSION } from "../version.js";
import { ensureNodeHostConfig, saveNodeHostConfig, type NodeHostGatewayConfig } from "./config.js";

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
};

type SystemRunParams = {
  command: string[];
  rawCommand?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number | null;
  needsScreenRecording?: boolean | null;
  agentId?: string | null;
  sessionKey?: string | null;
  approved?: boolean | null;
  approvalDecision?: string | null;
  runId?: string | null;
};

type SystemWhichParams = {
  bins: string[];
};

type BrowserProxyParams = {
  method?: string;
  path?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
};

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

type SystemExecApprovalsSetParams = {
  file: ExecApprovalsFile;
  baseHash?: string | null;
};

type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

type RunResult = {
  exitCode?: number;
  timedOut: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string | null;
  truncated: boolean;
};

function resolveExecSecurity(value?: string): ExecSecurity {
  return value === "deny" || value === "allowlist" || value === "full" ? value : "allowlist";
}

function isCmdExeInvocation(argv: string[]): boolean {
  const token = argv[0]?.trim();
  if (!token) {
    return false;
  }
  const base = path.win32.basename(token).toLowerCase();
  return base === "cmd.exe" || base === "cmd";
}

function resolveExecAsk(value?: string): ExecAsk {
  return value === "off" || value === "on-miss" || value === "always" ? value : "on-miss";
}

type ExecEventPayload = {
  sessionKey: string;
  runId: string;
  host: string;
  command?: string;
  exitCode?: number;
  timedOut?: boolean;
  success?: boolean;
  output?: string;
  reason?: string;
};

type NodeInvokeRequestPayload = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
  timeoutMs?: number | null;
  idempotencyKey?: string | null;
};

const OUTPUT_CAP = 200_000;
const OUTPUT_EVENT_TAIL = 20_000;
const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const BROWSER_PROXY_MAX_FILE_BYTES = 10 * 1024 * 1024;

const execHostEnforced = process.env.SYNUREX_NODE_EXEC_HOST?.trim().toLowerCase() === "app";
const execHostFallbackAllowed =
  process.env.SYNUREX_NODE_EXEC_FALLBACK?.trim().toLowerCase() !== "0";

const blockedEnvKeys = new Set([
  "NODE_OPTIONS",
  "PYTHONHOME",
  "PYTHONPATH",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
]);

const blockedEnvPrefixes = ["DYLD_", "LD_"];

class SkillBinsCache {
  private bins = new Set<string>();
  private lastRefresh = 0;
  private readonly ttlMs = 90_000;
  private readonly fetch: () => Promise<string[]>;

  constructor(fetch: () => Promise<string[]>) {
    this.fetch = fetch;
  }

  async current(force = false): Promise<Set<string>> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }

  private async refresh() {
    try {
      const bins = await this.fetch();
      this.bins = new Set(bins);
      this.lastRefresh = Date.now();
    } catch {
      if (!this.lastRefresh) {
        this.bins = new Set();
      }
    }
  }
}

function sanitizeEnv(
  overrides?: Record<string, string> | null,
): Record<string, string> | undefined {
  if (!overrides) {
    return undefined;
  }
  const merged = { ...process.env } as Record<string, string>;
  const basePath = process.env.PATH ?? DEFAULT_NODE_PATH;
  for (const [rawKey, value] of Object.entries(overrides)) {
    const key = rawKey.trim();
    if (!key) {
      continue;
    }
    const upper = key.toUpperCase();
    if (upper === "PATH") {
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      if (!basePath || trimmed === basePath) {
        merged[key] = trimmed;
        continue;
      }
      const suffix = `${path.delimiter}${basePath}`;
      if (trimmed.endsWith(suffix)) {
        merged[key] = trimmed;
      }
      continue;
    }
    if (blockedEnvKeys.has(upper)) {
      continue;
    }
    if (blockedEnvPrefixes.some((prefix) => upper.startsWith(prefix))) {
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function normalizeProfileAllowlist(raw?: string[]): string[] {
  return Array.isArray(raw) ? raw.map((entry) => entry.trim()).filter(Boolean) : [];
}

function resolveBrowserProxyConfig() {
  const cfg = loadConfig();
  const proxy = cfg.nodeHost?.browserProxy;
  const allowProfiles = normalizeProfileAllowlist(proxy?.allowProfiles);
  const enabled = proxy?.enabled !== false;
  return { enabled, allowProfiles };
}

let browserControlReady: Promise<void> | null = null;

async function ensureBrowserControlService(): Promise<void> {
  if (browserControlReady) {
    return browserControlReady;
  }
  browserControlReady = (async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    if (!resolved.enabled) {
      throw new Error("browser control disabled");
    }
    const started = await startBrowserControlServiceFromConfig();
    if (!started) {
      throw new Error("browser control disabled");
    }
  })();
  return browserControlReady;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number, label?: string): Promise<T> {
  const resolved =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.max(1, Math.floor(timeoutMs))
      : undefined;
  if (!resolved) {
    return await promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label ?? "request"} timed out`));
    }, resolved);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isProfileAllowed(params: { allowProfiles: string[]; profile?: string | null }) {
  const { allowProfiles, profile } = params;
  if (!allowProfiles.length) {
    return true;
  }
  if (!profile) {
    return false;
  }
  return allowProfiles.includes(profile.trim());
}

function collectBrowserProxyPaths(payload: unknown): string[] {
  const paths = new Set<string>();
  const obj =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  if (!obj) {
    return [];
  }
  if (typeof obj.path === "string" && obj.path.trim()) {
    paths.add(obj.path.trim());
  }
  if (typeof obj.imagePath === "string" && obj.imagePath.trim()) {
    paths.add(obj.imagePath.trim());
  }
  const download = obj.download;
  if (download && typeof download === "object") {
    const dlPath = (download as Record<string, unknown>).path;
    if (typeof dlPath === "string" && dlPath.trim()) {
      paths.add(dlPath.trim());
    }
  }
  return [...paths];
}

async function readBrowserProxyFile(filePath: string): Promise<BrowserProxyFile | null> {
  const stat = await fsPromises.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return null;
  }
  if (stat.size > BROWSER_PROXY_MAX_FILE_BYTES) {
    throw new Error(
      `browser proxy file exceeds ${Math.round(BROWSER_PROXY_MAX_FILE_BYTES / (1024 * 1024))}MB`,
    );
  }
  const buffer = await fsPromises.readFile(filePath);
  const mimeType = await detectMime({ buffer, filePath });
  return { path: filePath, base64: buffer.toString("base64"), mimeType };
}

function formatCommand(argv: string[]): string {
  return argv
    .map((arg) => {
      const trimmed = arg.trim();
      if (!trimmed) {
        return '""';
      }
      const needsQuotes = /\s|"/.test(trimmed);
      if (!needsQuotes) {
        return trimmed;
      }
      return `"${trimmed.replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

function truncateOutput(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) {
    return { text: raw, truncated: false };
  }
  return { text: `... (truncated) ${raw.slice(raw.length - maxChars)}`, truncated: true };
}

function redactExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  return {
    ...file,
    socket: socketPath ? { path: socketPath } : undefined,
  };
}

function requireExecApprovalsBaseHash(
  params: SystemExecApprovalsSetParams,
  snapshot: ExecApprovalsSnapshot,
) {
  if (!snapshot.exists) {
    return;
  }
  if (!snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash unavailable; reload and retry");
  }
  const baseHash = typeof params.baseHash === "string" ? params.baseHash.trim() : "";
  if (!baseHash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash required; reload and retry");
  }
  if (baseHash !== snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals changed; reload and retry");
  }
}

async function runCommand(
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeoutMs: number | undefined,
): Promise<RunResult> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (outputLen >= OUTPUT_CAP) {
        truncated = true;
        return;
      }
      const remaining = OUTPUT_CAP - outputLen;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      const str = slice.toString("utf8");
      outputLen += slice.length;
      if (target === "stdout") {
        stdout += str;
      } else {
        stderr += str;
      }
      if (chunk.length > remaining) {
        truncated = true;
      }
    };

    child.stdout?.on("data", (chunk) => onChunk(chunk as Buffer, "stdout"));
    child.stderr?.on("data", (chunk) => onChunk(chunk as Buffer, "stderr"));

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    const finalize = (exitCode?: number, error?: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        exitCode,
        timedOut,
        success: exitCode === 0 && !timedOut && !error,
        stdout,
        stderr,
        error: error ?? null,
        truncated,
      });
    };

    child.on("error", (err) => {
      finalize(undefined, err.message);
    });
    child.on("exit", (code) => {
      finalize(code === null ? undefined : code, null);
    });
  });
}

function resolveEnvPath(env?: Record<string, string>): string[] {
  const raw =
    env?.PATH ??
    (env as Record<string, string>)?.Path ??
    process.env.PATH ??
    process.env.Path ??
    DEFAULT_NODE_PATH;
  return raw.split(path.delimiter).filter(Boolean);
}

function ensureNodePathEnv(): string {
  ensureSynurexCliOnPath({ pathEnv: process.env.PATH ?? "" });
  const current = process.env.PATH ?? "";
  if (current.trim()) {
    return current;
  }
  process.env.PATH = DEFAULT_NODE_PATH;
  return DEFAULT_NODE_PATH;
}

function resolveExecutable(bin: string, env?: Record<string, string>) {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((ext) => ext.toLowerCase())
      : [""];
  for (const dir of resolveEnvPath(env)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function handleSystemWhich(params: SystemWhichParams, env?: Record<string, string>) {
  const bins = params.bins.map((bin) => bin.trim()).filter(Boolean);
  const found: Record<string, string> = {};
  for (const bin of bins) {
    const path = resolveExecutable(bin, env);
    if (path) {
      found[bin] = path;
    }
  }
  return { bins: found };
}

function buildExecEventPayload(payload: ExecEventPayload): ExecEventPayload {
  if (!payload.output) {
    return payload;
  }
  const trimmed = payload.output.trim();
  if (!trimmed) {
    return payload;
  }
  const { text } = truncateOutput(trimmed, OUTPUT_EVENT_TAIL);
  return { ...payload, output: text };
}

async function runViaMacAppExecHost(params: {
  approvals: ReturnType<typeof resolveExecApprovals>;
  request: ExecHostRequest;
}): Promise<ExecHostResponse | null> {
  const { approvals, request } = params;
  return await requestExecHostViaSocket({
    socketPath: approvals.socketPath,
    token: approvals.token,
    request,
  });
}

export async function runNodeHost(opts: NodeHostRunOptions): Promise<void> {
  const config = await ensureNodeHostConfig();
  const nodeId = opts.nodeId?.trim() || config.nodeId;
  if (nodeId !== config.nodeId) {
    config.nodeId = nodeId;
  }
  const displayName =
    opts.displayName?.trim() || config.displayName || (await getMachineDisplayName());
  config.displayName = displayName;
  const gateway: NodeHostGatewayConfig = {
    host: opts.gatewayHost,
    port: opts.gatewayPort,
    tls: opts.gatewayTls ?? loadConfig().gateway?.tls?.enabled ?? false,
    tlsFingerprint: opts.gatewayTlsFingerprint,
  };
  config.gateway = gateway;
  await saveNodeHostConfig(config);

  const cfg = loadConfig();
  const browserProxy = resolveBrowserProxyConfig();
  const resolvedBrowser = resolveBrowserConfig(cfg.browser, cfg);
  const browserProxyEnabled = browserProxy.enabled && resolvedBrowser.enabled;
  const isRemoteMode = cfg.gateway?.mode === "remote";
  const token =
    process.env.SYNUREX_GATEWAY_TOKEN?.trim() ||
    (isRemoteMode ? cfg.gateway?.remote?.token : cfg.gateway?.auth?.token);
  const password =
    process.env.SYNUREX_GATEWAY_PASSWORD?.trim() ||
    (isRemoteMode ? cfg.gateway?.remote?.password : cfg.gateway?.auth?.password);

  const host = gateway.host ?? "127.0.0.1";
  const port = gateway.port ?? 18789;
  const scheme = gateway.tls ? "wss" : "ws";
  const url = `${scheme}://${host}:${port}`;
  const pathEnv = ensureNodePathEnv();

  const client = new GatewayClient({
    url,
    token: token?.trim() || undefined,
    password: password?.trim() || undefined,
    instanceId: nodeId,
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: displayName,
    clientVersion: VERSION,
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.NODE,
    role: "node",
    scopes: [],
    caps: ["system", "screen", "input", "file", "audio", "app", ...(browserProxyEnabled ? ["browser"] : [])],
    commands: [
      "system.run",
      "system.which",
      "system.info",
      "system.execApprovals.get",
      "system.execApprovals.set",
      "screen.snap",
      "clipboard.read",
      "clipboard.write",
      "process.list",
      "process.kill",
      "network.info",
      "display.list",
      "input.type",
      "input.key",
      "input.click",
      "app.launch",
      "app.list",
      "audio.play",
      "audio.record",
      "file.watch",
      "file.read",
      "file.write",
      "file.list",
      "file.stat",
      "file.copy",
      "file.delete",
      ...(browserProxyEnabled ? ["browser.proxy"] : []),
    ],
    pathEnv,
    permissions: undefined,
    deviceIdentity: loadOrCreateDeviceIdentity(),
    tlsFingerprint: gateway.tlsFingerprint,
    onEvent: (evt) => {
      if (evt.event !== "node.invoke.request") {
        return;
      }
      const payload = coerceNodeInvokePayload(evt.payload);
      if (!payload) {
        return;
      }
      void handleInvoke(payload, client, skillBins);
    },
    onConnectError: (err) => {
      // keep retrying (handled by GatewayClient)
      // eslint-disable-next-line no-console
      console.error(`node host gateway connect failed: ${err.message}`);
    },
    onClose: (code, reason) => {
      // eslint-disable-next-line no-console
      console.error(`node host gateway closed (${code}): ${reason}`);
    },
  });

  const skillBins = new SkillBinsCache(async () => {
    const res = await client.request<{ bins: Array<unknown> }>("skills.bins", {});
    const bins = Array.isArray(res?.bins) ? res.bins.map((bin) => String(bin)) : [];
    return bins;
  });

  client.start();
  await new Promise(() => {});
}

async function handleInvoke(
  frame: NodeInvokeRequestPayload,
  client: GatewayClient,
  skillBins: SkillBinsCache,
) {
  const command = String(frame.command ?? "");
  if (command === "system.execApprovals.get") {
    try {
      ensureExecApprovals();
      const snapshot = readExecApprovalsSnapshot();
      const payload: ExecApprovalsSnapshot = {
        path: snapshot.path,
        exists: snapshot.exists,
        hash: snapshot.hash,
        file: redactExecApprovals(snapshot.file),
      };
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify(payload),
      });
    } catch (err) {
      const message = String(err);
      const code = message.toLowerCase().includes("timed out") ? "TIMEOUT" : "INVALID_REQUEST";
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code, message },
      });
    }
    return;
  }

  if (command === "system.execApprovals.set") {
    try {
      const params = decodeParams<SystemExecApprovalsSetParams>(frame.paramsJSON);
      if (!params.file || typeof params.file !== "object") {
        throw new Error("INVALID_REQUEST: exec approvals file required");
      }
      ensureExecApprovals();
      const snapshot = readExecApprovalsSnapshot();
      requireExecApprovalsBaseHash(params, snapshot);
      const normalized = normalizeExecApprovals(params.file);
      const currentSocketPath = snapshot.file.socket?.path?.trim();
      const currentToken = snapshot.file.socket?.token?.trim();
      const socketPath =
        normalized.socket?.path?.trim() ?? currentSocketPath ?? resolveExecApprovalsSocketPath();
      const token = normalized.socket?.token?.trim() ?? currentToken ?? "";
      const next: ExecApprovalsFile = {
        ...normalized,
        socket: {
          path: socketPath,
          token,
        },
      };
      saveExecApprovals(next);
      const nextSnapshot = readExecApprovalsSnapshot();
      const payload: ExecApprovalsSnapshot = {
        path: nextSnapshot.path,
        exists: nextSnapshot.exists,
        hash: nextSnapshot.hash,
        file: redactExecApprovals(nextSnapshot.file),
      };
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify(payload),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: String(err) },
      });
    }
    return;
  }

  if (command === "system.which") {
    try {
      const params = decodeParams<SystemWhichParams>(frame.paramsJSON);
      if (!Array.isArray(params.bins)) {
        throw new Error("INVALID_REQUEST: bins required");
      }
      const env = sanitizeEnv(undefined);
      const payload = await handleSystemWhich(params, env);
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify(payload),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: String(err) },
      });
    }
    return;
  }

  if (command === "browser.proxy") {
    try {
      const params = decodeParams<BrowserProxyParams>(frame.paramsJSON);
      const pathValue = typeof params.path === "string" ? params.path.trim() : "";
      if (!pathValue) {
        throw new Error("INVALID_REQUEST: path required");
      }
      const proxyConfig = resolveBrowserProxyConfig();
      if (!proxyConfig.enabled) {
        throw new Error("UNAVAILABLE: node browser proxy disabled");
      }
      await ensureBrowserControlService();
      const cfg = loadConfig();
      const resolved = resolveBrowserConfig(cfg.browser, cfg);
      const requestedProfile = typeof params.profile === "string" ? params.profile.trim() : "";
      const allowedProfiles = proxyConfig.allowProfiles;
      if (allowedProfiles.length > 0) {
        if (pathValue !== "/profiles") {
          const profileToCheck = requestedProfile || resolved.defaultProfile;
          if (!isProfileAllowed({ allowProfiles: allowedProfiles, profile: profileToCheck })) {
            throw new Error("INVALID_REQUEST: browser profile not allowed");
          }
        } else if (requestedProfile) {
          if (!isProfileAllowed({ allowProfiles: allowedProfiles, profile: requestedProfile })) {
            throw new Error("INVALID_REQUEST: browser profile not allowed");
          }
        }
      }

      const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
      const path = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
      const body = params.body;
      const query: Record<string, unknown> = {};
      if (requestedProfile) {
        query.profile = requestedProfile;
      }
      const rawQuery = params.query ?? {};
      for (const [key, value] of Object.entries(rawQuery)) {
        if (value === undefined || value === null) {
          continue;
        }
        query[key] = typeof value === "string" ? value : String(value);
      }
      const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
      const response = await withTimeout(
        dispatcher.dispatch({
          method: method === "DELETE" ? "DELETE" : method === "POST" ? "POST" : "GET",
          path,
          query,
          body,
        }),
        params.timeoutMs,
        "browser proxy request",
      );
      if (response.status >= 400) {
        const message =
          response.body && typeof response.body === "object" && "error" in response.body
            ? String((response.body as { error?: unknown }).error)
            : `HTTP ${response.status}`;
        throw new Error(message);
      }
      const result = response.body;
      if (allowedProfiles.length > 0 && path === "/profiles") {
        const obj =
          typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
        const profiles = Array.isArray(obj.profiles) ? obj.profiles : [];
        obj.profiles = profiles.filter((entry) => {
          if (!entry || typeof entry !== "object") {
            return false;
          }
          const name = (entry as Record<string, unknown>).name;
          return typeof name === "string" && allowedProfiles.includes(name);
        });
      }
      let files: BrowserProxyFile[] | undefined;
      const paths = collectBrowserProxyPaths(result);
      if (paths.length > 0) {
        const loaded = await Promise.all(
          paths.map(async (p) => {
            try {
              const file = await readBrowserProxyFile(p);
              if (!file) {
                throw new Error("file not found");
              }
              return file;
            } catch (err) {
              throw new Error(`browser proxy file read failed for ${p}: ${String(err)}`, {
                cause: err,
              });
            }
          }),
        );
        if (loaded.length > 0) {
          files = loaded;
        }
      }
      const payload: BrowserProxyResult = files ? { result, files } : { result };
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify(payload),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: String(err) },
      });
    }
    return;
  }

  // ── screen.snap ──────────────────────────────────────────────────────
  if (command === "screen.snap") {
    try {
      const params = decodeParams<{ display?: string; format?: string; quality?: number }>(frame.paramsJSON);
      const display = params.display || process.env.DISPLAY || ":0";
      const format = params.format === "jpg" || params.format === "jpeg" ? "jpg" : "png";
      const tmpFile = path.join(os.tmpdir(), `screen-snap-${crypto.randomUUID()}.${format}`);
      const platform = process.platform;

      let cmd: string[];
      if (platform === "darwin") {
        cmd = ["screencapture", "-x", "-t", format, tmpFile];
      } else if (platform === "win32") {
        // PowerShell screenshot
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${tmpFile.replace(/\\/g, "\\\\")}')
$g.Dispose()
$bmp.Dispose()`;
        cmd = ["powershell", "-NoProfile", "-Command", psScript];
      } else {
        // Linux with import (ImageMagick)
        cmd = ["bash", "-c", `DISPLAY=${display} import -window root ${tmpFile}`];
      }

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { timeout: 15000 });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`screenshot failed (exit ${code})`)));
        proc.on("error", reject);
      });

      const buffer = await fsPromises.readFile(tmpFile);
      await fsPromises.rm(tmpFile, { force: true }).catch(() => {});
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({
          format,
          size: buffer.length,
          encoding: "base64",
          data: buffer.toString("base64"),
        }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  // ── clipboard.read / clipboard.write ───────────────────────────────
  if (command === "clipboard.read") {
    try {
      const platform = process.platform;
      let cmd: string[];
      if (platform === "darwin") {
        cmd = ["pbpaste"];
      } else if (platform === "win32") {
        cmd = ["powershell", "-NoProfile", "-Command", "Get-Clipboard"];
      } else {
        const display = process.env.DISPLAY || ":0";
        cmd = ["bash", "-c", `DISPLAY=${display} xclip -selection clipboard -o 2>/dev/null || DISPLAY=${display} xsel --clipboard --output 2>/dev/null || echo ""`];
      }
      const text = await new Promise<string>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { timeout: 5000 });
        let out = "";
        proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
        proc.on("close", () => resolve(out));
        proc.on("error", reject);
      });
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ text }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  if (command === "clipboard.write") {
    try {
      const params = decodeParams<{ text: string }>(frame.paramsJSON);
      if (typeof params.text !== "string") throw new Error("INVALID_REQUEST: text required");
      const platform = process.platform;
      let cmd: string[];
      if (platform === "darwin") {
        cmd = ["pbcopy"];
      } else if (platform === "win32") {
        cmd = ["powershell", "-NoProfile", "-Command", `Set-Clipboard -Value $input`];
      } else {
        const display = process.env.DISPLAY || ":0";
        cmd = ["bash", "-c", `DISPLAY=${display} xclip -selection clipboard 2>/dev/null || DISPLAY=${display} xsel --clipboard --input 2>/dev/null`];
      }
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { timeout: 5000 });
        proc.stdin?.write(params.text);
        proc.stdin?.end();
        proc.on("close", () => resolve());
        proc.on("error", reject);
      });
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ written: true, length: params.text.length }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  // ── process.list / process.kill ────────────────────────────────────
  if (command === "process.list") {
    try {
      const params = decodeParams<{ filter?: string; limit?: number }>(frame.paramsJSON);
      const platform = process.platform;
      let cmd: string[];
      if (platform === "win32") {
        cmd = ["powershell", "-NoProfile", "-Command", "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Depth 2"];
      } else {
        cmd = ["ps", "aux", "--no-headers"];
      }
      const output = await new Promise<string>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { timeout: 10000 });
        let out = "";
        proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
        proc.on("close", () => resolve(out));
        proc.on("error", reject);
      });

      let processes: Array<{ pid: number; name: string; cpu?: string; mem?: string }>;
      if (platform === "win32") {
        try {
          const raw = JSON.parse(output);
          const arr = Array.isArray(raw) ? raw : [raw];
          processes = arr.map((p: { Id: number; ProcessName: string; CPU: number; WorkingSet64: number }) => ({
            pid: p.Id,
            name: p.ProcessName,
            cpu: String(p.CPU ?? 0),
            mem: String(Math.round((p.WorkingSet64 ?? 0) / 1024 / 1024)) + "MB",
          }));
        } catch { processes = []; }
      } else {
        processes = output.trim().split("\n").filter(Boolean).map((line) => {
          const parts = line.trim().split(/\s+/);
          return { pid: parseInt(parts[1], 10), name: parts[10] || parts[1], cpu: parts[2], mem: parts[3] };
        });
      }

      const filter = params.filter?.toLowerCase();
      if (filter) {
        processes = processes.filter((p) => p.name.toLowerCase().includes(filter));
      }
      const limit = params.limit && params.limit > 0 ? params.limit : 100;
      processes = processes.slice(0, limit);

      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ count: processes.length, processes }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  if (command === "process.kill") {
    try {
      const params = decodeParams<{ pid?: number; name?: string; signal?: string }>(frame.paramsJSON);
      if (!params.pid && !params.name) throw new Error("INVALID_REQUEST: pid or name required");
      const signal = params.signal || "SIGTERM";

      if (params.pid) {
        process.kill(params.pid, signal as NodeJS.Signals);
        await sendInvokeResult(client, frame, {
          ok: true,
          payloadJSON: JSON.stringify({ killed: true, pid: params.pid, signal }),
        });
      } else {
        const platform = process.platform;
        let cmd: string[];
        if (platform === "win32") {
          cmd = ["powershell", "-NoProfile", "-Command", `Stop-Process -Name "${params.name}" -Force`];
        } else {
          cmd = ["pkill", "-f", params.name!];
        }
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(cmd[0], cmd.slice(1), { timeout: 5000 });
          proc.on("close", () => resolve());
          proc.on("error", reject);
        });
        await sendInvokeResult(client, frame, {
          ok: true,
          payloadJSON: JSON.stringify({ killed: true, name: params.name, signal }),
        });
      }
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  // ── system.info ────────────────────────────────────────────────────
  if (command === "system.info") {
    try {
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const uptimeSecs = os.uptime();

      // Disk usage
      let diskInfo: { total?: string; free?: string; used?: string } = {};
      try {
        const platform = process.platform;
        if (platform === "win32") {
          const out = await new Promise<string>((resolve, reject) => {
            const proc = spawn("powershell", ["-NoProfile", "-Command",
              "Get-PSDrive C | Select-Object Used,Free | ConvertTo-Json"], { timeout: 5000 });
            let data = "";
            proc.stdout?.on("data", (d: Buffer) => { data += d.toString(); });
            proc.on("close", () => resolve(data));
            proc.on("error", reject);
          });
          const d = JSON.parse(out);
          diskInfo = {
            total: String(Math.round((d.Used + d.Free) / 1024 / 1024 / 1024)) + "GB",
            free: String(Math.round(d.Free / 1024 / 1024 / 1024)) + "GB",
            used: String(Math.round(d.Used / 1024 / 1024 / 1024)) + "GB",
          };
        } else {
          const out = await new Promise<string>((resolve, reject) => {
            const proc = spawn("df", ["-h", "/"], { timeout: 5000 });
            let data = "";
            proc.stdout?.on("data", (d: Buffer) => { data += d.toString(); });
            proc.on("close", () => resolve(data));
            proc.on("error", reject);
          });
          const lines = out.trim().split("\n");
          if (lines.length > 1) {
            const parts = lines[1].split(/\s+/);
            diskInfo = { total: parts[1], used: parts[2], free: parts[3] };
          }
        }
      } catch { /* disk info optional */ }

      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({
          hostname: os.hostname(),
          platform: process.platform,
          arch: process.arch,
          os: `${os.type()} ${os.release()}`,
          cpuModel: cpus[0]?.model || "unknown",
          cpuCores: cpus.length,
          totalMemory: `${Math.round(totalMem / 1024 / 1024)}MB`,
          freeMemory: `${Math.round(freeMem / 1024 / 1024)}MB`,
          usedMemory: `${Math.round((totalMem - freeMem) / 1024 / 1024)}MB`,
          disk: diskInfo,
          uptime: `${Math.floor(uptimeSecs / 3600)}h ${Math.floor((uptimeSecs % 3600) / 60)}m`,
          nodeVersion: process.version,
          pid: process.pid,
        }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  // ── network.info ───────────────────────────────────────────────────
  if (command === "network.info") {
    try {
      const interfaces = os.networkInterfaces();
      const nets: Array<{ name: string; address: string; family: string; mac: string; internal: boolean }> = [];
      for (const [name, addrs] of Object.entries(interfaces)) {
        if (!addrs) continue;
        for (const addr of addrs) {
          nets.push({
            name,
            address: addr.address,
            family: addr.family,
            mac: addr.mac,
            internal: addr.internal,
          });
        }
      }
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({
          hostname: os.hostname(),
          interfaces: nets,
        }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  // ── display.list ───────────────────────────────────────────────────
  if (command === "display.list") {
    try {
      const platform = process.platform;
      let displays: Array<{ name: string; resolution?: string; primary?: boolean }> = [];

      if (platform === "win32") {
        const out = await new Promise<string>((resolve, reject) => {
          const proc = spawn("powershell", ["-NoProfile", "-Command",
            "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ DeviceName=$_.DeviceName; Bounds=\"$($_.Bounds.Width)x$($_.Bounds.Height)\"; Primary=$_.Primary } } | ConvertTo-Json"], { timeout: 5000 });
          let data = "";
          proc.stdout?.on("data", (d: Buffer) => { data += d.toString(); });
          proc.on("close", () => resolve(data));
          proc.on("error", reject);
        });
        try {
          const raw = JSON.parse(out);
          const arr = Array.isArray(raw) ? raw : [raw];
          displays = arr.map((d: { DeviceName: string; Bounds: string; Primary: boolean }) => ({
            name: d.DeviceName,
            resolution: d.Bounds,
            primary: d.Primary,
          }));
        } catch { /* parse failed */ }
      } else if (platform === "darwin") {
        const out = await new Promise<string>((resolve, reject) => {
          const proc = spawn("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 10000 });
          let data = "";
          proc.stdout?.on("data", (d: Buffer) => { data += d.toString(); });
          proc.on("close", () => resolve(data));
          proc.on("error", reject);
        });
        try {
          const raw = JSON.parse(out);
          const gpus = raw.SPDisplaysDataType || [];
          for (const gpu of gpus) {
            for (const disp of gpu.spdisplays_ndrvs || []) {
              displays.push({
                name: disp._name || "Display",
                resolution: disp._spdisplays_resolution || "unknown",
                primary: disp.spdisplays_main === "spdisplays_yes",
              });
            }
          }
        } catch { /* parse failed */ }
      } else {
        // Linux — xrandr
        const display = process.env.DISPLAY || ":0";
        const out = await new Promise<string>((resolve, reject) => {
          const proc = spawn("bash", ["-c", `DISPLAY=${display} xrandr --query 2>/dev/null || echo "no display"`], { timeout: 5000 });
          let data = "";
          proc.stdout?.on("data", (d: Buffer) => { data += d.toString(); });
          proc.on("close", () => resolve(data));
          proc.on("error", reject);
        });
        const lines = out.split("\n");
        for (const line of lines) {
          const match = line.match(/^(\S+)\s+connected\s+(primary\s+)?(\d+x\d+)/);
          if (match) {
            displays.push({
              name: match[1],
              resolution: match[3],
              primary: !!match[2],
            });
          }
        }
      }

      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ displays }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  // ── input.type / input.key / input.click ───────────────────────────
  if (command === "input.type") {
    try {
      const params = decodeParams<{ text: string; delay?: number }>(frame.paramsJSON);
      if (typeof params.text !== "string") throw new Error("INVALID_REQUEST: text required");
      const platform = process.platform;
      let cmd: string[];

      if (platform === "darwin") {
        // osascript keystroke
        const escaped = params.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        cmd = ["osascript", "-e", `tell application "System Events" to keystroke "${escaped}"`];
      } else if (platform === "win32") {
        const escaped = params.text.replace(/'/g, "''");
        cmd = ["powershell", "-NoProfile", "-Command",
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`];
      } else {
        const display = process.env.DISPLAY || ":0";
        cmd = ["bash", "-c", `DISPLAY=${display} xdotool type --clearmodifiers -- "${params.text.replace(/"/g, '\\"')}"`];
      }

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { timeout: 10000 });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`input.type failed (exit ${code})`)));
        proc.on("error", reject);
      });
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ typed: true, length: params.text.length }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  if (command === "input.key") {
    try {
      const params = decodeParams<{ key: string; modifiers?: string[] }>(frame.paramsJSON);
      if (typeof params.key !== "string") throw new Error("INVALID_REQUEST: key required");
      const platform = process.platform;
      const mods = Array.isArray(params.modifiers) ? params.modifiers : [];
      let cmd: string[];

      if (platform === "darwin") {
        const modStr = mods.map((m) => {
          if (m === "ctrl" || m === "control") return "control down";
          if (m === "alt" || m === "option") return "option down";
          if (m === "shift") return "shift down";
          if (m === "cmd" || m === "command") return "command down";
          return `${m} down`;
        }).join(", ");
        const using = modStr ? ` using {${modStr}}` : "";
        cmd = ["osascript", "-e", `tell application "System Events" to key code ${params.key}${using}`];
      } else if (platform === "win32") {
        // Map modifiers to SendKeys format
        let keyStr = "";
        if (mods.includes("ctrl") || mods.includes("control")) keyStr += "^";
        if (mods.includes("alt")) keyStr += "%";
        if (mods.includes("shift")) keyStr += "+";
        keyStr += `{${params.key}}`;
        cmd = ["powershell", "-NoProfile", "-Command",
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keyStr}')`];
      } else {
        const display = process.env.DISPLAY || ":0";
        const modStr = mods.map((m) => `${m}+`).join("");
        cmd = ["bash", "-c", `DISPLAY=${display} xdotool key --clearmodifiers ${modStr}${params.key}`];
      }

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { timeout: 5000 });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`input.key failed (exit ${code})`)));
        proc.on("error", reject);
      });
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ pressed: true, key: params.key, modifiers: mods }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  if (command === "input.click") {
    try {
      const params = decodeParams<{ x: number; y: number; button?: string; doubleClick?: boolean }>(frame.paramsJSON);
      if (typeof params.x !== "number" || typeof params.y !== "number") throw new Error("INVALID_REQUEST: x and y required");
      const button = params.button || "left";
      const double = params.doubleClick ? true : false;
      const platform = process.platform;
      let cmd: string[];

      if (platform === "darwin") {
        const clickType = double ? "double click" : "click";
        cmd = ["osascript", "-e", `tell application "System Events" to ${clickType} at {${params.x}, ${params.y}}`];
      } else if (platform === "win32") {
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${params.x}, ${params.y})
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse {
    [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
}
"@
[Mouse]::mouse_event(0x0002, 0, 0, 0, 0)
[Mouse]::mouse_event(0x0004, 0, 0, 0, 0)
${double ? "[Mouse]::mouse_event(0x0002, 0, 0, 0, 0)\n[Mouse]::mouse_event(0x0004, 0, 0, 0, 0)" : ""}`;
        cmd = ["powershell", "-NoProfile", "-Command", psScript];
      } else {
        const display = process.env.DISPLAY || ":0";
        const btnNum = button === "right" ? "3" : button === "middle" ? "2" : "1";
        const clickCmd = double
          ? `xdotool mousemove ${params.x} ${params.y} click --repeat 2 ${btnNum}`
          : `xdotool mousemove ${params.x} ${params.y} click ${btnNum}`;
        cmd = ["bash", "-c", `DISPLAY=${display} ${clickCmd}`];
      }

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { timeout: 5000 });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`input.click failed (exit ${code})`)));
        proc.on("error", reject);
      });
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ clicked: true, x: params.x, y: params.y, button, doubleClick: double }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  // ── app.launch / app.list ──────────────────────────────────────────
  if (command === "app.launch") {
    try {
      const params = decodeParams<{ name: string; args?: string[] }>(frame.paramsJSON);
      if (!params.name) throw new Error("INVALID_REQUEST: name required");
      const platform = process.platform;
      let cmd: string[];

      if (platform === "darwin") {
        const args = params.args?.length ? ["-a", params.name, "--args", ...params.args] : ["-a", params.name];
        cmd = ["open", ...args];
      } else if (platform === "win32") {
        cmd = ["powershell", "-NoProfile", "-Command", `Start-Process "${params.name}" ${params.args?.map(a => `"${a}"`).join(" ") || ""}`];
      } else {
        const display = process.env.DISPLAY || ":0";
        const argStr = params.args?.join(" ") || "";
        cmd = ["bash", "-c", `DISPLAY=${display} nohup ${params.name} ${argStr} > /dev/null 2>&1 &`];
      }

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { timeout: 10000, detached: platform !== "win32" });
        proc.unref?.();
        proc.on("close", () => resolve());
        proc.on("error", reject);
      });
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ launched: true, name: params.name }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  if (command === "app.list") {
    try {
      const platform = process.platform;
      let apps: Array<{ name: string; path?: string }> = [];

      if (platform === "darwin") {
        const out = await new Promise<string>((resolve, reject) => {
          const proc = spawn("bash", ["-c", "ls /Applications/*.app | sed 's|/Applications/||;s|.app||'"], { timeout: 5000 });
          let data = "";
          proc.stdout?.on("data", (d: Buffer) => { data += d.toString(); });
          proc.on("close", () => resolve(data));
          proc.on("error", reject);
        });
        apps = out.trim().split("\n").filter(Boolean).map((name) => ({ name, path: `/Applications/${name}.app` }));
      } else if (platform === "win32") {
        const out = await new Promise<string>((resolve, reject) => {
          const proc = spawn("powershell", ["-NoProfile", "-Command",
            "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Depth 2"], { timeout: 15000 });
          let data = "";
          proc.stdout?.on("data", (d: Buffer) => { data += d.toString(); });
          proc.on("close", () => resolve(data));
          proc.on("error", reject);
        });
        try {
          const raw = JSON.parse(out);
          const arr = Array.isArray(raw) ? raw : [raw];
          apps = arr.map((a: { Name: string; AppID: string }) => ({ name: a.Name, path: a.AppID }));
        } catch { /* parse failed */ }
      } else {
        // Linux — check .desktop files
        const out = await new Promise<string>((resolve, reject) => {
          const proc = spawn("bash", ["-c",
            "find /usr/share/applications /usr/local/share/applications ~/.local/share/applications -name '*.desktop' -exec grep -l '^Name=' {} \\; 2>/dev/null | head -100 | while read f; do grep '^Name=' \"$f\" | head -1 | sed 's/Name=//'; done"],
            { timeout: 10000 });
          let data = "";
          proc.stdout?.on("data", (d: Buffer) => { data += d.toString(); });
          proc.on("close", () => resolve(data));
          proc.on("error", reject);
        });
        apps = out.trim().split("\n").filter(Boolean).map((name) => ({ name }));
      }

      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ count: apps.length, apps }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  // ── audio.play / audio.record ──────────────────────────────────────
  if (command === "audio.play") {
    try {
      const params = decodeParams<{ path?: string; data?: string; encoding?: string; url?: string }>(frame.paramsJSON);
      let audioFile: string;

      if (params.url) {
        // Download URL to temp file
        audioFile = path.join(os.tmpdir(), `audio-play-${crypto.randomUUID()}`);
        await new Promise<void>((resolve, reject) => {
          const cmd = process.platform === "win32"
            ? ["powershell", "-NoProfile", "-Command", `Invoke-WebRequest -Uri '${params.url}' -OutFile '${audioFile}'`]
            : ["curl", "-sL", "-o", audioFile, params.url!];
          const proc = spawn(cmd[0], cmd.slice(1), { timeout: 30000 });
          proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`download failed (exit ${code})`)));
          proc.on("error", reject);
        });
      } else if (params.data) {
        audioFile = path.join(os.tmpdir(), `audio-play-${crypto.randomUUID()}.wav`);
        const encoding = params.encoding === "utf8" ? "utf8" as const : "base64" as const;
        await fsPromises.writeFile(audioFile, Buffer.from(params.data, encoding));
      } else if (params.path) {
        audioFile = path.resolve(params.path);
      } else {
        throw new Error("INVALID_REQUEST: path, data, or url required");
      }

      const platform = process.platform;
      let cmd: string[];
      if (platform === "darwin") {
        cmd = ["afplay", audioFile];
      } else if (platform === "win32") {
        cmd = ["powershell", "-NoProfile", "-Command",
          `(New-Object System.Media.SoundPlayer '${audioFile}').PlaySync()`];
      } else {
        cmd = ["bash", "-c", `aplay "${audioFile}" 2>/dev/null || paplay "${audioFile}" 2>/dev/null || ffplay -nodisp -autoexit "${audioFile}" 2>/dev/null`];
      }

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { timeout: 60000 });
        proc.on("close", () => resolve());
        proc.on("error", reject);
      });
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ played: true }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  if (command === "audio.record") {
    try {
      const params = decodeParams<{ durationMs?: number; format?: string }>(frame.paramsJSON);
      const duration = params.durationMs && params.durationMs > 0 ? params.durationMs : 5000;
      const durationSecs = Math.ceil(duration / 1000);
      const format = params.format === "mp3" ? "mp3" : "wav";
      const tmpFile = path.join(os.tmpdir(), `audio-rec-${crypto.randomUUID()}.${format}`);
      const platform = process.platform;
      let cmd: string[];

      if (platform === "darwin") {
        cmd = ["bash", "-c", `rec -q "${tmpFile}" trim 0 ${durationSecs} 2>/dev/null || ffmpeg -f avfoundation -i ":0" -t ${durationSecs} "${tmpFile}" -y 2>/dev/null`];
      } else if (platform === "win32") {
        cmd = ["powershell", "-NoProfile", "-Command",
          `ffmpeg -f dshow -i audio="Microphone" -t ${durationSecs} "${tmpFile}" -y 2>$null`];
      } else {
        cmd = ["bash", "-c", `arecord -d ${durationSecs} -f cd "${tmpFile}" 2>/dev/null || ffmpeg -f pulse -i default -t ${durationSecs} "${tmpFile}" -y 2>/dev/null || ffmpeg -f alsa -i default -t ${durationSecs} "${tmpFile}" -y 2>/dev/null`];
      }

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { timeout: (durationSecs + 5) * 1000 });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`recording failed (exit ${code})`)));
        proc.on("error", reject);
      });

      const buffer = await fsPromises.readFile(tmpFile);
      await fsPromises.rm(tmpFile, { force: true }).catch(() => {});
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({
          format,
          durationMs: duration,
          size: buffer.length,
          encoding: "base64",
          data: buffer.toString("base64"),
        }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  // ── file.watch ─────────────────────────────────────────────────────
  if (command === "file.watch") {
    try {
      const params = decodeParams<{ path: string; durationMs?: number }>(frame.paramsJSON);
      if (!params.path) throw new Error("INVALID_REQUEST: path required");
      const watchPath = path.resolve(params.path);
      const duration = params.durationMs && params.durationMs > 0 ? params.durationMs : 10000;
      const events: Array<{ event: string; filename: string | null; time: string }> = [];

      await new Promise<void>((resolve) => {
        const watcher = fs.watch(watchPath, { recursive: false }, (eventType, filename) => {
          events.push({ event: eventType, filename: filename ?? null, time: new Date().toISOString() });
        });
        setTimeout(() => {
          watcher.close();
          resolve();
        }, Math.min(duration, 30000)); // cap at 30s
      });

      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({
          path: watchPath,
          durationMs: duration,
          events,
        }),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message: String(err) },
      });
    }
    return;
  }

  if (command === "file.read") {
    try {
      const params = decodeParams<{ path: string; encoding?: string; maxBytes?: number }>(frame.paramsJSON);
      if (!params.path || typeof params.path !== "string") {
        throw new Error("INVALID_REQUEST: path required");
      }
      const filePath = path.resolve(params.path);
      const stat = await fsPromises.stat(filePath);
      if (!stat.isFile()) {
        throw new Error("INVALID_REQUEST: path is not a file");
      }
      const maxBytes = typeof params.maxBytes === "number" && params.maxBytes > 0
        ? params.maxBytes
        : 50 * 1024 * 1024; // 50MB default limit
      if (stat.size > maxBytes) {
        throw new Error(`INVALID_REQUEST: file size ${stat.size} exceeds limit ${maxBytes}`);
      }
      const buffer = await fsPromises.readFile(filePath);
      const encoding = params.encoding === "utf8" || params.encoding === "text" ? "utf8" : "base64";
      const data = encoding === "utf8" ? buffer.toString("utf8") : buffer.toString("base64");
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({
          path: filePath,
          size: stat.size,
          encoding,
          data,
        }),
      });
    } catch (err) {
      const message = String(err);
      const code = message.includes("ENOENT") ? "NOT_FOUND"
        : message.includes("EACCES") ? "PERMISSION_DENIED"
        : message.includes("INVALID_REQUEST") ? "INVALID_REQUEST"
        : "INTERNAL";
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code, message },
      });
    }
    return;
  }

  if (command === "file.write") {
    try {
      const params = decodeParams<{ path: string; data: string; encoding?: string; mkdir?: boolean }>(frame.paramsJSON);
      if (!params.path || typeof params.path !== "string") {
        throw new Error("INVALID_REQUEST: path required");
      }
      if (typeof params.data !== "string") {
        throw new Error("INVALID_REQUEST: data required");
      }
      const filePath = path.resolve(params.path);
      if (params.mkdir) {
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      }
      const encoding = params.encoding === "utf8" || params.encoding === "text" ? "utf8" : "base64";
      const buffer = encoding === "utf8"
        ? Buffer.from(params.data, "utf8")
        : Buffer.from(params.data, "base64");
      await fsPromises.writeFile(filePath, buffer);
      const stat = await fsPromises.stat(filePath);
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({
          path: filePath,
          size: stat.size,
          written: true,
        }),
      });
    } catch (err) {
      const message = String(err);
      const code = message.includes("ENOENT") ? "NOT_FOUND"
        : message.includes("EACCES") ? "PERMISSION_DENIED"
        : message.includes("INVALID_REQUEST") ? "INVALID_REQUEST"
        : "INTERNAL";
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code, message },
      });
    }
    return;
  }

  if (command === "file.list") {
    try {
      const params = decodeParams<{ path: string; recursive?: boolean }>(frame.paramsJSON);
      if (!params.path || typeof params.path !== "string") {
        throw new Error("INVALID_REQUEST: path required");
      }
      const dirPath = path.resolve(params.path);
      const stat = await fsPromises.stat(dirPath);
      if (!stat.isDirectory()) {
        throw new Error("INVALID_REQUEST: path is not a directory");
      }
      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
      const items = entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : e.isFile() ? "file" : e.isSymbolicLink() ? "symlink" : "other",
      }));
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({
          path: dirPath,
          entries: items,
        }),
      });
    } catch (err) {
      const message = String(err);
      const code = message.includes("ENOENT") ? "NOT_FOUND"
        : message.includes("EACCES") ? "PERMISSION_DENIED"
        : message.includes("INVALID_REQUEST") ? "INVALID_REQUEST"
        : "INTERNAL";
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code, message },
      });
    }
    return;
  }

  if (command === "file.stat") {
    try {
      const params = decodeParams<{ path: string }>(frame.paramsJSON);
      if (!params.path || typeof params.path !== "string") {
        throw new Error("INVALID_REQUEST: path required");
      }
      const filePath = path.resolve(params.path);
      const stat = await fsPromises.stat(filePath);
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({
          path: filePath,
          size: stat.size,
          type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
          modified: stat.mtime.toISOString(),
          created: stat.birthtime.toISOString(),
          permissions: stat.mode.toString(8),
        }),
      });
    } catch (err) {
      const message = String(err);
      const code = message.includes("ENOENT") ? "NOT_FOUND" : "INTERNAL";
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code, message },
      });
    }
    return;
  }

  if (command === "file.copy") {
    try {
      const params = decodeParams<{ source: string; destination: string; mkdir?: boolean }>(frame.paramsJSON);
      if (!params.source || !params.destination) {
        throw new Error("INVALID_REQUEST: source and destination required");
      }
      const src = path.resolve(params.source);
      const dst = path.resolve(params.destination);
      if (params.mkdir) {
        await fsPromises.mkdir(path.dirname(dst), { recursive: true });
      }
      await fsPromises.copyFile(src, dst);
      const stat = await fsPromises.stat(dst);
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({
          source: src,
          destination: dst,
          size: stat.size,
        }),
      });
    } catch (err) {
      const message = String(err);
      const code = message.includes("ENOENT") ? "NOT_FOUND"
        : message.includes("EACCES") ? "PERMISSION_DENIED"
        : "INTERNAL";
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code, message },
      });
    }
    return;
  }

  if (command === "file.delete") {
    try {
      const params = decodeParams<{ path: string }>(frame.paramsJSON);
      if (!params.path || typeof params.path !== "string") {
        throw new Error("INVALID_REQUEST: path required");
      }
      const filePath = path.resolve(params.path);
      await fsPromises.rm(filePath, { force: true });
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify({ path: filePath, deleted: true }),
      });
    } catch (err) {
      const message = String(err);
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INTERNAL", message },
      });
    }
    return;
  }

  if (command !== "system.run") {
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "command not supported" },
    });
    return;
  }

  let params: SystemRunParams;
  try {
    params = decodeParams<SystemRunParams>(frame.paramsJSON);
  } catch (err) {
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: String(err) },
    });
    return;
  }

  if (!Array.isArray(params.command) || params.command.length === 0) {
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "command required" },
    });
    return;
  }

  const argv = params.command.map((item) => String(item));
  const rawCommand = typeof params.rawCommand === "string" ? params.rawCommand.trim() : "";
  const cmdText = rawCommand || formatCommand(argv);
  const agentId = params.agentId?.trim() || undefined;
  const cfg = loadConfig();
  const agentExec = agentId ? resolveAgentConfig(cfg, agentId)?.tools?.exec : undefined;
  const configuredSecurity = resolveExecSecurity(agentExec?.security ?? cfg.tools?.exec?.security);
  const configuredAsk = resolveExecAsk(agentExec?.ask ?? cfg.tools?.exec?.ask);
  const approvals = resolveExecApprovals(agentId, {
    security: configuredSecurity,
    ask: configuredAsk,
  });
  const security = approvals.agent.security;
  const ask = approvals.agent.ask;
  const autoAllowSkills = approvals.agent.autoAllowSkills;
  const sessionKey = params.sessionKey?.trim() || "node";
  const runId = params.runId?.trim() || crypto.randomUUID();
  const env = sanitizeEnv(params.env ?? undefined);
  const safeBins = resolveSafeBins(agentExec?.safeBins ?? cfg.tools?.exec?.safeBins);
  const bins = autoAllowSkills ? await skillBins.current() : new Set<string>();
  let analysisOk = false;
  let allowlistMatches: ExecAllowlistEntry[] = [];
  let allowlistSatisfied = false;
  let segments: ExecCommandSegment[] = [];
  if (rawCommand) {
    const allowlistEval = evaluateShellAllowlist({
      command: rawCommand,
      allowlist: approvals.allowlist,
      safeBins,
      cwd: params.cwd ?? undefined,
      env,
      skillBins: bins,
      autoAllowSkills,
      platform: process.platform,
    });
    analysisOk = allowlistEval.analysisOk;
    allowlistMatches = allowlistEval.allowlistMatches;
    allowlistSatisfied =
      security === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
    segments = allowlistEval.segments;
  } else {
    const analysis = analyzeArgvCommand({ argv, cwd: params.cwd ?? undefined, env });
    const allowlistEval = evaluateExecAllowlist({
      analysis,
      allowlist: approvals.allowlist,
      safeBins,
      cwd: params.cwd ?? undefined,
      skillBins: bins,
      autoAllowSkills,
    });
    analysisOk = analysis.ok;
    allowlistMatches = allowlistEval.allowlistMatches;
    allowlistSatisfied =
      security === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
    segments = analysis.segments;
  }
  const isWindows = process.platform === "win32";
  const cmdInvocation = rawCommand
    ? isCmdExeInvocation(segments[0]?.argv ?? [])
    : isCmdExeInvocation(argv);
  if (security === "allowlist" && isWindows && cmdInvocation) {
    analysisOk = false;
    allowlistSatisfied = false;
  }

  const useMacAppExec = process.platform === "darwin";
  if (useMacAppExec) {
    const approvalDecision =
      params.approvalDecision === "allow-once" || params.approvalDecision === "allow-always"
        ? params.approvalDecision
        : null;
    const execRequest: ExecHostRequest = {
      command: argv,
      rawCommand: rawCommand || null,
      cwd: params.cwd ?? null,
      env: params.env ?? null,
      timeoutMs: params.timeoutMs ?? null,
      needsScreenRecording: params.needsScreenRecording ?? null,
      agentId: agentId ?? null,
      sessionKey: sessionKey ?? null,
      approvalDecision,
    };
    const response = await runViaMacAppExecHost({ approvals, request: execRequest });
    if (!response) {
      if (execHostEnforced || !execHostFallbackAllowed) {
        await sendNodeEvent(
          client,
          "exec.denied",
          buildExecEventPayload({
            sessionKey,
            runId,
            host: "node",
            command: cmdText,
            reason: "companion-unavailable",
          }),
        );
        await sendInvokeResult(client, frame, {
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "COMPANION_APP_UNAVAILABLE: macOS app exec host unreachable",
          },
        });
        return;
      }
    } else if (!response.ok) {
      const reason = response.error.reason ?? "approval-required";
      await sendNodeEvent(
        client,
        "exec.denied",
        buildExecEventPayload({
          sessionKey,
          runId,
          host: "node",
          command: cmdText,
          reason,
        }),
      );
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "UNAVAILABLE", message: response.error.message },
      });
      return;
    } else {
      const result: ExecHostRunResult = response.payload;
      const combined = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");
      await sendNodeEvent(
        client,
        "exec.finished",
        buildExecEventPayload({
          sessionKey,
          runId,
          host: "node",
          command: cmdText,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          success: result.success,
          output: combined,
        }),
      );
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify(result),
      });
      return;
    }
  }

  if (security === "deny") {
    await sendNodeEvent(
      client,
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "security=deny",
      }),
    );
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DISABLED: security=deny" },
    });
    return;
  }

  const requiresAsk = requiresExecApproval({
    ask,
    security,
    analysisOk,
    allowlistSatisfied,
  });

  const approvalDecision =
    params.approvalDecision === "allow-once" || params.approvalDecision === "allow-always"
      ? params.approvalDecision
      : null;
  const approvedByAsk = approvalDecision !== null || params.approved === true;
  if (requiresAsk && !approvedByAsk) {
    await sendNodeEvent(
      client,
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "approval-required",
      }),
    );
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
    });
    return;
  }
  if (approvalDecision === "allow-always" && security === "allowlist") {
    if (analysisOk) {
      for (const segment of segments) {
        const pattern = segment.resolution?.resolvedPath ?? "";
        if (pattern) {
          addAllowlistEntry(approvals.file, agentId, pattern);
        }
      }
    }
  }

  if (security === "allowlist" && (!analysisOk || !allowlistSatisfied) && !approvedByAsk) {
    await sendNodeEvent(
      client,
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "allowlist-miss",
      }),
    );
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: allowlist miss" },
    });
    return;
  }

  if (allowlistMatches.length > 0) {
    const seen = new Set<string>();
    for (const match of allowlistMatches) {
      if (!match?.pattern || seen.has(match.pattern)) {
        continue;
      }
      seen.add(match.pattern);
      recordAllowlistUse(
        approvals.file,
        agentId,
        match,
        cmdText,
        segments[0]?.resolution?.resolvedPath,
      );
    }
  }

  if (params.needsScreenRecording === true) {
    await sendNodeEvent(
      client,
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "permission:screenRecording",
      }),
    );
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "PERMISSION_MISSING: screenRecording" },
    });
    return;
  }

  let execArgv = argv;
  if (
    security === "allowlist" &&
    isWindows &&
    !approvedByAsk &&
    rawCommand &&
    analysisOk &&
    allowlistSatisfied &&
    segments.length === 1 &&
    segments[0]?.argv.length > 0
  ) {
    // Avoid cmd.exe in allowlist mode on Windows; run the parsed argv directly.
    execArgv = segments[0].argv;
  }

  const result = await runCommand(
    execArgv,
    params.cwd?.trim() || undefined,
    env,
    params.timeoutMs ?? undefined,
  );
  if (result.truncated) {
    const suffix = "... (truncated)";
    if (result.stderr.trim().length > 0) {
      result.stderr = `${result.stderr}\n${suffix}`;
    } else {
      result.stdout = `${result.stdout}\n${suffix}`;
    }
  }
  const combined = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");
  await sendNodeEvent(
    client,
    "exec.finished",
    buildExecEventPayload({
      sessionKey,
      runId,
      host: "node",
      command: cmdText,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      success: result.success,
      output: combined,
    }),
  );

  await sendInvokeResult(client, frame, {
    ok: true,
    payloadJSON: JSON.stringify({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ?? null,
    }),
  });
}

function decodeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  return JSON.parse(raw) as T;
}

function coerceNodeInvokePayload(payload: unknown): NodeInvokeRequestPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const nodeId = typeof obj.nodeId === "string" ? obj.nodeId.trim() : "";
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!id || !nodeId || !command) {
    return null;
  }
  const paramsJSON =
    typeof obj.paramsJSON === "string"
      ? obj.paramsJSON
      : obj.params !== undefined
        ? JSON.stringify(obj.params)
        : null;
  const timeoutMs = typeof obj.timeoutMs === "number" ? obj.timeoutMs : null;
  const idempotencyKey = typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : null;
  return {
    id,
    nodeId,
    command,
    paramsJSON,
    timeoutMs,
    idempotencyKey,
  };
}

async function sendInvokeResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  },
) {
  try {
    await client.request("node.invoke.result", buildNodeInvokeResultParams(frame, result));
  } catch {
    // ignore: node invoke responses are best-effort
  }
}

export function buildNodeInvokeResultParams(
  frame: NodeInvokeRequestPayload,
  result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  },
): {
  id: string;
  nodeId: string;
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
} {
  const params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string;
    error?: { code?: string; message?: string };
  } = {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: result.ok,
  };
  if (result.payload !== undefined) {
    params.payload = result.payload;
  }
  if (typeof result.payloadJSON === "string") {
    params.payloadJSON = result.payloadJSON;
  }
  if (result.error) {
    params.error = result.error;
  }
  return params;
}

async function sendNodeEvent(client: GatewayClient, event: string, payload: unknown) {
  try {
    await client.request("node.event", {
      event,
      payloadJSON: payload ? JSON.stringify(payload) : null,
    });
  } catch {
    // ignore: node events are best-effort
  }
}
