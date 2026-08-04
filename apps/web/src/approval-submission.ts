export type ApprovalFailureDisposition =
  "retry" | "already-handled" | "ignored";

export class ApprovalSubmissionTracker {
  readonly #submitting = new Set<string>();
  readonly #resolved = new Set<string>();

  begin(requestId: string): boolean {
    if (this.#submitting.has(requestId) || this.#resolved.has(requestId))
      return false;
    this.#submitting.add(requestId);
    return true;
  }

  resolve(requestId: string): { wasSubmitting: boolean } {
    const wasSubmitting = this.#submitting.delete(requestId);
    this.#resolved.add(requestId);
    return { wasSubmitting };
  }

  complete(requestId: string): boolean {
    const known =
      this.#submitting.delete(requestId) || this.#resolved.has(requestId);
    if (known) this.#resolved.add(requestId);
    return known;
  }

  fail(requestId: string, error: unknown): ApprovalFailureDisposition {
    const wasSubmitting = this.#submitting.delete(requestId);
    if (this.#resolved.has(requestId) || isAlreadyHandledError(error)) {
      this.#resolved.add(requestId);
      return "already-handled";
    }
    return wasSubmitting ? "retry" : "ignored";
  }

  clear(): void {
    this.#submitting.clear();
    this.#resolved.clear();
  }
}

export function isAlreadyHandledError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("request is no longer pending")
  );
}
