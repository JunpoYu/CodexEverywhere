import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const timelineSource = readFileSync(
  new URL("./thread-view.ts", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("composer approval tray", () => {
  it("keeps approvals beside the composer instead of in history", () => {
    expect(source).toContain('id="composer-approvals"');
    expect(source).toContain('id="composer-approval-list"');
    expect(source).toContain("createApprovalTrayCard(");
    expect(timelineSource).not.toContain("[data-request-id]");
    expect(styles).toContain(".approval-tray-item.collapsed");
  });

  it("expands one request and resolves each request independently", () => {
    expect(source).toContain("expandedApprovalId = pendingCards[0]");
    expect(source).toContain("String(payload.requestId)");
    expect(source).toContain("approvalSubmissions.begin(requestId)");
    expect(source).toContain("card.dataset.resolutionScheduled");
    expect(source).not.toMatch(/全部(允许|批准|拒绝)/);
  });

  it("compacts queue messages while an approval is pending", () => {
    expect(source).toContain("toggleComposerQueueDuringApproval");
    expect(styles).toContain(
      ".composer.approval-pending .composer-queue:not(.force-open)",
    );
  });
});
