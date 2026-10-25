/**
 * Compiles a natural-language scene edit into the numeric overrides the sliders already use.
 * Pure: no network, model, or simulator. Anything the scene cannot represent is refused.
 */
import {
  sceneOverrideRange,
  TASK_FAMILY_SPECS,
  isTaskFamily,
  validateSceneOverrides,
  type SceneOverrideKey,
} from "./scenes.js";

export interface ScenePromptApplication {
  key: string;
  label: string;
  value: number;
  phrase: string;
}

export interface ScenePromptResult {
  ok: boolean;
  overrides: Record<string, number>;
  applied: ScenePromptApplication[];
  refusals: string[];
}

function unrecognizedRefusal(taskFamily: string): string {
  return `${capabilitySentence(taskFamily)} Name one of those and a direction or a distance.`;
}

type ObjectKind = "divider" | "cube" | "target" | "gap" | "speed";
type AxisName = "dx" | "dy" | "height" | "width" | "speed";
type Sign = 1 | -1;

interface Hit {
  kind: "object" | "axis" | "verb" | "attr" | "number";
  start: number;
  end: number;
  rank: number;
  object?: ObjectKind;
  axis?: AxisName;
  sign?: Sign;
  /** Distance in metres, multiplier, or a bare number in the key's own unit. */
  amount?: number;
  unit?: "metres" | "times" | "bare" | "percent";
}

interface AxisHit {
  axis: AxisName;
  sign: Sign;
  start: number;
  end: number;
}

interface NumberHit {
  start: number;
  end: number;
  amount: number;
  unit: "metres" | "times" | "bare" | "percent";
}

interface Change {
  key: SceneOverrideKey;
  mode: "delta" | "absolute";
  sign: Sign;
  /** Null means one slider step. Otherwise metres or a speed multiplier. */
  amount: number | null;
  phrase: string;
}

export function compileScenePrompt(
  taskFamily: string,
  text: string,
  current: Record<string, number>,
): ScenePromptResult {
  const allowed = allowedKeys(taskFamily);
  const overrides = projectOverrides(current, allowed);
  const source = text.trim();
  if (!source) {
    return { ok: false, overrides, applied: [], refusals: [unrecognizedRefusal(taskFamily)] };
  }

  const refusals: string[] = [];
  for (const thing of unsupportedThings(source.toLowerCase())) {
    pushRefusal(refusals, cannotRepresent(thing, taskFamily));
  }

  const applied: ScenePromptApplication[] = [];
  for (const change of interpret(source, taskFamily, allowed, refusals)) {
    const range = sceneOverrideRange(taskFamily, change.key);
    const base = startingValue(overrides, change.key);
    const next = change.mode === "absolute"
      ? clamp(change.amount ?? base, range.min, range.max)
      : clamp(base + change.sign * (change.amount === null ? range.step : Math.abs(change.amount)), range.min, range.max);
    overrides[change.key] = next;
    applied.push({ key: change.key, label: range.label, value: next, phrase: change.phrase });
  }

  if (applied.length === 0 && refusals.length === 0) refusals.push(unrecognizedRefusal(taskFamily));
  const validation = validateSceneOverrides(taskFamily, overrides);
  return { ok: applied.length > 0 && validation.ok, overrides, applied, refusals };
}

function interpret(source: string, taskFamily: string, allowed: ReadonlySet<string>, refusals: string[]): Change[] {
  const lower = source.toLowerCase();
  const hits = withVerbAxes(scan(lower));
  const objects = hits.filter((hit) => hit.kind === "object");
  const numbers = hits.filter((hit): hit is Hit & { amount: number; unit: NonNullable<Hit["unit"]> } => hit.kind === "number" && hit.amount !== undefined && hit.unit !== undefined);
  const axes = hits.filter((hit): hit is Hit & { axis: AxisName; sign: Sign } => hit.kind === "axis" && hit.axis !== undefined && hit.sign !== undefined)
    .map((hit) => ({ axis: hit.axis, sign: hit.sign, start: hit.start, end: hit.end }));
  const bound = bindNumbers(axes, numbers.map((hit) => ({ start: hit.start, end: hit.end, amount: hit.amount, unit: hit.unit })));
  const changes: Change[] = [];

  if (axes.length === 0) {
    const absolute = absoluteChange(source, lower, hits, numbers, taskFamily, allowed, refusals);
    if (absolute) changes.push(absolute);
    return changes;
  }

  let skipUntil = -1;
  for (let index = 0; index < axes.length; index += 1) {
    const axis = axes[index]!;
    if (axis.start < skipUntil) continue;
    // "Further away" is one match. "Taller and higher" is two words for one step when the second has no distance.
    const twin = index + 1 < axes.length ? axes[index + 1] : undefined;
    if (twin && twin.axis === axis.axis && twin.sign === axis.sign && !bound.has(twin)) skipUntil = twin.end;
    const object = objectFor(axis, objects);
    if (!object) {
      if (objects.some((hit) => hit.object === "speed") && (axis.axis === "dx" || axis.axis === "dy")) {
        pushRefusal(refusals, cannotRepresent(robotMotion(axis.axis), taskFamily));
      }
      continue;
    }
    const key = keyFor(object, axis.axis);
    if (!key) {
      pushRefusal(refusals, cannotRepresent(impossible(object, axis.axis), taskFamily));
      continue;
    }
    if (!allowed.has(key)) {
      pushRefusal(refusals, unavailable(key, taskFamily));
      continue;
    }
    const number = bound.get(axis);
    if (number?.unit === "percent") {
      pushRefusal(refusals, cannotRepresent("a percentage", taskFamily));
      continue;
    }
    const converted = number ? convert(key, number, taskFamily, refusals) : { ok: true as const, amount: null };
    if (!converted.ok) continue;
    const phrase = axis.axis === "dy"
      ? `${source} (${axis.sign === 1 ? "left is +dy" : "right is -dy"})`
      : source;
    const absolute = converted.amount !== null && isScalar(key) && cueBefore(lower, number?.start ?? 0) === "to";
    changes.push({
      key,
      mode: absolute ? "absolute" : "delta",
      sign: axis.sign,
      amount: converted.amount,
      phrase,
    });
  }
  return changes;
}

function absoluteChange(
  source: string,
  lower: string,
  hits: Hit[],
  numbers: Array<Hit & { amount: number; unit: NonNullable<Hit["unit"]> }>,
  taskFamily: string,
  allowed: ReadonlySet<string>,
  refusals: string[],
): Change | null {
  const number = numbers[0];
  if (!number) return null;
  const attr = hits.find((hit) => hit.kind === "attr");
  const speed = hits.some((hit) => hit.kind === "object" && hit.object === "speed");
  const axis: AxisName | null = attr?.axis ?? (speed ? "speed" : null);
  if (!axis) return null;
  const object = axis === "speed"
    ? "speed"
    : objectFor({ axis, sign: 1, start: attr?.start ?? number.start, end: attr?.end ?? number.end }, hits.filter((hit) => hit.kind === "object"));
  if (!object) return null;
  const key = keyFor(object, axis);
  if (!key) {
    pushRefusal(refusals, cannotRepresent(impossible(object, axis), taskFamily));
    return null;
  }
  if (!allowed.has(key)) {
    pushRefusal(refusals, unavailable(key, taskFamily));
    return null;
  }
  if (number.unit === "percent") {
    pushRefusal(refusals, cannotRepresent("a percentage", taskFamily));
    return null;
  }
  const converted = convert(key, { start: number.start, end: number.end, amount: number.amount, unit: number.unit }, taskFamily, refusals);
  if (!converted.ok || converted.amount === null) return null;
  const verb = hits.find((hit) => hit.kind === "verb");
  const setpoint = cueBefore(lower, number.start) === "to" || !verb;
  return {
    key,
    mode: setpoint ? "absolute" : "delta",
    sign: verb?.sign ?? 1,
    amount: converted.amount,
    phrase: source,
  };
}

function scan(text: string): Hit[] {
  const found: Hit[] = [];
  const take = (regex: RegExp, build: (match: RegExpMatchArray) => Hit | null) => {
    for (const match of text.matchAll(regex)) {
      const hit = build(match);
      if (hit) found.push(hit);
    }
  };

  take(/\b(dividers?|cubes?|targets?|gaps?|openings?|robots?|speeds?)\b/gi, (match) => ({
    kind: "object",
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    rank: 3,
    object: objectKind(match[1] ?? match[0]),
  }));
  take(/\b(?:lower|higher)\s+(?:the\s+)?(?:robot\s+)?speed\b|\bspeed\s+(?:is\s+)?(higher|lower)\b/gi, (match) => ({
    kind: "axis", start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, rank: 0,
    axis: "speed", sign: /higher/.test(match[0].toLowerCase()) ? 1 : -1,
  }));
  take(/\b(?:faster|quicker|speed\s*up|speedup|fast)\b/gi, (match) => axis("speed", 1, match));
  take(/\b(?:slower|slow\s+down|slowdown|slow)\b/gi, (match) => axis("speed", -1, match));
  take(/\b(?:taller|higher)\b/gi, (match) => axis("height", 1, match));
  take(/\b(?:shorter|lower)\b/gi, (match) => axis("height", -1, match));
  take(/\b(?:wider|widen)\b/gi, (match) => axis("width", 1, match));
  take(/\b(?:narrower|narrow)\b/gi, (match) => axis("width", -1, match));
  take(/\baway\s+from\s+the\s+robot\b|\b(?:further|farther|away|outwards?)(?:\s+away)?\b/gi, (match) => axis("dx", 1, match));
  take(/\b(?:closer|nearer|inwards?)(?:\s+to(?:\s+the\s+robot)?)?\b|\b(?:toward|towards)\s+the\s+robot\b/gi, (match) => axis("dx", -1, match));
  take(/\b(?:toward|towards)\b(?!\s+(?:the\s+)?(?:left|right)\b)/gi, (match) => axis("dx", -1, match));
  take(/\bleft\b/gi, (match) => axis("dy", 1, match));
  take(/\bright\b/gi, (match) => axis("dy", -1, match));
  take(/\b(?:increase|raise)\b/gi, (match) => ({
    kind: "verb", start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, rank: 2, sign: 1,
  }));
  take(/\b(?:decrease|reduce|drop)\b/gi, (match) => ({
    kind: "verb", start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, rank: 2, sign: -1,
  }));
  take(/\bheight\b/gi, (match) => ({
    kind: "attr", start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, rank: 2, axis: "height",
  }));
  take(/\bwidth\b/gi, (match) => ({
    kind: "attr", start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, rank: 2, axis: "width",
  }));
  take(/(?<![\w.])(-?\d+(?:\.\d+)?)(?:\s*(centimet(?:er|re)s?|millimet(?:er|re)s?|met(?:er|re)s?|cm|mm|m|times|×|x|%|percent))?(?![a-z])/gi, (match) => {
    const parsed = parseNumber(Number(match[1]), match[2]);
    return {
      kind: "number",
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      rank: 1,
      amount: parsed.amount,
      unit: parsed.unit,
    };
  });
  take(/\b(?:a|an|one)\s+(centimet(?:er|re)s?|millimet(?:er|re)s?|met(?:er|re)s?)\b/gi, (match) => {
    const parsed = parseNumber(1, match[1]);
    return {
      kind: "number",
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      rank: 1,
      amount: parsed.amount,
      unit: parsed.unit,
    };
  });

  found.sort((a, b) => a.start - b.start || (b.end - a.end) - (a.end - a.start) || a.rank - b.rank);
  const kept: Hit[] = [];
  for (const hit of found) {
    if (kept.some((prior) => hit.start < prior.end && hit.end > prior.start)) continue;
    kept.push(hit);
  }
  return kept;
}

function withVerbAxes(hits: Hit[]): Hit[] {
  if (hits.some((hit) => hit.kind === "axis")) return hits;
  const verb = hits.find((hit) => hit.kind === "verb");
  if (!verb?.sign) return hits;
  const attr = hits.find((hit) => hit.kind === "attr");
  if (attr?.axis) {
    return [...hits, { kind: "axis", start: attr.start, end: attr.end, rank: 0, axis: attr.axis, sign: verb.sign }];
  }
  const speed = hits.find((hit) => hit.kind === "object" && hit.object === "speed");
  if (speed) {
    return [...hits, { kind: "axis", start: speed.start, end: speed.end, rank: 0, axis: "speed", sign: verb.sign }];
  }
  return hits;
}

function bindNumbers(axes: AxisHit[], numbers: NumberHit[]): Map<AxisHit, NumberHit> {
  const used = new Set<NumberHit>();
  const bound = new Map<AxisHit, NumberHit>();
  const ordered = [...axes].sort((a, b) => a.start - b.start);
  for (const axis of ordered) {
    const before = numbers.filter((number) => !used.has(number) && number.end <= axis.start);
    const pick = before[before.length - 1];
    if (!pick) continue;
    used.add(pick);
    bound.set(axis, pick);
  }
  for (const axis of ordered) {
    if (bound.has(axis)) continue;
    const after = numbers.filter((number) => !used.has(number) && number.start >= axis.end);
    const pick = after[0];
    if (!pick) continue;
    used.add(pick);
    bound.set(axis, pick);
  }
  return bound;
}

function objectFor(axis: AxisHit, objects: Hit[]): ObjectKind | null {
  if (axis.axis === "speed") return "speed";
  const positions = objects.filter((hit) => hit.object && hit.object !== "speed");
  const before = positions.filter((hit) => hit.end <= axis.start);
  if (before.length > 0) return before[before.length - 1]!.object ?? null;
  const after = positions.filter((hit) => hit.start >= axis.end);
  if (after.length > 0) return after[0]!.object ?? null;
  if (axis.axis === "height") return "divider";
  if (axis.axis === "width") return "gap";
  return null;
}

function keyFor(object: ObjectKind, axis: AxisName): SceneOverrideKey | null {
  const table: Partial<Record<`${ObjectKind}:${AxisName}`, SceneOverrideKey>> = {
    "divider:dx": "dividerDx",
    "divider:dy": "dividerDy",
    "divider:height": "dividerHeight",
    "cube:dx": "cubeDx",
    "cube:dy": "cubeDy",
    "target:dx": "targetDx",
    "target:dy": "targetDy",
    "gap:dx": "gapDx",
    "gap:width": "gapWidth",
    "speed:speed": "speedScale",
  };
  return table[`${object}:${axis}`] ?? null;
}

function convert(
  key: SceneOverrideKey,
  number: NumberHit,
  taskFamily: string,
  refusals: string[],
): { ok: true; amount: number | null } | { ok: false } {
  const range = sceneOverrideRange(taskFamily, key);
  const label = range.label;
  if (number.unit === "percent") {
    pushRefusal(refusals, cannotRepresent("a percentage", taskFamily));
    return { ok: false };
  }
  if (number.unit === "times" && range.unit !== "×") {
    pushRefusal(refusals, cannotRepresent(`a multiplier for ${label}`, taskFamily));
    return { ok: false };
  }
  if (number.unit === "metres" && range.unit !== "m") {
    pushRefusal(refusals, cannotRepresent(`a distance for ${label}`, taskFamily));
    return { ok: false };
  }
  return { ok: true, amount: number.amount };
}

function cueBefore(text: string, index: number): "to" | "by" | null {
  const before = text.slice(0, index);
  if (/\b(?:to|at|equals|=)\s*$/i.test(before)) return "to";
  if (/\bby\s*$/i.test(before)) return "by";
  return null;
}

function unsupportedThings(text: string): string[] {
  const found: { start: number; end: number; thing: string }[] = [];
  const patterns: { regex: RegExp; thing: string }[] = [
    { regex: /\b(?:second|another|extra|additional|dual)[-\s]+arms?\b|\b(?:two|2)\s+arms\b/gi, thing: "a second arm" },
    { regex: /\b(?:another|second|extra|additional|new)\s+(?:robots?|pandas?|frankas?)\b|\b(?:two|2)\s+robots\b/gi, thing: "another robot" },
    { regex: /\bconveyors?(?:\s+belts?)?\b/gi, thing: "a conveyor" },
    { regex: /\b(?:new|another|extra|additional)\s+objects?\b|\badd\s+(?:a|an|another)\s+(?:new\s+)?(?:objects?|cubes?|blocks?|boxes?|balls?|spheres?|cylinders?|items?|obstacles?)\b/gi, thing: "a new object" },
    { regex: /\b(?:humans?|people|person|operator)\b/gi, thing: "a human" },
    { regex: /\b(?:different|another|new|other)\s+tasks?\b|\b(?:change|switch)\s+(?:the\s+|to\s+(?:a\s+)?)?tasks?\b/gi, thing: "a different task" },
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      found.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, thing: pattern.thing });
    }
  }
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const things: string[] = [];
  const spans: { start: number; end: number }[] = [];
  for (const hit of found) {
    if (spans.some((span) => hit.start < span.end && hit.end > span.start)) continue;
    if (things.includes(hit.thing)) continue;
    spans.push(hit);
    things.push(hit.thing);
  }
  return things;
}

function allowedKeys(taskFamily: string): Set<string> {
  if (!isTaskFamily(taskFamily)) return new Set();
  return new Set(TASK_FAMILY_SPECS[taskFamily].overrideKeys);
}

function projectOverrides(current: Record<string, number>, allowed: ReadonlySet<string>): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!allowed.has(key) || typeof value !== "number" || !Number.isFinite(value)) continue;
    overrides[key] = value;
  }
  return overrides;
}

function startingValue(overrides: Record<string, number>, key: SceneOverrideKey): number {
  const value = overrides[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (key === "speedScale") return 1;
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Number(Math.min(max, Math.max(min, value)).toFixed(5));
}

function isScalar(key: SceneOverrideKey): boolean {
  return key === "dividerHeight" || key === "gapWidth" || key === "speedScale";
}

function capabilitySentence(taskFamily: string): string {
  if (!isTaskFamily(taskFamily)) return `Unknown task "${taskFamily}".`;
  const labels = TASK_FAMILY_SPECS[taskFamily].overrideKeys.map((key) => sceneOverrideRange(taskFamily, key).label);
  return `This scene can change ${englishList(labels)}.`;
}

function cannotRepresent(thing: string, taskFamily: string): string {
  return `This scene cannot represent ${thing}. ${capabilitySentence(taskFamily)}`;
}

function unavailable(key: SceneOverrideKey, taskFamily: string): string {
  const title = isTaskFamily(taskFamily) ? TASK_FAMILY_SPECS[taskFamily].title : taskFamily;
  return `${sceneOverrideRange(taskFamily, key).label} is not a setting for "${title}". ${capabilitySentence(taskFamily)}`;
}

function impossible(object: ObjectKind, axis: AxisName): string {
  const name = object === "speed" ? "robot" : object;
  if (axis === "dy") return `moving the ${name} sideways`;
  if (axis === "dx") return `moving the ${name} toward or away from the robot`;
  if (axis === "height") return `a ${name} height`;
  if (axis === "width") return `a ${name} width`;
  return `a ${name} speed`;
}

function robotMotion(axis: AxisName): string {
  return axis === "dy" ? "moving the robot sideways" : "moving the robot closer or farther";
}

function englishList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function pushRefusal(refusals: string[], refusal: string) {
  if (!refusals.includes(refusal)) refusals.push(refusal);
}

function axis(name: AxisName, sign: Sign, match: RegExpMatchArray): Hit {
  return {
    kind: "axis",
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    rank: 0,
    axis: name,
    sign,
  };
}

function objectKind(word: string): ObjectKind {
  const value = word.toLowerCase();
  if (value.startsWith("divider")) return "divider";
  if (value.startsWith("cube")) return "cube";
  if (value.startsWith("target")) return "target";
  if (value.startsWith("gap") || value.startsWith("opening")) return "gap";
  return "speed";
}

function parseNumber(value: number, unit: string | undefined): { amount: number; unit: NonNullable<Hit["unit"]> } {
  if (!unit) return { amount: value, unit: "bare" };
  const normalized = unit.toLowerCase();
  if (normalized === "%" || normalized === "percent") return { amount: value, unit: "percent" };
  if (normalized === "x" || normalized === "×" || normalized === "times") return { amount: value, unit: "times" };
  if (normalized === "cm" || normalized.startsWith("centimet")) return { amount: value / 100, unit: "metres" };
  if (normalized === "mm" || normalized.startsWith("millimet")) return { amount: value / 1000, unit: "metres" };
  return { amount: value, unit: "metres" };
}
