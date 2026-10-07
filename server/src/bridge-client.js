import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// After Effects writes its log to ExtendScript's Folder.temp. That is usually
// os.tmpdir(), but on macOS it may be the TemporaryItems subfolder of it
// (unverified), so point at whichever candidate actually exists.
const LOG_NAME = "claude-ae-bridge.log";
function logHint() {
  const candidates = [
    path.join(os.tmpdir(), LOG_NAME),
    path.join(os.tmpdir(), "TemporaryItems", LOG_NAME),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  return found || candidates.join(" or ");
}

const HOST = "127.0.0.1";
const PORT = 41890;
const CALL_TIMEOUT_MS = 15000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;

// Temporary diagnostic verbosity — prints to stderr so it doesn't pollute
// MCP stdio. Set to true to debug connection issues.
const DEBUG = false;
function dbg(...args) {
  if (DEBUG) console.error("[bridge-client]", new Date().toISOString(), ...args);
}

export class BridgeClient {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.buffer = "";
    this.pending = new Map();
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.started = false;
  }

  // Kicks off a persistent background connect/reconnect loop. Safe to call
  // more than once. Does NOT wait for a connection — call() fails fast
  // instead if one isn't up yet, rather than hanging.
  start() {
    if (this.started) return;
    this.started = true;
    this._attemptConnect();
  }

  _attemptConnect() {
    if (this.connecting || this.connected) return;
    this.connecting = true;
    dbg("connecting to", HOST + ":" + PORT, "local port will be assigned by OS");
    const socket = net.createConnection({ host: HOST, port: PORT }, () => {
      this.connected = true;
      this.connecting = false;
      this.reconnectDelay = RECONNECT_BASE_MS;
      dbg("connected, localPort=", socket.localPort);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      dbg("raw data received (" + chunk.length + " chars):", JSON.stringify(chunk));
      this._onData(chunk);
    });
    socket.on("error", (err) => {
      dbg("socket error:", err.message);
      // "close" fires right after and does the actual bookkeeping/retry.
    });
    socket.on("close", (hadError) => {
      dbg("socket closed, hadError=", hadError, "wasConnected=", this.connected);
      const wasConnected = this.connected;
      this.connected = false;
      this.connecting = false;
      this.socket = null;
      this.buffer = "";
      if (wasConnected) this._rejectAllPending(new Error("AE bridge disconnected"));
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      setTimeout(() => this._attemptConnect(), delay);
    });
    this.socket = socket;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        // Always surface this (stderr, so MCP stdio stays clean): a dropped
        // response otherwise shows up only as a 60s timeout.
        console.error("[ae-bridge] unparseable line from AE (" + line.length + " chars): " + line.slice(0, 120));
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) {
        dbg("received response for unknown/unmatched id:", msg.id, "pending ids:", [...this.pending.keys()]);
        continue;
      }
      dbg("matched response for id=" + msg.id, "ok=" + msg.ok);
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error?.message || "Unknown AE bridge error"));
    }
  }

  _rejectAllPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // Bounded wait for an in-flight connection attempt to land, so the very
  // first call after startup doesn't fail just because connect() hadn't
  // finished yet. Polls the flag rather than tracking one socket's events,
  // since the underlying socket gets replaced across reconnects.
  _waitForConnection(timeoutMs) {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (this.connected) return resolve();
        if (Date.now() >= deadline) return reject(new Error("timed out waiting to connect"));
        setTimeout(check, 50);
      };
      check();
    });
  }

  async call(op, args, opts = {}) {
    this.start();
    if (!this.connected) {
      await this._waitForConnection(3000).catch(() => {});
    }
    if (!this.connected || !this.socket) {
      throw new Error(
        "AE bridge not connected — make sure After Effects is running with claude-bridge.jsx loaded " +
        `(check ${logHint()} for its startup log).`
      );
    }
    const timeoutMs = opts.timeoutMs || CALL_TIMEOUT_MS;
    const id = randomUUID();
    const payload = JSON.stringify({ id, op, args: args || {} }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        dbg("TIMEOUT for id=" + id, "op=" + op, "still-pending=", [...this.pending.keys()]);
        reject(new Error(`Timed out waiting for AE to respond to '${op}' after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      dbg("writing request id=" + id, "op=" + op, "bytes=" + payload.length);
      this.socket.write(payload, (err) => {
        if (err) dbg("write callback error for id=" + id + ":", err.message);
        else dbg("write callback OK (flushed to OS) for id=" + id);
      });
    });
  }
}
