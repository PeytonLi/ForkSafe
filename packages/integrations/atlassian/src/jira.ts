import type { AdfDoc } from "./adf.js";
import type { AtlassianTransport } from "./http.js";
import { AtlassianHttpError } from "./http.js";

type JiraIssue = {
  id: string;
  key: string;
  fields?: {
    status?: { name?: string };
    labels?: string[];
  };
};

type JiraPage<T> = {
  startAt?: number;
  maxResults?: number;
  total?: number;
  values?: T[];
  comments?: T[];
};

export class JiraClient {
  constructor(private readonly transport: AtlassianTransport) {}

  async probe(): Promise<void> {
    await this.request("GET", "/rest/api/3/myself");
  }

  async getIssue(key: string, fields: string[]): Promise<JiraIssue> {
    const query = new URLSearchParams({ fields: fields.join(",") });
    return (
      await this.request<JiraIssue>(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}?${query}`,
      )
    ).body;
  }

  async searchJql(
    jql: string,
    fields: string[],
    maxResults = 50,
  ): Promise<JiraIssue[]> {
    const response = await this.request<{ issues?: JiraIssue[] }>(
      "POST",
      "/rest/api/3/search/jql",
      { jql, fields, maxResults },
    );
    return response.body.issues ?? [];
  }

  async createIssue({
    projectKey,
    summary,
    description,
    issueType = "Task",
    labels,
  }: {
    projectKey: string;
    summary: string;
    description: AdfDoc;
    issueType?: string;
    labels?: string[];
  }): Promise<{ id: string; key: string }> {
    const body = await this.request<{ id: string; key: string }>(
      "POST",
      "/rest/api/3/issue",
      {
        fields: {
          project: { key: projectKey },
          summary,
          description,
          issuetype: { name: issueType },
          ...(labels === undefined ? {} : { labels }),
        },
      },
    );
    return body.body;
  }

  async updateIssue(
    key: string,
    {
      summary,
      description,
      addLabels,
    }: {
      summary?: string;
      description?: AdfDoc;
      addLabels?: string[];
    },
  ): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (summary !== undefined) fields.summary = summary;
    if (description !== undefined) fields.description = description;
    const update: Record<string, unknown> = {};
    if (addLabels?.length) {
      update.labels = addLabels.map((label) => ({ add: label }));
    }
    await this.request(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(key)}`,
      {
        ...(Object.keys(fields).length ? { fields } : {}),
        ...(Object.keys(update).length ? { update } : {}),
      },
    );
  }

  async listComments(key: string): Promise<unknown[]> {
    const comments: unknown[] = [];
    let startAt = 0;
    while (true) {
      const page = await this.request<JiraPage<unknown>>(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100`,
      );
      const items = page.body.comments ?? page.body.values ?? [];
      comments.push(...items);
      const next = startAt + items.length;
      if (items.length === 0 || (page.body.total !== undefined && next >= page.body.total)) {
        break;
      }
      if (page.body.total === undefined && items.length < 100) break;
      startAt = next;
    }
    return comments;
  }

  async addComment(key: string, body: AdfDoc): Promise<unknown> {
    return (
      await this.request(
        "POST",
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
        { body },
      )
    ).body;
  }

  async upsertRemoteLink(
    key: string,
    {
      globalId,
      url,
      title,
      summary,
      status,
    }: {
      globalId: string;
      url: string;
      title: string;
      summary?: string;
      status?: boolean;
    },
  ): Promise<unknown> {
    return (
      await this.request(
        "POST",
        `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`,
        {
          globalId,
          object: {
            url,
            title,
            ...(summary === undefined ? {} : { summary }),
            ...(status === undefined ? {} : { status: { resolved: status } }),
          },
        },
      )
    ).body;
  }

  async getIssueProperty(key: string, prop: string): Promise<unknown | null> {
    try {
      return (
        await this.request<{ value?: unknown }>(
          "GET",
          `/rest/api/3/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(prop)}`,
        )
      ).body.value ?? null;
    } catch (error) {
      if (error instanceof AtlassianHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async setIssueProperty(key: string, prop: string, value: unknown): Promise<void> {
    await this.request(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(prop)}`,
      { value },
    );
  }

  async getTransitions(key: string): Promise<
    Array<{ id: string; name: string; to?: { name?: string } }>
  > {
    const body = await this.request<{
      transitions?: Array<{ id: string; name: string; to?: { name?: string } }>;
    }>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    return body.body.transitions ?? [];
  }

  async transitionIssue(key: string, transitionId: string): Promise<void> {
    await this.request(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { transition: { id: transitionId } },
    );
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const response = await this.transport({
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new AtlassianHttpError(
        response.status,
        method,
        path,
        typeof response.body === "string"
          ? response.body.slice(0, 500)
          : JSON.stringify(response.body).slice(0, 500),
      );
    }
    return response as { status: number; body: T };
  }
}

export type JiraWorkflowMapping = {
  readyForReview?: { statusNames: string[] };
  accepted?: { statusNames: string[] };
};
