#!/usr/bin/env node
/**
 * Pi 配置与扩展安全同步器
 *
 * 目标：
 * 1. 将 Action 内置的 settings.json 与 ~/.pi/agent/settings.json 深度合并，
 *    既确保 defaultProjectTrust: "always" 生效，又不覆盖宿主环境已有的其他配置。
 * 2. 将 pi-config/extensions/*.ts 增量同步到 ~/.pi/agent/extensions/。
 * 3. 不注入全局 AGENTS.md，避免污染目标仓库的上下文与提示词。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function setupPiConfig({
  actionPath = process.env.ACTION_PATH || process.cwd(),
  agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
} = {}) {
  const configDir = resolve(actionPath, "pi-config");
  const extTargetDir = join(agentDir, "extensions");
  mkdirSync(extTargetDir, { recursive: true });

  const srcSettingsPath = join(configDir, "settings.json");
  const dstSettingsPath = join(agentDir, "settings.json");
  let baseSettings = {};
  if (existsSync(srcSettingsPath)) {
    try {
      baseSettings = JSON.parse(readFileSync(srcSettingsPath, "utf8"));
    } catch {
      baseSettings = { defaultProjectTrust: "always" };
    }
  }

  let existingSettings = {};
  if (existsSync(dstSettingsPath)) {
    try {
      existingSettings = JSON.parse(readFileSync(dstSettingsPath, "utf8"));
    } catch {
      existingSettings = {};
    }
  }

  const mergedSettings = {
    ...baseSettings,
    ...existingSettings,
    defaultProjectTrust: existingSettings.defaultProjectTrust ?? baseSettings.defaultProjectTrust ?? "always",
  };
  writeFileSync(dstSettingsPath, `${JSON.stringify(mergedSettings, null, 2)}\n`, "utf8");

  const srcExtDir = join(configDir, "extensions");
  const installedExtensions = [];
  if (existsSync(srcExtDir)) {
    for (const entry of readdirSync(srcExtDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js") && !entry.name.endsWith(".mjs")) continue;
      const srcFile = join(srcExtDir, entry.name);
      const dstFile = join(extTargetDir, entry.name);
      copyFileSync(srcFile, dstFile);
      installedExtensions.push(entry.name);
    }
  }

  return { agentDir, settingsPath: dstSettingsPath, installedExtensions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const res = setupPiConfig();
    console.error(`[setup-pi-config] synced to ${res.agentDir} (extensions: ${res.installedExtensions.join(", ") || "none"})`);
  } catch (error) {
    console.error(`[setup-pi-config] error: ${error.message}`);
    process.exit(1);
  }
}
