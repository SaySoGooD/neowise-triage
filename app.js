const TOPIC_LABELS = { delivery: "Доставка", pricing: "Цены", other: "Другое" };
const MESSAGES = {
  empty: "Введите текст заявки.",
  loading: "Разбираем заявку…",
  manual: "AI не справился с этой заявкой. Разберите её вручную: определите тему и напишите ответ сами.",
};

const form = document.querySelector("form");
const messageInput = document.querySelector("#message");
const resultArea = document.querySelector("#result");
let latestRequestId = 0;

function element(tag, text, className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render(...nodes) {
  resultArea.replaceChildren(...nodes);
}

function renderNotice(text, kind = "") {
  render(element("p", text, `notice ${kind}`.trim()));
}

function renderReady({ topic, draft }) {
  render(
    element("p", `Тема: ${TOPIC_LABELS[topic] ?? topic}`),
    element("p", "Черновик ответа (проверьте перед отправкой):"),
    element("div", draft, "draft"),
  );
}

async function requestTriage(text) {
  try {
    const reply = await fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return await reply.json();
  } catch {
    return { status: "manual_review" };
  }
}

function renderResult(data) {
  if (data.status === "ready") return renderReady(data);
  if (data.status === "invalid_input") return renderNotice(MESSAGES.empty, "error");
  renderNotice(MESSAGES.manual);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value;
  render();
  if (text.trim() === "") return renderNotice(MESSAGES.empty, "error");

  const requestId = ++latestRequestId;
  renderNotice(MESSAGES.loading);
  const data = await requestTriage(text);
  if (requestId === latestRequestId) renderResult(data);
});
