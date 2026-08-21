import { jsonValueSchema, type JsonValue } from "@codex-everywhere/protocol/v2";

export type CodexObject = Readonly<Record<string, JsonValue>>;

export function parseCodexObject(value: unknown, field: string): CodexObject {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || !isCodexObject(parsed.data)) {
    throw new Error(`Invalid ${field}`);
  }
  return parsed.data;
}

export function requireCodexObject(
  value: JsonValue | undefined,
  field: string,
): CodexObject {
  if (!isCodexObject(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

export function requireCodexString(
  value: JsonValue | undefined,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

export function isCodexObject(
  value: JsonValue | undefined,
): value is CodexObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
