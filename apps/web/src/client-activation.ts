export interface ContinuityNegotiatingClient {
  enableSideContinuityAcknowledgements(): Promise<boolean>;
  close(): void;
}

export class RetryableClientPreparationError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Client continuity negotiation failed",
      { cause },
    );
    this.name = "RetryableClientPreparationError";
  }
}

export async function prepareClientForBinding<
  TClient extends ContinuityNegotiatingClient,
>(
  client: TClient,
  options: { retryOnFailure?: boolean } = {},
): Promise<TClient> {
  try {
    await client.enableSideContinuityAcknowledgements();
    return client;
  } catch (error) {
    client.close();
    if (options.retryOnFailure)
      throw new RetryableClientPreparationError(error);
    throw error;
  }
}
