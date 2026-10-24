import { z } from "zod";
import type { AtlassianTransport } from "./http.js";
import { AtlassianHttpError } from "./http.js";

export const RequirementsPage = z.object({
  pageId: z.string().min(1),
  title: z.string(),
  spaceId: z.string(),
  version: z.number().int().nonnegative(),
  versionCreatedAt: z.string(),
  bodyStorage: z.string(),
  webUrl: z.string().url().optional(),
});
export type RequirementsPage = z.infer<typeof RequirementsPage>;

export const RequirementItem = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(["checked_rule", "human_review"]),
  check: z
    .object({
      metric: z.enum([
        "timeoutSec",
        "penetrationLimitM",
        "completionRadiusM",
        "forbiddenContact",
      ]),
      op: z.enum(["<=", "none"]),
      value: z.union([z.number(), z.string()]),
    })
    .optional(),
});
export type RequirementItem = z.infer<typeof RequirementItem>;

export const RequirementSet = z.object({
  source: z.object({
    system: z.literal("confluence"),
    pageId: z.string(),
    version: z.number().int().nonnegative(),
    title: z.string(),
    retrievedAtMs: z.number().int(),
  }),
  items: z.array(RequirementItem),
});
export type RequirementSet = z.infer<typeof RequirementSet>;

export class ConfluenceClient {
  constructor(private readonly transport: AtlassianTransport) {}

  async probe(): Promise<void> {
    const response = await this.transport({
      method: "GET",
      path: "/wiki/api/v2/spaces?limit=1",
    });
    if (response.status < 200 || response.status >= 300) {
      throw new AtlassianHttpError(
        response.status,
        "GET",
        "/wiki/api/v2/spaces?limit=1",
        typeof response.body === "string"
          ? response.body.slice(0, 500)
          : JSON.stringify(response.body).slice(0, 500),
      );
    }
  }

  async getPage(pageId: string): Promise<RequirementsPage> {
    const response = await this.transport({
      method: "GET",
      path: `/wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new AtlassianHttpError(
        response.status,
        "GET",
        `/wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`,
        typeof response.body === "string"
          ? response.body.slice(0, 500)
          : JSON.stringify(response.body).slice(0, 500),
      );
    }
    const page = response.body as {
      id: string;
      title: string;
      spaceId?: string;
      space?: { id?: string };
      version?: { number?: number; createdAt?: string };
      body?: { storage?: { value?: string } };
      _fixture?: string;
      _links?: { webui?: string; base?: string };
    };
    const webUrl = page._links?.webui
      ? /^https?:\/\//i.test(page._links.webui)
        ? page._links.webui
        : page._links.base
          ? new URL(page._links.webui, page._links.base).toString()
          : undefined
      : undefined;
    return RequirementsPage.parse({
      pageId: page.id,
      title: page.title,
      spaceId: page.spaceId ?? page.space?.id,
      version: page.version?.number,
      versionCreatedAt: page.version?.createdAt ?? "",
      bodyStorage: page.body?.storage?.value ?? "",
      ...(webUrl === undefined ? {} : { webUrl }),
    });
  }
}

export function extractRequirements(
  page: RequirementsPage,
  nowMs: number,
): RequirementSet {
  const blocks = [...page.bodyStorage.matchAll(/<(li|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  const rawBlocks =
    blocks.length > 0
      ? blocks.map((match) => match[2] ?? "")
      : [page.bodyStorage];
  const items: RequirementItem[] = [];
  let index = 0;
  for (const raw of rawBlocks) {
    const text = decodeEntities(raw.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    let check: RequirementItem["check"];
    const timeout = text.match(/\btimeout\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\b/i);
    const penetration = text.match(/\bpenetration\b.*?\b(\d+(?:\.\d+)?)\s*mm\b/i);
    const completion = text.match(
      /\bcompletion\s+radius\b.*?\b(\d+(?:\.\d+)?)\s*(mm|cm|m)\b/i,
    );
    const contact = text.match(
      /\bmust\s+not\s+(?:touch|contact|collide\s+with)\s+(?:the\s+)?(divider|wall)\b/i,
    );
    if (timeout) {
      check = {
        metric: "timeoutSec",
        op: "<=",
        value: Number(timeout[1]),
      };
    } else if (penetration) {
      check = {
        metric: "penetrationLimitM",
        op: "<=",
        value: Number(penetration[1]) / 1000,
      };
    } else if (completion) {
      const multiplier =
        completion[2]?.toLowerCase() === "mm"
          ? 0.001
          : completion[2]?.toLowerCase() === "cm"
            ? 0.01
            : 1;
      check = {
        metric: "completionRadiusM",
        op: "<=",
        value: Number(completion[1]) * multiplier,
      };
    } else if (contact) {
      check = {
        metric: "forbiddenContact",
        op: "none",
        value: contact[1]?.toLowerCase() ?? "divider",
      };
    }
    const kind = check
      ? "checked_rule"
      : /\b(must|shall|should|never|always|require)\b/i.test(text)
        ? "human_review"
        : undefined;
    if (!kind) continue;
    index += 1;
    items.push(
      RequirementItem.parse({
        id: `${page.pageId}@v${page.version}#${index}`,
        text,
        kind,
        ...(check ? { check } : {}),
      }),
    );
  }
  return RequirementSet.parse({
    source: {
      system: "confluence",
      pageId: page.pageId,
      version: page.version,
      title: page.title,
      retrievedAtMs: nowMs,
    },
    items,
  });
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return named[code.toLowerCase()] ?? entity;
  });
}
