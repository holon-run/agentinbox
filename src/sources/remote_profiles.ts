import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PollSubscriptionConfig, RuntimeInvokeOptions } from "@holon-run/uxc-daemon-client";
import { AppendSourceEventInput, SubscriptionSource } from "../model";
import {
  GITHUB_ENDPOINT,
  normalizeGithubRepoEvent,
  parseGithubSourceConfig,
} from "./github";
import {
  DEFAULT_GITHUB_CI_PER_PAGE,
  DEFAULT_GITHUB_CI_POLL_INTERVAL_SECS,
  GITHUB_CI_ENDPOINT,
  normalizeGithubWorkflowRunEvent,
  parseGithubCiSourceConfig,
} from "./github_ci";
import {
  FEISHU_OPENAPI_ENDPOINT,
  normalizeFeishuBotEvent,
  parseFeishuSourceConfig,
} from "./feishu";

export interface ManagedSourceSpec {
  endpoint: string;
  operation_id?: string | null;
  args?: Record<string, unknown> | null;
  resource_uri?: string | null;
  read_resource?: boolean;
  transport_hint?: "websocket" | "discord_gateway" | "slack_socket_mode" | "feishu_long_connection" | null;
  subprotocols?: string[];
  initial_text_frames?: string[];
  mode: "stream" | "poll";
  poll_config?: PollSubscriptionConfig | null;
  options?: RuntimeInvokeOptions;
}

export interface MappedRemoteEvent {
  sourceNativeId: string;
  eventVariant: string;
  metadata: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  occurredAt?: string;
  deliveryHandle?: AppendSourceEventInput["deliveryHandle"];
}

export interface RemoteSourceProfile {
  id: string;
  validateConfig(source: SubscriptionSource): void;
  buildManagedSourceSpec(source: SubscriptionSource): ManagedSourceSpec;
  mapRawEvent(rawPayload: Record<string, unknown>, source: SubscriptionSource): MappedRemoteEvent | null;
}

const REMOTE_USER_PROFILE_ROOT_DIR = "source-profiles";
const BUILTIN_PROFILE_IDS = new Set(["builtin.github_repo", "builtin.github_repo_ci", "builtin.feishu_bot"]);

export class RemoteSourceProfileRegistry {
  private readonly profileCache = new Map<string, RemoteSourceProfile>();

  resolve(source: SubscriptionSource, homeDir: string): Promise<RemoteSourceProfile> {
    if (source.sourceType === "github_repo") {
      return Promise.resolve(GITHUB_REPO_PROFILE);
    }
    if (source.sourceType === "github_repo_ci") {
      return Promise.resolve(GITHUB_REPO_CI_PROFILE);
    }
    if (source.sourceType === "feishu_bot") {
      return Promise.resolve(FEISHU_BOT_PROFILE);
    }
    if (source.sourceType !== "remote_source") {
      throw new Error(`unsupported source type for remote profile: ${source.sourceType}`);
    }
    return this.loadUserProfile(source, homeDir);
  }

  private async loadUserProfile(source: SubscriptionSource, homeDir: string): Promise<RemoteSourceProfile> {
    const config = source.config ?? {};
    const profilePath = asNonEmptyString(config.profilePath);
    if (!profilePath) {
      throw new Error("remote_source requires config.profilePath");
    }

    const profileRoot = path.resolve(homeDir, REMOTE_USER_PROFILE_ROOT_DIR);
    const resolvedPath = resolveAndValidateProfilePath(profileRoot, profilePath);
    const cacheKey = `${resolvedPath}:${source.sourceKey}`;
    const cached = this.profileCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`remote_source profile not found: ${resolvedPath}`);
    }

    const imported = await dynamicImportModule(pathToFileURL(resolvedPath).href);
    const profile = ((imported.default ?? imported) as RemoteSourceProfile | undefined);
    if (!profile || typeof profile !== "object") {
      throw new Error(`remote_source profile must export default object: ${resolvedPath}`);
    }
    validateProfileContract(profile, resolvedPath);
    this.profileCache.set(cacheKey, profile);
    return profile;
  }
}

async function dynamicImportModule(moduleUrl: string): Promise<Record<string, unknown>> {
  const importer = new Function("url", "return import(url);") as (url: string) => Promise<Record<string, unknown>>;
  return importer(moduleUrl);
}

export function builtInProfileIdForSourceType(sourceType: SubscriptionSource["sourceType"]): string | null {
  if (sourceType === "github_repo") {
    return "builtin.github_repo";
  }
  if (sourceType === "github_repo_ci") {
    return "builtin.github_repo_ci";
  }
  if (sourceType === "feishu_bot") {
    return "builtin.feishu_bot";
  }
  return null;
}

function validateProfileContract(profile: RemoteSourceProfile, sourcePath: string): void {
  if (!profile.id || typeof profile.id !== "string") {
    throw new Error(`remote_source profile id must be a non-empty string: ${sourcePath}`);
  }
  if (BUILTIN_PROFILE_IDS.has(profile.id)) {
    throw new Error(`remote_source profile id is reserved: ${profile.id}`);
  }
  if (typeof profile.validateConfig !== "function") {
    throw new Error(`remote_source profile missing validateConfig(): ${sourcePath}`);
  }
  if (typeof profile.buildManagedSourceSpec !== "function") {
    throw new Error(`remote_source profile missing buildManagedSourceSpec(): ${sourcePath}`);
  }
  if (typeof profile.mapRawEvent !== "function") {
    throw new Error(`remote_source profile missing mapRawEvent(): ${sourcePath}`);
  }
}

function resolveAndValidateProfilePath(profileRoot: string, profilePath: string): string {
  const resolved = path.isAbsolute(profilePath)
    ? path.resolve(profilePath)
    : path.resolve(profileRoot, profilePath);
  const normalizedRoot = ensureTrailingSep(path.resolve(profileRoot));
  const normalizedResolved = path.resolve(resolved);
  if (!normalizedResolved.startsWith(normalizedRoot) && normalizedResolved !== path.resolve(profileRoot)) {
    throw new Error(`remote_source profilePath must stay under ${profileRoot}`);
  }
  return normalizedResolved;
}

function ensureTrailingSep(input: string): string {
  return input.endsWith(path.sep) ? input : `${input}${path.sep}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const GITHUB_REPO_PROFILE: RemoteSourceProfile = {
  id: "builtin.github_repo",
  validateConfig(source: SubscriptionSource): void {
    parseGithubSourceConfig(source);
  },
  buildManagedSourceSpec(source: SubscriptionSource): ManagedSourceSpec {
    const config = parseGithubSourceConfig(source);
    return {
      endpoint: GITHUB_ENDPOINT,
      operation_id: "get:/repos/{owner}/{repo}/events",
      args: {
        owner: config.owner,
        repo: config.repo,
        per_page: config.perPage ?? 10,
      },
      mode: "poll",
      poll_config: {
        interval_secs: config.pollIntervalSecs ?? 30,
        extract_items_pointer: "",
        checkpoint_strategy: {
          type: "item_key",
          item_key_pointer: "/id",
          seen_window: 1024,
        },
      },
      options: { auth: config.uxcAuth },
    };
  },
  mapRawEvent(rawPayload: Record<string, unknown>, source: SubscriptionSource): MappedRemoteEvent | null {
    const config = parseGithubSourceConfig(source);
    const normalized = normalizeGithubRepoEvent(source, config, rawPayload);
    if (!normalized) {
      return null;
    }
    return {
      sourceNativeId: normalized.sourceNativeId,
      eventVariant: normalized.eventVariant,
      metadata: normalized.metadata ?? {},
      rawPayload: normalized.rawPayload ?? rawPayload,
      occurredAt: normalized.occurredAt,
      deliveryHandle: normalized.deliveryHandle,
    };
  },
};

const GITHUB_REPO_CI_PROFILE: RemoteSourceProfile = {
  id: "builtin.github_repo_ci",
  validateConfig(source: SubscriptionSource): void {
    parseGithubCiSourceConfig(source);
  },
  buildManagedSourceSpec(source: SubscriptionSource): ManagedSourceSpec {
    const config = parseGithubCiSourceConfig(source);
    const args: Record<string, unknown> = {
      owner: config.owner,
      repo: config.repo,
      per_page: config.perPage ?? DEFAULT_GITHUB_CI_PER_PAGE,
    };
    if (config.eventFilter) {
      args.event = config.eventFilter;
    }
    if (config.branch) {
      args.branch = config.branch;
    }
    if (config.statusFilter) {
      args.status = config.statusFilter;
    }
    return {
      endpoint: GITHUB_CI_ENDPOINT,
      operation_id: "get:/repos/{owner}/{repo}/actions/runs",
      args,
      mode: "poll",
      poll_config: {
        interval_secs: config.pollIntervalSecs ?? DEFAULT_GITHUB_CI_POLL_INTERVAL_SECS,
        extract_items_pointer: "/workflow_runs",
        checkpoint_strategy: {
          type: "item_key",
          item_key_pointer: "/id",
          seen_window: 1024,
        },
      },
      options: { auth: config.uxcAuth },
    };
  },
  mapRawEvent(rawPayload: Record<string, unknown>, source: SubscriptionSource): MappedRemoteEvent | null {
    const config = parseGithubCiSourceConfig(source);
    const normalized = normalizeGithubWorkflowRunEvent(source, config, rawPayload);
    if (!normalized) {
      return null;
    }
    return {
      sourceNativeId: normalized.sourceNativeId,
      eventVariant: normalized.eventVariant,
      metadata: normalized.metadata ?? {},
      rawPayload: normalized.rawPayload ?? rawPayload,
      occurredAt: normalized.occurredAt,
      deliveryHandle: normalized.deliveryHandle,
    };
  },
};

const FEISHU_BOT_PROFILE: RemoteSourceProfile = {
  id: "builtin.feishu_bot",
  validateConfig(source: SubscriptionSource): void {
    parseFeishuSourceConfig(source);
  },
  buildManagedSourceSpec(source: SubscriptionSource): ManagedSourceSpec {
    const config = parseFeishuSourceConfig(source);
    return {
      endpoint: config.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      mode: "stream",
      transport_hint: "feishu_long_connection",
      options: { auth: config.uxcAuth },
    };
  },
  mapRawEvent(rawPayload: Record<string, unknown>, source: SubscriptionSource): MappedRemoteEvent | null {
    const config = parseFeishuSourceConfig(source);
    const normalized = normalizeFeishuBotEvent(source, config, rawPayload);
    if (!normalized) {
      return null;
    }
    return {
      sourceNativeId: normalized.sourceNativeId,
      eventVariant: normalized.eventVariant,
      metadata: normalized.metadata ?? {},
      rawPayload: normalized.rawPayload ?? rawPayload,
      occurredAt: normalized.occurredAt,
      deliveryHandle: normalized.deliveryHandle,
    };
  },
};

export function profileConfigForSource(source: SubscriptionSource): Record<string, unknown> {
  const config = asRecord(source.config);
  if (source.sourceType === "remote_source") {
    return asRecord(config.profileConfig);
  }
  return config;
}
