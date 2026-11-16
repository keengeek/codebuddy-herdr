#!/usr/bin/env node
/**
 * install-dev.mjs - install the codebuddy-herdr plugin into CodeBuddy as a LIVE
 * SYMLINK (dev mode). CodeBuddy keeps a hash-based plugin cache; a full restart
 * can replace the symlink with a copy, so re-run this script to restore it.
 *
 * Steps:
 *   1. Resolve the plugin source dir (this repo = parent of this script).
 *   2. Install the plugin locally if it is not already installed.
 *   3. Replace CodeBuddy's cache copy AND package-sources copy with symlinks to
 *      the source, so edits apply via /reload-plugins.
 *   4. Enable the plugin.
 *
 * Written in Node so the same command works on macOS, Linux, and Windows
 * (Windows uses directory junctions, which need no administrator rights).
 *
 * Usage:  node script/install-dev.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODEBUDDY_HOME = process.env.CODEBUDDY_HOME || join(homedir(), ".codebuddy");
const REGISTRY = join(CODEBUDDY_HOME, "plugins", "installed_plugins.json");
const PLUGIN_NAME = JSON.parse(
  readFileSync(join(SOURCE, ".codebuddy-plugin", "plugin.json"), "utf8"),
).name;

function readInstalled() {
  if (!existsSync(REGISTRY)) return undefined;
  const data = JSON.parse(readFileSync(REGISTRY, "utf8"));
  return Object.entries(data.plugins ?? {}).find(([key]) => key.startsWith(`${PLUGIN_NAME}@`));
}

/** Run the CodeBuddy CLI, tolerating the failure modes the shell script ignored. */
function codebuddy(...args) {
  // Windows resolves the CLI through a .cmd shim, which needs a shell; quote the
  // arguments ourselves because Node joins them unquoted for `shell: true`.
  const quote = (value) => (/[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  try {
    if (process.platform === "win32") {
      execFileSync("codebuddy.cmd", args.map(quote), { stdio: "inherit", shell: true });
    } else {
      execFileSync("codebuddy", args, { stdio: "inherit" });
    }
  } catch {
    // The CLI prints its own errors; the symlink steps are still worth doing.
  }
}

/** Point `link` at `target`, replacing whatever is there. */
function relink(target, link) {
  try {
    if (realpathSync(link) === realpathSync(target)) {
      console.log(`  already linked: ${link}`);
      return;
    }
  } catch {
    // Not a link yet (or dangling): fall through and replace it.
  }
  rmSync(link, { recursive: true, force: true });
  try {
    // Junctions work without administrator rights or developer mode on Windows.
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    console.log(`  linked: ${link} -> ${target}`);
  } catch (error) {
    console.error(`  could not link ${link}: ${error.message}`);
    process.exitCode = 1;
  }
}

console.log(`Plugin source: ${SOURCE}`);
console.log(`Plugin name:   ${PLUGIN_NAME}`);

if (!readInstalled()) {
  console.log("Plugin not installed yet; installing locally (codebuddy plugin add)...");
  codebuddy("plugin", "add", SOURCE, "-y");
}

const installed = readInstalled();
if (!installed) {
  console.error(`ERROR: could not find ${PLUGIN_NAME} in ${REGISTRY}`);
  process.exit(1);
}

const [pluginId, records] = installed;
const cachePath = records?.[0]?.installPath;
if (!cachePath) {
  console.error(`ERROR: no installPath for ${pluginId} in ${REGISTRY}`);
  process.exit(1);
}

// cache/            <market>/<name>/<version>
// package-sources/  <market>/versions/<version>/package
const versionDir = basename(cachePath);
const market = basename(dirname(dirname(cachePath)));
const pluginsRoot = dirname(dirname(dirname(dirname(cachePath))));
const packageSources = join(pluginsRoot, "package-sources", market, "versions", versionDir, "package");

console.log(`Cache path:      ${cachePath}`);
console.log(`Package-sources: ${packageSources}`);

relink(SOURCE, cachePath);
relink(SOURCE, packageSources);

console.log(`Enabling ${pluginId} ...`);
codebuddy("plugin", "enable", pluginId);

console.log();
console.log("Done. Run /reload-plugins (or start a new session) to load the plugin.");
console.log(`Edits to ${SOURCE} now apply live via /reload-plugins.`);
