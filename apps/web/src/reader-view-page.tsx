import type { ReaderDocumentView, ReaderVersion } from "../../../packages/domain/src/index";

export type ReaderPageMode = "RECORD" | "EFFECTIVE" | "EXACT" | "AS_OF";

export interface ReaderViewPageProps {
  readonly view: ReaderDocumentView;
  readonly answeredAt: Date | string;
  readonly requestInstant: Date | string;
  readonly mode: ReaderPageMode;
}

function formatInstant(value: Date | string): string {
  return `${new Date(value).toISOString()} (UTC)`;
}

function versionLabel(version: Pick<ReaderVersion, "displayLabel" | "id">): string {
  return version.displayLabel ?? version.id;
}

function Classification({ version }: Readonly<{ version: ReaderVersion | null }>) {
  return (
    <section aria-labelledby="classification-and-handling">
      <h2 id="classification-and-handling">Classification and handling</h2>
      {version ? (
        <dl>
          <dt>Classification</dt>
          <dd>
            {version.classification.name} ({version.classification.code})
          </dd>
          <dt>Handling instructions</dt>
          <dd>{version.classification.handlingInstructions}</dd>
        </dl>
      ) : (
        <dl>
          <dt>Classification</dt>
          <dd>Not applicable — no version governed at the stated instant.</dd>
          <dt>Handling instructions</dt>
          <dd>None — no policy version governed at the stated instant.</dd>
        </dl>
      )}
    </section>
  );
}

function ExactVersionNotice({
  documentId,
  version,
  requestInstant,
}: Readonly<{
  documentId: string;
  version: ReaderVersion;
  requestInstant: Date | string;
}>) {
  if (version.governsAtRequestInstant) {
    return <p role="status">This version governs now.</p>;
  }
  if (new Date(version.effectiveFrom).valueOf() > new Date(requestInstant).valueOf()) {
    return (
      <aside aria-labelledby="scheduled-version">
        <h2 id="scheduled-version">Scheduled version</h2>
        <p>
          This version will bind from{" "}
          <time dateTime={new Date(version.effectiveFrom).toISOString()}>
            {formatInstant(version.effectiveFrom)}
          </time>
          . It does not govern now.
        </p>
      </aside>
    );
  }
  return (
    <aside aria-labelledby="historical-version">
      <h2 id="historical-version">Historical version</h2>
      <p>This version does not govern now.</p>
      {version.supersededBy ? (
        <p>
          Superseded by{" "}
          <a href={`/documents/${documentId}/versions/${version.supersededBy.id}`}>
            version {versionLabel(version.supersededBy)} — {version.supersededBy.title}
          </a>
          .
        </p>
      ) : null}
    </aside>
  );
}

function ResolutionNotice({
  mode,
  version,
  answeredAt,
  requestInstant,
}: Readonly<{
  mode: ReaderPageMode;
  version: ReaderVersion | null;
  answeredAt: Date | string;
  requestInstant: Date | string;
}>) {
  if (mode === "AS_OF") {
    const answer = new Date(answeredAt).valueOf();
    const request = new Date(requestInstant).valueOf();
    return (
      <aside aria-labelledby="point-in-time-answer">
        <h2 id="point-in-time-answer">Point-in-time answer</h2>
        <p>
          Answered for{" "}
          <time dateTime={new Date(answeredAt).toISOString()}>{formatInstant(answeredAt)}</time>.
        </p>
        {version ? (
          answer > request ? (
            <p>This version is scheduled to govern at the stated instant.</p>
          ) : (
            <p>This version governed at the stated instant.</p>
          )
        ) : (
          <p>Nothing governed at this instant.</p>
        )}
      </aside>
    );
  }
  return version ? (
    <p role="status">
      Version {versionLabel(version)} governs for this answer, made at{" "}
      <time dateTime={new Date(answeredAt).toISOString()}>{formatInstant(answeredAt)}</time>.
    </p>
  ) : (
    <p role="status">No version governs at this instant.</p>
  );
}

export function ReaderViewPage({ view, answeredAt, requestInstant, mode }: ReaderViewPageProps) {
  const { document, version } = view;
  return (
    <main>
      <p>
        <a href="/">Document register</a>
      </p>
      <p>
        {mode === "RECORD"
          ? "Document record"
          : mode === "EFFECTIVE"
            ? "Effective policy"
            : mode === "EXACT"
              ? "Exact version"
              : "Dated policy view"}
      </p>
      <h1>
        {document.code} {version?.title ?? document.title}
      </h1>

      {mode === "EXACT" && version ? (
        <ExactVersionNotice
          documentId={document.id}
          version={version}
          requestInstant={requestInstant}
        />
      ) : (
        <ResolutionNotice
          mode={mode}
          version={version}
          answeredAt={answeredAt}
          requestInstant={requestInstant}
        />
      )}

      <Classification version={version} />

      <section aria-labelledby="document-details">
        <h2 id="document-details">Document details</h2>
        <dl>
          <dt>Document</dt>
          <dd>
            {document.code} — {document.title}
          </dd>
          <dt>Owner</dt>
          <dd>{document.owner?.name ?? "No owner assigned"}</dd>
          <dt>Owning scope</dt>
          <dd>
            {document.owningScope.name} ({document.owningScope.code})
          </dd>
          <dt>Document type</dt>
          <dd>{version?.documentType.name ?? document.documentType.name}</dd>
        </dl>
      </section>

      {version ? (
        <>
          <section aria-labelledby="version-details">
            <h2 id="version-details">Version details</h2>
            <dl>
              <dt>Version</dt>
              <dd>{versionLabel(version)}</dd>
              <dt>Effective from</dt>
              <dd>
                <time dateTime={new Date(version.effectiveFrom).toISOString()}>
                  {formatInstant(version.effectiveFrom)}
                </time>
              </dd>
              {version.effectiveUntil ? (
                <>
                  <dt>Governed until</dt>
                  <dd>
                    <time dateTime={new Date(version.effectiveUntil).toISOString()}>
                      {formatInstant(version.effectiveUntil)}
                    </time>
                  </dd>
                </>
              ) : null}
              <dt>Change summary</dt>
              <dd>{version.changeSummary ?? "No change summary supplied"}</dd>
            </dl>
          </section>

          <section aria-labelledby="document-files">
            <h2 id="document-files">Document files</h2>
            <p>
              Content digest: <code>{version.contentDigest}</code>
            </p>
            {version.attachments.length === 0 ? (
              <p>No attachment metadata is recorded for this version.</p>
            ) : (
              <ul>
                {version.attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <strong>{attachment.filename}</strong> — {attachment.mediaType},{" "}
                    {attachment.byteSize} bytes — digest <code>{attachment.digest}</code>
                  </li>
                ))}
              </ul>
            )}
            <p>The stored file metadata is shown here; file download is not available.</p>
          </section>
        </>
      ) : null}

      {mode !== "AS_OF" && view.laterPublishedVersion ? (
        <aside aria-labelledby="scheduled-update">
          <h2 id="scheduled-update">Scheduled update</h2>
          <p>
            Version {view.laterPublishedVersion.displayLabel ?? view.laterPublishedVersion.id} —{" "}
            {view.laterPublishedVersion.title} will bind from{" "}
            <time dateTime={new Date(view.laterPublishedVersion.bindsFrom).toISOString()}>
              {formatInstant(view.laterPublishedVersion.bindsFrom)}
            </time>
            .{" "}
            {version
              ? "The version above continues to govern until then."
              : "Nothing governs before then."}
          </p>
        </aside>
      ) : null}

      <nav aria-label="Document reader links">
        <a href={`/documents/${document.id}`}>Document record</a>{" "}
        <a href={`/documents/${document.id}/effective`}>Effective policy</a>
        {version ? (
          <>
            {" "}
            <a href={`/documents/${document.id}/versions/${version.id}`}>Exact version</a>
          </>
        ) : null}
      </nav>
    </main>
  );
}
