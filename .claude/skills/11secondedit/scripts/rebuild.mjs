// Deterministic rebuild after any change (transcript edits in the browser, new decisions):
// edl.json → composition/. No AI involved.
import { currentProjectDir } from "./lib.mjs";
import { buildEdl } from "./build-edl.mjs";
import { buildComposition } from "./build-composition.mjs";

const dir = currentProjectDir();
const edl = buildEdl(dir);
buildComposition(dir, { applyColor: !process.argv.includes("--no-color") });
console.log(`Rebuilt: ${edl.sourceDuration.toFixed(1)}s → ${edl.duration.toFixed(1)}s, ${edl.segments.length} segments.`);
