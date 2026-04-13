import { resolveAgentInboxHome } from "./paths";
import { ResolvedSourceIdentity, ResolvedSourceSchema, SourceSchema, SubscriptionSource } from "./model";
import { RemoteSourceProfileRegistry, builtInProfileIdForSourceType } from "./sources/remote_profiles";
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
  return {
    hostType: "remote_source",
    sourceKind: `remote:${profile.id}`,
    implementationId: profile.id,
  };
}

export async function resolveSourceSchema(
  source: SubscriptionSource,
  context: ResolveSourceContext = {},
): Promise<ResolvedSourceSchema> {
  const identity = await resolveSourceIdentity(source, context);
  return withResolvedIdentity(source.sourceId, getSourceSchema(source.sourceType), identity);
}

export function withResolvedIdentity(
  sourceId: string,
  schema: SourceSchema,
  identity: ResolvedSourceIdentity,
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
  };
}
