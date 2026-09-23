"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ContentUploadSlotPayload } from "@/authoring";

interface ContentUploadFormProps {
  readonly documentId: string;
  readonly versionId: string;
  readonly submission: Readonly<{
    revisionId: string;
    revisionRowVersion: string;
    versionRowVersion: string;
  }> | null;
}

async function digest(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const value = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha-256:${hex}`;
}

function navigateToFinalization(
  documentId: string,
  versionId: string,
  slot: ContentUploadSlotPayload,
): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = `/author/documents/${documentId}/versions/${versionId}/revisions/${slot.revisionId}/finalize`;
  const fields = {
    slotId: slot.slotId,
    claimedDigest: slot.claimedDigest,
    claimedByteSize: String(slot.claimedByteSize),
    expiresAt: slot.expiresAt,
  };
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}

export function ContentUploadForm({ documentId, versionId, submission }: ContentUploadFormProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [hydrated, setHydrated] = useState(false);
  const [fileSelected, setFileSelected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setHydrated(true), []);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file || file.size < 1) {
      setError("Choose a non-empty policy file.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const claimedDigest = await digest(file);
      const slotResponse = await fetch(
        `/author/documents/${documentId}/versions/${versionId}/revisions/upload-slots`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claimedDigest, claimedByteSize: file.size }),
        },
      );
      if (!slotResponse.ok) throw new Error("upload slot was refused");
      const slot = (await slotResponse.json()) as ContentUploadSlotPayload;
      const uploadResponse = await fetch(slot.uploadUrl, {
        method: "PUT",
        headers: slot.requiredHeaders,
        body: file,
      });
      if (!uploadResponse.ok) throw new Error("object upload failed");
      navigateToFinalization(documentId, versionId, slot);
    } catch {
      setSaving(false);
      setError("The file could not be saved. Request a new upload and try again.");
    }
  }

  return (
    <>
      <form onSubmit={save}>
        <label htmlFor="content">Candidate policy file</label>
        <input
          id="content"
          name="content"
          onChange={() => setFileSelected(true)}
          ref={fileInput}
          required
          type="file"
        />
        <button disabled={!hydrated || saving} type="submit">
          {saving ? "Saving…" : "Save draft"}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
      {submission ? (
        <form action={`/author/documents/${documentId}/versions/${versionId}/submit`} method="post">
          <input name="revisionId" type="hidden" value={submission.revisionId} />
          <input
            name="expectedRevisionRowVersion"
            type="hidden"
            value={submission.revisionRowVersion}
          />
          <input
            name="expectedVersionRowVersion"
            type="hidden"
            value={submission.versionRowVersion}
          />
          <button disabled={fileSelected || saving} type="submit">
            Submit for review
          </button>
        </form>
      ) : null}
    </>
  );
}
