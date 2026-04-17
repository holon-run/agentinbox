# RFCs

- [Event Filtering](./event-filtering.md)
- [Source Kinds And Resolved Schemas](./source-kinds-and-resolved-schemas.md)
- [Subscription Lifecycle And Terminal Auto-Retire](./subscription-lifecycle-and-terminal-retire.md)
- [Inbox Digests And Threaded Notification Entries](./inbox-digests-and-threaded-notification-entries.md)

<!-- INDEX:START -->

- [Current Agent Resolution And Safe Agent-Scoped CLI Behavior](./current-agent-resolution.md)
  2026-04-09 · Define how AgentInbox CLI should resolve the current agent, warn on cross-session targeting, and auto-register session-bound agents.
  <!-- mdorigin:index kind=article -->

- [Delivery Handles And Source-Specific Operations](./delivery-handles-and-operations.md)
  2026-04-16 · Keep outbound delivery in AgentInbox, but standardize handle routing and source-specific operations instead of forcing all providers into one generic send action.
  <!-- mdorigin:index kind=article -->

- [Inbox Digests And Threaded Notification Entries](./inbox-digests-and-threaded-notification-entries.md)
  2026-04-17 · Reduce bursty notification noise by keeping raw inbox items immutable, while materializing agent-facing digest threads and immutable digest snapshots for read, activation, and ack.
  <!-- mdorigin:index kind=article -->

- [Source Hosts And Streams](./source-hosts-and-streams.md)
  2026-04-16 · Split provider/account hosting from concrete feeds so AgentInbox can support many provider streams without exploding top-level source kinds.
  <!-- mdorigin:index kind=article -->

- [Source Kinds And Resolved Schemas](./source-kinds-and-resolved-schemas.md)
  2026-04-13 · Separate runtime host types from user-facing source kinds, make source capability discovery implementation-backed through resolved per-source schemas, and define the UXC/AgentInbox boundary for remote-hosted sources.
  <!-- mdorigin:index kind=article -->

- [Subscription Lifecycle And Terminal Auto-Retire](./subscription-lifecycle-and-terminal-retire.md)
  2026-04-13 · Replace temporary-subscription semantics with explicit cleanup policies, source-scoped tracked resources, deadline cleanup, and terminal-state auto-retire for task-scoped subscriptions.
  <!-- mdorigin:index kind=article -->

- [RFC: Agent-First Event Filtering](./event-filtering.md)
  `AgentInbox` should move from today's flat `matchRules` map to an agent-first filtering model with:
  <!-- mdorigin:index kind=article -->

<!-- INDEX:END -->
