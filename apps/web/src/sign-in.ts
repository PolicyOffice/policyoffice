import { withTenantTransaction } from "@policyoffice/db/application-transaction";
import { issueSession } from "../../../packages/domain/src/index";
import { serializeSessionCookie } from "./session-cookie.js";

export interface SignInRequest {
  readonly contactEmail: string;
  readonly password: string;
  readonly userAgentClass: string;
}

export interface SignInHandlerOptions {
  readonly tenantId: string;
  readonly clock?: () => Date;
}

const RESPONSE_HEADERS = Object.freeze({ "cache-control": "no-store" });

function failedSignIn(): Response {
  return new Response(null, {
    status: 303,
    headers: { ...RESPONSE_HEADERS, location: "/sign-in?error=1" },
  });
}

function signedIn(token: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...RESPONSE_HEADERS,
      location: "/",
      "set-cookie": serializeSessionCookie(token),
    },
  });
}

/** Framework-neutral local-password boundary, exercised directly against app_role. */
export function createSignInHandler(
  options: SignInHandlerOptions,
): (request: SignInRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());

  return async (request) => {
    if (
      request.contactEmail.trim().length === 0 ||
      request.password.trim().length === 0 ||
      request.userAgentClass.trim().length === 0
    ) {
      return failedSignIn();
    }

    const instant = clock();
    const issued = await withTenantTransaction(
      {
        tenantId: options.tenantId,
        credential: {
          contactEmail: request.contactEmail,
          password: request.password,
        },
      },
      (transaction) =>
        issueSession(transaction, {
          tenantId: options.tenantId,
          userId: transaction.context.principal.id,
          userAgentClass: request.userAgentClass,
          instant,
        }),
    );

    return issued === null ? failedSignIn() : signedIn(issued.token);
  };
}
