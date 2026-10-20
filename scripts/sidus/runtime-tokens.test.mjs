import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureGateToken } from "./runtime-tokens.mjs";

const adminToken = "admin-test-token";
const createdToken = "oct_created-gate-token-value";

function fakeAdminApi(existingTokens) {
  const tokens = [...existingTokens];
  const requests = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ url: String(url), method, body });
    if (init.headers?.authorization !== `Bearer ${adminToken}`) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    if (method === "GET" && String(url) === "https://connect.example.test/api/runtime-tokens") {
      return Response.json(tokens);
    }
    if (method === "POST" && String(url) === "https://connect.example.test/api/runtime-tokens") {
      const record = { id: "token-created", name: body.name, createdAt: "2026-10-20T10:00:00.000Z" };
      tokens.push(record);
      return Response.json({ token: createdToken, record });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  };
  return { fetch, requests };
}

function secretRecorder() {
  const writes = [];
  return {
    writes,
    writeSecret: async (name, value) => {
      writes.push({ name, value });
    },
  };
}

async function captureProcessOutput(run) {
  const captured = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const tap = (original) =>
    function (chunk, ...rest) {
      captured.push(String(chunk));
      return original.call(this, chunk, ...rest);
    };
  process.stdout.write = tap(originalOut);
  process.stderr.write = tap(originalErr);
  try {
    await run();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return captured.join("");
}

const env = {
  OOMOL_CONNECT_ADMIN_TOKEN: adminToken,
  OOMOL_CONNECT_ORIGIN: "https://connect.example.test",
};

test("creates sidus-gate with full action access and hands its token only to the secret writer", async () => {
  const api = fakeAdminApi([{ id: "token-other", name: "other", createdAt: "2026-10-01T00:00:00.000Z" }]);
  const secrets = secretRecorder();
  const logged = [];

  const output = await captureProcessOutput(() =>
    ensureGateToken({ env, fetch: api.fetch, writeSecret: secrets.writeSecret, log: (line) => logged.push(line) }),
  );

  assert.deepEqual(
    api.requests.filter((request) => request.method === "POST"),
    [
      {
        url: "https://connect.example.test/api/runtime-tokens",
        method: "POST",
        body: {
          name: "sidus-gate",
          allowedActions: ["*"],
          blockedActions: [],
          allowedProxies: [],
          allowedTriggers: [],
          allowedConnections: [],
        },
      },
    ],
  );
  assert.deepEqual(secrets.writes, [{ name: "CONNECTOR_WRITE_TOKEN", value: createdToken }]);
  assert.equal(output.includes(createdToken), false);
  assert.equal(logged.join("\n").includes(createdToken), false);
});

test("leaves an existing sidus-gate token unchanged", async () => {
  const api = fakeAdminApi([{ id: "token-gate", name: "sidus-gate", createdAt: "2026-10-01T00:00:00.000Z" }]);
  const secrets = secretRecorder();
  const logged = [];

  await ensureGateToken({ env, fetch: api.fetch, writeSecret: secrets.writeSecret, log: (line) => logged.push(line) });

  assert.deepEqual(
    api.requests.map((request) => request.method),
    ["GET"],
  );
  assert.deepEqual(secrets.writes, []);
  assert.deepEqual(logged, ["sidus-gate exists; unchanged"]);
});

test("refuses to run while OOMOL_CONNECT_RUNTIME_TOKEN is set", async () => {
  const api = fakeAdminApi([]);
  const secrets = secretRecorder();

  await assert.rejects(
    ensureGateToken({
      env: { ...env, OOMOL_CONNECT_RUNTIME_TOKEN: "bootstrap" },
      fetch: api.fetch,
      writeSecret: secrets.writeSecret,
      log: () => {},
    }),
    { code: "runtime_token_set" },
  );
  assert.deepEqual(api.requests, []);
  assert.deepEqual(secrets.writes, []);
});
