import { v } from "convex/values";
import { z } from "zod";
import {
  describeInputError, describeScene as matchScene, explainScene, isTaskFamily,
  normalizeDescribedOverrides, SCENE_OVERRIDE_RANGES, TASK_FAMILIES, TASK_FAMILY_SPECS,
  unsupportedScene, type DescribeOutcome,
} from "@forksafe/contracts";
import { action } from "./_generated/server.js";
import { requireWriteIdentity } from "./lib/webAccess.js";

export const DESCRIBE_TIMEOUT_MS = 15_000;
const modelScene = z.object({
  taskFamily: z.string(),
  overrides: z.record(z.number().finite().nullable()),
  explanation: z.string(),
}).strict();

export const describeScene = action({
  args: { text: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args): Promise<DescribeOutcome> => {
    await requireWriteIdentity(ctx, args.serviceToken);
    const error = describeInputError(args.text);
    if (error) return { mode: "rules", ...error };
    if (!process.env.OPENAI_API_KEY) return { mode: "rules", ...matchScene(args.text) };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Description timed out"));
        }, DESCRIBE_TIMEOUT_MS);
      });
      const request = async (): Promise<DescribeOutcome> => {
        const keys = Object.keys(SCENE_OVERRIDE_RANGES);
        const tasks = TASK_FAMILIES.map((family) => {
          const spec = TASK_FAMILY_SPECS[family];
          const settings = spec.overrideKeys.map((key) => {
            const range = SCENE_OVERRIDE_RANGES[key];
            return `${key}: ${range.label}, ${range.min}..${range.max} ${range.unit}`;
          }).join("; ");
          return `${family}: ${spec.title}. ${spec.description} Settings: ${settings}`;
        }).join("\n");
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: process.env.FORKSAFE_DESCRIBE_MODEL || "gpt-4o-mini",
            temperature: 0,
            max_completion_tokens: 600,
            messages: [
              { role: "system", content: `You convert a short description of a robot simulation into settings. Only these tasks exist:\n${tasks}\nIf the description is not one of these tasks, answer taskFamily "unsupported". A drop into a bin is not a throw or toss. Use null for any setting the description does not ask to change. Never invent tasks or settings. Distances are in metres; robot speed is a multiplier where 1 is normal.` },
              { role: "user", content: args.text.trim() },
            ],
            response_format: { type: "json_schema", json_schema: {
              name: "scene", strict: true, schema: {
                type: "object", additionalProperties: false, required: ["taskFamily", "overrides", "explanation"],
                properties: {
                  taskFamily: { type: "string", enum: [...TASK_FAMILIES, "unsupported"] },
                  overrides: { type: "object", additionalProperties: false, required: keys,
                    properties: Object.fromEntries(keys.map((key) => [key, { type: ["number", "null"] }])) },
                  explanation: { type: "string" },
                },
              },
            } },
          }),
        });
        if (!response.ok) throw new Error("Description unavailable");
        const envelope = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }).parse(await response.json());
        const parsed = modelScene.parse(JSON.parse(envelope.choices[0]!.message.content));
        if (!isTaskFamily(parsed.taskFamily)) return { mode: "llm", ...unsupportedScene() };
        const overrides = normalizeDescribedOverrides(parsed.taskFamily, parsed.overrides);
        return { mode: "llm", status: "matched", taskFamily: parsed.taskFamily, overrides, explanation: explainScene(parsed.taskFamily, overrides) };
      };
      return await Promise.race([request(), timeout]);
    } catch {
      return { mode: "rules", fallback: true, ...matchScene(args.text) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  },
});
