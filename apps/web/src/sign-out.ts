import { randomUUID } from "node:crypto";
import {
  withTenantTransaction,
  type ApplicationTransaction,
} from "@policyoffice/db/application-transaction";
import { revokeSessionByToken } from "../../../packages/domain/src/index";
import { clearSessionCookie } from "./session-cookie.js";

export interface SignOutRequest {
  readonly sessionToken: string | undefined;
}

export interface SignOutHandlerOptions {
  readonly tenantId: string;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

interface ConfigurationRow extends Record<string, unknown> {
  id: string;
}

const RESPONSE_HEADERS = Object.freeze({ "cache-control": "no-store" });

function signedOut(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...RESPONSE_HEADERS,
      location: "/sign-in",
      "set-cookie": clearSessionCookie(),
    },
  });
}

async function activeConfigurationVersionId(
  transaction: ApplicationTransaction,
  tenantId: string,
  instant: Date,
): Promise<string> {
  const { rows } = await transaction.query<ConfigurationRow>(
    `select id
       from configuration_version
      where tenant_id = $1::uuid and effective_from <= $2::timestamptz
      order by effective_from desc, sequence desc
      limit 1`,
    [tenantId, instant.toISOString()],
  );
  const row = rows[0];
  if (!row || rows.length !== 1) throw new Error("active configuration is unavailable");
  return row.id;
}

/** End the presented session without revealing whether it existed. */
export function createSignOutHandler(
  options: SignOutHandlerOptions,
): (request: SignOutRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  return async (request) => {
    if (request.sessionToken === undefined || request.sessionToken.length === 0) return signedOut();

    const instant = clock();
    await withTenantTransaction(
      { tenantId: options.tenantId, sessionToken: request.sessionToken, instant },
      async (transaction) => {
        if (transaction.context.principal.type !== "USER") {
          throw new Error("session principal must be a user");
        }
        const configurationVersionId = await activeConfigurationVersionId(
          transaction,
          options.tenantId,
          instant,
        );
        await revokeSessionByToken(transaction, {
          tenantId: options.tenantId,
          token: request.sessionToken as string,
          actor: { type: "USER", id: transaction.context.principal.id },
          occurredAt: instant,
          requestId: idFactory(),
          correlationId: idFactory(),
          sourceChannel: "WEB",
          configurationVersionId,
        });
      },
    );

    return signedOut();
  };
}
