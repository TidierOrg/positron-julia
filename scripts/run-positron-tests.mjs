// Launcher for the Positron-only integration tests (src/test/positron/).
//
// Downloads (or reuses a cached) Positron build and runs the compiled Mocha
// entry point (out/test/positron/index.js) inside it, via
// @posit-dev/positron-test-electron -- the Positron analog of
// @vscode/test-electron.
//
// Run with `npm run test-positron`, which compiles the extension and tests
// first via the `pretest-positron` hook. Set POSITRON_CHANNEL=daily to test
// against a daily Positron build (default: stable).
//
// NOTE: @posit-dev/positron-test-electron currently supports macOS only
// (arm64 + x64); Windows/Linux support is planned upstream. On other
// platforms, rely on the "Positron API Tests" GitHub Actions workflow.

import { runTests } from "@posit-dev/positron-test-electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Extension root (contains package.json); scripts/ lives one level below it.
  const extensionDevelopmentPath = path.resolve(__dirname, "..");

  // Compiled Mocha entry point that discovers and runs the Positron tests.
  const extensionTestsPath = path.resolve(
    extensionDevelopmentPath,
    "out",
    "test",
    "positron",
    "index.js"
  );

  const code = await runTests({
    channel: process.env.POSITRON_CHANNEL ?? "stable",
    extensionDevelopmentPath,
    extensionTestsPath,
    // Keep Positron's bundled extensions enabled (no --disable-extensions):
    // the Julia extension resolves positron.positron-supervisor when creating
    // sessions, and leaving them enabled keeps the door open for future tests
    // that exercise that cross-extension wiring.
    disableExtensions: false,
  });

  process.exit(code);
}

main().catch((err) => {
  console.error("Failed to run Positron integration tests:");
  console.error(err);
  process.exit(1);
});
