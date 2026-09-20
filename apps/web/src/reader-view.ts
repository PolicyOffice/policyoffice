import {
  withTenantTransaction,
  type ApplicationTransaction,
} from "@policyoffice/db/application-transaction";
import { authorizationDataLoader } from "@policyoffice/db/authorization";
import {
  AuthzContext,
  READER_VIEW_REQUIRED_CAPABILITIES,
  decide,
  getReaderDocumentVersion,
  resolveReaderDocument,
  type ReaderDocumentView,
} from "../../../packages/domain/src/index";

export interface ReaderViewHandlerOptions {
  readonly tenantId: string;
  readonly clock?: () => Date;
}

export interface ReaderResolutionRequest {
  readonly sessionToken: string | undefined;
  readonly documentId: string;
  readonly at?: string;
}

export interface ReaderVersionRequest {
  readonly sessionToken: string | undefined;
  readonly documentId: string;
  readonly versionId: string;
}

export interface ReaderViewPayload {
  readonly view: ReaderDocumentView;
  readonly answeredAt: Date;
  readonly requestInstant: Date;
}

const RESPONSE_HEADERS = Object.freeze({ "cache-control": "no-store" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: RESPONSE_HEADERS });
}

function parsedInstant(value: string | undefined, fallback: Date): Date | null {
  if (value === undefined) return fallback;
  if (!ZONED_INSTANT.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function authorizationContext(
  transaction: ApplicationTransaction,
  tenantId: string,
  instant: Date,
): AuthzContext {
  return new AuthzContext({
    tenantId,
    principal: transaction.context.principal,
    instant,
    load: authorizationDataLoader(transaction),
  });
}

async function documentPermissions(
  context: AuthzContext,
  tenantId: string,
  documentId: string,
): Promise<Readonly<{ read: boolean; readHistory: boolean }>> {
  const resource = { tenantId, type: "DOCUMENT" as const, id: documentId };
  const read = await decide(context, READER_VIEW_REQUIRED_CAPABILITIES.read, resource);
  const readHistory = await decide(
    context,
    READER_VIEW_REQUIRED_CAPABILITIES.readHistory,
    resource,
  );
  return Object.freeze({ read: read.allowed, readHistory: readHistory.allowed });
}

/** Resolve the document at now or a caller-supplied zoned instant. */
export function createReaderResolutionHandler(
  options: ReaderViewHandlerOptions,
): (request: ReaderResolutionRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  return async (request) => {
    if (!request.sessionToken || !UUID.test(request.documentId)) return notFound();
    const requestInstant = clock();
    const at = parsedInstant(request.at, requestInstant);
    if (!at) return notFound();

    const response = await withTenantTransaction(
      { tenantId: options.tenantId, sessionToken: request.sessionToken, instant: requestInstant },
      async (transaction) => {
        const context = authorizationContext(transaction, options.tenantId, requestInstant);
        const permissions = await documentPermissions(
          context,
          options.tenantId,
          request.documentId,
        );
        if (!permissions.read && !permissions.readHistory) return notFound();

        const view = await resolveReaderDocument(transaction, {
          tenantId: options.tenantId,
          documentId: request.documentId,
          at,
          requestInstant,
        });
        if (!view) return notFound();
        const historicalAddress =
          request.at !== undefined && at.valueOf() < requestInstant.valueOf();
        const requiresHistory =
          historicalAddress || (view.version !== null && !view.version.governsAtRequestInstant);
        if (requiresHistory ? !permissions.readHistory : !permissions.read) return notFound();
        return Response.json({ view, answeredAt: at, requestInstant } satisfies ReaderViewPayload, {
          status: 200,
          headers: RESPONSE_HEADERS,
        });
      },
    );
    return response ?? notFound();
  };
}

/** Resolve one exact released version and select read versus history authorization. */
export function createReaderVersionHandler(
  options: ReaderViewHandlerOptions,
): (request: ReaderVersionRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  return async (request) => {
    if (!request.sessionToken || !UUID.test(request.documentId) || !UUID.test(request.versionId)) {
      return notFound();
    }
    const requestInstant = clock();
    const response = await withTenantTransaction(
      { tenantId: options.tenantId, sessionToken: request.sessionToken, instant: requestInstant },
      async (transaction) => {
        const context = authorizationContext(transaction, options.tenantId, requestInstant);
        const permissions = await documentPermissions(
          context,
          options.tenantId,
          request.documentId,
        );
        if (!permissions.read && !permissions.readHistory) return notFound();

        const view = await getReaderDocumentVersion(transaction, {
          tenantId: options.tenantId,
          documentId: request.documentId,
          versionId: request.versionId,
          requestInstant,
        });
        if (!view || !view.version) return notFound();
        const allowed = view.version.governsAtRequestInstant
          ? permissions.read
          : permissions.readHistory;
        if (!allowed) return notFound();
        return Response.json(
          { view, answeredAt: requestInstant, requestInstant } satisfies ReaderViewPayload,
          { status: 200, headers: RESPONSE_HEADERS },
        );
      },
    );
    return response ?? notFound();
  };
}
