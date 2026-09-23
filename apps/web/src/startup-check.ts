import { installationTenantId } from "./installation-tenant.ts";
import { storageConfiguration } from "../../../packages/storage/src/config.ts";

// `predev` and `prestart` run this before Next binds a port or accepts a request.
installationTenantId();
storageConfiguration();
