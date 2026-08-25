/**
 * The three migration checks, runnable individually because CI runs them as separate
 * gates and one job should have one reason to go red.
 */
import { verifyDrift, verifyFresh, verifyUpgrade } from "./verify.js";

const command = process.argv[2];

if (command === "fresh") {
  await verifyFresh();
  console.log("fresh install: the migration chain builds the schema from nothing");
} else if (command === "upgrade") {
  await verifyUpgrade();
  console.log("upgrade: new migrations applied to the previous schema, with data intact");
} else if (command === "drift") {
  const { drifted, diff } = await verifyDrift();
  if (drifted) {
    console.error("SCHEMA DRIFT: the migration chain and src/schema.ts disagree.\n");
    console.error(diff);
    console.error(
      [
        "",
        "One of the two is wrong. ADR-0009 keeps them in step so that a disagreement is a",
        "failed build rather than a runtime discovery.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log("drift: the schema built from migrations matches src/schema.ts");
} else {
  console.error("usage: verify-cli.ts <fresh|upgrade|drift>");
  process.exit(2);
}
