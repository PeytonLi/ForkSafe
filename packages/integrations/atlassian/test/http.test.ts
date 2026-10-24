import { describe, expect, it } from "vitest";
import { basicAuthTransport } from "../src/http.js";

describe("basicAuthTransport", () => {
  it("sends Basic auth and JSON headers to a normalized site URL", async () => {
    let requestUrl = "";
    let requestHeaders: HeadersInit | undefined;
    const transport = basicAuthTransport({
      siteUrl: "https://example.atlassian.net///",
      email: "reviewer@example.test",
      apiToken: "token-value",
      fetch: (async (input, init) => {
        requestUrl = String(input);
        requestHeaders = init?.headers;
        return new Response('{"accountId":"account-1"}', { status: 200 });
      }) as typeof fetch,
    });
    const response = await transport({ method: "GET", path: "/rest/api/3/myself" });
    expect(requestUrl).toBe("https://example.atlassian.net/rest/api/3/myself");
    expect(new Headers(requestHeaders).get("Authorization")).toBe(
      `Basic ${btoa("reviewer@example.test:token-value")}`,
    );
    expect(new Headers(requestHeaders).get("Accept")).toBe("application/json");
    expect(response.body).toEqual({ accountId: "account-1" });
  });

  it("redacts token, encoded credentials, and email from errors", async () => {
    const email = "reviewer@example.test";
    const token = "sensitive-api-token";
    const basic = btoa(`${email}:${token}`);
    const transport = basicAuthTransport({
      siteUrl: "https://example.atlassian.net",
      email,
      apiToken: token,
      fetch: (async () =>
        new Response(`echo ${token} ${basic} ${email}`, { status: 401 })) as typeof fetch,
    });
    let error: Error | undefined;
    try {
      await transport({ method: "GET", path: "/rest/api/3/myself" });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).not.toContain(token);
    expect(error!.message).not.toContain(basic);
    expect(error!.message).not.toContain(email);
    expect(JSON.stringify(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(basic);
    expect(JSON.stringify(error)).not.toContain(email);
  });

  it("sanitizes fetch failures even when the underlying error echoes credentials", async () => {
    const email = "private@example.test";
    const token = "private-token";
    const basic = btoa(`${email}:${token}`);
    const transport = basicAuthTransport({
      siteUrl: "https://example.atlassian.net",
      email,
      apiToken: token,
      fetch: (async () => {
        throw new Error(`${email} ${token} ${basic}`);
      }) as typeof fetch,
    });
    await expect(transport({ method: "POST", path: "/rest/api/3/issue" })).rejects.toThrow("request failed");
    let error: Error | undefined;
    try {
      await transport({ method: "POST", path: `/rest/api/3/issue/${email}?token=${token}` });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).not.toContain(email);
    expect(error?.message).not.toContain(token);
    expect(error?.message).not.toContain(basic);
  });
});
