import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classify } from "./mock-ai.mjs";
import { triage, isValidText, MODEL_TIMEOUT_MS, TriageCancelled } from "./triage.mjs";

const MAX_BODY_BYTES = 64 * 1024;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class InvalidInput extends Error {}

const defaultLogger = (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

function send(response, status, contentType, body) {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": contentType });
  response.end(body);
}

function sendJson(response, status, body) {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function isForeignOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.host;
  } catch {
    return true;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInput("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readTriageText(request) {
  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    if (error instanceof InvalidInput) throw error;
    throw new InvalidInput("broken_json");
  }
  if (!isValidText(body?.text)) throw new InvalidInput("invalid_text");
  return body.text;
}

async function handleTriage(request, response, { classifyFn, timeoutMs, log }) {
  if (isForeignOrigin(request)) {
    log({ event: "triage_rejected", reason: "foreign_origin" });
    return sendJson(response, 403, { status: "forbidden" });
  }
  let text;
  try {
    text = await readTriageText(request);
  } catch (error) {
    if (!(error instanceof InvalidInput)) throw error;
    log({ event: "triage_invalid_input", reason: error.message });
    return sendJson(response, 400, { status: "invalid_input" });
  }
  const clientGone = new AbortController();
  response.on("close", () => {
    if (!response.writableFinished) clientGone.abort();
  });
  const started = Date.now();
  let outcome;
  try {
    outcome = await triage(text, { classifyFn, timeoutMs, signal: clientGone.signal });
  } catch (error) {
    if (!(error instanceof TriageCancelled)) throw error;
    log({ event: "triage_cancelled", durationMs: Date.now() - started });
    return;
  }
  const { response: result, reason } = outcome;
  log({ event: "triage_done", status: result.status, reason, durationMs: Date.now() - started, textLength: text.length });
  sendJson(response, 200, result);
}

export function createApp({ classifyFn = classify, timeoutMs = MODEL_TIMEOUT_MS, pages = {}, log = defaultLogger } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const page = request.method === "GET" ? pages[request.url] : undefined;
      if (page) return send(response, 200, page.type, page.body);
      if (request.method === "POST" && request.url === "/api/triage") {
        return await handleTriage(request, response, { classifyFn, timeoutMs, log });
      }
      sendJson(response, 404, { status: "not_found" });
    } catch (error) {
      log({ event: "server_error", error: error.message });
      if (!response.headersSent) sendJson(response, 500, { status: "server_error" });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}

async function loadPages() {
  const read = (name) => readFile(new URL(name, import.meta.url));
  return {
    "/": { type: "text/html; charset=utf-8", body: await read("./index.html") },
    "/app.js": { type: "text/javascript; charset=utf-8", body: await read("./app.js") },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3000);
  createApp({ pages: await loadPages() }).listen(port, "127.0.0.1", () => {
    console.log(`http://127.0.0.1:${port}`);
  });
}
