import http from "node:http";
import https from "node:https";
import { ClientTransport } from "./paths";
import { InboxWatchEvent, WatchInboxOptions } from "./model";

export interface AgentInboxResponse<T = unknown> {
  statusCode: number;
  data: T;
}

export class AgentInboxClient {
  constructor(private readonly transport: ClientTransport) {}

  async request<T = unknown>(
    endpoint: string,
    body?: unknown,
    method: "GET" | "POST" | "DELETE" = "POST",
  ): Promise<AgentInboxResponse<T>> {
    if (this.transport.kind === "socket") {
      return requestViaSocket<T>(this.transport.socketPath, endpoint, body, method);
    }
    return requestViaUrl<T>(this.transport.baseUrl, endpoint, body, method);
  }

  watchInbox(agentId: string, options: WatchInboxOptions = {}): AsyncIterable<InboxWatchEvent> {
    const query = new URLSearchParams();
    if (options.afterItemId) {
      query.set("after_item_id", options.afterItemId);
    }
    if (options.includeAcked) {
      query.set("include_acked", "true");
    }
    if (options.heartbeatMs) {
      query.set("heartbeat_ms", String(options.heartbeatMs));
    }
    const endpoint = `/agents/${encodeURIComponent(agentId)}/inbox/watch${query.size > 0 ? `?${query.toString()}` : ""}`;

    if (this.transport.kind === "socket") {
      return watchViaSocket(this.transport.socketPath, endpoint);
    }
    return watchViaUrl(this.transport.baseUrl, endpoint);
  }
}

function requestViaSocket<T>(
  socketPath: string,
  endpoint: string,
  body: unknown,
  method: "GET" | "POST" | "DELETE",
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
  method: "GET" | "POST" | "DELETE",
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

function watchViaSocket(socketPath: string, endpoint: string): AsyncIterable<InboxWatchEvent> {
  return createSseStream((handleResponse) => {
    const req = http.request(
      {
        socketPath,
        path: normalizeEndpoint(endpoint),
        method: "GET",
        headers: {
          accept: "text/event-stream",
        },
      },
      handleResponse,
    );
    req.end();
    return req;
  });
}

function watchViaUrl(baseUrl: string, endpoint: string): AsyncIterable<InboxWatchEvent> {
  return createSseStream((handleResponse) => {
    const url = new URL(normalizeEndpoint(endpoint), baseUrl);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          accept: "text/event-stream",
        },
      },
      handleResponse,
    );
    req.end();
    return req;
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

function createSseStream(
  openRequest: (handleResponse: (res: http.IncomingMessage) => void) => http.ClientRequest,
): AsyncIterable<InboxWatchEvent> {
  const queue: InboxWatchEvent[] = [];
  const waiters: Array<(result: IteratorResult<InboxWatchEvent>) => void> = [];
  let done = false;
  let failure: Error | null = null;
  let request: http.ClientRequest | null = null;
  let response: http.IncomingMessage | null = null;

  const push = (event: InboxWatchEvent) => {
    if (done) {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    queue.push(event);
  };

  const finish = (error?: Error) => {
    if (done) {
      return;
    }
    done = true;
    failure = error ?? null;
    request?.destroy();
    response?.destroy();
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) {
        continue;
      }
      waiter({ value: undefined, done: true });
    }
  };

  request = openRequest((res) => {
    response = res;
    if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        finish(new Error(body || `watch failed with status ${res.statusCode ?? 500}`));
      });
      return;
    }

    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      try {
        buffer += chunk;
        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex >= 0) {
          const frame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const event = parseSseFrame(frame);
          if (event) {
            push(event);
          }
          separatorIndex = buffer.indexOf("\n\n");
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    res.on("end", () => {
      finish();
    });
    res.on("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });

  request.on("error", (error) => {
    finish(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    [Symbol.asyncIterator](): AsyncIterator<InboxWatchEvent> {
      return {
        next(): Promise<IteratorResult<InboxWatchEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as InboxWatchEvent, done: false });
          }
          if (done) {
            if (failure) {
              return Promise.reject(failure);
            }
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<InboxWatchEvent>>((resolve) => {
            waiters.push(resolve);
          }).then((result) => {
            if (result.done && failure) {
              throw failure;
            }
            return result;
          });
        },
        return(): Promise<IteratorResult<InboxWatchEvent>> {
          finish();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function parseSseFrame(frame: string): InboxWatchEvent | null {
  const lines = frame
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !line.startsWith(":"));
  if (lines.length === 0) {
    return null;
  }

  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const payload = JSON.parse(dataLines.join("\n")) as InboxWatchEvent;
  if (eventName !== payload.event) {
    throw new Error(`unexpected SSE event name ${eventName} for payload event ${payload.event}`);
  }
  return payload;
}
