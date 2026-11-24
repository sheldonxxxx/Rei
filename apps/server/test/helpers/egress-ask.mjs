// Stands in for the egress proxy inside a sandbox command: asks the control plane's decide socket about a destination
// with the token that is in the proxy variables, and prints "<decision> <message>".
import http from "node:http";

const [, , socketPath, host, port] = process.argv;
const token = decodeURIComponent(new URL(process.env.HTTPS_PROXY).password);
const body = JSON.stringify({ token, host, port: Number(port) });
const req = http.request(
  {
    socketPath,
    path: "/egress/decide",
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
  },
  (res) => {
    let text = "";
    res.on("data", (c) => (text += c));
    res.on("end", () => {
      const r = JSON.parse(text);
      console.log(`${r.decision}${r.message ? ` ${r.message}` : ""}`);
    });
  },
);
req.on("error", (e) => {
  console.log(`error ${e.message}`);
  process.exitCode = 1;
});
req.end(body);
