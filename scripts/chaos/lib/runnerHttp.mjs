import { createHmac } from "node:crypto";
import { redactSecrets, rememberSecret } from "./convex.mjs";

export function sign(secret, timestamp, rawBody) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

function redactJson(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item)]));
  }
  return value;
}

export async function postRunner(siteUrl, credential, endpoint, body) {
  rememberSecret(credential.secret);
  const timestamp = String(Date.now());
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const response = await fetch(`${siteUrl.replace(/\/+$/, "")}/runner/${endpoint.replace(/^\/+/, "")}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forksafe-timestamp": timestamp,
      "x-forksafe-signature": sign(credential.secret, timestamp, rawBody),
      "x-forksafe-runner": credential.credentialId,
    },
    body: rawBody,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { text: redactSecrets(text) };
  }
  return { status: response.status, json: redactJson(json) };
}
