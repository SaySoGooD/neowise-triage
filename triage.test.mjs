import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./server.mjs";
import { parseModelOutput, triage, FailureReason, MODEL_TIMEOUT_MS } from "./triage.mjs";

function withLimit(promise, message, ms = 2_000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function waitFor(check) {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
  return true;
}

let server;
let baseUrl;
const logs = [];

before(async () => {
  server = createApp({ log: (entry) => logs.push(entry) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function post(body, raw = false) {
  const reply = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() };
}

const MANUAL = { status: "manual_review", topic: null, draft: null };

test("корректная заявка: тема и черновик", async () => {
  const { status, body } = await post({ text: "Когда будет доставка?" });
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.ok(body.draft.trim().length > 0);
});

for (const [name, body] of [
  ["пустая строка", { text: "" }],
  ["только пробелы", { text: "   " }],
  ["нет поля text", {}],
  ["text не строка", { text: 42 }],
  ["null вместо объекта", null],
]) {
  test(`неверный ввод: ${name} → 400`, async () => {
    const reply = await post(body);
    assert.equal(reply.status, 400);
    assert.deepEqual(reply.body, { status: "invalid_input" });
  });
}

test("битый JSON в запросе → 400", async () => {
  const reply = await post("{text:", true);
  assert.equal(reply.status, 400);
  assert.deepEqual(reply.body, { status: "invalid_input" });
});

for (const tag of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${tag} → manual_review`, async () => {
    const reply = await post({ text: `Вопрос по цене ${tag}` });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, MANUAL);
  });
}

test("таймаут модели: ответ manual_review не позже ~300 мс", async () => {
  const started = Date.now();
  const reply = await post({ text: "Где мой заказ? [timeout]" });
  const elapsed = Date.now() - started;
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, MANUAL);
  assert.ok(elapsed < 600, `ждали ${elapsed} мс, имитатор отвечает за 1200 мс`);
});

test("проверка ответа AI называет причину сбоя", () => {
  assert.equal(parseModelOutput("not json").reason, FailureReason.NOT_JSON);
  assert.equal(parseModelOutput("null").reason, FailureReason.NOT_JSON);
  assert.equal(parseModelOutput('{"topic":"refund","draft":"ok"}').reason, FailureReason.BAD_TOPIC);
  assert.equal(parseModelOutput('{"topic":"other","draft":"  "}').reason, FailureReason.EMPTY_DRAFT);
  assert.deepEqual(parseModelOutput('{"topic":"other","draft":" Да "}'), { ok: true, topic: "other", draft: "Да" });
});

test("CSRF: POST с чужого сайта отклоняется", async () => {
  const reply = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: JSON.stringify({ text: "Цена?" }),
  });
  assert.equal(reply.status, 403);
});

test("LFI: файлы проекта по пути не отдаются", async () => {
  for (const path of ["/server.mjs", "/../server.mjs", "/%2e%2e/server.mjs", "/mock-ai.mjs"]) {
    const reply = await fetch(`${baseUrl}${path}`);
    assert.equal(reply.status, 404, path);
  }
});

test("ответы содержат защитные заголовки", async () => {
  const reply = await fetch(`${baseUrl}/api/triage`, { method: "POST", body: "{}" });
  assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
  assert.match(reply.headers.get("content-security-policy"), /default-src 'self'/);
});

test("логи пишут причину сбоя, но не текст заявки", async () => {
  const secret = "Паспорт 1234 567890 [bad-topic]";
  await post({ text: secret });
  const entry = logs.findLast((e) => e.event === "triage_done");
  assert.equal(entry.status, "manual_review");
  assert.equal(entry.reason, FailureReason.BAD_TOPIC);
  assert.ok(!JSON.stringify(logs).includes("1234 567890"));
});

test("таймаут держится, даже если модель игнорирует signal", async () => {
  const slow = createApp({ classifyFn: () => new Promise(() => {}), timeoutMs: 50, log: () => {} });
  await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
  try {
    const reply = await fetch(`http://127.0.0.1:${slow.address().port}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Привет" }),
    });
    assert.deepEqual(await reply.json(), MANUAL);
  } finally {
    await new Promise((resolve) => slow.close(resolve));
  }
});

test("клиент отменил запрос: вызов модели тоже отменяется", async () => {
  const cancelLogs = [];
  let markStarted;
  let markAborted;
  const modelStarted = new Promise((resolve) => { markStarted = resolve; });
  const modelAborted = new Promise((resolve) => { markAborted = resolve; });
  const app = createApp({
    classifyFn: (_text, { signal }) => {
      signal.addEventListener("abort", () => markAborted(true), { once: true });
      markStarted();
      return new Promise(() => {});
    },
    timeoutMs: 5_000,
    log: (entry) => cancelLogs.push(entry),
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const client = new AbortController();
    const pending = fetch(`http://127.0.0.1:${app.address().port}/api/triage`, {
      method: "POST",
      body: JSON.stringify({ text: "Привет" }),
      signal: client.signal,
    }).catch(() => {});
    await withLimit(modelStarted, "модель не была вызвана");
    client.abort();
    await pending;
    assert.equal(await withLimit(modelAborted, "вызов модели не отменён"), true);
    await withLimit(waitFor(() => cancelLogs.some((e) => e.event === "triage_cancelled")), "нет записи triage_cancelled");
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test("триаж ждёт модель ровно столько, сколько задано", async () => {
  const started = Date.now();
  const { response, reason } = await triage("Привет", { classifyFn: () => new Promise(() => {}), timeoutMs: MODEL_TIMEOUT_MS });
  const elapsed = Date.now() - started;
  assert.equal(MODEL_TIMEOUT_MS, 300);
  assert.equal(response.status, "manual_review");
  assert.equal(reason, FailureReason.TIMEOUT);
  assert.ok(elapsed >= 290 && elapsed < 450, `ждали ${elapsed} мс`);
});

test("таймаут записывается как model_timeout, даже если модель сразу падает при отмене", async () => {
  const classifyFn = (_text, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
  });
  const { reason } = await triage("Привет", { classifyFn, timeoutMs: 20 });
  assert.equal(reason, FailureReason.TIMEOUT);
});

test("Origin с другим протоколом или портом отклоняется", async () => {
  const port = new URL(baseUrl).port;
  for (const origin of [`https://127.0.0.1:${port}`, `http://127.0.0.1:1`]) {
    const reply = await fetch(`${baseUrl}/api/triage`, {
      method: "POST",
      headers: { Origin: origin },
      body: JSON.stringify({ text: "Цена?" }),
    });
    assert.equal(reply.status, 403, origin);
  }
});

test("DNS rebinding: чужой Host отклоняется", async () => {
  const { request } = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/api/triage`, { method: "POST", headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end(JSON.stringify({ text: "Цена?" }));
  });
  assert.equal(status, 421);
});
