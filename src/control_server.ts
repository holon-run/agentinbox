import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { ServeTransport } from "./paths";

export interface StartedControlServer {
  info: Record<string, unknown>;
  close(): Promise<void>;
}

export async function startControlServer(
  server: http.Server,
  transport: ServeTransport,
): Promise<StartedControlServer> {
  if (transport.kind === "socket") {
    await prepareSocketPath(transport.socketPath);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(transport.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return {
      info: {
        socketPath: transport.socketPath,
      },
      async close(): Promise<void> {
        await closeServer(server);
        cleanupSocketPath(transport.socketPath);
      },
    };
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(transport.port, transport.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    info: {
      url: transport.baseUrl,
    },
    async close(): Promise<void> {
      await closeServer(server);
    },
  };
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  if (!fs.existsSync(socketPath)) {
    return;
  }
  if (await canConnectToSocket(socketPath)) {
    throw new Error(`AgentInbox daemon already running at ${socketPath}`);
  }
  cleanupSocketPath(socketPath);
}

function cleanupSocketPath(socketPath: string): void {
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {
    // Best effort cleanup for stale sockets.
  }
}

function canConnectToSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
