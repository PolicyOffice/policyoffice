import { describe, expect, it } from "vitest";
import { ARGON2ID_PARAMETERS, argon2idPasswordVerifier } from "./argon2id.js";

describe("the Argon2id password verifier adapter", () => {
  it("stores explicit Argon2id parameters and verifies only the matching password", async () => {
    const passwordHash = await argon2idPasswordVerifier.hash("correct horse battery staple");

    expect(passwordHash.secretHash).toMatch(/^\$argon2id\$v=19\$/);
    expect(passwordHash.params).toEqual(ARGON2ID_PARAMETERS);
    await expect(
      argon2idPasswordVerifier.verify("correct horse battery staple", passwordHash),
    ).resolves.toBe(true);
    await expect(argon2idPasswordVerifier.verify("incorrect", passwordHash)).resolves.toBe(false);
  });

  it("fails closed for a credential recorded under another algorithm", async () => {
    const passwordHash = await argon2idPasswordVerifier.hash("correct horse battery staple");

    await expect(
      argon2idPasswordVerifier.verify("correct horse battery staple", {
        ...passwordHash,
        params: { ...passwordHash.params, algorithm: "argon2i" },
      }),
    ).resolves.toBe(false);
  });

  it("fails closed for malformed stored credential data", async () => {
    await expect(
      argon2idPasswordVerifier.verify("correct horse battery staple", {
        secretHash: "$argon2id$malformed",
        params: ARGON2ID_PARAMETERS,
      }),
    ).resolves.toBe(false);
  });
});
