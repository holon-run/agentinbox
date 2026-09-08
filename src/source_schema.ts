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
      { name: "modulePath", type: "string", required: true, description: "Local module path under $AGENTINBOX_HOME/source-modules." },
      { name: "moduleConfig", type: "object", required: false, description: "Module-specific configuration passed to validate/spec/map hooks." },
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
      { name: "headRepositoryFullName", type: "string|null", description: "Head repository full name for the workflow run when available." },
      { name: "headSha", type: "string|null", description: "Head commit SHA for the workflow run." },
      { name: "pullRequestNumbers", type: "number[]", description: "Pull request numbers associated with the workflow run." },
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
        head_repository: { full_name: "holon-run/agentinbox" },
        pull_requests: [{ number: 93 }],
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
      { name: "attachments", type: "object[]", description: "Message attachments and Feishu/Lark document links that can be saved by source operations." },
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
      { name: "uxcAuth", type: "string", required: false, description: "Optional UXC auth profile for the Feishu/Lark app." },
      { name: "eventTypes", type: "string[]", required: false, description: "Optional Feishu event type allowlist." },
      { name: "chatIds", type: "string[]", required: false, description: "Optional Feishu chat allowlist." },
      { name: "schemaUrl", type: "string", required: false, description: "Optional Feishu OpenAPI schema URL." },
      { name: "replyInThread", type: "boolean", required: false, description: "Reply in thread when sending outbound messages." },
    ],
  },
  telegram_bot: {
    sourceType: "telegram_bot",
    metadataFields: [
      { name: "updateId", type: "string", description: "Telegram update_id." },
      { name: "chatId", type: "string", description: "Telegram chat ID." },
      { name: "chatType", type: "string|null", description: "Telegram chat type such as private, group, or channel." },
      { name: "messageId", type: "string", description: "Telegram message_id." },
      { name: "messageType", type: "string", description: "Normalized Telegram message type such as text or photo." },
      { name: "fromId", type: "string|null", description: "Telegram sender user ID when present." },
      { name: "fromUsername", type: "string|null", description: "Telegram sender username when present." },
      { name: "fromFirstName", type: "string|null", description: "Telegram sender first_name when present." },
      { name: "content", type: "string|null", description: "Message text or caption when present." },
    ],
    payloadExamples: [
      {
        update_id: 123,
        message: {
          message_id: 7,
          date: 1710000000,
          text: "hello",
          chat: { id: 456, type: "private" },
          from: { id: 111, username: "operator", first_name: "Op" },
        },
      },
    ],
    eventVariantExamples: ["message.text", "edited_message.text", "channel_post.photo"],
    configFields: [
      { name: "botToken", type: "string", required: false, description: "Telegram bot token. Prefer tokenEnv for shared/local configuration." },
      { name: "tokenEnv", type: "string", required: false, description: "Environment variable name containing the Telegram bot token." },
      { name: "botUsername", type: "string", required: false, description: "Optional bot username used for source host identity." },
      { name: "chatIds", type: "string[]", required: false, description: "Optional Telegram chat ID allowlist." },
      { name: "allowedUpdates", type: "string[]", required: false, description: "Optional Telegram Bot API allowed_updates value." },
      { name: "endpoint", type: "string", required: false, description: "Optional Telegram Bot API endpoint override." },
    ],
  },
  email_mailbox: {
    sourceType: "email_mailbox",
    metadataFields: [
      { name: "provider", type: "string", description: "Email provider: imap, gmail, graph, or jmap." },
      { name: "account", type: "string", description: "Mailbox account alias." },
      { name: "mailbox", type: "string", description: "Mailbox name such as INBOX." },
      { name: "messageId", type: "string|null", description: "RFC Message-ID header when present." },
      { name: "providerMessageId", type: "string|null", description: "Provider-native message id (IMAP UID or provider message id)." },
      { name: "threadId", type: "string|null", description: "Thread reference derived from References/In-Reply-To headers." },
      { name: "from", type: "string|null", description: "Normalized sender address." },
      { name: "fromName", type: "string|null", description: "Sender display name when present." },
      { name: "to", type: "object[]", description: "Normalized recipients with address and optional name." },
      { name: "cc", type: "object[]", description: "Normalized cc recipients with address and optional name." },
      { name: "subject", type: "string|null", description: "Message subject." },
      { name: "textPreview", type: "string|null", description: "Short body snippet." },
      { name: "date", type: "string|null", description: "Message date header value." },
      { name: "hasAttachments", type: "boolean", description: "Whether the message carries attachments." },
      { name: "attachmentCount", type: "number|null", description: "Attachment count; null when the provider did not expand attachment metadata." },
      { name: "attachments", type: "object[]", description: "Attachment metadata entries with opaque retrieval handles; binary content is never embedded." },
    ],
    payloadExamples: [
      {
        type: "email_event",
        version: "v1",
        provider: "imap",
        account: "user@example.com",
        mailbox: "INBOX",
        event_kind: "message_received",
        message: {
          uid: "42",
          message_id: "<msg@example.com>",
          from: "sender@example.com",
          to: [{ raw: "user@example.com" }],
          subject: "Quarterly report",
          snippet: "Please review...",
        },
      },
    ],
    eventVariantExamples: ["email.message.received"],
    configFields: [
      { name: "provider", type: "string", required: true, description: "Email provider: imap, gmail, graph, or jmap." },
      { name: "uxcAuth", type: "string", required: true, description: "UXC auth profile name holding mailbox credentials; credentials never inline." },
      { name: "endpoint", type: "string", required: false, description: "imap:// or imaps:// endpoint for imap; provider API endpoint for gmail/graph/jmap (jmap requires it)." },
      { name: "account", type: "string", required: false, description: "Account alias; defaults to the auth profile username." },
      { name: "mailbox", type: "string", required: false, description: "Mailbox to watch; defaults to INBOX." },
      { name: "pollIntervalSecs", type: "number", required: false, description: "Provider poll interval in seconds (min 15, default 60)." },
      { name: "smtpEndpoint", type: "string", required: false, description: "Default smtp:// endpoint for outbound reply/send delivery." },
      { name: "fromAddress", type: "string", required: false, description: "Default outbound From address for delivery." },
      { name: "addressAllowlist", type: "string[]", required: false, description: "Optional from/to address allowlist applied before inbox routing." },
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
