import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// packages/actions/src/setup-pi-config.ts
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function setupPiConfig(options = {}) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const actionPath = options.actionPath || process.env.ACTION_PATH || resolve(__dirname, "../../..");
  const agentDir = options.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const extTargetDir = join(agentDir, "extensions");
  mkdirSync(extTargetDir, { recursive: true });
  for (const stale of [
    join(agentDir, "AGENTS.md"),
    join(extTargetDir, "web-search.ts"),
    join(extTargetDir, "submit-review.ts")
  ]) {
    if (existsSync(stale)) {
      rmSync(stale, { force: true });
    }
  }
  const dstSettingsPath = join(agentDir, "settings.json");
  let existingSettings = {};
  if (existsSync(dstSettingsPath)) {
    try {
      existingSettings = JSON.parse(
        readFileSync(dstSettingsPath, "utf8")
      );
    } catch {
      existingSettings = {};
    }
  }
  const mergedSettings = {
    ...existingSettings,
    defaultProjectTrust: options.defaultProjectTrust ?? "never"
  };
  writeFileSync(
    dstSettingsPath,
    `${JSON.stringify(mergedSettings, null, 2)}
`,
    "utf8"
  );
  const srcExtDir = join(actionPath, "packages", "extensions", "src");
  const installedExtensions = [];
  if (existsSync(srcExtDir)) {
    for (const entry of readdirSync(srcExtDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".d.ts") || entry.name === "index.ts" || entry.name === "submit-review.ts") {
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
      copyFileSync(join(srcExtDir, entry.name), join(extTargetDir, entry.name));
      installedExtensions.push(entry.name);
    }
  }
  return {
    settingsPath: dstSettingsPath,
    installedExtensions
  };
}
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    const { settingsPath, installedExtensions } = setupPiConfig();
    process.stderr.write(
      `[setup-pi-config] Updated ${settingsPath}; extensions: ${installedExtensions.join(", ") || "none"}
`
    );
  } catch (error) {
    process.stderr.write(
      `[setup-pi-config] Error: ${error instanceof Error ? error.message : String(error)}
`
    );
    process.exit(1);
  }
}
export {
  setupPiConfig
};
