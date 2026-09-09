import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineItem } from "./timeline-item-model.js";
import { TurnActivityGroup } from "./TurnActivityGroup.js";

describe("TurnActivityGroup", () => {
  it("keeps process payloads out of the DOM until the group is opened", () => {
    const html = renderToStaticMarkup(
      createElement(TurnActivityGroup, {
        items: [command("completed", "LARGE_OUTPUT_SENTINEL")],
      }),
    );

    expect(html).toContain("处理过程");
    expect(html).toContain("1 项");
    expect(html).not.toContain("pnpm test");
    expect(html).not.toContain("LARGE_OUTPUT_SENTINEL");
  });

  it("surfaces a failed activity in the collapsed summary", () => {
    const html = renderToStaticMarkup(
      createElement(TurnActivityGroup, {
        items: [command("failed", "failure detail")],
      }),
    );

    expect(html).toContain("处理过程有失败");
    expect(html).toContain('data-failed="true"');
    expect(html).not.toContain("failure detail");
  });
});

function command(status: string, output: string): TimelineItem {
  return {
    version: 1,
    id: crypto.randomUUID(),
    turnId: "turn-1",
    type: "command",
    data: {
      type: "commandExecution",
      command: "pnpm test",
      status,
      aggregatedOutput: output,
    },
  };
}
