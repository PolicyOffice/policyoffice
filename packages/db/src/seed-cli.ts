import { loadFixtureSet, loadReferenceData } from "./fixtures.js";

const command = process.argv[2];

if (command === "reference") {
  const applied = await loadReferenceData();
  console.log(
    applied.length === 0
      ? "reference data is current; it is owned by the applied migration chain"
      : `loaded reference data through ${applied.length} migration(s)`,
  );
} else if (command === "development" || command === "test") {
  const result = await loadFixtureSet(command);
  console.log(`loaded ${result.kind} fixtures for ${result.tenantIds.length} tenant(s)`);
} else {
  console.error("usage: seed-cli.ts <reference|development|test>");
  process.exitCode = 2;
}
