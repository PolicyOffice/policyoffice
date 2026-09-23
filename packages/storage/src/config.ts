const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export type StorageEnvironment = Readonly<Record<string, string | undefined>>;

export interface StorageConfiguration {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region: string;
  readonly forcePathStyle: boolean;
}

export class StorageConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageConfigurationError";
  }
}

function required(environment: StorageEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new StorageConfigurationError(`${name} is required`);
  return value;
}

function endpointUrl(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (cause) {
    throw new StorageConfigurationError("S3_ENDPOINT must be an absolute HTTP(S) URL", {
      cause,
    });
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new StorageConfigurationError("S3_ENDPOINT must be an absolute HTTP(S) URL");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new StorageConfigurationError(
      "S3_ENDPOINT must not contain credentials, query or fragment",
    );
  }
  return endpoint;
}

function parseForcePathStyle(environment: StorageEnvironment, endpoint: URL): boolean {
  const configured = environment.S3_FORCE_PATH_STYLE?.trim().toLowerCase();
  if (configured !== undefined && configured !== "true" && configured !== "false") {
    throw new StorageConfigurationError("S3_FORCE_PATH_STYLE must be true or false when set");
  }
  if (configured !== undefined) return configured === "true";
  return endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
}

/** Parse every storage setting before the web process binds a port. */
export function storageConfiguration(
  environment: StorageEnvironment = process.env,
): StorageConfiguration {
  const endpoint = endpointUrl(required(environment, "S3_ENDPOINT"));
  const bucket = required(environment, "S3_BUCKET");
  if (!BUCKET.test(bucket)) {
    throw new StorageConfigurationError("S3_BUCKET must be a valid DNS-compatible bucket name");
  }
  return Object.freeze({
    endpoint: endpoint.toString().replace(/\/$/, ""),
    accessKeyId: required(environment, "S3_ACCESS_KEY"),
    secretAccessKey: required(environment, "S3_SECRET_KEY"),
    bucket,
    region: environment.S3_REGION?.trim() || "us-east-1",
    forcePathStyle: parseForcePathStyle(environment, endpoint),
  });
}
