export * from './contracts';
export * from './mock';
export * from './errors';
export * from './transport';
export * from './streamParser';
export * from './openAiCompatible';
export * from './settings';
export * from './promptBuilder';
export * from './redaction';
export * from './budget';
export * from './preflight';
export * from './requestPlan';

// Phase 5C.1 — dynamic hybrid architecture and correction (C-FIX-001 ~ C-FIX-010).
export {
  HYBRID_CONFIG_DESCRIPTORS,
  configValues,
  createHybridConfigStore,
  defaultConfigFlat,
  fingerprintValues,
  hybridConfig,
  runtimeKeyFor,
  toConfigValues,
} from './config';
export type { ConfigDescriptor, ConfigValidation, ConfigValue, HybridConfigStore, HybridConfigValues } from './config';
export {
  allocateContext,
  elideSection,
  focusTermsFrom,
  selectSourceForAllocation,
  type BudgetSection,
  type ContextAllocation,
  type ContextProfile,
  type ElidedSection,
  type SectionAllowance,
  type SourceAllocationOptions,
} from './contextAllocator';
export { createRedactionRegistry, type RedactionPattern, type RedactionRegistry } from './redactionRegistry';
export { assertDataBoundary, inspectDataBoundary, type BoundaryViolation } from './dataBoundary';
export {
  BUILTIN_PROVIDER_PROFILES,
  createProviderProfile,
  createProviderRegistry,
  contextProfileFor,
  providerRegistry,
  type ModelCapabilityOverride,
  type ProviderCapabilities,
  type ProviderProfile,
  type ProviderProfileInput,
  type ProviderRegistry,
  type ProviderResolution,
  type ProviderTarget,
  type ProviderTimeoutPolicy,
} from './providerProfiles';
export {
  PHASE_LABEL,
  ResourceGuard,
  phaseTimeoutError,
  policyForProfile,
  resolveResourcePolicy,
  responseByteCapFor,
  withPhaseDeadline,
  type ResourceLimits,
  type ResourcePolicy,
} from './resourcePolicy';
export { createSseEventDecoder, createUtf8FrameDecoder, type SseEvent, type SseProblem } from './streamCodec';
export {
  TERMINAL_STATES,
  canMove,
  createLifecycleRegistry,
  createRequestLifecycle,
  lifecycleStateFor,
  sharedLifecycleRegistry,
  type LifecycleRegistry,
  type LifecycleSnapshot,
  type LifecycleState,
  type RequestLifecycle,
} from './lifecycle';
export {
  assertSnapshotIntegrity,
  canonicalJson,
  sealRequestSnapshot,
  verifyRequestSnapshot,
  type RequestSnapshot,
  type SnapshotVerification,
} from './requestSnapshot';
export {
  GENESIS_HASH,
  createEvidenceLog,
  executionFindings,
  verifyEvidenceRecords,
  type EvidenceLog,
  type EvidenceRecord,
} from './evidence';
