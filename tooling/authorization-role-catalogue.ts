export interface AuthorizationRoleDefinition {
  readonly code: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly isSystem: boolean;
}

export interface AuthorizationModelDefinition {
  readonly capabilities: readonly string[];
  readonly roles: readonly AuthorizationRoleDefinition[];
}

function section(document: string, heading: string, nextHeading: string): string {
  const selected = document.split(heading)[1]?.split(nextHeading)[0];
  if (!selected) throw new Error(`could not find ${heading} before ${nextHeading}`);
  return selected;
}

function roleCode(name: string): string {
  return name
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, "_")
    .replaceAll(/^_|_$/g, "");
}

function inheritedRole(
  roleName: string,
  capabilityCell: string,
  resolved: readonly AuthorizationRoleDefinition[],
): AuthorizationRoleDefinition | undefined {
  if (capabilityCell.trimStart().startsWith("`")) return undefined;

  const reference = capabilityCell.match(/^([^,`—]+?)(?:,|—|$)/)?.[1]?.trim();
  if (!reference) return undefined;
  const matches = resolved.filter(
    (role) => role.name === reference || role.name.endsWith(` ${reference}`),
  );
  if (matches.length !== 1) {
    throw new Error(`${roleName}: could not resolve inherited role ${reference}`);
  }
  return matches[0];
}

export function parseAuthorizationModel(document: string): AuthorizationModelDefinition {
  const capabilities = section(document, "## Capabilities", "## Roles")
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\| `([a-z_]+\.[a-z_]+)` \|/);
      return match?.[1] ? [match[1]] : [];
    });

  const roles: AuthorizationRoleDefinition[] = [];
  for (const line of section(document, "## Roles", "## Scopes and containment").split("\n")) {
    const match = line.match(/^\| \*\*([^*]+)\*\* \| (.+) \|$/);
    if (!match?.[1] || !match[2]) continue;

    const name = match[1];
    const capabilityCell = match[2];
    const inherited = inheritedRole(name, capabilityCell, roles);
    const direct = [...capabilityCell.matchAll(/`([a-z_]+\.[a-z_]+)`/g)].map(
      (capability) => capability[1]!,
    );
    roles.push({
      code: roleCode(name),
      name,
      capabilities: [...new Set([...(inherited?.capabilities ?? []), ...direct])],
      isSystem: true,
    });
  }

  const documented = new Set(capabilities);
  for (const role of roles) {
    const unknown = role.capabilities.filter((capability) => !documented.has(capability));
    if (unknown.length > 0) {
      throw new Error(`${role.name}: unknown documented capabilities ${unknown.join(", ")}`);
    }
  }

  return { capabilities, roles };
}

export function systemRoleProblems(
  documentedRoles: readonly AuthorizationRoleDefinition[],
  seededRoles: readonly AuthorizationRoleDefinition[],
): string[] {
  const documented = new Map(documentedRoles.map((role) => [role.code, role]));
  const seeded = new Map(seededRoles.map((role) => [role.code, role]));
  const problems: string[] = [];

  for (const [code, role] of documented) {
    const seed = seeded.get(code);
    if (!seed) {
      problems.push(`${role.name} (${code}): documented role is missing from the seed`);
      continue;
    }
    if (seed.name !== role.name) {
      problems.push(`${role.name} (${code}): seeded name is ${seed.name}`);
    }
    if (!seed.isSystem) {
      problems.push(`${role.name} (${code}): seed is not marked as a system role`);
    }
    const expectedCapabilities = [...new Set(role.capabilities)].sort();
    const seededCapabilities = [...new Set(seed.capabilities)].sort();
    if (JSON.stringify(seededCapabilities) !== JSON.stringify(expectedCapabilities)) {
      problems.push(
        `${role.name} (${code}): capabilities differ; documented [${expectedCapabilities.join(", ")}], seeded [${seededCapabilities.join(", ")}]`,
      );
    }
  }

  for (const [code, role] of seeded) {
    if (!documented.has(code)) {
      problems.push(`${role.name} (${code}): seeded role is missing from the document`);
    }
  }

  return problems.sort();
}
