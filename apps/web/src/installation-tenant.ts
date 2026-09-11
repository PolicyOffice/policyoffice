const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INSTALLATION_TENANT_CONFIGURATION = "POLICYOFFICE_TENANT_ID";

export interface InstallationEnvironment {
  readonly [name: string]: string | undefined;
  readonly POLICYOFFICE_TENANT_ID?: string;
}

/**
 * The Pilot deploys one installation per customer. Keeping that decision behind this
 * seam lets a later hostname resolver replace one function rather than the request path.
 */
export function installationTenantId(environment: InstallationEnvironment = process.env): string {
  const tenantId = environment.POLICYOFFICE_TENANT_ID;
  if (tenantId === undefined || tenantId.trim().length === 0) {
    throw new Error(`${INSTALLATION_TENANT_CONFIGURATION} is required`);
  }
  if (!UUID.test(tenantId)) {
    throw new Error(`${INSTALLATION_TENANT_CONFIGURATION} must be a UUID`);
  }
  return tenantId;
}
