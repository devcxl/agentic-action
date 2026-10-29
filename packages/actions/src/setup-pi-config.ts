import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SetupPiConfigOptions {
  actionPath?: string;
  agentDir?: string;
  defaultProjectTrust?: "never" | "ask" | "always";
}

export interface SetupPiConfigResult {
  settingsPath: string;
  installedExtensions: string[];
}

export function setupPiConfig(
  options: SetupPiConfigOptions = {},
): SetupPiConfigResult {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distParent = resolve(__dirname, "..");
  const defaultActionPath = existsSync(join(distParent, "packages/extensions/src"))
    ? distParent
    : resolve(__dirname, "../../..");
  const actionPath =
    options.actionPath ||
    process.env.ACTION_PATH ||
    defaultActionPath;
  const agentDir =
    options.agentDir ||
    process.env.PI_CODING_AGENT_DIR ||
    join(homedir(), ".pi", "agent");

  const extTargetDir = join(agentDir, "extensions");
  mkdirSync(extTargetDir, { recursive: true });

  // Clean up legacy v1 artifacts or task-scoped extensions if cached in global agentDir
  for (const stale of [
    join(agentDir, "AGENTS.md"),
    join(extTargetDir, "web-search.ts"),
    join(extTargetDir, "submit-review.ts"),
  ]) {
    if (existsSync(stale)) {
      rmSync(stale, { force: true });
    }
  }

  const dstSettingsPath = join(agentDir, "settings.json");
  let existingSettings: Record<string, unknown> = {};
  if (existsSync(dstSettingsPath)) {
    try {
      existingSettings = JSON.parse(
        readFileSync(dstSettingsPath, "utf8"),
      ) as Record<string, unknown>;
    } catch {
      existingSettings = {};
    }
  }

  const mergedSettings: Record<string, unknown> = {
    ...existingSettings,
    defaultProjectTrust: options.defaultProjectTrust ?? "never",
  };
  writeFileSync(
    dstSettingsPath,
    `${JSON.stringify(mergedSettings, null, 2)}\n`,
    "utf8",
  );

  const srcExtDir = join(actionPath, "packages", "extensions", "src");
  const installedExtensions: string[] = [];
  if (existsSync(srcExtDir)) {
    for (const entry of readdirSync(srcExtDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      // submit-review.ts is loaded explicitly via `-e` only during PR review to avoid global tool conflicts
      if (
        entry.name.endsWith(".d.ts") ||
        entry.name === "index.ts" ||
        entry.name === "submit-review.ts"
      ) {
        continue;
      }
      if (
        !entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".js") &&
        !entry.name.endsWith(".mjs")
      ) {
        continue;
      }
      copyFileSync(join(srcExtDir, entry.name), join(extTargetDir, entry.name));
      installedExtensions.push(entry.name);
    }
  }

  return {
    settingsPath: dstSettingsPath,
    installedExtensions,
  };
}

if (
  process.argv[1] &&
  import.meta.url === `file://${resolve(process.argv[1])}`
) {
  try {
    const { settingsPath, installedExtensions } = setupPiConfig();
    process.stderr.write(
      `[setup-pi-config] Updated ${settingsPath}; extensions: ${installedExtensions.join(", ") || "none"}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[setup-pi-config] Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
