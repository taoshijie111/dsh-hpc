import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";

export type Relay = {
  /** Socket path the carrier connects to (Unix domain socket or Windows named pipe). */
  path: string;
  close(): Promise<void>;
};

/** A private socket path; Windows has no filesystem sockets, so a named pipe is used. */
export function relayPath(dataDir: string, id: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\multiservers-${id}` : join(dataDir, `relay-${id}.sock`);
}

/**
 * The service side of the carrier's upstream: a private socket that only the
 * carrier can use, relayed to the harness's loopback HTTP port. The carrier
 * therefore never holds a general-purpose network client towards the harness.
 */
export function createRelay(targetPort: number, socketPath: string): Promise<Relay> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket) => {
      const upstream = connect({ port: targetPort, host: "127.0.0.1" });
      socket.pipe(upstream);
      upstream.pipe(socket);
      const destroyBoth = () => {
        socket.destroy();
        upstream.destroy();
      };
      socket.on("error", destroyBoth);
      upstream.on("error", destroyBoth);
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    });
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      server.on("error", () => undefined);
      resolve({
        path: socketPath,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
