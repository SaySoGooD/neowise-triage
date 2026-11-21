import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./server.mjs";
import { parseModelOutput, FailureReason } from "./triage.mjs";

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
  assert.ok(elapsed < 800, `ждали ${elapsed} мс, имитатор отвечает за 1200 мс`);
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
