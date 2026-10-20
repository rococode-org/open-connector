import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gateTokenName = "sidus-gate";
const gateSecretName = "CONNECTOR_WRITE_TOKEN";
const defaultOrigin = "https://connect.copaciu.com";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const gateTokenPolicy = {
  allowedActions: ["*"],
  blockedActions: [],
  allowedProxies: [],
  allowedTriggers: [],
  allowedConnections: [],
};

class RefusalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function ensureGateToken({ env, fetch, writeSecret, log }) {
  if (env.OOMOL_CONNECT_RUNTIME_TOKEN) {
    throw new RefusalError("runtime_token_set", "Unset OOMOL_CONNECT_RUNTIME_TOKEN before you manage the gate token.");
  }
  const adminToken = env.OOMOL_CONNECT_ADMIN_TOKEN?.trim();
  if (!adminToken) {
    throw new RefusalError("admin_token_missing", "Set OOMOL_CONNECT_ADMIN_TOKEN.");
  }
  const tokensUrl = new URL("/api/runtime-tokens", env.OOMOL_CONNECT_ORIGIN || defaultOrigin).href;
  const headers = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };

  const listed = await fetch(tokensUrl, { method: "GET", headers });
  if (!listed.ok) {
    throw new RefusalError("list_failed", `GET /api/runtime-tokens answered ${listed.status}.`);
  }
  const tokens = await listed.json();
  if (tokens.some((token) => token.name === gateTokenName)) {
    log(`${gateTokenName} exists; unchanged`);
    return;
  }

  const created = await fetch(tokensUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: gateTokenName, ...gateTokenPolicy }),
  });
  if (!created.ok) {
    throw new RefusalError("create_failed", `POST /api/runtime-tokens answered ${created.status}.`);
  }
  const { token } = await created.json();
  await writeSecret(gateSecretName, token);
  log(`${gateTokenName} created; ${gateSecretName} set`);
}

function wranglerSecretWriter(directory) {
  return async (name, value) => {
    const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
      cwd: directory,
      input: value,
      stdio: ["pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      throw new RefusalError("secret_put_failed", `wrangler secret put ${name} exited with ${result.status}.`);
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sidusShellDirectory = resolve(repositoryRoot, process.env.SIDUS_SHELL_DIR || "../sidus-shell");
  try {
    await ensureGateToken({
      env: process.env,
      fetch: globalThis.fetch,
      writeSecret: wranglerSecretWriter(sidusShellDirectory),
      log: (line) => console.log(line),
    });
  } catch (error) {
    console.error(
      error instanceof RefusalError ? `${error.code}: ${error.message}` : `runtime-tokens failed: ${error.name}`,
    );
    process.exitCode = 1;
  }
}
