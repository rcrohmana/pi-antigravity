// A-04 section 9.4 no-model descendant canary probe.
// Invoked as: node env-canary-probe.mjs child|grandchild
// The "child" mode starts a grandchild with NORMAL environment inheritance
// (no env override) and aggregates both reports. Reports contain only boolean
// canary presence and sorted environment key NAMES — never values.
import { spawn } from "node:child_process";

const CANARY_NAME = "A04_TEST_CANARY";

function report() {
  return {
    keys: Object.keys(process.env).sort(),
    canaryPresent: Object.hasOwn(process.env, CANARY_NAME),
  };
}

const mode = process.argv[2];
if (mode === "grandchild") {
  process.stdout.write(`${JSON.stringify(report())}\n`);
} else {
  const grandchild = spawn(process.execPath, [process.argv[1], "grandchild"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  let stdout = "";
  let stderrBytes = 0;
  grandchild.stdout.setEncoding("utf8");
  grandchild.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  grandchild.stderr.on("data", (chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
  });
  grandchild.once("close", (code) => {
    let grandchildReport = null;
    try {
      grandchildReport = JSON.parse(stdout);
    } catch {
      // Surfaced through the null report below.
    }
    process.stdout.write(
      `${JSON.stringify({ child: report(), grandchild: grandchildReport, grandchildExitCode: code, grandchildStderrLength: stderrBytes })}\n`,
    );
  });
}
