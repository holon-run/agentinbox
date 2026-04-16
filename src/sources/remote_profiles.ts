export {
  type ExpandedSubscriptionInput,
  type ExpandSubscriptionShortcutInput,
  type LifecycleSignal,
  type ManagedSourceSpec,
  type MappedRemoteEvent,
  type RemoteSourceCapabilityDescription,
  type RemoteSourceModule,
  type SubscriptionShortcutSpec,
  RemoteSourceModuleRegistry,
  builtInModuleIdForSourceType,
  moduleConfigForSource,
} from "./remote_modules";

import { RemoteSourceModuleRegistry, builtInModuleIdForSourceType, moduleConfigForSource } from "./remote_modules";

// Deprecated compatibility aliases kept for downstream imports during the profile->module rename transition.
export type RemoteSourceProfile = import("./remote_modules").RemoteSourceModule;

export class RemoteSourceProfileRegistry extends RemoteSourceModuleRegistry {}

export const builtInProfileIdForSourceType = builtInModuleIdForSourceType;
export const profileConfigForSource = moduleConfigForSource;
