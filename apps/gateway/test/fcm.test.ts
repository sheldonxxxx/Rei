import { createVerify, generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { createFcmSender, readFcmAccount } from "../src/core/notify/fcm.ts";

it("signs and caches an OAuth token, sends data-only messages, and only removes unregistered destinations", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const email = "testing@example.test";
  const account = await readFcmAccount(
    JSON.stringify({
      project_id: "example-project",
      client_email: email,
      private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
    }),
  );
  await expect(readFcmAccount("{}")).rejects.toThrow("not a valid Firebase service account");
  const now = 1000;
  let exchanges = 0;
  let sends = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      exchanges++;
      const form = new URLSearchParams(init?.body as URLSearchParams);
      const [header, claims, signature] = form.get("assertion")!.split(".");
      expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
        iss: email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: url,
        iat: 1,
        exp: 3601,
      });
      expect(
        createVerify("RSA-SHA256")
          .update(`${header}.${claims}`)
          .verify(publicKey, Buffer.from(signature!, "base64url")),
      ).toBe(true);
      return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
    }
    sends++;
    expect(url).toBe("https://fcm.googleapis.com/v1/projects/example-project/messages:send");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mock-access-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      message: { token: "registration", data: { title: "Rei" }, android: { ttl: "60s", priority: "high" } },
    });
    if (sends === 1) return Response.json({ name: "message-id" });
    if (sends === 2) return Response.json({ error: {} }, { status: 404, headers: { "retry-after": "20" } });
    return Response.json(
      {
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "UNREGISTERED",
            },
          ],
        },
      },
      { status: 404 },
    );
  };
  const send = createFcmSender(account, fetchMock, () => now);
  const content = { token: "registration", data: { title: "Rei" }, ttl: 60, urgent: true };
  expect(await send(content)).toEqual({ ok: true });
  expect(await send(content)).toEqual({ ok: false, status: 404, gone: false, retryAfterMs: 20_000 });
  expect(await send(content)).toEqual({ ok: false, status: 404, gone: true });
  expect(exchanges).toBe(1);
  expect(sends).toBe(3);
});
