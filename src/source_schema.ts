import { SourceSchema, SourceType } from "./model";

const SOURCE_SCHEMAS: Record<SourceType, SourceSchema> = {
  local_event: {
    sourceType: "local_event",
    metadataFields: [
      { name: "channel", type: "string", description: "Producer-defined routing channel for local event ingress." },
      { name: "subject", type: "string", description: "Producer-defined short summary or subject field." },
    ],
    payloadExamples: [
      { text: "hello from local event source" },
    ],
    eventVariantExamples: ["message.created"],
    configFields: [],
  },
  remote_source: {
    sourceType: "remote_source",
    metadataFields: [],
    payloadExamples: [],
    eventVariantExamples: [],
    configFields: [
      { name: "profilePath", type: "string", required: true, description: "Local module path under $AGENTINBOX_HOME/source-profiles." },
      { name: "profileConfig", type: "object", required: false, description: "Profile-specific configuration passed to validate/spec/map hooks." },
    ],
  },
  github_repo: {
    sourceType: "github_repo",
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
        id: "1234567890",
        type: "IssueCommentEvent",
        action: "created",
        actor: "jolestar",
        issue: { number: 12, title: "Track filtering work" },
        comment: { body: "@alpha please look" },
      },
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
    configFields: [
      { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
      { name: "repo", type: "string", required: true, description: "GitHub repository name." },
      { name: "uxcAuth", type: "string", required: false, description: "Optional uxc auth profile." },
      { name: "eventTypes", type: "string[]", required: false, description: "Optional GitHub event type allowlist." },
    ],
  },
  github_repo_ci: {
    sourceType: "github_repo_ci",
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
    payloadExamples: [
      {
        id: 987,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        event: "pull_request",
        head_branch: "main",
        actor: "jolestar",
        head_commit: { message: "fix ci" },
      },
    ],
    eventVariantExamples: ["workflow_run.ci.completed.failure", "workflow_run.nightly_checks.observed"],
    configFields: [
      { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
      { name: "repo", type: "string", required: true, description: "GitHub repository name." },
      { name: "uxcAuth", type: "string", required: false, description: "Optional uxc auth profile." },
      { name: "pollIntervalSecs", type: "number", required: false, description: "Polling interval in seconds." },
      { name: "perPage", type: "number", required: false, description: "Workflow runs requested per poll." },
      { name: "eventFilter", type: "string", required: false, description: "Optional GitHub workflow event filter." },
      { name: "branch", type: "string", required: false, description: "Optional branch filter for workflow runs." },
      { name: "statusFilter", type: "string", required: false, description: "Optional workflow status filter." },
    ],
  },
  feishu_bot: {
    sourceType: "feishu_bot",
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
    payloadExamples: [
      {
        event_type: "im.message.receive_v1",
        message: { chat_id: "oc_456", message_type: "text" },
        sender: { sender_id: { open_id: "ou_alpha" } },
      },
    ],
    eventVariantExamples: ["im.message.receive_v1.text"],
    configFields: [
      { name: "appId", type: "string", required: true, description: "Feishu app ID." },
      { name: "appSecret", type: "string", required: true, description: "Feishu app secret." },
      { name: "eventTypes", type: "string[]", required: false, description: "Optional Feishu event type allowlist." },
      { name: "chatIds", type: "string[]", required: false, description: "Optional Feishu chat allowlist." },
      { name: "schemaUrl", type: "string", required: false, description: "Optional Feishu OpenAPI schema URL." },
      { name: "replyInThread", type: "boolean", required: false, description: "Reply in thread when sending outbound messages." },
      { name: "uxcAuth", type: "string", required: false, description: "Optional uxc auth profile." },
    ],
  },
};

export function getSourceSchema(sourceType: SourceType): SourceSchema {
  const schema = SOURCE_SCHEMAS[sourceType];
  if (!schema) {
    throw new Error(`unknown source type: ${sourceType}`);
  }
  return schema;
}

export function listSourceSchemas(): SourceSchema[] {
  return Object.values(SOURCE_SCHEMAS);
}
