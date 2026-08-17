import { describe, expect, it } from "vitest";

import { GatewayV2Error } from "./errors.js";
import { gatewayMethodDefinitions, gatewayMethodNames } from "./methods.js";
import {
  parseGatewayEventEnvelopeV2,
  parseGatewayRequestEnvelopeV2,
} from "./wire.js";

describe("Gateway API v2 schema fuzz boundary", () => {
  it("rejects a deterministic malformed corpus without leaking input", () => {
    const random = mulberry32(0xce04_2026);
    for (let index = 0; index < 500; index += 1) {
      const marker = `fuzz-secret-${index}`;
      const candidate = randomValue(random, 0, marker);
      assertSanitizedFailure(
        () => parseGatewayRequestEnvelopeV2(candidate),
        marker,
      );
      assertSanitizedFailure(
        () => parseGatewayEventEnvelopeV2(candidate),
        marker,
      );
    }
  });

  it("keeps every registered input and output schema total on arbitrary JSON", () => {
    const random = mulberry32(0x5cae_04);
    for (const method of gatewayMethodNames) {
      const definition = gatewayMethodDefinitions[method];
      for (let index = 0; index < 40; index += 1) {
        const candidate = randomValue(random, 0, `${method}:${index}`);
        expect(
          () => definition.input.safeParse(candidate),
          method,
        ).not.toThrow();
        expect(
          () => definition.output.safeParse(candidate),
          method,
        ).not.toThrow();
      }
    }
  });
});

function assertSanitizedFailure(action: () => unknown, marker: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayV2Error);
    expect(JSON.stringify((error as GatewayV2Error).toPayload())).not.toContain(
      marker,
    );
    return;
  }
  throw new Error("Malformed fuzz value unexpectedly passed a strict envelope");
}

function randomValue(
  random: () => number,
  depth: number,
  marker: string,
): unknown {
  const choice = Math.floor(random() * (depth >= 3 ? 5 : 8));
  if (choice === 0) return null;
  if (choice === 1) return random() < 0.5;
  if (choice === 2) return Math.floor(random() * 1_000_000);
  if (choice === 3) return `${marker}:${Math.floor(random() * 1_000_000)}`;
  if (choice === 4) return undefined;
  if (choice === 5) {
    return Array.from({ length: Math.floor(random() * 5) }, () =>
      randomValue(random, depth + 1, marker),
    );
  }
  const result: Record<string, unknown> = {};
  for (let index = 0; index < Math.floor(random() * 5); index += 1) {
    result[`field_${index}_${Math.floor(random() * 20)}`] = randomValue(
      random,
      depth + 1,
      marker,
    );
  }
  return result;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b_79f5) >>> 0;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}
