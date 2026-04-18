import { HostType, RegisterSourceInput, SourceType } from "./model";

export interface SourceRegistrationResolution {
  hostType: HostType;
  hostKey: string;
  hostConfig: Record<string, unknown>;
  streamKind: string;
  streamKey: string;
  streamConfig: Record<string, unknown>;
  sourceType: SourceType;
}

export function resolveSourceRegistration(input: RegisterSourceInput): SourceRegistrationResolution {
  const config = input.config ?? {};
  if (input.sourceType === "github_repo") {
    return {
      hostType: "github",
      hostKey: `uxcAuth:${stringOrDefault(config.uxcAuth, input.configRef ?? "default")}`,
      hostConfig: {
        ...(valueOrUndefined(config.uxcAuth) ? { uxcAuth: config.uxcAuth } : {}),
      },
      streamKind: "repo_events",
      streamKey: input.sourceKey,
      streamConfig: config,
      sourceType: input.sourceType,
    };
  }
  if (input.sourceType === "github_repo_ci") {
    return {
      hostType: "github",
      hostKey: `uxcAuth:${stringOrDefault(config.uxcAuth, input.configRef ?? "default")}`,
      hostConfig: {
        ...(valueOrUndefined(config.uxcAuth) ? { uxcAuth: config.uxcAuth } : {}),
      },
      streamKind: "ci_runs",
      streamKey: input.sourceKey,
      streamConfig: config,
      sourceType: input.sourceType,
    };
  }
  if (input.sourceType === "feishu_bot") {
    return {
      hostType: "feishu",
      hostKey: `app:${stringOrDefault(config.appId, input.configRef ?? input.sourceKey)}`,
      hostConfig: {
        ...(valueOrUndefined(config.appId) ? { appId: config.appId } : {}),
        ...(valueOrUndefined(config.appSecret) ? { appSecret: config.appSecret } : {}),
        ...(valueOrUndefined(config.schemaUrl) ? { schemaUrl: config.schemaUrl } : {}),
        ...(valueOrUndefined(config.replyInThread) ? { replyInThread: config.replyInThread } : {}),
        ...(valueOrUndefined(config.uxcAuth) ? { uxcAuth: config.uxcAuth } : {}),
      },
      streamKind: "message_events",
      streamKey: input.sourceKey,
      streamConfig: config,
      sourceType: input.sourceType,
    };
  }
  if (input.sourceType === "local_event") {
    return {
      hostType: "local_event",
      hostKey: input.sourceKey,
      hostConfig: {},
      streamKind: "events",
      streamKey: input.sourceKey,
      streamConfig: config,
      sourceType: input.sourceType,
    };
  }
  return {
    hostType: "remote_source",
    hostKey: input.sourceKey,
    hostConfig: config,
    streamKind: "default",
    streamKey: input.sourceKey,
    streamConfig: config,
    sourceType: input.sourceType,
  };
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function valueOrUndefined(value: unknown): boolean {
  return value !== undefined && value !== null;
}
