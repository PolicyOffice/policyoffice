/**
 * The worker process.
 *
 * A second process, not a second copy of the rules. It depends on @policyoffice/domain
 * exactly as the web application does, which is what makes INV-TEN-004 -- tenant scoping
 * enforced below the presentation layer -- true for background work as well as requests.
 *
 * It deliberately does not import the web application. `ADR-0007` decides what actually
 * runs here; this is the process boundary, nothing more.
 */
import { DOMAIN_PACKAGE } from "@policyoffice/domain";

function main(): void {
  // eslint-disable-next-line no-console -- the only output this process has yet
  console.log(`worker started; domain=${DOMAIN_PACKAGE}`);
}

main();
