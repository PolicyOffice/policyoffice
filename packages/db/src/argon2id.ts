import { argon2id, hash as argonHash, verify as argonVerify } from "argon2";
import type { PasswordHash, PasswordVerifier } from "@policyoffice/domain";

/** Explicitly stored beside each credential so future parameter raises are additive. */
export const ARGON2ID_PARAMETERS = Object.freeze({
  algorithm: "argon2id",
  version: 19,
  memoryCostKiB: 65_536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
} as const);

export const argon2idPasswordVerifier: PasswordVerifier = Object.freeze({
  async hash(secret: string): Promise<PasswordHash> {
    const secretHash = await argonHash(secret, {
      type: argon2id,
      version: ARGON2ID_PARAMETERS.version,
      memoryCost: ARGON2ID_PARAMETERS.memoryCostKiB,
      timeCost: ARGON2ID_PARAMETERS.timeCost,
      parallelism: ARGON2ID_PARAMETERS.parallelism,
      hashLength: ARGON2ID_PARAMETERS.hashLength,
    });
    return Object.freeze({ secretHash, params: ARGON2ID_PARAMETERS });
  },

  async verify(secret: string, passwordHash: PasswordHash): Promise<boolean> {
    if (
      passwordHash.params.algorithm !== ARGON2ID_PARAMETERS.algorithm ||
      !passwordHash.secretHash.startsWith("$argon2id$")
    ) {
      return false;
    }
    try {
      return await argonVerify(passwordHash.secretHash, secret);
    } catch {
      // Corrupt credential data must fail closed without becoming an authentication bypass.
      return false;
    }
  },
});
