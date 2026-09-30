import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getIntercomDirPath } from "./paths.ts";
import {
  getBrokerLaunchSpec,
  getBrokerSpawnOptions,
  getTsxLoaderPath,
  isBrokerHealthOkMessage,
} from "./spawn.ts";

test("getTsxLoaderPath resolves the tsx loader via module resolution", () => {
  const loaderPath = getTsxLoaderPath();
  assert.equal(path.basename(loaderPath), "loader.mjs");
  assert.equal(path.basename(path.dirname(loaderPath)), "dist");
  assert.equal(path.basename(path.dirname(path.dirname(loaderPath))), "tsx");
});

test("getTsxLoaderPath falls back to a flat sibling tsx install", () => {
  const storeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-store-"));

  try {
    const extensionDir = path.join(storeDir, "node_modules", "pi-intercom");
    const loaderPath = path.join(storeDir, "node_modules", "tsx", "dist", "loader.mjs");
    mkdirSync(extensionDir, { recursive: true });
    mkdirSync(path.dirname(loaderPath), { recursive: true });
    writeFileSync(loaderPath, "");

    assert.equal(getTsxLoaderPath(extensionDir), loaderPath);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("getTsxLoaderPath keeps the nested fallback when no sibling tsx loader exists", () => {
  const storeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-store-"));

  try {
    const extensionDir = path.join(storeDir, "pi-intercom");
    mkdirSync(extensionDir, { recursive: true });

    assert.equal(
      getTsxLoaderPath(extensionDir),
      path.join(extensionDir, "node_modules", "tsx", "dist", "loader.mjs"),
    );
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("getBrokerLaunchSpec runs the default broker in one Node process with the tsx loader", () => {
  const spec = getBrokerLaunchSpec("/repo/broker.ts", "npx", ["--no-install", "tsx"], "/repo", "/usr/bin/node");
  assert.equal(spec.command, "/usr/bin/node");
  assert.equal(spec.args.length, 3);
  assert.equal(spec.args[0], "--import");
  assert.match(spec.args[1], /^file:\/\/.*\/tsx\/dist\/loader\.mjs$/);
  assert.equal(spec.args[2], "/repo/broker.ts");
  assert.equal(spec.captureStartupStderr, true);
});

test("getBrokerLaunchSpec falls back to PATH node for a standalone Pi executable", () => {
  const spec = getBrokerLaunchSpec("C:/repo/broker.ts", "npx", ["--no-install", "tsx"], "C:/repo", "C:/Program Files/Pi/pi.exe");
  assert.equal(spec.command, "node");
  assert.equal(spec.args[0], "--import");
});

test("getBrokerLaunchSpec runs a custom broker command directly", () => {
  const spec = getBrokerLaunchSpec("/repo/broker.ts", "bun", ["--smol"], "/repo", "/usr/bin/node");
  assert.equal(spec.command, "bun");
  assert.deepEqual(spec.args, ["--smol", "/repo/broker.ts"]);
  assert.equal(spec.captureStartupStderr, false);
});

test("getBrokerSpawnOptions uses the runtime directory instead of the package directory", () => {
  const options = getBrokerSpawnOptions();
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(options.cwd, getIntercomDirPath());
});

test("getBrokerSpawnOptions honors a custom agent directory with stderr ignored", () => {
  const agentDir = path.join(tmpdir(), "custom-agent");
  const options = getBrokerSpawnOptions({ PI_CODING_AGENT_DIR: agentDir }, false);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, path.join(agentDir, "intercom"));
  assert.equal(options.env.PI_CODING_AGENT_DIR, agentDir);
});

test("getBrokerSpawnOptions resolves relative PI_CODING_AGENT_DIR before changing cwd", () => {
  const options = getBrokerSpawnOptions({ PI_CODING_AGENT_DIR: "relative-agent" });
  const agentDir = path.resolve("relative-agent");
  assert.equal(options.cwd, path.join(agentDir, "intercom"));
  assert.equal(options.env.PI_CODING_AGENT_DIR, agentDir);
});

test("spawnBrokerIfNeeded includes stderr from default broker startup failures", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-intercom-spawn-"));
  const extensionDir = path.join(root, "pi-intercom");
  const brokerDir = path.join(extensionDir, "broker");
  const fakeTsxLoader = path.join(extensionDir, "node_modules", "tsx", "dist", "loader.mjs");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    mkdirSync(brokerDir, { recursive: true });
    mkdirSync(path.dirname(fakeTsxLoader), { recursive: true });
    writeFileSync(path.join(extensionDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(fakeTsxLoader, "process.stderr.write('fake tsx failed\\n'); process.exit(1);\n");

    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    for (const fileName of ["spawn.ts", "framing.ts", "paths.ts"]) {
      cpSync(path.join(sourceDir, fileName), path.join(brokerDir, fileName));
    }

    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    const moduleUrl = `${pathToFileURL(path.join(brokerDir, "spawn.ts")).href}?case=${Date.now()}`;
    const imported = await import(moduleUrl) as typeof import("./spawn.ts");

    await assert.rejects(
      () => imported.spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Intercom broker exited before startup with code 1/);
        assert.match(error.message, /Broker stderr:\nfake tsx failed/);
        return true;
      },
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("isBrokerHealthOkMessage requires the intercom protocol marker", () => {
  assert.equal(isBrokerHealthOkMessage({ type: "health_ok", requestId: "req-1", protocol: "pi-intercom", version: 1 }, "req-1"), true);
  assert.equal(isBrokerHealthOkMessage({ type: "health_ok", requestId: "req-1" }, "req-1"), false);
  assert.equal(isBrokerHealthOkMessage({ type: "health_ok", requestId: "req-2", protocol: "pi-intercom", version: 1 }, "req-1"), false);
  assert.equal(isBrokerHealthOkMessage("ok", "req-1"), false);
});
