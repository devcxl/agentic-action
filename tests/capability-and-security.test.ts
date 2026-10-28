import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSandboxSpec,
  collectSensitiveValues,
  deriveCapabilityPolicy,
  isShellEnabledInPolicy,
  redactText,
} from "@agentic-action/core";
import { scrubGitCredentials } from "@agentic-action/adapters";
import { setupPiConfig } from "@agentic-action/actions";

describe("CapabilityPolicy, SandboxSpec & Security (P0 / P1)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "agentic-cap-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("enforces --no-approve and --no-mcp by default for untrusted PR review", () => {
    const policy = deriveCapabilityPolicy({
      tools: "read,grep,find,ls,submit_review",
      provider: "openai",
      model: "gpt-4o",
      trustProject: false,
      allowMcp: false,
    });

    const sandbox = buildSandboxSpec(
      {
        prompt: "- dash prompt",
        model: "gpt-4o",
        provider: "openai",
        apiKey: "sk-secret-key-12345678",
        mode: "json",
        policy,
      },
      {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-openai-12345678",
        ANTHROPIC_API_KEY: "sk-ant-other-provider",
        TYPESAFE_API_KEY: "ts-jev-secret-key-999",
        EXA_API_KEY: "exa-should-not-leak",
        GITHUB_TOKEN: "ghs_github_secret_token",
        GH_TOKEN: "ghs_gh_secret_token",
        INPUT_API_KEY: "sk-input-secret",
        INPUT_GITHUB_TOKEN: "ghs_input_token",
      },
    );

    expect(sandbox.argv).toContain("--no-approve");
    expect(sandbox.argv).not.toContain("--approve");
    expect(sandbox.argv).toContain("--no-mcp");
    expect(sandbox.redactedArgv).not.toContain("sk-secret-key-12345678");
    expect(sandbox.redactedArgv).toContain("***");

    const dashIdx = sandbox.argv.indexOf("--");
    expect(dashIdx).toBeGreaterThan(0);
    expect(sandbox.argv[dashIdx + 1]).toBe("- dash prompt");

    // Strict allowlist assertions (P1 & T1):
    // 1. Current provider key is kept
    expect(sandbox.env.OPENAI_API_KEY).toBe("sk-openai-12345678");
    // 2. Other provider keys, TYPESAFE_API_KEY, GITHUB_TOKEN, GH_TOKEN, INPUT_* are stripped
    expect(sandbox.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sandbox.env.TYPESAFE_API_KEY).toBeUndefined();
    expect(sandbox.env.EXA_API_KEY).toBeUndefined();
    expect(sandbox.env.GITHUB_TOKEN).toBeUndefined();
    expect(sandbox.env.GH_TOKEN).toBeUndefined();
    expect(sandbox.env.INPUT_API_KEY).toBeUndefined();
    expect(sandbox.env.INPUT_GITHUB_TOKEN).toBeUndefined();
  });

  it("exposes GH_TOKEN only when bash tool is explicitly enabled in policy", () => {
    const readOnlyPolicy = deriveCapabilityPolicy({
      tools: "read,grep,find,ls",
      provider: "openai",
      model: "gpt-4o",
    });
    expect(isShellEnabledInPolicy(readOnlyPolicy)).toBe(false);

    const bashPolicy = deriveCapabilityPolicy({
      tools: "read,bash",
      provider: "openai",
      model: "gpt-4o",
    });
    expect(isShellEnabledInPolicy(bashPolicy)).toBe(true);

    const sandboxWithBash = buildSandboxSpec(
      {
        prompt: "run gh status",
        model: "gpt-4o",
        provider: "openai",
        policy: bashPolicy,
      },
      { GH_TOKEN: "ghs_allowed_for_bash", PATH: "/usr/bin" },
    );
    expect(sandboxWithBash.env.GH_TOKEN).toBe("ghs_allowed_for_bash");
  });

  it("scrubs persisted http.*.extraheader credentials from .git/config (S2 fix)", () => {
    const repoDir = join(workDir, "git-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync(
      "git",
      [
        "config",
        "--local",
        "http.https://github.com/.extraheader",
        "AUTHORIZATION: basic dG9rZW46Z2hzX3NlY3JldF90b2tlbl8xMjM0NTY=",
      ],
      { cwd: repoDir },
    );

    const beforeConfig = readFileSync(join(repoDir, ".git/config"), "utf8");
    expect(beforeConfig).toContain("extraheader");

    const removed = scrubGitCredentials(repoDir);
    expect(removed).toContain("http.https://github.com/.extraheader");

    const afterConfig = readFileSync(join(repoDir, ".git/config"), "utf8");
    expect(afterConfig).not.toContain("extraheader");
    expect(afterConfig).not.toContain("dG9rZW46Z2hzX3NlY3JldF90b2tlbl8xMjM0NTY=");
  });

  it("redacts sensitive values and patterns from output and comments", () => {
    const env = {
      GITHUB_TOKEN: "ghs_super_secret_token_value_12345",
      HALF_CABBAGE_API_KEY: "hc_secret_key_value_987654",
      TYPESAFE_API_KEY: "ts_jev_api_key_abcdef12345",
    };
    const secrets = collectSensitiveValues(env);
    const leakedComment = [
      "Found token in .git/config: ghs_super_secret_token_value_12345",
      "And provider key hc_secret_key_value_987654",
      "And jev key ts_jev_api_key_abcdef12345",
      "And inline Authorization: Bearer my_inline_bearer_token_999",
    ].join("\n");

    const sanitized = redactText(leakedComment, secrets);
    expect(sanitized).not.toContain("ghs_super_secret_token_value_12345");
    expect(sanitized).not.toContain("hc_secret_key_value_987654");
    expect(sanitized).not.toContain("ts_jev_api_key_abcdef12345");
    expect(sanitized).not.toContain("my_inline_bearer_token_999");
    expect(sanitized).toContain("***");
  });

  it("setupPiConfig sets defaultProjectTrust to never and removes stale web-search.ts", () => {
    const fakeAgentDir = join(workDir, "pi-agent");
    const extDir = join(fakeAgentDir, "extensions");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(fakeAgentDir, "settings.json"),
      JSON.stringify({ customSetting: "preserve-me", defaultProjectTrust: "always" }),
      "utf8",
    );
    writeFileSync(join(fakeAgentDir, "AGENTS.md"), "stale agents", "utf8");
    writeFileSync(join(extDir, "web-search.ts"), "// stale extension", "utf8");

    const res = setupPiConfig({
      actionPath: process.cwd(),
      agentDir: fakeAgentDir,
    });

    const merged = JSON.parse(readFileSync(res.settingsPath, "utf8"));
    expect(merged.customSetting).toBe("preserve-me");
    expect(merged.defaultProjectTrust).toBe("never");
    expect(existsSync(join(fakeAgentDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(extDir, "web-search.ts"))).toBe(false);
    expect(res.installedExtensions).toContain("ci-logger.ts");
    expect(res.installedExtensions).toContain("halfcabbage.ts");
    expect(res.installedExtensions).toContain("submit-review.ts");
    expect(res.installedExtensions).not.toContain("web-search.ts");
  });
});
