import type { BackgroundDetail } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { memoryChange } from "../test/fixtures.ts";
import { BackgroundActivity } from "./BackgroundActivity.tsx";

const job: BackgroundDetail["job"] = {
  id: "bg_test",
  kind: "memory.review",
  dedupe: "window",
  session_id: "ses_source",
  agent_id: "agent",
  payload: '{"sourceRunId":"run_source","cut":"42"}',
  status: "no_changes",
  attempt: 1,
  fence: 1,
  lease_until: null,
  retry_at: 0,
  created_at: 1,
  finished_at: 2,
  diagnostic: null,
  result: '{"changeIds":[],"through":2}',
};
const detail: BackgroundDetail = { job, attempts: [], changes: [], sources: [] };
function api() {
  return {
    getBackground: vi.fn().mockResolvedValue({ jobs: [job], next: null }),
    getBackgroundDetail: vi.fn().mockResolvedValue(detail),
    retryBackground: vi.fn().mockResolvedValue({ retried: true }),
    undoMemoryChange: vi.fn(),
  };
}
it("lists no-change success through the generic Memory Review filter", async () => {
  const fake = api();
  render(<BackgroundActivity api={fake} route="/background?kind=memory.review" rev={0} onBack={() => {}} />);
  expect(await screen.findByText("No changes")).toBeTruthy();
  expect(fake.getBackground).toHaveBeenCalledWith({ kind: "memory.review" });
  expect(screen.getByRole("link", { name: /Memory Review/ }).getAttribute("href")).toBe("/background/bg_test");
});
it("retries failed work and refreshes the durable status", async () => {
  const fake = api();
  fake.getBackgroundDetail
    .mockResolvedValueOnce({ ...detail, job: { ...job, status: "failed", diagnostic: "MODEL_UNAVAILABLE" } })
    .mockResolvedValue({ ...detail, job: { ...job, status: "queued" } });
  render(<BackgroundActivity api={fake} route="/background/bg_test" rev={0} onBack={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry review" }));
  await waitFor(() => expect(fake.retryBackground).toHaveBeenCalledWith("bg_test"));
  expect(await screen.findByText("Queued")).toBeTruthy();
});
it("opens source evidence, displays diffs and refreshes Undo", async () => {
  const fake = api();
  const change = memoryChange({ after: "Test preference." });
  const applied = {
    ...detail,
    job: { ...job, status: "succeeded" },
    changes: [change],
    sources: [{ messageId: "u:source", runId: "source", entryId: "40" }],
  };
  fake.getBackgroundDetail
    .mockResolvedValueOnce(applied)
    .mockResolvedValue({ ...applied, changes: [{ ...change, undoneAt: 3 }] });
  fake.undoMemoryChange.mockResolvedValue({ change: { ...change, undoneAt: 3 }, line: null });
  render(<BackgroundActivity api={fake} route="/background/bg_test" rev={0} onBack={() => {}} />);
  expect(await screen.findByText("Test preference.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Source message 1" }).getAttribute("href")).toContain("m=u%3Asource");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(fake.undoMemoryChange).toHaveBeenCalledWith(change.id));
  expect(await screen.findByText("Undone")).toBeTruthy();
});
it("shows a failed chat title with its reason and retries it from the list", async () => {
  const fake = api();
  const failed: BackgroundDetail["job"] = {
    ...job,
    id: "bg_title",
    kind: "session.title",
    status: "failed",
    diagnostic: "MODEL_CALL_FAILED: no such model",
    result: null,
  };
  fake.getBackground.mockResolvedValue({ jobs: [failed], next: null });
  render(<BackgroundActivity api={fake} route="/background?kind=session.title" rev={0} onBack={() => {}} />);
  expect(await screen.findByText("The model call failed: no such model")).toBeTruthy();
  expect(screen.queryByText(/user messages/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry Chat title" }));
  await waitFor(() => expect(fake.retryBackground).toHaveBeenCalledWith("bg_title"));
});
it("shows a chat title task without memory sections and the title it set", async () => {
  const fake = api();
  fake.getBackgroundDetail.mockResolvedValue({
    ...detail,
    job: { ...job, kind: "session.title", status: "succeeded", result: '{"title":"Quokka care tips"}' },
  });
  render(<BackgroundActivity api={fake} route="/background/bg_test" rev={0} onBack={() => {}} />);
  expect(await screen.findByText("Title: Quokka care tips")).toBeTruthy();
  expect(screen.queryByText("Memory changes")).toBeNull();
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
});
