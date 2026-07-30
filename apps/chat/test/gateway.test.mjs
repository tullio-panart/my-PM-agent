import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createChatServer } from "../dist/app.js";
import { DocumentStore } from "../dist/documents.js";

const PUBLIC_DIRECTORY = fileURLToPath(new URL("../public", import.meta.url));
const SESSION_ID = "9d4482cf-f720-4f70-98af-e337db1a9d53";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not receive a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startGateway(t, options) {
  const gateway = createChatServer({
    publicDirectory: PUBLIC_DIRECTORY,
    timeoutMs: 500,
    logError: () => {},
    ...options,
  });
  const url = await listen(gateway);
  t.after(() => close(gateway));
  return url;
}

async function startUpstream(t, handler) {
  const upstream = createServer(handler);
  const url = await listen(upstream);
  t.after(() => close(upstream));
  return url;
}

async function chat(url, body, headers = { "Content-Type": "application/json" }) {
  return fetch(`${url}/api/chat`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("GET /health reports only the gateway health", async (t) => {
  const gatewayUrl = await startGateway(t, {
    upstreamUrl: "http://127.0.0.1:1/webhook/chat",
  });

  const response = await fetch(`${gatewayUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
});

test("GET /api/agents exposes active and coming-soon agents without workflow paths", async (t) => {
  const gatewayUrl = await startGateway(t, {
    upstreamUrl: "http://127.0.0.1:1/webhook/chat",
    agents: [
      {
        id: "project-manager",
        name: "Project Manager",
        description: "Plans projects.",
        status: "active",
        workflowPath: "/webhook/chat",
        examplePrompts: ["Plan this project"],
      },
      {
        id: "sales",
        name: "Sales",
        description: "Coming soon.",
        status: "coming-soon",
        workflowPath: "",
        examplePrompts: [],
      },
    ],
  });

  const response = await fetch(`${gatewayUrl}/api/agents`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.agents.length, 2);
  assert.equal(body.agents[0].status, "active");
  assert.equal(body.agents[1].status, "coming-soon");
  assert.equal("workflowPath" in body.agents[0], false);
});

test("pasted text is session-bound and forwarded only through a document ID", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-solopreneur-docs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const documentStore = new DocumentStore(
    directory,
    "http://127.0.0.1:1",
  );
  let forwardedBody;
  const upstreamUrl = await startUpstream(t, async (request, response) => {
    forwardedBody = await readJsonRequest(request);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        sessionId: SESSION_ID,
        reply: "The source contains one action.",
      }),
    );
  });
  const gatewayUrl = await startGateway(t, {
    documentStore,
    upstreamUrl: `${upstreamUrl}/webhook/chat`,
  });

  const createResponse = await fetch(`${gatewayUrl}/api/documents/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      name: "Monday\nmeeting",
      text: "Sam: We agreed that Alex will publish the launch checklist on Friday.",
    }),
  });
  const created = await createResponse.json();

  assert.equal(createResponse.status, 201);
  assert.equal(created.document.name, "Monday meeting");
  assert.equal(created.document.wordCount, 12);
  assert.equal("text" in created.document, false);

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    agentId: "project-manager",
    message: "List confirmed actions.",
    documentIds: [created.document.id],
  });

  assert.equal(response.status, 200);
  assert.equal(forwardedBody.schemaVersion, 2);
  assert.equal(forwardedBody.documents.length, 1);
  assert.equal(forwardedBody.documents[0].name, "Monday meeting");
  assert.match(forwardedBody.documents[0].text, /launch checklist/);

  const otherSessionResponse = await chat(gatewayUrl, {
    sessionId: "1be3cc7e-f7ef-48e4-919e-d2d09f8a43cb",
    message: "Read the document.",
    documentIds: [created.document.id],
  });
  assert.equal(otherSessionResponse.status, 404);
  assert.equal(
    (await otherSessionResponse.json()).error.code,
    "DOCUMENT_NOT_FOUND",
  );
});

test("a valid request is trimmed, forwarded, and returned", async (t) => {
  let forwardedBody;
  const upstreamUrl = await startUpstream(t, async (request, response) => {
    forwardedBody = await readJsonRequest(request);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        sessionId: SESSION_ID,
        reply: "  You have three open tasks.  ",
        runId: "run-123",
      }),
    );
  });
  const gatewayUrl = await startGateway(t, {
    upstreamUrl: `${upstreamUrl}/webhook/chat`,
  });

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    message: "  Show me my open tasks  ",
    ignored: "version-one-compatible",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(forwardedBody, {
    schemaVersion: 2,
    sessionId: SESSION_ID,
    agentId: "project-manager",
    message: "Show me my open tasks",
    documents: [],
  });
  assert.deepEqual(await response.json(), {
    sessionId: SESSION_ID,
    reply: "You have three open tasks.",
    runId: "run-123",
  });
});

test("invalid requests never reach the upstream agent", async (t) => {
  let upstreamCalls = 0;
  const upstreamUrl = await startUpstream(t, (_request, response) => {
    upstreamCalls += 1;
    response.writeHead(500);
    response.end();
  });
  const gatewayUrl = await startGateway(t, { upstreamUrl });

  const cases = [
    {
      name: "non-object body",
      body: [],
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "missing session",
      body: { message: "Hello" },
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "invalid UUID",
      body: { sessionId: "not-a-uuid", message: "Hello" },
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "missing message",
      body: { sessionId: SESSION_ID },
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "empty message",
      body: { sessionId: SESSION_ID, message: "   " },
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "oversized message",
      body: { sessionId: SESSION_ID, message: "x".repeat(8_001) },
      status: 413,
      code: "MESSAGE_TOO_LONG",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const response = await chat(gatewayUrl, item.body);
      const body = await response.json();
      assert.equal(response.status, item.status);
      assert.equal(body.error.code, item.code);
    });
  }

  const malformedJson = await chat(gatewayUrl, "{ definitely-not-json");
  assert.equal(malformedJson.status, 400);
  assert.equal((await malformedJson.json()).error.code, "INVALID_REQUEST");

  const wrongContentType = await chat(
    gatewayUrl,
    JSON.stringify({ sessionId: SESSION_ID, message: "Hello" }),
    { "Content-Type": "text/plain" },
  );
  assert.equal(wrongContentType.status, 400);
  assert.equal(upstreamCalls, 0);
});

test("an unavailable upstream returns a safe, helpful error", async (t) => {
  const temporaryServer = createServer();
  const unavailableUrl = await listen(temporaryServer);
  await close(temporaryServer);
  const gatewayUrl = await startGateway(t, { upstreamUrl: unavailableUrl });

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    message: "Hello",
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error.code, "AGENT_UNAVAILABLE");
  assert.match(body.error.message, /n8n.*workflow/i);
});

test("an inactive n8n webhook returns AGENT_UNAVAILABLE", async (t) => {
  const upstreamUrl = await startUpstream(t, (_request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("The requested webhook is not registered.");
  });
  const gatewayUrl = await startGateway(t, { upstreamUrl });

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    message: "Hello",
  });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "AGENT_UNAVAILABLE");
});

test("a slow upstream returns AGENT_TIMEOUT", async (t) => {
  const upstreamUrl = await startUpstream(t, () => {});
  const gatewayUrl = await startGateway(t, {
    upstreamUrl,
    timeoutMs: 25,
  });

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    message: "Hello",
  });

  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "AGENT_TIMEOUT");
});

test("malformed upstream responses are not passed to the browser", async (t) => {
  const upstreamUrl = await startUpstream(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        sessionId: "1be3cc7e-f7ef-48e4-919e-d2d09f8a43cb",
        reply: "wrong session",
        secret: "sk-ant-never-return-this",
      }),
    );
  });
  const gatewayUrl = await startGateway(t, { upstreamUrl });

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    message: "Hello",
  });
  const rawBody = await response.text();

  assert.equal(response.status, 502);
  assert.equal(JSON.parse(rawBody).error.code, "AGENT_ERROR");
  assert.doesNotMatch(rawBody, /sk-ant-never-return-this|wrong session/);
});

test("raw upstream failures and secrets are hidden", async (t) => {
  const upstreamUrl = await startUpstream(t, (_request, response) => {
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("stack trace: ANTHROPIC_API_KEY=sk-ant-secret");
  });
  const gatewayUrl = await startGateway(t, { upstreamUrl });

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    message: "Hello",
  });
  const rawBody = await response.text();

  assert.equal(response.status, 502);
  assert.equal(JSON.parse(rawBody).error.code, "AGENT_ERROR");
  assert.doesNotMatch(rawBody, /ANTHROPIC|sk-ant|stack trace/);
});

test("an invalid Claude credential is reported without leaking provider details", async (t) => {
  const upstreamUrl = await startUpstream(t, (_request, response) => {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "invalid x-api-key sk-ant-api03-do-not-leak",
        },
      }),
    );
  });
  const gatewayUrl = await startGateway(t, { upstreamUrl });

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    message: "Hello",
  });
  const rawBody = await response.text();

  assert.equal(response.status, 502);
  assert.equal(JSON.parse(rawBody).error.code, "AGENT_ERROR");
  assert.doesNotMatch(rawBody, /authentication_error|x-api-key|sk-ant/);
  assert.match(rawBody, /n8n workflow/i);
});

test("exhausted Claude credit is reported without leaking billing details", async (t) => {
  const upstreamUrl = await startUpstream(t, (_request, response) => {
    response.writeHead(402, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        type: "error",
        error: {
          type: "billing_error",
          message: "credit balance is too low for workspace secret-id",
        },
      }),
    );
  });
  const gatewayUrl = await startGateway(t, { upstreamUrl });

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    message: "Hello",
  });
  const rawBody = await response.text();

  assert.equal(response.status, 502);
  assert.equal(JSON.parse(rawBody).error.code, "AGENT_ERROR");
  assert.doesNotMatch(rawBody, /billing_error|credit balance|secret-id/);
  assert.match(rawBody, /n8n workflow/i);
});

test("a provider network failure is reported without leaking its stack trace", async (t) => {
  const upstreamUrl = await startUpstream(t, (_request, response) => {
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end(
      "ConnectTimeoutError: api.anthropic.com ENETUNREACH at internal secret-host",
    );
  });
  const gatewayUrl = await startGateway(t, { upstreamUrl });

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    message: "Hello",
  });
  const rawBody = await response.text();

  assert.equal(response.status, 502);
  assert.equal(JSON.parse(rawBody).error.code, "AGENT_ERROR");
  assert.doesNotMatch(rawBody, /anthropic|ENETUNREACH|secret-host/i);
});

test("rate limiting uses the stable error contract", async (t) => {
  const upstreamUrl = await startUpstream(t, (_request, response) => {
    response.writeHead(429, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ internal: "provider-specific details" }));
  });
  const gatewayUrl = await startGateway(t, { upstreamUrl });

  const response = await chat(gatewayUrl, {
    sessionId: SESSION_ID,
    message: "Hello",
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal((await response.json()).error.code, "RATE_LIMITED");
});

test("static files are served safely", async (t) => {
  const gatewayUrl = await startGateway(t, {
    upstreamUrl: "http://127.0.0.1:1/webhook/chat",
  });

  const page = await fetch(gatewayUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.match(await page.text(), /<!doctype html>/i);

  const traversal = await fetch(`${gatewayUrl}/%2e%2e%2fpackage.json`);
  assert.equal(traversal.status, 404);

  const missing = await fetch(`${gatewayUrl}/missing.js`);
  assert.equal(missing.status, 404);
});
