import { context, type Context, type Span } from "@opentelemetry/api";
import type { Telemetry } from "@forksafe/telemetry";

type AttemptTelemetry = { turnContext?: Context; artifacts: number };

export class RunnerTelemetry {
  private readonly attempts = new Map<string, AttemptTelemetry>();

  constructor(readonly telemetry: Telemetry) {}

  beginAttempt(attemptId: string): void {
    this.attempts.set(attemptId, { artifacts: 0 });
  }

  setTurnContext(attemptId: string, turnContext: Context): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt) attempt.turnContext = turnContext;
  }

  clearTurnContext(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt) delete attempt.turnContext;
  }

  artifactCount(attemptId: string): number {
    return this.attempts.get(attemptId)?.artifacts ?? 0;
  }

  finishAttempt(attemptId: string): void {
    this.attempts.delete(attemptId);
  }

  async withToolSpan<T>(
    name: string,
    attemptId: string,
    run: (span: Span) => Promise<T>,
    countArtifact = false,
  ): Promise<T> {
    const attempt = this.attempts.get(attemptId);
    const parent = attempt?.turnContext ?? context.active();
    return this.telemetry.withSpan("runner.tool", { "forksafe.tool.name": name }, async (span) => {
      try {
        const result = await run(span);
        const status = toolStatus(result);
        span.setAttribute("forksafe.tool.status", status);
        if (countArtifact && status === "ok" && attempt) attempt.artifacts += 1;
        return result;
      } catch (error) {
        span.setAttribute("forksafe.tool.status", "error");
        throw error;
      }
    }, { parent });
  }
}

function toolStatus(result: unknown): "ok" | "blocked" {
  if (!result || typeof result !== "object") return "ok";
  const value = result as { status?: unknown; ok?: unknown };
  if (value.status === "blocked" || value.status === "rejected" || value.ok === false) return "blocked";
  return "ok";
}
