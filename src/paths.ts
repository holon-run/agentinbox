import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_AGENTINBOX_PORT = 4747;

export interface ResolveServeConfigInput {
  env?: NodeJS.ProcessEnv;
  homeDirOverride?: string;
  statePathOverride?: string;
  socketPathOverride?: string;
  portOverride?: number;
}

export interface ResolveClientTransportInput {
  env?: NodeJS.ProcessEnv;
  homeDirOverride?: string;
  socketPathOverride?: string;
  baseUrlOverride?: string;
}

export type ServeTransport =
  | { kind: "socket"; socketPath: string }
  | { kind: "tcp"; host: string; port: number; baseUrl: string };

export type ClientTransport =
  | { kind: "socket"; socketPath: string; source: "flag" | "env" | "default" }
  | { kind: "url"; baseUrl: string; source: "flag" | "env" | "fallback" };

export interface ResolvedServeConfig {
  homeDir: string;
  dbPath: string;
  transport: ServeTransport;
  warnings: string[];
}

export function resolveAgentInboxHome(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  if (override) {
    return path.resolve(override);
  }
  if (env.AGENTINBOX_HOME) {
    return path.resolve(env.AGENTINBOX_HOME);
  }
  return path.join(os.homedir(), ".agentinbox");
}

export function resolveServeConfig(input: ResolveServeConfigInput = {}): ResolvedServeConfig {
  const env = input.env ?? process.env;
  const homeDir = resolveAgentInboxHome(env, input.homeDirOverride);
  const dbPath = resolveDbPath({
    env,
    homeDir,
    statePathOverride: input.statePathOverride,
  });

  if (input.socketPathOverride && input.portOverride != null) {
    throw new Error("serve accepts either --socket or --port, not both");
  }

  if (input.socketPathOverride) {
    return {
      homeDir,
      dbPath,
      transport: {
        kind: "socket",
        socketPath: path.resolve(input.socketPathOverride),
      },
      warnings: [],
    };
  }

  if (input.portOverride != null) {
    return {
      homeDir,
      dbPath,
      transport: {
        kind: "tcp",
        host: "127.0.0.1",
        port: input.portOverride,
        baseUrl: `http://127.0.0.1:${input.portOverride}`,
      },
      warnings: [],
    };
  }

  return {
    homeDir,
    dbPath,
    transport: {
      kind: "socket",
      socketPath: resolveSocketPath(env, homeDir, input.socketPathOverride),
    },
    warnings: [],
  };
}

export function resolveClientTransport(input: ResolveClientTransportInput = {}): ClientTransport {
  const env = input.env ?? process.env;
  const homeDir = resolveAgentInboxHome(env, input.homeDirOverride);

  if (input.socketPathOverride && input.baseUrlOverride) {
    throw new Error("client accepts either --socket or --url, not both");
  }

  if (input.socketPathOverride) {
    return {
      kind: "socket",
      socketPath: path.resolve(input.socketPathOverride),
      source: "flag",
    };
  }

  if (input.baseUrlOverride) {
    return {
      kind: "url",
      baseUrl: input.baseUrlOverride,
      source: "flag",
    };
  }

  if (env.AGENTINBOX_SOCKET) {
    return {
      kind: "socket",
      socketPath: path.resolve(env.AGENTINBOX_SOCKET),
      source: "env",
    };
  }

  if (env.AGENTINBOX_URL) {
    return {
      kind: "url",
      baseUrl: env.AGENTINBOX_URL,
      source: "env",
    };
  }

  const defaultSocketPath = resolveSocketPath(env, homeDir);
  if (fs.existsSync(defaultSocketPath)) {
    return {
      kind: "socket",
      socketPath: defaultSocketPath,
      source: "default",
    };
  }

  return {
    kind: "url",
    baseUrl: `http://127.0.0.1:${DEFAULT_AGENTINBOX_PORT}`,
    source: "fallback",
  };
}

interface ResolveDbPathInput {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  statePathOverride?: string;
}

function resolveDbPath(input: ResolveDbPathInput): string {
  if (input.statePathOverride) {
    return path.resolve(input.statePathOverride);
  }
  if (input.env.AGENTINBOX_DB_PATH) {
    return path.resolve(input.env.AGENTINBOX_DB_PATH);
  }
  return path.join(input.homeDir, "agentinbox.sqlite");
}

function resolveSocketPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  override?: string,
): string {
  if (override) {
    return path.resolve(override);
  }
  if (env.AGENTINBOX_SOCKET) {
    return path.resolve(env.AGENTINBOX_SOCKET);
  }
  return path.join(homeDir, "agentinbox.sock");
}
