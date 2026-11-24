// Where the gateway keeps what must survive a restart and must never leave it: MCP connectors with their tokens and OAuth
// client registrations, plus the VAPID key pair. Values are JSON; `modify` is a serialized
// read-modify-write (return undefined to delete the key). The Node implementation is node/secretstore.ts.
export interface SecretStore {
  read<T>(key: string): Promise<T | undefined>;
  modify<T>(key: string, fn: (current: T | undefined) => T | undefined): Promise<T | undefined>;
}
