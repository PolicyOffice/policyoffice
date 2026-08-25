/**
 * Every invariant either has a test, or is explicitly registered as not yet implemented.
 *
 * `agent-workflow.md` § Traceability commits to a chain:
 *
 *   spec section  ->  INV-ID  ->  test name  ->  issue  ->  PR  ->  ADR
 *
 * with the gate: "CI fails if any invariant has zero tests referencing it."
 *
 * Taken literally today that fails on ~149 invariants, because almost nothing is
 * implemented. A gate that is red from the first commit is a gate somebody disables
 * within a week, and then the chain is decorative.
 *
 * So the gate is: an invariant must be **tested** or **registered**. The register is a
 * committed file, reviewed like anything else, and it only shrinks. Adding an entry is
 * more visible in a diff than writing the test would have been, which is the incentive
 * we want.
 *
 * Three ways to fail, deliberately:
 *
 *   1. untested and unregistered   -- the gate's actual purpose
 *   2. registered AND tested       -- the register has rotted into a list of things
 *                                     quietly done; the entry must go
 *   3. a test names an unknown ID  -- a typo that would otherwise look like coverage,
 *                                     which is worse than no coverage at all
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY = join(REPO_ROOT, "docs/domain/invariants.md");
const REGISTER = join(REPO_ROOT, "tooling/invariants-pending.md");

const INV = /INV-[A-Z]+-\d+/g;

export interface Coverage {
  registered: Set<string>;
  tested: Map<string, string[]>;
  pending: Map<string, string>;
}

export interface Problem {
  kind: "untested-and-unregistered" | "registered-but-tested" | "unknown-id";
  id: string;
  detail: string;
}

/** Invariant IDs declared in the registry. The registry is the only source of truth. */
export function parseRegistry(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    // Only table rows declare invariants. Prose references them too, and counting those
    // would invent invariants that do not exist.
    if (!line.startsWith("| INV-")) continue;
    const m = line.match(/^\|\s*(INV-[A-Z]+-\d+)/);
    if (m?.[1]) ids.add(m[1]);
  }
  return ids;
}

/**
 * Entries in the not-yet-implemented register.
 *
 * Fenced code blocks are skipped. The register documents its own format with a worked
 * example, and an example that parses as a real entry would report a phantom invariant
 * -- which is exactly the "unknown id" failure below, raised against documentation.
 */
export function parseRegister(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^-\s+(INV-[A-Z]+-\d+)\s+[—-]\s+(.+)$/);
    if (m?.[1] && m[2]) out.set(m[1], m[2].trim());
  }
  return out;
}

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === ".git")
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Invariant IDs cited in **test titles**, not anywhere in the file.
 *
 * Scanning file contents would let a passing mention in a comment count as coverage.
 * `agent-workflow.md` says test *names* contain the IDs, so the titles passed to
 * describe/it/test are what is read.
 */
export function citedInTitles(source: string, fileName = "t.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (/^(describe|it|test)(\.\w+)*$/.test(callee)) {
        const first = node.arguments[0];
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          found.push(...(first.text.match(INV) ?? []));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export function collect(root = REPO_ROOT): Coverage {
  const registered = parseRegistry(readFileSync(REGISTRY, "utf8"));
  const pending = parseRegister(readFileSync(REGISTER, "utf8"));
  const tested = new Map<string, string[]>();
  for (const file of testFiles(root)) {
    for (const id of citedInTitles(readFileSync(file, "utf8"), file)) {
      const where = relative(root, file);
      tested.set(id, [...(tested.get(id) ?? []), where]);
    }
  }
  return { registered, tested, pending };
}

export function problems({ registered, tested, pending }: Coverage): Problem[] {
  const found: Problem[] = [];
  for (const id of registered) {
    if (tested.has(id) && pending.has(id)) {
      found.push({
        kind: "registered-but-tested",
        id,
        detail: `tested in ${tested.get(id)?.join(", ")} but still listed as pending. Remove the register entry.`,
      });
    } else if (!tested.has(id) && !pending.has(id)) {
      found.push({
        kind: "untested-and-unregistered",
        id,
        detail:
          "no test names it and it is not in tooling/invariants-pending.md. Write the test, or register it with a reason and the ticket that will.",
      });
    }
  }
  for (const [id, files] of tested) {
    if (!registered.has(id)) {
      found.push({
        kind: "unknown-id",
        id,
        detail: `named by ${files.join(", ")} but absent from docs/domain/invariants.md. A typo here looks like coverage while proving nothing.`,
      });
    }
  }
  for (const id of pending.keys()) {
    if (!registered.has(id)) {
      found.push({
        kind: "unknown-id",
        id,
        detail: "listed as pending but absent from the registry. Remove it.",
      });
    }
  }
  return found;
}

export function report(c: Coverage): string {
  const p = problems(c);
  const covered = [...c.registered].filter((id) => c.tested.has(id)).length;
  const lines = [
    `invariants: ${c.registered.size} registered, ${covered} tested, ${c.pending.size} pending`,
  ];
  if (p.length) {
    lines.push("");
    for (const problem of p) lines.push(`  ${problem.kind}: ${problem.id} — ${problem.detail}`);
  }
  return lines.join("\n");
}

// Runnable directly: `node --experimental-strip-types tooling/invariant-coverage.ts`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=tooling)/, ""))) {
  const c = collect();
  const p = problems(c);
  console.log(report(c));
  process.exit(p.length ? 1 : 0);
}
