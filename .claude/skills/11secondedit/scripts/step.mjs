// Report progress to the browser checklist.
// Usage: node step.mjs <start|done|skip|error> <stepId> [detail...]
//        node step.mjs finish            -> pipeline complete, browser switches to the editor
//        node step.mjs fail "<message>"  -> pipeline failed
import { currentProjectDir, setStep, updateState } from "./lib.mjs";

const [action, id, ...rest] = process.argv.slice(2).filter((a, i, arr) => a !== "--project" && arr[i - 1] !== "--project");
const dir = currentProjectDir();
const detail = rest.join(" ") || undefined;
const map = { start: "running", done: "done", skip: "skipped", error: "error" };

if (action === "finish") {
  updateState(dir, (s) => { s.status = "review"; s.finishedAt = new Date().toISOString(); });
  console.log("Pipeline finished; browser is now showing the editor.");
} else if (action === "fail") {
  updateState(dir, (s) => { s.status = "error"; s.error = [id, ...rest].filter(Boolean).join(" "); });
  console.log("Marked pipeline as failed.");
} else if (map[action] && id) {
  setStep(dir, id, map[action], detail);
  console.log(`${id}: ${map[action]}${detail ? " — " + detail : ""}`);
} else {
  console.error("Usage: node step.mjs <start|done|skip|error> <stepId> [detail] | finish | fail <msg>");
  process.exit(1);
}
