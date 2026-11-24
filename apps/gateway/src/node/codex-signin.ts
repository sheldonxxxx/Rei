import type { CodexImagesSetup, CodexImagesSignInStatus } from "../core/types.ts";
import { CODEX_DEVICE_URL, CODEX_IMAGES, loginCodexImages } from "./codex-auth.ts";
import type { FileCredentialStore } from "./credstore.ts";

interface Attempt {
  userCode: string;
  controller: AbortController;
}

/**
 * The web app's way to sign in to Codex Images: one device-code attempt at a time, held here so a page reload or a
 * second tab finds it again. The credential goes to the same store the CLI writes; no token ever leaves the gateway.
 */
export function codexImagesSetup(
  store: FileCredentialStore,
  login: typeof loginCodexImages = loginCodexImages,
): CodexImagesSetup {
  let attempt: Attempt | undefined;
  let error: string | undefined;
  const signedIn = async () => (await store.read(CODEX_IMAGES))?.type === "oauth";
  const status = async (): Promise<CodexImagesSignInStatus> => ({
    enabled: true,
    signedIn: await signedIn(),
    pending: attempt !== undefined,
    ...(attempt ? { userCode: attempt.userCode, verificationUrl: CODEX_DEVICE_URL } : {}),
    ...(!attempt && error ? { error } : {}),
  });
  return {
    status,
    async start() {
      if (attempt) throw new Error("A Codex Images sign-in is already in progress.");
      error = undefined;
      const controller = new AbortController();
      const shown = Promise.withResolvers<string>();
      // The attempt exists from the moment the code does; a failure before that rejects `start`, a later one shows in status.
      let current: Attempt | undefined;
      const running = login(
        store,
        (userCode) => {
          current = { userCode, controller };
          attempt = current;
          shown.resolve(userCode);
        },
        controller.signal,
      );
      running.then(
        () => {
          if (current && attempt === current) attempt = undefined;
        },
        (cause: unknown) => {
          if (!current) return shown.reject(cause);
          if (attempt !== current) return;
          attempt = undefined;
          if (controller.signal.aborted) return;
          error =
            cause instanceof Error && cause.name === "TimeoutError"
              ? "The sign-in code expired. Start again."
              : cause instanceof Error
                ? cause.message
                : "Codex Images sign-in failed.";
        },
      );
      return { userCode: await shown.promise, verificationUrl: CODEX_DEVICE_URL };
    },
    cancel() {
      attempt?.controller.abort();
      attempt = undefined;
    },
    async signOut() {
      attempt?.controller.abort();
      attempt = undefined;
      await store.delete(CODEX_IMAGES);
    },
  };
}
