import { describe, expect, it, vi } from "vitest";

import { completeWorkspaceMutation } from "./WorkspacesPage.js";

describe("completeWorkspaceMutation", () => {
  it("keeps a completed mutation successful when the list refresh fails", async () => {
    const operation = vi.fn(async () => ({ version: 1 as const }));
    const refreshError = new Error("list unavailable");
    const refresh = vi.fn(async () => Promise.reject(refreshError));

    await expect(
      completeWorkspaceMutation(operation, refresh),
    ).resolves.toEqual({ status: "completed", refreshError });
    expect(operation).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not refresh after a definitive mutation failure", async () => {
    const operationError = new Error("mutation rejected");
    const operation = vi.fn(async () => Promise.reject(operationError));
    const refresh = vi.fn(async () => undefined);

    await expect(
      completeWorkspaceMutation(operation, refresh),
    ).resolves.toEqual({ status: "failed", error: operationError });
    expect(refresh).not.toHaveBeenCalled();
  });
});
