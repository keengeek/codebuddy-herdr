#!/usr/bin/env node
/**
 * Report CodeBuddy hook events to Herdr's local socket API.
 *
 * This file is compiled to bin/herdr-report.js before publishing.  Keeping the
 * runnable JavaScript in the package means hooks do not need ts-node or tsx.
 */

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const SOURCE = "codebuddy";
const AGENT = "CodeBuddy";
const RESUME_BIN = "codebuddy";
const SOCKET_TIMEOUT_MS = 500;
const SEQ_LOCK_TIMEOUT_MS = 450;
const SEQ_LOCK_RETRY_MS = 2;
const SEQ_LOCK_STALE_MS = 5_000;

type AgentState = "idle" | "working" | "blocked";

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  notification_type?: unknown;
  message?: unknown;
}

interface AgentParams {
  pane_id: string;
  source: typeof SOURCE;
  agent: typeof AGENT;
  state?: AgentState;
  seq: bigint;
  message?: string;
  agent_session_id?: string;
  resume_argv?: string[];
  agent_session_path?: string;
}

function counterPath(): string {
  const pane = process.env.HERDR_PANE_ID ?? "none";
  // Pane IDs normally only contain ':' as punctuation.  Keeping the filename
  // conservative also ensures an unexpected ID cannot escape TMPDIR.
  const safePane = pane.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(process.env.TMPDIR || tmpdir(), `herdr-codebuddy-seq-${safePane}`);
}

/** Short synchronous sleep, so hooks stay inside their tight time budget. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Node core exposes no flock(2) and macOS ships no flock(1) utility, so the
 * counter file is guarded by an O_EXCL lock file instead.  The lock is held for
 * two synchronous file operations only, so a bounded retry loop is enough.  A
 * lock older than SEQ_LOCK_STALE_MS is treated as left behind by a crash.
 */
function acquireLock(lockPath: string): number | undefined {
  const deadline = Date.now() + SEQ_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > SEQ_LOCK_STALE_MS) unlinkSync(lockPath);
    } catch {
      // The holder released the lock in the meantime; just retry.
    }
    if (Date.now() >= deadline) return undefined;
    sleepSync(SEQ_LOCK_RETRY_MS);
  }
}

function releaseLock(descriptor: number, lockPath: string): void {
  try {
    closeSync(descriptor);
  } catch {
    // Closing a lock file must never break the hook.
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Another process may have already removed a stale lock.
  }
}

function nextSeq(): bigint | undefined {
  // Date.now supplies the wall-clock nanosecond base; the monotonic clock's
  // sub-millisecond part avoids most same-millisecond collisions. The locked
  // persisted counter handles the remaining cases and clock rollback.
  const base = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  const path = counterPath();
  const lockPath = `${path}.lock`;

  // A lock we cannot take drops this report instead of risking an
  // out-of-order sequence, which Herdr would ignore anyway.
  const descriptor = acquireLock(lockPath);
  if (descriptor === undefined) return undefined;
  try {
    let last = 0n;
    try {
      const lastText = readFileSync(path, "utf8").trim();
      if (/^\d+$/.test(lastText)) last = BigInt(lastText);
    } catch {
      // First report for this pane: the counter file does not exist yet.
    }
    const next = base > last ? base : last + 1n;
    writeFileSync(path, next.toString(), "utf8");
    return next;
  } catch {
    return undefined;
  } finally {
    releaseLock(descriptor, lockPath);
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Herdr exposes its API as a Unix domain socket on macOS/Linux and as a named
 * pipe on Windows.  Windows reports the pipe name without the `\\.\pipe\`
 * prefix, so add it back unless the path already carries it.
 */
function socketEndpoint(socketPath: string): string {
  if (process.platform !== "win32") return socketPath;
  return socketPath.startsWith("\\\\.\\pipe\\") ? socketPath : `\\\\.\\pipe\\${socketPath}`;
}

async function readHook(): Promise<HookPayload> {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += String(chunk);
    if (!raw.trim()) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as HookPayload)
      : {};
  } catch {
    return {};
  }
}

function requestJson(method: string, params: AgentParams): string {
  // JSON.stringify cannot encode bigint. Serialize seq separately so it stays
  // a JSON number (not a rounded JS Number or a string).
  const { seq, ...otherParams } = params;
  const paramsWithoutSeq = JSON.stringify(otherParams);
  const paramsJson = `${paramsWithoutSeq.slice(0, -1)},"seq":${seq.toString()}}`;
  return `${JSON.stringify({
    id: `${SOURCE}:${Date.now()}:${process.pid}`,
    method,
  }).slice(0, -1)},"params":${paramsJson}}\n`;
}

async function send(method: string, params: AgentParams): Promise<void> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) return;

  const payload = requestJson(method, params);
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve();
    };
    const client = net.createConnection({ path: socketEndpoint(socketPath) });
    client.setTimeout(SOCKET_TIMEOUT_MS, finish);
    client.once("error", finish);
    // Herdr sends a small acknowledgement. Waiting for it (or EOF) avoids
    // resetting the connection while the server is still writing the reply.
    client.once("data", finish);
    client.once("end", finish);
    client.once("close", finish);
    client.once("connect", () => client.end(payload));
  });
}

async function reportState(pane: string, state: AgentState, message?: string): Promise<void> {
  const seq = nextSeq();
  if (seq === undefined) return;
  await send("pane.report_agent", {
    pane_id: pane,
    source: SOURCE,
    agent: AGENT,
    state,
    seq,
    ...(message ? { message } : {}),
  });
}

async function main(): Promise<void> {
  if (process.env.HERDR_ENV !== "1") return;
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) return;

  const hook = await readHook();
  const event = asString(hook.hook_event_name);

  if (event === "SessionStart") {
    const seq = nextSeq();
    if (seq === undefined) return;
    const sessionId = asString(hook.session_id);
    const transcript = asString(hook.transcript_path);
    await send("pane.report_agent", {
      pane_id: pane,
      source: SOURCE,
      agent: AGENT,
      state: "idle",
      seq,
      ...(sessionId
        ? { agent_session_id: sessionId, resume_argv: [RESUME_BIN, "--resume", sessionId] }
        : {}),
      ...(transcript ? { agent_session_path: transcript } : {}),
    });
    return;
  }

  if (event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse") {
    await reportState(pane, "working");
    return;
  }
  if (event === "Stop") {
    await reportState(pane, "idle");
    return;
  }
  if (event === "Notification") {
    const notificationType = asString(hook.notification_type).toLowerCase();
    if (notificationType === "idle_prompt") {
      // idle_prompt means the agent finished and awaits the user's next input;
      // it is not blocked. Report idle, else the "prompt" substring below would
      // misclassify a finished turn as blocked (a sticky wrong state).
      await reportState(pane, "idle");
    } else if (/(permission|prompt|decision)/.test(notificationType)) {
      await reportState(pane, "blocked", asString(hook.message) || "needs input");
    }
    return;
  }
  if (event === "SessionEnd") {
    const seq = nextSeq();
    if (seq === undefined) return;
    await send("pane.release_agent", { pane_id: pane, source: SOURCE, agent: AGENT, seq });
  }
}

main().catch(() => {
  // Hook failures must never affect a CodeBuddy session.
});
