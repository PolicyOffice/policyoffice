import { cookies } from "next/headers";
import { createContentUploadSlotHandler } from "@/authoring";
import { installationTenantId } from "@/installation-tenant";
import { controlledFileStorage } from "@/object-storage";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface UploadSlotRouteContext {
  readonly params: Promise<Readonly<{ documentId: string; versionId: string }>>;
}

interface UploadSlotBody {
  readonly claimedDigest: string;
  readonly claimedByteSize: number;
}

function uploadSlotBody(value: unknown): UploadSlotBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { claimedDigest: "", claimedByteSize: 0 };
  }
  const body = value as Record<string, unknown>;
  return {
    claimedDigest: typeof body.claimedDigest === "string" ? body.claimedDigest : "",
    claimedByteSize: typeof body.claimedByteSize === "number" ? body.claimedByteSize : 0,
  };
}

export async function POST(request: Request, context: UploadSlotRouteContext): Promise<Response> {
  const [cookieStore, { documentId, versionId }] = await Promise.all([cookies(), context.params]);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  return createContentUploadSlotHandler({
    tenantId: installationTenantId(),
    storage: controlledFileStorage(),
  })({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
    documentId,
    versionId,
    ...uploadSlotBody(body),
  });
}
