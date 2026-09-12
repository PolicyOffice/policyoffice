import { withTenantTransaction } from "@policyoffice/db/application-transaction";
import { authorizationDataLoader } from "@policyoffice/db/authorization";
import {
  AuthzContext,
  DOCUMENT_REQUIRED_CAPABILITIES,
  decide,
  listDocumentRegister,
} from "../../../packages/domain/src/index";

export interface DocumentRegisterRequest {
  readonly sessionToken: string | undefined;
}

export interface DocumentRegisterHandlerOptions {
  readonly tenantId: string;
  readonly clock?: () => Date;
}

const RESPONSE_HEADERS = Object.freeze({ "cache-control": "no-store" });

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: RESPONSE_HEADERS });
}

/** The framework-neutral request boundary exercised directly against app_role in tests. */
export function createDocumentRegisterHandler(
  options: DocumentRegisterHandlerOptions,
): (request: DocumentRegisterRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());

  return async (request) => {
    // Session expiry and grant validity must observe one fixed request instant.
    const instant = clock();
    if (request.sessionToken === undefined) return notFound();

    const response = await withTenantTransaction(
      {
        tenantId: options.tenantId,
        sessionToken: request.sessionToken,
        instant,
      },
      async (transaction) => {
        const context = new AuthzContext({
          tenantId: options.tenantId,
          principal: transaction.context.principal,
          instant,
          load: authorizationDataLoader(transaction),
        });
        const decision = await decide(context, DOCUMENT_REQUIRED_CAPABILITIES.listRegister, {
          tenantId: options.tenantId,
          type: "TENANT",
          id: null,
        });
        if (!decision.allowed) return notFound();

        const documents = await listDocumentRegister(transaction, options.tenantId);
        return Response.json({ documents }, { status: 200, headers: RESPONSE_HEADERS });
      },
    );

    return response ?? notFound();
  };
}
