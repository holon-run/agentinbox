import { resolveAgentInboxHome } from "./paths";
import { ResolvedSourceIdentity, ResolvedSourceSchema, SourceSchema, SourceStream } from "./model";
import { RemoteSourceModule, RemoteSourceModuleRegistry, builtInModuleIdForSourceType, moduleConfigForSource } from "./sources/remote_modules";
import { getSourceSchema } from "./source_schema";

export interface ResolveSourceContext {
  homeDir?: string;
  moduleRegistry?: RemoteSourceModuleRegistry;
}

export async function resolveSourceIdentity(
  source: SourceStream,
  context: ResolveSourceContext = {},
): Promise<ResolvedSourceIdentity> {
  if (source.sourceType === "local_event") {
    return {
      hostType: "local_event",
      sourceKind: "local_event",
      implementationId: "builtin.local_event",
    };
  }

  const builtinImplementationId = builtInModuleIdForSourceType(source.sourceType);
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

  const moduleRegistry = context.moduleRegistry ?? new RemoteSourceModuleRegistry();
  const homeDir = context.homeDir ?? resolveAgentInboxHome(process.env);
  const module = await moduleRegistry.resolve(source, homeDir);
  const capabilityDescription = typeof module.describeCapabilities === "function"
    ? module.describeCapabilities(moduleInputSource(source))
    : undefined;
  return {
    hostType: "remote_source",
    sourceKind: capabilityDescription?.sourceKind?.trim() || `remote:${module.id}`,
    implementationId: module.id,
  };
}

export async function resolveSourceSchema(
  source: SourceStream,
  context: ResolveSourceContext = {},
): Promise<ResolvedSourceSchema> {
  const moduleRegistry = context.moduleRegistry ?? new RemoteSourceModuleRegistry();
  const homeDir = context.homeDir ?? resolveAgentInboxHome(process.env);
  const resolvedContext: ResolveSourceContext = { ...context, moduleRegistry, homeDir };
  const identity = await resolveSourceIdentity(source, resolvedContext);
  const staticSchema = getSourceSchema(source.sourceType);
  let capabilityDescription: ReturnType<NonNullable<RemoteSourceModule["describeCapabilities"]>> | undefined;
  let module: RemoteSourceModule | null = null;
  if (identity.hostType === "remote_source") {
    module = await moduleRegistry.resolve(source, homeDir);
    capabilityDescription = typeof module.describeCapabilities === "function"
      ? module.describeCapabilities(moduleInputSource(source))
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
          supportsTrackedResourceRef: typeof module?.deriveTrackedResource === "function",
          supportsLifecycleSignals: typeof module?.projectLifecycleSignal === "function",
          shortcuts: typeof module?.listSubscriptionShortcuts === "function"
            ? module.listSubscriptionShortcuts(moduleInputSource(source))
            : [],
          followTemplates: typeof module?.listFollowTemplates === "function"
            ? module.listFollowTemplates(moduleInputSource(source))
            : undefined,
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
    followTemplates?: Array<{
      templateId: string;
      providerOrKind: string;
      label: string;
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
    ...(capabilityMetadata?.followTemplates && capabilityMetadata.followTemplates.length > 0
      ? {
          followSchema: {
            templates: capabilityMetadata.followTemplates,
          },
        }
      : {}),
  };
}

function moduleInputSource(source: SourceStream): SourceStream {
  if (source.sourceType !== "remote_source") {
    return source;
  }
  return {
    ...source,
    config: moduleConfigForSource(source),
  };
}
