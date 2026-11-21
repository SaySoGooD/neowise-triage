import { classify } from "./mock-ai.mjs";

export const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;

export const FailureReason = Object.freeze({
  TIMEOUT: "model_timeout",
  MODEL_ERROR: "model_error",
  NOT_JSON: "not_json",
  BAD_TOPIC: "bad_topic",
  EMPTY_DRAFT: "empty_draft",
});

class ModelTimeout extends Error {}

export function isValidText(text) {
  return typeof text === "string" && text.trim() !== "";
}

async function callModelWithTimeout(text, classifyFn, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelTimeout());
    }, timeoutMs);
  });
  try {
    return await Promise.race([classifyFn(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function parseModelOutput(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: FailureReason.NOT_JSON };
  }
  if (!data || typeof data !== "object") return { ok: false, reason: FailureReason.NOT_JSON };
  if (!ALLOWED_TOPICS.has(data.topic)) return { ok: false, reason: FailureReason.BAD_TOPIC };
  if (!isValidText(data.draft)) return { ok: false, reason: FailureReason.EMPTY_DRAFT };
  return { ok: true, topic: data.topic, draft: data.draft.trim() };
}

function manualReview(reason) {
  return { response: { status: "manual_review", topic: null, draft: null }, reason };
}

export async function triage(text, { classifyFn = classify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  let raw;
  try {
    raw = await callModelWithTimeout(text, classifyFn, timeoutMs);
  } catch (error) {
    return manualReview(error instanceof ModelTimeout ? FailureReason.TIMEOUT : FailureReason.MODEL_ERROR);
  }
  const parsed = parseModelOutput(raw);
  if (!parsed.ok) return manualReview(parsed.reason);
  return { response: { status: "ready", topic: parsed.topic, draft: parsed.draft }, reason: null };
}
