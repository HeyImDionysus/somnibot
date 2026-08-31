import { readCompletedProjectLicensingMetadata, savedLicensingProductSchema, savedProductToLicensingDraft, savedProductToPolicyIdentityInput } from './licensing-handoff';
import { buildSavedProductLicensingSdkBundle } from './licensing-sdk-bundle';
import { buildSdkContractIdentity, classifySdkIntegrationDrift } from './sdk-contract-identity';
import { readVerifiedSdkIntegrationReceiptMetadata } from './sdk-integration-provenance';

export async function verifyLaunchSdkIntegration(savedProduct: unknown, deploymentOrigin: string | null): Promise<boolean> {
  if (!deploymentOrigin) return false;
  const product = savedLicensingProductSchema.parse(savedProduct);
  const receipt = await readVerifiedSdkIntegrationReceiptMetadata(product.metadata);
  if (!receipt) return false;
  const apiBase = `${deploymentOrigin}/api`;
  const draft = await savedProductToLicensingDraft(product, apiBase);
  const completedProject = readCompletedProjectLicensingMetadata(product.metadata);
  const bundle = await buildSavedProductLicensingSdkBundle({
    projectName: draft.projectName,
    projectContext: draft.projectContext,
    apiBase,
    plansAndFeatures: draft.plansAndFeatures,
    installationIdentity: draft.installationIdentity,
    policy: savedProductToPolicyIdentityInput(product),
    capabilities: completedProject?.capabilities ?? [],
  });
  const identity = buildSdkContractIdentity({
    storeProductId: product.id,
    deploymentOrigin,
    productPolicyRevision: bundle.files['somnibot-sdk.json'].content.productPolicyRevision,
    contractHash: bundle.contractIdentity.value,
  });
  return classifySdkIntegrationDrift(identity, receipt) === 'current';
}
