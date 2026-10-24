import { IntegrationReadiness } from "@forksafe/contracts";
import { z } from "zod";
import { ServiceError } from "./errors";

const WebIntegrationReadiness = IntegrationReadiness.extend({ probed: z.boolean() });
const ReadinessResponse = z.object({ integrations: z.array(WebIntegrationReadiness) });

/** Reads the server-side readiness report served at /api/readiness. */
export async function fetchReadiness(signal?: AbortSignal): Promise<z.infer<typeof WebIntegrationReadiness>[]> {
  let res: Response;
  try {
    res = await fetch("/api/readiness", { signal, headers: { accept: "application/json" } });
  } catch (e) {
    throw new ServiceError("unavailable", `Readiness endpoint unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new ServiceError("unavailable", `Readiness endpoint returned ${res.status}`);
  const parsed = ReadinessResponse.safeParse(await res.json());
  if (!parsed.success) throw new ServiceError("invalid_data", "Readiness response did not match contracts");
  return parsed.data.integrations;
}
