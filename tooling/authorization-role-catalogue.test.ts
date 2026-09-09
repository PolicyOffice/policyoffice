import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYSTEM_ROLE_SEEDS } from "../packages/db/src/authorization-reference.js";
import { ACCESS_GRANT_REQUIRED_CAPABILITIES } from "../packages/domain/src/authorization.js";
import {
  parseAuthorizationModel,
  systemRoleProblems,
  type AuthorizationRoleDefinition,
} from "./authorization-role-catalogue.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUTHORIZATION_MODEL = readFileSync(join(ROOT, "docs/domain/authorization-model.md"), "utf8");

const reader: AuthorizationRoleDefinition = {
  code: "READER",
  name: "Reader",
  capabilities: ["document.read"],
  isSystem: true,
};

describe("authorization role catalogue", () => {
  it("INV-AUTH-016: keeps system role seeds equal to the documented role table", () => {
    const documented = parseAuthorizationModel(AUTHORIZATION_MODEL);
    expect(documented.capabilities).toHaveLength(30);
    expect(documented.roles).toHaveLength(9);
    expect(systemRoleProblems(documented.roles, SYSTEM_ROLE_SEEDS)).toEqual([]);
  });

  it("records document.manage_access for grant and revoke entry points without enforcing it", () => {
    expect(ACCESS_GRANT_REQUIRED_CAPABILITIES).toEqual({
      grant: "document.manage_access",
      revoke: "document.manage_access",
    });
  });

  it("accepts matching documented and seeded role fixtures", () => {
    expect(systemRoleProblems([reader], [reader])).toEqual([]);
  });

  it("names a role present only in the document", () => {
    expect(systemRoleProblems([reader], [])).toEqual([
      "Reader (READER): documented role is missing from the seed",
    ]);
  });

  it("names a role present only in the seed", () => {
    expect(systemRoleProblems([], [reader])).toEqual([
      "Reader (READER): seeded role is missing from the document",
    ]);
  });
});
