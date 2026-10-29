import type { ConnectorDef, ModelAliasDef } from "@foundry/contract";

/** What the platform offers, loaded by the API from config/ and handed to the gate. */
export interface Catalog {
  connectors: ConnectorDef[];
  models: ModelAliasDef[];
}

export const connectorOf = (c: Catalog, id: string) => c.connectors.find((x) => x.id === id);
