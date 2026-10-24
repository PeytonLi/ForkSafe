export type AtlassianTransport = (req: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}) => Promise<{ status: number; body: unknown }>;

export class AtlassianHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Atlassian ${method} ${path} failed with HTTP ${status}: ${detail}`);
    this.name = "AtlassianHttpError";
  }
}

export function redact(text: string, values: string[]): string {
  return values
    .filter((value) => value.length > 0)
    .reduce(
      (result, value) => result.split(value).join("[REDACTED]"),
      text,
    );
}

export function basicAuthTransport({
  siteUrl,
  email,
  apiToken,
  fetch: fetchImpl = globalThis.fetch,
}: {
  siteUrl: string;
  email: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
}): AtlassianTransport {
  const baseUrl = siteUrl.replace(/\/+$/, "");
  const basicHeaderValue = btoa(`${email}:${apiToken}`);
  const authorization = `Basic ${basicHeaderValue}`;

  return async ({ method, path, body }) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = response.status === 204 ? "" : await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const detail = redact(text.slice(0, 500), [
        apiToken,
        basicHeaderValue,
        email,
      ]);
      throw new AtlassianHttpError(response.status, method, path, detail);
    }
    return { status: response.status, body: parsed };
  };
}
