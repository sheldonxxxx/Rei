interface OpenPickerSelection {
  finished(): Promise<string | null> | undefined;
  cancel(): void;
}

export interface OpenPickerWindow extends Window {
  __reiArmOpenFilePicker?: (timeout: number) => OpenPickerSelection | undefined;
  showOpenFilePicker?: (options?: { multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
}

interface StorageBuckets {
  open(name: string, options: { expires: number }): Promise<{ getDirectory(): Promise<FileSystemDirectoryHandle> }>;
  delete(name: string): Promise<void>;
}

// Serialized by Playwright and installed before site scripts can cache showOpenFilePicker.
export function installOpenFilePicker(): void {
  const page = window as OpenPickerWindow;
  const nativeOpen = page.showOpenFilePicker;
  if (!nativeOpen || page.__reiArmOpenFilePicker) return;
  const buckets = (navigator as Navigator & { storageBuckets?: StorageBuckets }).storageBuckets;
  if (!buckets) return;
  try {
    // Match Chromium's restriction on native pickers in cross-origin frames.
    if (page.origin === "null" || page.top?.origin !== page.origin) return;
  } catch {
    return;
  }

  type Selection = { completion?: Promise<string | null>; cancel?: () => void };
  let active: Selection | undefined;
  Object.defineProperty(page, "__reiArmOpenFilePicker", {
    value: (timeout: number) => {
      if (active) return undefined;
      const selection: Selection = {};
      active = selection;
      const cancel = () => {
        clearTimeout(timer);
        if (active === selection) active = undefined;
        selection.cancel?.();
      };
      const timer = setTimeout(cancel, timeout);
      return {
        finished: () => selection.completion,
        cancel,
      };
    },
  });

  page.showOpenFilePicker = async (options) => {
    const selection = active;
    if (!selection) return nativeOpen.call(page, options);
    if (selection.completion || !navigator.userActivation.isActive)
      throw new DOMException("The file picker is unavailable.", "AbortError");

    // Route the request through the same chooser and frame checks as an ordinary HTML input.
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    input.multiple = options?.multiple === true;
    const selected = new Promise<File>((resolve, reject) => {
      const cancel = () => reject(new DOMException("No file selected.", "AbortError"));
      selection.cancel = cancel;
      input.addEventListener("cancel", cancel, { once: true });
      input.addEventListener(
        "change",
        () => {
          const file = input.files?.[0];
          if (file) resolve(file);
          else cancel();
        },
        { once: true },
      );
    });
    const result = selected
      .then(async (file) => {
        // A real handle supports getFile, instanceof and structured clone. It points only to a copy in
        // the receiving origin's expiring storage bucket, so the page cannot access the source workspace.
        const name = `rei-upload-${crypto.randomUUID()}`;
        try {
          const bucket = await buckets.open(name, { expires: Date.now() + 60 * 60 * 1000 });
          const dir = await bucket.getDirectory();
          const handle = await dir.getFileHandle(file.name, { create: true });
          const writable = await handle.createWritable();
          await file.stream().pipeTo(writable);
          const getFile = handle.getFile.bind(handle);
          const type = file.type;
          Object.defineProperty(handle, "getFile", {
            value: async () => {
              const copy = await getFile();
              return copy.type === type ? copy : new File([copy], copy.name, { type, lastModified: copy.lastModified });
            },
          });
          return [handle];
        } catch (error) {
          await buckets.delete(name).catch(() => undefined);
          throw error;
        }
      })
      .finally(() => input.remove());
    selection.completion = result.then(
      () => null,
      () => "The browser could not supply a file handle to the page.",
    );
    try {
      document.documentElement.append(input);
      input.click();
    } catch {
      selection.cancel?.();
    }
    return result;
  };
}
