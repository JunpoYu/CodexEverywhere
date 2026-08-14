export interface ContinuityNegotiatingClient {
  enableSideContinuityAcknowledgements(): Promise<boolean>;
  close(): void;
}

export async function prepareClientForBinding<
  TClient extends ContinuityNegotiatingClient,
>(client: TClient): Promise<TClient> {
  try {
    await client.enableSideContinuityAcknowledgements();
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
