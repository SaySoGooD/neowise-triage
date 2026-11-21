const TOPIC_LABELS = { delivery: "Доставка", pricing: "Цены", other: "Другое" };
const MESSAGES = {
  empty: "Введите текст заявки.",
  loading: "Разбираем заявку…",
  manual: "AI не справился с этой заявкой. Выберите тему и напишите ответ сами.",
  copied: "Ответ скопирован.",
};

const form = document.querySelector("form");
const messageInput = document.querySelector("#message");
const resultArea = document.querySelector("#result");
let currentRequest = null;

function element(tag, text = "", className = "") {
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

function topicSelect() {
  const select = element("select");
  select.id = "manual-topic";
  select.append(element("option", "Выберите тему"));
  select.firstChild.value = "";
  for (const [value, label] of Object.entries(TOPIC_LABELS)) {
    const option = element("option", label);
    option.value = value;
    select.append(option);
  }
  return select;
}

function copyButton(source, status) {
  const button = element("button", "Скопировать ответ");
  button.type = "button";
  button.addEventListener("click", async () => {
    if (source.value.trim() === "") return;
    await navigator.clipboard.writeText(source.value);
    status.textContent = MESSAGES.copied;
  });
  return button;
}

function renderManualReview() {
  const select = topicSelect();
  const answer = element("textarea");
  answer.id = "manual-answer";
  answer.rows = 4;
  answer.placeholder = "Ответ клиенту";
  const status = element("span", "", "hint");
  const topicLabel = element("label", "Тема");
  topicLabel.htmlFor = select.id;
  const answerLabel = element("label", "Ответ");
  answerLabel.htmlFor = answer.id;
  render(
    element("p", MESSAGES.manual, "notice"),
    topicLabel, select,
    answerLabel, answer,
    copyButton(answer, status), status,
  );
}

async function requestTriage(text, signal) {
  try {
    const reply = await fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    return await reply.json();
  } catch (error) {
    if (error.name === "AbortError") return null;
    return { status: "manual_review" };
  }
}

function renderResult(data) {
  if (data.status === "ready") return renderReady(data);
  if (data.status === "invalid_input") return renderNotice(MESSAGES.empty, "error");
  renderManualReview();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  currentRequest?.abort();
  currentRequest = null;
  const text = messageInput.value;
  render();
  if (text.trim() === "") return renderNotice(MESSAGES.empty, "error");

  const request = new AbortController();
  currentRequest = request;
  renderNotice(MESSAGES.loading);
  const data = await requestTriage(text, request.signal);
  if (data && currentRequest === request) renderResult(data);
});
