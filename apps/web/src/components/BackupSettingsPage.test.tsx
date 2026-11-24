import type { BackupSettings } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnsavedChangesProvider } from "../lib/unsaved.tsx";
import { BackupSettingsPage } from "./BackupSettingsPage.tsx";

const base: BackupSettings = {
  available: true,
  enabled: false,
  time: "03:00",
  timeZone: "Asia/Macau",
  retention: { daily: 7, weekly: 4, monthly: 12 },
  repository: "none",
  path: "/backups",
  running: false,
  lastRun: null,
  lastSuccessAt: null,
  nextRunAt: null,
  stale: false,
  snapshots: null,
  repositoryBytes: null,
  history: [],
};

const run = (over: Partial<BackupSettings["history"][number]> = {}) => ({
  id: "bk_1",
  trigger: "manual" as const,
  status: "ok" as const,
  startedAt: Date.now() - 60_000,
  finishedAt: Date.now() - 50_000,
  snapshotId: "abc",
  bytesAdded: 2048,
  counts: { objects: 3 },
  error: null,
  maintenance: null,
  ...over,
});

function api(initial: BackupSettings) {
  return {
    getBackups: vi.fn().mockResolvedValue(initial),
    updateBackups: vi.fn(),
    generateBackupPassword: vi.fn().mockResolvedValue({ password: "aaaa-bbbb-cccc-dddd" }),
    setBackupRepository: vi.fn(),
    forgetBackupRepository: vi.fn(),
    runBackup: vi.fn(),
  };
}

const show = (a: ReturnType<typeof api>) =>
  render(
    <UnsavedChangesProvider>
      <BackupSettingsPage api={a} />
    </UnsavedChangesProvider>,
  );

describe("BackupSettingsPage", () => {
  it("says backups are not set up when the stack has no backup folder", async () => {
    show(api({ ...base, available: false }));
    expect(await screen.findByText(/REI_BACKUP_DIR/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create repository" })).toBeNull();
  });

  it("creates a repository only after the password is shown and confirmed", async () => {
    const a = api(base);
    const ready = { ...base, repository: "ready" as const, snapshots: 0, repositoryBytes: 100 };
    a.setBackupRepository.mockResolvedValue(ready);
    show(a);
    fireEvent.click(await screen.findByRole("button", { name: "Create repository" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("backup-password").textContent).toBe("aaaa-bbbb-cccc-dddd");
    const confirm = within(dialog).getByRole("button", { name: "Create repository" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "I saved this password" }));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(a.setBackupRepository).toHaveBeenCalledWith({ mode: "create", confirmed: true }));
    expect(await screen.findByText(/0 backups/)).toBeTruthy();
  });

  it("connects to an existing repository with its password", async () => {
    const a = api(base);
    a.setBackupRepository.mockResolvedValue({ ...base, repository: "ready", snapshots: 4, repositoryBytes: 5_000_000 });
    show(a);
    fireEvent.click(await screen.findByRole("button", { name: "Connect existing" }));
    fireEvent.change(await screen.findByLabelText("Repository password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(a.setBackupRepository).toHaveBeenCalledWith({ mode: "connect", password: "secret" }));
    expect(await screen.findByText(/4 backups, 4\.8 MB/)).toBeTruthy();
  });

  it("shows the history, including why a run failed, and starts a run", async () => {
    const ready = {
      ...base,
      repository: "ready" as const,
      enabled: true,
      nextRunAt: Date.now() + 3_600_000,
      snapshots: 2,
      repositoryBytes: 10,
      history: [run({ id: "bk_2", status: "failed", error: "restic backup failed (exit 1)", bytesAdded: null }), run()],
    };
    const a = api({ ...ready, lastRun: ready.history[0] ?? null });
    a.runBackup.mockResolvedValue({ ...ready, running: true });
    show(a);
    expect(await screen.findByText("restic backup failed (exit 1)")).toBeTruthy();
    expect(screen.getByText("2.0 KB added")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(a.runBackup).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Backing up…" })).toBeTruthy();
  });

  it("saves the time and retention, and refuses a retention that keeps nothing", async () => {
    const ready = { ...base, repository: "ready" as const, snapshots: 1, repositoryBytes: 1 };
    const a = api(ready);
    a.updateBackups.mockResolvedValue({ ...ready, time: "04:30", retention: { daily: 3, weekly: 4, monthly: 12 } });
    show(a);
    fireEvent.change(await screen.findByLabelText("Keep daily backups"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "04:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(a.updateBackups).toHaveBeenCalledWith({
        time: "04:30",
        retention: { daily: 3, weekly: 4, monthly: 12 },
      }),
    );
    for (const key of ["daily", "weekly", "monthly"])
      fireEvent.change(screen.getByLabelText(`Keep ${key} backups`), { target: { value: "0" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/keep at least one backup/);
  });

  it("turns the schedule on and off", async () => {
    const ready = { ...base, repository: "ready" as const, snapshots: 1, repositoryBytes: 1 };
    const a = api(ready);
    a.updateBackups.mockResolvedValue({ ...ready, enabled: true, nextRunAt: Date.now() + 1000 });
    show(a);
    fireEvent.click(await screen.findByRole("switch", { name: "Back up every day" }));
    await waitFor(() => expect(a.updateBackups).toHaveBeenCalledWith({ enabled: true }));
  });

  it("forgets the repository after a confirmation", async () => {
    const ready = { ...base, repository: "ready" as const, snapshots: 1, repositoryBytes: 1 };
    const a = api(ready);
    a.forgetBackupRepository.mockResolvedValue(base);
    show(a);
    fireEvent.click(await screen.findByRole("button", { name: "Forget repository" }));
    expect(a.forgetBackupRepository).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Forget" }));
    await waitFor(() => expect(a.forgetBackupRepository).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Create repository" })).toBeTruthy();
  });
});
