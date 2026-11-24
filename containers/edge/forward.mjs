// The edge: the only container with a published port. It forwards TCP to the control plane, which sits on the
// internal network only (no internet, D30); Docker cannot publish a port from an internal-only network. It holds no
// secrets and parses nothing. Later this is where TLS or a tunnel goes.
import net from "node:net";

const [host, port] = (process.env.EDGE_TARGET ?? "control:8787").split(":");
const listen = Number(process.env.EDGE_PORT ?? 8787);

const server = net.createServer((client) => {
  const upstream = net.connect(Number(port), host);
  const drop = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", drop);
  upstream.on("error", drop);
  client.pipe(upstream).pipe(client);
});
server.listen(listen, "0.0.0.0", () =>
  console.log(JSON.stringify({ event: "edge.listening", port: listen, target: `${host}:${port}` })),
);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
