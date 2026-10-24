export type ParsedTraceparent = {
  traceId: string;
  spanId: string;
  sampled: boolean;
};

export function parseTraceparent(value: string | null): ParsedTraceparent | null {
  if (!value || value.length > 55) return null;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return null;
  return {
    traceId: match[1]!,
    spanId: match[2]!,
    sampled: (Number.parseInt(match[3]!, 16) & 1) === 1,
  };
}

export function traceLog(route: string, request: Request): void {
  const traceparent = parseTraceparent(request.headers.get("traceparent"));
  if (!traceparent) return;
  console.log(JSON.stringify({
    kind: "runner_http",
    route,
    traceId: traceparent.traceId,
    parentSpanId: traceparent.spanId,
  }));
}
