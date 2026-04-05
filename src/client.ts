import http from "node:http";
import https from "node:https";
import { ClientTransport } from "./paths";

export interface AgentInboxResponse<T = unknown> {
  statusCode: number;
  data: T;
}

export class AgentInboxClient {
  constructor(private readonly transport: ClientTransport) {}

  async request<T = unknown>(
    endpoint: string,
    body?: unknown,
    method: "GET" | "POST" = "POST",
  ): Promise<AgentInboxResponse<T>> {
    if (this.transport.kind === "socket") {
      return requestViaSocket<T>(this.transport.socketPath, endpoint, body, method);
    }
    return requestViaUrl<T>(this.transport.baseUrl, endpoint, body, method);
  }
}

function requestViaSocket<T>(
  socketPath: string,
  endpoint: string,
  body: unknown,
  method: "GET" | "POST",
): Promise<AgentInboxResponse<T>> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        socketPath,
        path: normalizeEndpoint(endpoint),
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        void collectResponse<T>(res).then(resolve, reject);
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function requestViaUrl<T>(
  baseUrl: string,
  endpoint: string,
  body: unknown,
  method: "GET" | "POST",
): Promise<AgentInboxResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(normalizeEndpoint(endpoint), baseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        void collectResponse<T>(res).then(resolve, reject);
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function collectResponse<T>(res: http.IncomingMessage): Promise<AgentInboxResponse<T>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    res.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = raw ? JSON.parse(raw) as T : ({} as T);
        resolve({
          statusCode: res.statusCode ?? 500,
          data: parsed,
        });
      } catch (error) {
        reject(error);
      }
    });
    res.on("error", reject);
  });
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}
