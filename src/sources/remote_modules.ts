import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PollSubscriptionConfig, RuntimeInvokeOptions } from "@holon-run/uxc-daemon-client";
import {
  ActivationItem,
  AppendSourceEventInput,
  CleanupPolicy,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryOperationDescriptor,
  NotificationGrouping,
  SourceSchemaField,
  SourceStream,
  SubscriptionFilter,
} from "../model";
import {
  deriveGithubTrackedResource,
  expandGithubSubscriptionShortcut,
  GITHUB_ENDPOINT,
  githubDeliveryOperationsForHandle,
  githubSubscriptionShortcutSpec,
  invokeGithubDeliveryOperation,
  normalizeGithubRepoEvent,
  parseGithubSourceConfig,
  projectGithubLifecycleSignal,
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
  feishuDeliveryOperationsForHandle,
  invokeFeishuDeliveryOperation,
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

export interface RemoteSourceCapabilityDescription {
  sourceKind?: string;
  aliases?: string[];
  configSchema?: SourceSchemaField[];
  metadataFields?: SourceSchemaField[];
  eventVariantExamples?: string[];
  payloadExamples?: Record<string, unknown>[];
}

export interface SubscriptionShortcutSpec {
  name: string;
  description: string;
  argsSchema?: SourceSchemaField[];
}

export interface ExpandedSubscriptionInput {
  filter?: SubscriptionFilter;
  trackedResourceRef?: string | null;
  cleanupPolicy?: CleanupPolicy | null;
}

export interface ExpandedSubscriptionMember extends ExpandedSubscriptionInput {
  streamKind?: string | null;
}

export interface ExpandedSubscriptionPlan {
  members: ExpandedSubscriptionMember[];
}

export interface ExpandSubscriptionShortcutInput {
  name: string;
  args?: Record<string, unknown>;
  source: SourceStream;
}

export interface LifecycleSignal {
  ref: string;
  terminal: boolean;
  state?: string | null;
  result?: string | null;
  occurredAt?: string;
}

export interface ListDeliveryOperationsInput {
  handle: DeliveryHandle;
  source?: SourceStream | null;
}

export interface InvokeDeliveryOperationInput {
  handle: DeliveryHandle;
  operation: string;
  input: Record<string, unknown>;
  attempt: DeliveryAttempt;
  source?: SourceStream | null;
}

export interface RemoteSourceModule {
  id: string;
  validateConfig(source: SourceStream): void;
  buildManagedSourceSpec(source: SourceStream): ManagedSourceSpec;
  mapRawEvent(rawPayload: Record<string, unknown>, source: SourceStream): MappedRemoteEvent | null;
  // Optional capability hooks used by resolved schema and future subscription ergonomics.
  describeCapabilities?(source: SourceStream): RemoteSourceCapabilityDescription;
  listSubscriptionShortcuts?(source: SourceStream): SubscriptionShortcutSpec[];
  expandSubscriptionShortcut?(input: ExpandSubscriptionShortcutInput): ExpandedSubscriptionInput | ExpandedSubscriptionPlan | null;
  deriveTrackedResource?(filter: SubscriptionFilter, source: SourceStream): { ref: string } | null;
  projectLifecycleSignal?(rawPayload: Record<string, unknown>, source: SourceStream): LifecycleSignal | null;
  deriveInlinePreview?(item: ActivationItem, source: SourceStream): string | null;
  deriveNotificationGrouping?(item: ActivationItem, source: SourceStream): NotificationGrouping | null;
  listDeliveryOperations?(input: ListDeliveryOperationsInput): DeliveryOperationDescriptor[];
  invokeDeliveryOperation?(input: InvokeDeliveryOperationInput): Promise<{ status: DeliveryAttempt["status"]; note: string }>;
  summarizeDigestThread?(items: ActivationItem[], source: SourceStream, grouping: NotificationGrouping): string | null;
}

const REMOTE_USER_MODULE_ROOT_DIR = "source-modules";
const BUILTIN_MODULE_IDS = new Set(["builtin.github_repo", "builtin.github_repo_ci", "builtin.feishu_bot"]);

export class RemoteSourceModuleRegistry {
  private readonly moduleCache = new Map<string, RemoteSourceModule>();

  resolve(source: SourceStream, homeDir: string): Promise<RemoteSourceModule> {
    if (source.sourceType === "github_repo") {
      return Promise.resolve(GITHUB_REPO_MODULE);
    }
    if (source.sourceType === "github_repo_ci") {
      return Promise.resolve(GITHUB_REPO_CI_MODULE);
    }
    if (source.sourceType === "feishu_bot") {
      return Promise.resolve(FEISHU_BOT_MODULE);
    }
    if (source.sourceType !== "remote_source") {
      throw new Error(`unsupported source type for remote module: ${source.sourceType}`);
    }
    return this.loadUserModule(source, homeDir);
  }

  private async loadUserModule(source: SourceStream, homeDir: string): Promise<RemoteSourceModule> {
    const config = source.config ?? {};
    const modulePath = asNonEmptyString(config.modulePath);
    if (!modulePath) {
      throw new Error("remote_source requires config.modulePath (module path)");
    }

    const moduleRoot = path.resolve(homeDir, REMOTE_USER_MODULE_ROOT_DIR);
    const resolvedPath = resolveAndValidateModulePath(moduleRoot, modulePath);
    const cacheKey = `${resolvedPath}:${source.sourceKey}`;
    const cached = this.moduleCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`remote_source module not found: ${resolvedPath}`);
    }

    const imported = await dynamicImportModule(pathToFileURL(resolvedPath).href);
    const module = ((imported.default ?? imported) as RemoteSourceModule | undefined);
    if (!module || typeof module !== "object") {
      throw new Error(`remote_source module must export default object: ${resolvedPath}`);
    }
    validateModuleContract(module, resolvedPath);
    this.moduleCache.set(cacheKey, module);
    return module;
  }
}

async function dynamicImportModule(moduleUrl: string): Promise<Record<string, unknown>> {
  const importer = new Function("url", "return import(url);") as (url: string) => Promise<Record<string, unknown>>;
  return importer(moduleUrl);
}

export function builtInModuleIdForSourceType(sourceType: SourceStream["sourceType"]): string | null {
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

function validateModuleContract(module: RemoteSourceModule, sourcePath: string): void {
  if (!module.id || typeof module.id !== "string") {
    throw new Error(`remote_source module id must be a non-empty string: ${sourcePath}`);
  }
  if (BUILTIN_MODULE_IDS.has(module.id)) {
    throw new Error(`remote_source module id is reserved: ${module.id}`);
  }
  if (typeof module.validateConfig !== "function") {
    throw new Error(`remote_source module missing validateConfig(): ${sourcePath}`);
  }
  if (typeof module.buildManagedSourceSpec !== "function") {
    throw new Error(`remote_source module missing buildManagedSourceSpec(): ${sourcePath}`);
  }
  if (typeof module.mapRawEvent !== "function") {
    throw new Error(`remote_source module missing mapRawEvent(): ${sourcePath}`);
  }
  validateOptionalHook(module.describeCapabilities, "describeCapabilities", sourcePath);
  validateOptionalHook(module.listSubscriptionShortcuts, "listSubscriptionShortcuts", sourcePath);
  validateOptionalHook(module.expandSubscriptionShortcut, "expandSubscriptionShortcut", sourcePath);
  validateOptionalHook(module.deriveTrackedResource, "deriveTrackedResource", sourcePath);
  validateOptionalHook(module.projectLifecycleSignal, "projectLifecycleSignal", sourcePath);
  validateOptionalHook(module.deriveInlinePreview, "deriveInlinePreview", sourcePath);
  validateOptionalHook(module.deriveNotificationGrouping, "deriveNotificationGrouping", sourcePath);
  validateOptionalHook(module.listDeliveryOperations, "listDeliveryOperations", sourcePath);
  validateOptionalHook(module.invokeDeliveryOperation, "invokeDeliveryOperation", sourcePath);
  validateOptionalHook(module.summarizeDigestThread, "summarizeDigestThread", sourcePath);
}

function validateOptionalHook(value: unknown, name: string, sourcePath: string): void {
  if (value !== undefined && typeof value !== "function") {
    throw new Error(`remote_source module ${name} must be a function when provided: ${sourcePath}`);
  }
}

function resolveAndValidateModulePath(moduleRoot: string, modulePath: string): string {
  const resolved = path.isAbsolute(modulePath)
    ? path.resolve(modulePath)
    : path.resolve(moduleRoot, modulePath);
  const normalizedRoot = ensureTrailingSep(path.resolve(moduleRoot));
  const normalizedResolved = path.resolve(resolved);
  if (!normalizedResolved.startsWith(normalizedRoot) && normalizedResolved !== path.resolve(moduleRoot)) {
    throw new Error(`remote_source modulePath must stay under ${moduleRoot}`);
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

const GITHUB_REPO_MODULE: RemoteSourceModule = {
  id: "builtin.github_repo",
  listDeliveryOperations(input: ListDeliveryOperationsInput): DeliveryOperationDescriptor[] {
    return githubDeliveryOperationsForHandle(input.handle);
  },
  async invokeDeliveryOperation(input: InvokeDeliveryOperationInput): Promise<{ status: DeliveryAttempt["status"]; note: string }> {
    return invokeGithubDeliveryOperation(input.handle, input.operation, input.input);
  },
  describeCapabilities(source: SourceStream): RemoteSourceCapabilityDescription {
    const config = parseGithubSourceConfig(source);
    return {
      sourceKind: "github_repo",
      aliases: ["github_repo"],
      configSchema: [
        { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
        { name: "repo", type: "string", required: true, description: "GitHub repository name." },
        { name: "uxcAuth", type: "string", required: false, description: "Optional uxc auth profile." },
        { name: "eventTypes", type: "string[]", required: false, description: "Optional GitHub event type allowlist." },
        { name: "perPage", type: "number", required: false, description: `Repository events requested per poll. Default ${config.perPage ?? 10}.` },
        { name: "pollIntervalSecs", type: "number", required: false, description: `Polling interval in seconds. Default ${config.pollIntervalSecs ?? 30}.` },
      ],
      metadataFields: [
        { name: "eventType", type: "string", description: "GitHub event type such as IssueCommentEvent." },
        { name: "action", type: "string", description: "GitHub event action suffix such as created." },
        { name: "author", type: "string|null", description: "Actor login for the event." },
        { name: "isPullRequest", type: "boolean", description: "Whether the event targets a pull request surface." },
        { name: "reviewState", type: "string|null", description: "Review decision state for PullRequestReviewEvent such as approved or changes_requested." },
        { name: "labels", type: "string[]", description: "Labels extracted from the issue or pull request." },
        { name: "mentions", type: "string[]", description: "Mention handles extracted from title/body/comment text." },
        { name: "number", type: "number|null", description: "Issue or pull request number when present." },
        { name: "repoFullName", type: "string", description: "Repository full name in owner/repo form." },
        { name: "title", type: "string|null", description: "Issue, pull request, or comment title." },
        { name: "body", type: "string|null", description: "Issue, pull request, or comment body text." },
        { name: "url", type: "string|null", description: "Primary GitHub HTML URL for the event target." },
      ],
      payloadExamples: [
        {
          id: "1234567891",
          type: "PullRequestReviewEvent",
          action: "created",
          actor: "Copilot",
          pull_request: { number: 67, title: "feat: add remote module capability hooks" },
          review: { state: "commented", body: "review summary" },
        },
        {
          id: "1234567892",
          type: "PullRequestEvent",
          action: "closed",
          actor: "jolestar",
          pull_request: { number: 72, title: "feat: add cleanup policy lifecycle engine", merged: true },
        },
      ],
      eventVariantExamples: [
        "IssueCommentEvent.created",
        "PullRequestEvent.opened",
        "PullRequestEvent.closed",
        "PullRequestReviewEvent.created",
        "PullRequestReviewCommentEvent.created",
      ],
    };
  },
  listSubscriptionShortcuts(): SubscriptionShortcutSpec[] {
    return githubSubscriptionShortcutSpec();
  },
  expandSubscriptionShortcut(input: ExpandSubscriptionShortcutInput): ExpandedSubscriptionInput | ExpandedSubscriptionPlan | null {
    return expandGithubSubscriptionShortcut(input);
  },
  deriveTrackedResource(filter: SubscriptionFilter, source: SourceStream): { ref: string } | null {
    return deriveGithubTrackedResource(filter, source);
  },
  deriveNotificationGrouping(item: ActivationItem): NotificationGrouping | null {
    const number = typeof item.metadata.number === "number" ? item.metadata.number : null;
    if (!number) {
      return null;
    }
    const variant = item.eventVariant;
    if (variant.startsWith("PullRequestReviewCommentEvent.")) {
      return {
        groupable: true,
        resourceRef: `pr:${number}`,
        eventFamily: "review_comments",
        summaryHint: `review comments on PR #${number}`,
      };
    }
    if (variant.startsWith("PullRequestReviewEvent.")) {
      return {
        groupable: true,
        resourceRef: `pr:${number}`,
        eventFamily: "reviews",
        summaryHint: `reviews on PR #${number}`,
      };
    }
    if (variant.startsWith("IssueCommentEvent.")) {
      return {
        groupable: true,
        resourceRef: item.metadata.isPullRequest === true ? `pr:${number}` : `issue:${number}`,
        eventFamily: "comments",
        summaryHint: item.metadata.isPullRequest === true ? `comments on PR #${number}` : `comments on issue #${number}`,
      };
    }
    if (variant.startsWith("PullRequestEvent.closed")) {
      return {
        groupable: true,
        resourceRef: `pr:${number}`,
        eventFamily: "lifecycle",
        summaryHint: `PR #${number} lifecycle updates`,
        flushClass: "immediate",
      };
    }
    return null;
  },
  summarizeDigestThread(items: ActivationItem[], _source: SourceStream, grouping: NotificationGrouping): string | null {
    if (!grouping.summaryHint || items.length === 0) {
      return null;
    }
    const count = items.length;
    return `${count} ${grouping.summaryHint}`;
  },
  projectLifecycleSignal(rawPayload: Record<string, unknown>, source: SourceStream) {
    return projectGithubLifecycleSignal(rawPayload, source);
  },
  validateConfig(source: SourceStream): void {
    parseGithubSourceConfig(source);
  },
  buildManagedSourceSpec(source: SourceStream): ManagedSourceSpec {
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
  mapRawEvent(rawPayload: Record<string, unknown>, source: SourceStream): MappedRemoteEvent | null {
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

const GITHUB_REPO_CI_MODULE: RemoteSourceModule = {
  id: "builtin.github_repo_ci",
  describeCapabilities(): RemoteSourceCapabilityDescription {
    return {
      sourceKind: "github_repo_ci",
      aliases: ["github_repo_ci"],
      configSchema: [
        { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
        { name: "repo", type: "string", required: true, description: "GitHub repository name." },
        { name: "uxcAuth", type: "string", required: false, description: "Optional uxc auth profile." },
        { name: "pollIntervalSecs", type: "number", required: false, description: "Polling interval in seconds." },
        { name: "perPage", type: "number", required: false, description: "Workflow runs requested per poll." },
        { name: "eventFilter", type: "string", required: false, description: "Optional GitHub workflow event filter." },
        { name: "branch", type: "string", required: false, description: "Optional branch filter for workflow runs." },
        { name: "statusFilter", type: "string", required: false, description: "Optional workflow status filter." },
      ],
      metadataFields: [
        { name: "name", type: "string|null", description: "Workflow run name." },
        { name: "status", type: "string", description: "Normalized workflow run status." },
        { name: "conclusion", type: "string|null", description: "Workflow run conclusion when completed." },
        { name: "event", type: "string|null", description: "GitHub trigger event for the workflow run." },
        { name: "headBranch", type: "string|null", description: "Head branch for the workflow run." },
        { name: "headSha", type: "string|null", description: "Head commit SHA for the workflow run." },
        { name: "actor", type: "string|null", description: "Actor login for the workflow run." },
        { name: "commitMessage", type: "string|null", description: "Head commit message when present." },
        { name: "htmlUrl", type: "string|null", description: "GitHub Actions run URL." },
      ],
      eventVariantExamples: ["workflow_run.ci.completed.failure", "workflow_run.nightly_checks.observed"],
    };
  },
  deriveInlinePreview(item: ActivationItem): string | null {
    const repoFullName = asNonEmptyString(item.metadata.repoFullName);
    const workflowName = asNonEmptyString(item.metadata.name)
      ?? asNonEmptyString(item.metadata.displayTitle)
      ?? asNonEmptyString(item.rawPayload.name)
      ?? asNonEmptyString(item.rawPayload.display_title);
    const headBranch = asNonEmptyString(item.metadata.headBranch) ?? asNonEmptyString(item.rawPayload.head_branch);
    const conclusion = asNonEmptyString(item.metadata.conclusion) ?? asNonEmptyString(item.rawPayload.conclusion);
    const status = asNonEmptyString(item.metadata.status) ?? asNonEmptyString(item.rawPayload.status);

    const parts: string[] = [];
    if (workflowName) {
      parts.push(workflowName);
    } else {
      parts.push("Workflow run");
    }
    if (conclusion) {
      parts.push(`completed ${conclusion}`);
    } else if (status) {
      parts.push(status);
    }
    if (repoFullName) {
      parts.push(`for ${repoFullName}`);
    }
    if (headBranch) {
      parts.push(`on ${headBranch}`);
    }

    return parts.join(" ");
  },
  deriveNotificationGrouping(item: ActivationItem): NotificationGrouping | null {
    const workflowRunId = typeof item.metadata.workflowRunId === "number" ? item.metadata.workflowRunId : null;
    if (!workflowRunId) {
      return null;
    }
    const conclusion = asNonEmptyString(item.metadata.conclusion);
    const status = asNonEmptyString(item.metadata.status);
    return {
      groupable: true,
      resourceRef: `workflow_run:${workflowRunId}`,
      eventFamily: "ci_updates",
      summaryHint: `CI updates for run #${workflowRunId}`,
      flushClass: conclusion || status === "completed" ? "immediate" : "normal",
    };
  },
  summarizeDigestThread(items: ActivationItem[], _source: SourceStream, grouping: NotificationGrouping): string | null {
    if (!grouping.summaryHint || items.length === 0) {
      return null;
    }
    return `${items.length} ${grouping.summaryHint}`;
  },
  validateConfig(source: SourceStream): void {
    parseGithubCiSourceConfig(source);
  },
  buildManagedSourceSpec(source: SourceStream): ManagedSourceSpec {
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
          type: "content_hash",
          seen_window: 1024,
        },
      },
      options: { auth: config.uxcAuth },
    };
  },
  mapRawEvent(rawPayload: Record<string, unknown>, source: SourceStream): MappedRemoteEvent | null {
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

const FEISHU_BOT_MODULE: RemoteSourceModule = {
  id: "builtin.feishu_bot",
  listDeliveryOperations(input: ListDeliveryOperationsInput): DeliveryOperationDescriptor[] {
    return feishuDeliveryOperationsForHandle(input.handle);
  },
  async invokeDeliveryOperation(input: InvokeDeliveryOperationInput): Promise<{ status: DeliveryAttempt["status"]; note: string }> {
    return invokeFeishuDeliveryOperation(input.handle, input.operation, input.input);
  },
  describeCapabilities(): RemoteSourceCapabilityDescription {
    return {
      sourceKind: "feishu_bot",
      aliases: ["feishu_bot"],
      configSchema: [
        { name: "appId", type: "string", required: true, description: "Feishu app ID." },
        { name: "appSecret", type: "string", required: true, description: "Feishu app secret." },
        { name: "eventTypes", type: "string[]", required: false, description: "Optional Feishu event type allowlist." },
        { name: "chatIds", type: "string[]", required: false, description: "Optional Feishu chat allowlist." },
        { name: "schemaUrl", type: "string", required: false, description: "Optional Feishu OpenAPI schema URL." },
        { name: "replyInThread", type: "boolean", required: false, description: "Reply in thread when sending outbound messages." },
        { name: "uxcAuth", type: "string", required: false, description: "Optional uxc auth profile." },
      ],
      metadataFields: [
        { name: "eventType", type: "string", description: "Feishu event type." },
        { name: "chatId", type: "string", description: "Target chat ID." },
        { name: "chatType", type: "string|null", description: "Feishu chat type." },
        { name: "messageId", type: "string", description: "Feishu message ID." },
        { name: "messageType", type: "string", description: "Feishu message type such as text." },
        { name: "senderOpenId", type: "string|null", description: "Sender open_id when present." },
        { name: "senderType", type: "string|null", description: "Sender type." },
        { name: "mentions", type: "string[]", description: "Mention names extracted from the message." },
        { name: "mentionOpenIds", type: "string[]", description: "Mention open_ids extracted from the message." },
        { name: "content", type: "string|null", description: "Normalized message content string." },
        { name: "threadId", type: "string|null", description: "Thread or root message ID when present." },
        { name: "parentId", type: "string|null", description: "Parent message ID when present." },
      ],
      eventVariantExamples: ["im.message.receive_v1.text"],
    };
  },
  validateConfig(source: SourceStream): void {
    parseFeishuSourceConfig(source);
  },
  buildManagedSourceSpec(source: SourceStream): ManagedSourceSpec {
    const config = parseFeishuSourceConfig(source);
    return {
      endpoint: config.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      mode: "stream",
      transport_hint: "feishu_long_connection",
      options: { auth: config.uxcAuth },
    };
  },
  mapRawEvent(rawPayload: Record<string, unknown>, source: SourceStream): MappedRemoteEvent | null {
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

export function moduleConfigForSource(source: SourceStream): Record<string, unknown> {
  const config = asRecord(source.config);
  if (source.sourceType === "remote_source") {
    return asRecord(config.moduleConfig);
  }
  return config;
}
