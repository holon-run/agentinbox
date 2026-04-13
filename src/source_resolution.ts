import { resolveAgentInboxHome } from "./paths";
import { ResolvedSourceIdentity, ResolvedSourceSchema, SourceSchema, SubscriptionSource } from "./model";
import { RemoteSourceProfile, RemoteSourceProfileRegistry, builtInProfileIdForSourceType, profileConfigForSource } from "./sources/remote_profiles";
import { getSourceSchema } from "./source_schema";

export interface ResolveSourceContext {
  homeDir?: string;
  profileRegistry?: RemoteSourceProfileRegistry;
}

export async function resolveSourceIdentity(
  source: SubscriptionSource,
  context: ResolveSourceContext = {},
): Promise<ResolvedSourceIdentity> {
  if (source.sourceType === "local_event") {
    return {
      hostType: "local_event",
      sourceKind: "local_event",
      implementationId: "builtin.local_event",
    };
  }

  const builtinImplementationId = builtInProfileIdForSourceType(source.sourceType);
  if (builtinImplementationId) {
    return {
      hostType: "remote_source",
      sourceKind: source.sourceType,
      implementationId: builtinImplementationId,
    };
  }

  if (source.sourceType !== "remote_source") {
    throw new Error(`unsupported source type for source resolution: ${source.sourceType}`);
  }

  const profileRegistry = context.profileRegistry ?? new RemoteSourceProfileRegistry();
  const homeDir = context.homeDir ?? resolveAgentInboxHome(process.env);
  const profile = await profileRegistry.resolve(source, homeDir);
  const capabilityDescription = typeof profile.describeCapabilities === "function"
    ? profile.describeCapabilities(profileInputSource(source))
    : undefined;
  return {
    hostType: "remote_source",
    sourceKind: capabilityDescription?.sourceKind?.trim() || `remote:${profile.id}`,
    implementationId: profile.id,
  };
}

export async function resolveSourceSchema(
  source: SubscriptionSource,
  context: ResolveSourceContext = {},
): Promise<ResolvedSourceSchema> {
  const profileRegistry = context.profileRegistry ?? new RemoteSourceProfileRegistry();
  const homeDir = context.homeDir ?? resolveAgentInboxHome(process.env);
  const resolvedContext: ResolveSourceContext = { ...context, profileRegistry, homeDir };
  const identity = await resolveSourceIdentity(source, resolvedContext);
  const staticSchema = getSourceSchema(source.sourceType);
  let capabilityDescription: ReturnType<NonNullable<RemoteSourceProfile["describeCapabilities"]>> | undefined;
  let profile: RemoteSourceProfile | null = null;
  if (identity.hostType === "remote_source") {
    profile = await profileRegistry.resolve(source, homeDir);
    capabilityDescription = typeof profile.describeCapabilities === "function"
      ? profile.describeCapabilities(profileInputSource(source))
      : undefined;
  }
  return withResolvedIdentity(
    source.sourceId,
    {
      sourceType: staticSchema.sourceType,
      metadataFields: capabilityDescription?.metadataFields ?? staticSchema.metadataFields,
      payloadExamples: capabilityDescription?.payloadExamples ?? staticSchema.payloadExamples,
      eventVariantExamples: capabilityDescription?.eventVariantExamples ?? staticSchema.eventVariantExamples,
      configFields: capabilityDescription?.configSchema ?? staticSchema.configFields,
    },
    identity,
    identity.hostType === "remote_source"
      ? {
          aliases: capabilityDescription?.aliases,
          supportsTrackedResourceRef: typeof profile?.deriveTrackedResource === "function",
          supportsLifecycleSignals: typeof profile?.projectLifecycleSignal === "function",
          shortcuts: typeof profile?.listSubscriptionShortcuts === "function"
            ? profile.listSubscriptionShortcuts(profileInputSource(source))
            : [],
        }
      : undefined,
  );
}

export function withResolvedIdentity(
  sourceId: string,
  schema: SourceSchema,
  identity: ResolvedSourceIdentity,
  capabilityMetadata?: {
    aliases?: string[];
    supportsTrackedResourceRef?: boolean;
    supportsLifecycleSignals?: boolean;
    shortcuts?: Array<{
      name: string;
      description: string;
      argsSchema?: SourceSchema["configFields"];
    }>;
  },
): ResolvedSourceSchema {
  return {
    sourceId,
    sourceType: schema.sourceType,
    metadataFields: schema.metadataFields,
    payloadExamples: schema.payloadExamples,
    eventVariantExamples: schema.eventVariantExamples,
    configFields: schema.configFields,
    hostType: identity.hostType,
    sourceKind: identity.sourceKind,
    implementationId: identity.implementationId,
    ...(capabilityMetadata?.aliases?.length ? { aliases: capabilityMetadata.aliases } : {}),
    ...(capabilityMetadata ? {
      subscriptionSchema: {
        supportsTrackedResourceRef: capabilityMetadata.supportsTrackedResourceRef ?? false,
        supportsLifecycleSignals: capabilityMetadata.supportsLifecycleSignals ?? false,
        shortcuts: capabilityMetadata.shortcuts ?? [],
      },
    } : {}),
  };
}

function profileInputSource(source: SubscriptionSource): SubscriptionSource {
  if (source.sourceType !== "remote_source") {
    return source;
  }
  return {
    ...source,
    config: profileConfigForSource(source),
  };
}
