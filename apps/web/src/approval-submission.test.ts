import { describe, expect, it } from "vitest";

import {
  ApprovalSubmissionTracker,
  isAlreadyHandledError,
} from "./approval-submission.js";

describe("ApprovalSubmissionTracker", () => {
  it("allows only one in-flight submission for a request", () => {
    const tracker = new ApprovalSubmissionTracker();

    expect(tracker.begin("request-1")).toBe(true);
    expect(tracker.begin("request-1")).toBe(false);
    expect(tracker.complete("request-1")).toBe(true);
    expect(tracker.begin("request-1")).toBe(false);
  });

  it("allows retry only after a definite submission failure", () => {
    const tracker = new ApprovalSubmissionTracker();

    expect(tracker.begin("request-1")).toBe(true);
    expect(tracker.fail("request-1", new Error("network failed"))).toBe(
      "retry",
    );
    expect(tracker.begin("request-1")).toBe(true);
  });

  it("treats a realtime resolution during submission as already handled", () => {
    const tracker = new ApprovalSubmissionTracker();

    expect(tracker.begin("request-1")).toBe(true);
    expect(tracker.resolve("request-1")).toEqual({ wasSubmitting: true });
    expect(tracker.fail("request-1", new Error("response lost"))).toBe(
      "already-handled",
    );
    expect(tracker.begin("request-1")).toBe(false);
  });

  it("recognizes the Agent response for a request handled elsewhere", () => {
    const tracker = new ApprovalSubmissionTracker();
    tracker.begin("request-1");

    expect(
      isAlreadyHandledError(
        new Error("Codex server request is no longer pending"),
      ),
    ).toBe(true);
    expect(
      tracker.fail(
        "request-1",
        new Error("Codex server request is no longer pending"),
      ),
    ).toBe("already-handled");
    expect(tracker.begin("request-1")).toBe(false);
  });

  it("forgets completed state when leaving the thread", () => {
    const tracker = new ApprovalSubmissionTracker();
    tracker.begin("request-1");
    tracker.resolve("request-1");

    tracker.clear();

    expect(tracker.begin("request-1")).toBe(true);
  });
});
