import type { SdkIntegrationReceipt as IntegrationReceipt } from './sdk-integration-receipt';

export {
  createSdkIntegrationReceipt,
  mergeSdkIntegrationReceiptMetadata,
  parseSdkIntegrationReceipt,
  readSdkIntegrationReceiptMetadata,
  SDK_RECEIPT_METADATA_KEY,
  sdkIntegrationReceiptSchema,
  type SdkIntegrationReceipt,
} from './sdk-integration-receipt';

export const SDK_SCHEMA_VERSION = 1;
export const SDK_PROTOCOL_VERSION = 2;

export type SdkContractIdentity = {
  readonly contractHash: string;
  readonly sdkSchemaVersion: number;
  readonly sdkProtocolVersion: number;
  readonly productPolicyRevision: string;
  readonly storeProductId: string;
  readonly deploymentOrigin: string;
};

export type SdkIntegrationDriftState =
  | 'current'
  | 'reintegration_required'
  | 'implementation_unverified'
  | 'older_protocol';

type BuildSdkContractIdentityInput = {
  readonly storeProductId: string;
  readonly deploymentOrigin: string;
  readonly productPolicyRevision: string;
  readonly contractHash: string;
};

export type SdkProductPolicyIdentityInput = {
  readonly storeProductId: string;
  readonly billingModel: 'one_time' | 'subscription' | 'free';
  readonly plans: readonly {
    readonly key: string;
    readonly name: string;
    readonly active: boolean;
    readonly intervalUnit: string | null;
    readonly intervalCount: number | null;
  }[];
  readonly rails: {
    readonly runtimeLicensing: boolean;
    readonly downloadableFiles: boolean;
    readonly hostedAccess: boolean;
    readonly discordRoles: boolean;
    readonly updates: boolean;
  };
  readonly dynamicPolicy: {
    readonly licenseMode: string;
    readonly keyPrefix: string;
    readonly maxDevices: number;
    readonly heartbeatIntervalSeconds: number;
    readonly sdkCacheTtlMs: number;
    readonly offlineGracePeriodSeconds: number;
    readonly featureFlags: readonly string[];
    readonly tier: string | null;
    readonly requireDiscordGuildMembership: boolean;
    readonly devicePolicy: string | null;
    readonly rotationPolicy: string;
    readonly selfServiceDeviceRemoval: boolean;
    readonly watermarkConfig: Readonly<Record<string, unknown>> | null;
  } | null;
  readonly staticPolicy: {
    readonly outputFormats: string;
    readonly deliveryDescriptors: readonly {
      readonly key: string;
      readonly displayName: string;
      readonly mediaType: string | null;
    }[];
  } | null;
  readonly capabilities: readonly {
    readonly key: string;
    readonly behavioralMeaning: string;
    readonly controlledFunctionality: string;
    readonly grantingPlans: readonly string[];
    readonly unavailableBehavior: string;
    readonly dependencyKeys: readonly string[];
  }[];
  readonly discordGrants: {
    readonly roleIds: readonly string[];
    readonly channelIds: readonly string[];
  };
};

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`).join(',')}}`;
  }
  throw new Error('SDK product policy contains a non-JSON value');
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export async function buildSdkProductPolicyRevision(
  input: SdkProductPolicyIdentityInput,
): Promise<string> {
  const normalized = {
    ...input,
    plans: [...input.plans].sort((left, right) => left.key.localeCompare(right.key)),
    dynamicPolicy: input.dynamicPolicy
      ? { ...input.dynamicPolicy, featureFlags: sorted(input.dynamicPolicy.featureFlags) }
      : null,
    staticPolicy: input.staticPolicy
      ? {
          ...input.staticPolicy,
          deliveryDescriptors: [...input.staticPolicy.deliveryDescriptors]
            .sort((left, right) => left.key.localeCompare(right.key)),
        }
      : null,
    capabilities: [...input.capabilities]
      .map((capability) => ({
        ...capability,
        grantingPlans: sorted(capability.grantingPlans),
        dependencyKeys: sorted(capability.dependencyKeys),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    discordGrants: {
      roleIds: sorted(input.discordGrants.roleIds),
      channelIds: sorted(input.discordGrants.channelIds),
    },
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(normalized)),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

export function normalizeSdkDeploymentOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('SDK deployment origin must use HTTP or HTTPS');
  }
  return url.origin;
}

export function resolveSdkDeploymentOrigin(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const configured = environment.DASHBOARD_URL ?? environment.NEXT_PUBLIC_APP_URL;
  if (!configured) return null;
  try {
    return normalizeSdkDeploymentOrigin(configured);
  } catch {
    return null;
  }
}

export function buildSdkContractIdentity(input: BuildSdkContractIdentityInput): SdkContractIdentity {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.productPolicyRevision)) {
    throw new Error('SDK product policy revision must be a sha256 identity');
  }
  if (!/^[a-f0-9]{64}$/.test(input.contractHash)) {
    throw new Error('SDK contract hash must be a sha256 digest');
  }
  const deploymentOrigin = normalizeSdkDeploymentOrigin(input.deploymentOrigin);
  return {
    contractHash: input.contractHash,
    sdkSchemaVersion: SDK_SCHEMA_VERSION,
    sdkProtocolVersion: SDK_PROTOCOL_VERSION,
    productPolicyRevision: input.productPolicyRevision,
    storeProductId: input.storeProductId,
    deploymentOrigin,
  };
}

export function classifySdkIntegrationDrift(
  identity: SdkContractIdentity,
  receipt: IntegrationReceipt | null,
): SdkIntegrationDriftState {
  if (
    !receipt
    || receipt.issuedBy !== 'somnibot-server'
    || receipt.integrityResult !== 'passed'
    || receipt.authenticityResult !== 'passed'
    || receipt.conformanceResult !== 'passed'
    || receipt.remainingUnverifiedRequirements.length > 0
  ) return 'implementation_unverified';
  if (receipt.sdkProtocolVersion < identity.sdkProtocolVersion) return 'older_protocol';
  if (
    receipt.contractHash !== identity.contractHash
    || receipt.sdkSchemaVersion !== identity.sdkSchemaVersion
    || receipt.sdkProtocolVersion !== identity.sdkProtocolVersion
    || receipt.productPolicyRevision !== identity.productPolicyRevision
    || receipt.storeProductId !== identity.storeProductId
    || normalizeSdkDeploymentOrigin(receipt.deploymentOrigin) !== identity.deploymentOrigin
  ) return 'reintegration_required';
  return 'current';
}
