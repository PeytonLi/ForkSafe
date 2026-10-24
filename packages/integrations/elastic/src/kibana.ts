export type KibanaErrorCode = "auth" | "not_found" | "conflict" | "bad_request" | "server" | "transport" | "timeout" | "invalid_response";

/** Typed Kibana failure. Messages never carry credentials, URLs or raw response bodies. */
export class KibanaError extends Error {
  constructor(readonly code: KibanaErrorCode, readonly status: number | undefined, message: string) {
    super(message);
    this.name = "KibanaError";
  }
}

export interface KibanaResponse<T = unknown> { status: number; data: T }

export function classifyKibanaStatus(status: number): KibanaErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "bad_request";
  return "server";
}

/** Minimal Kibana HTTP client for Agent Builder. Fails closed without URL or API key. */
export class KibanaClient {
  private base: string;
  constructor(url: string | undefined, private apiKey: string | undefined, private fetcher: typeof fetch = fetch, private timeoutMs = 30_000) {
    if (!url?.trim() || !apiKey?.trim()) throw new KibanaError("auth", undefined, "Kibana URL and API key are required");
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new KibanaError("bad_request", undefined, "Kibana URL is invalid"); }
    if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
      throw new KibanaError("bad_request", undefined, "Kibana URL must use https");
    }
    this.base = url.replace(/\/+$/, "");
  }

  async request<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, options: { timeoutMs?: number; allow404?: boolean } = {}): Promise<KibanaResponse<T | undefined>> {
    if (!path.startsWith("/api/agent_builder/")) throw new KibanaError("bad_request", undefined, "Only Agent Builder endpoints are allowed");
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: { Authorization: `ApiKey ${this.apiKey}`, "kbn-xsrf": "true", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new KibanaError("timeout", undefined, `Kibana ${method} ${path} timed out`);
      throw new KibanaError("transport", undefined, `Kibana ${method} ${path} failed to connect`);
    }
    if (response.status === 404 && options.allow404) return { status: 404, data: undefined };
    if (!response.ok) throw new KibanaError(classifyKibanaStatus(response.status), response.status, `Kibana ${method} ${path} returned HTTP ${response.status}`);
    const text = await response.text();
    if (!text) return { status: response.status, data: undefined };
    try { return { status: response.status, data: JSON.parse(text) as T }; }
    catch { throw new KibanaError("invalid_response", response.status, `Kibana ${method} ${path} returned non-JSON`); }
  }
}
