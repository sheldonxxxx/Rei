// Fixture access to persisted history state. Production callers use MemoryService.history.
import { HistoryIndex } from "../../src/memory/index.ts";
import type { MemoryService } from "../../src/memory/service.ts";
import { RetrievalOutbox } from "../../src/retrieval/outbox.ts";

export function historyState(memory: MemoryService): HistoryIndex {
  return new HistoryIndex(
    memory.store.db,
    memory.store.clock,
    new RetrievalOutbox(memory.store.db, memory.store.clock),
  );
}
