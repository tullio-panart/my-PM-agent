import { createServer } from "node:http";

const PORT = 3_401;
const MODEL = "claude-sonnet-4-6";
let messageCalls = 0;
let toolUseResponses = 0;
const toolUseByName = {};
let lastRequest = null;

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function contentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function latestToolResult(messages) {
  for (const message of [...messages].reverse()) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    const result = message.content.find((part) => part?.type === "tool_result");
    if (result) {
      return typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content);
    }
  }
  return null;
}

function parseToolResult(rawResult) {
  try {
    const parsed = JSON.parse(rawResult);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
}

function taskReply(value) {
  const tasks = Array.isArray(value?.tasks) ? value.tasks : [];
  if (tasks.length === 0) {
    return "There are no local tasks matching those filters.";
  }
  const lines = tasks.map(
    (task) => `#${task.id} ${task.title} (${task.status}, ${task.priority})`,
  );
  return `I found ${tasks.length} local tasks:\n${lines.join("\n")}`;
}

function proposalReply(value) {
  if (value?.ok !== true || value?.confirmationRequired !== true) {
    return value?.error?.message ?? "I could not prepare that task proposal.";
  }
  const phrase = value.confirmation?.phrase;
  const action = value.action ?? {};
  if (action.type === "create_task") {
    return [
      `I prepared a proposal to create “${action.arguments?.title}”.`,
      "No task has changed yet.",
      `To approve exactly this action, send this as a separate message: ${phrase}`,
      "The phrase expires in five minutes.",
    ].join("\n");
  }
  return [
    `I prepared a proposal to change task #${action.arguments?.taskId} to ${action.arguments?.status}.`,
    "No task has changed yet.",
    `To approve exactly this action, send this as a separate message: ${phrase}`,
    "The phrase expires in five minutes.",
  ].join("\n");
}

function systemText(system) {
  if (typeof system === "string") {
    return system;
  }
  return contentText(system);
}

function chooseResponse(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const textMessages = messages.map((message) => ({
    role: message.role,
    text: contentText(message.content),
  }));
  const lastUser =
    [...textMessages].reverse().find(
      (message) => message.role === "user" && message.text,
    )?.text ?? "";
  const previousText = textMessages
    .slice(0, -1)
    .map((message) => message.text)
    .join("\n");
  const rawToolResult = latestToolResult(messages);
  const toolResult = rawToolResult ? parseToolResult(rawToolResult) : null;
  const latestMessage = messages.at(-1);
  const currentHasToolResult =
    Array.isArray(latestMessage?.content) &&
    latestMessage.content.some((part) => part?.type === "tool_result");
  const toolNames = Array.isArray(body.tools)
    ? body.tools.map((tool) => tool.name)
    : [];

  if (/^(?:yes|yep|confirm|go ahead)$/i.test(lastUser.trim())) {
    return {
      type: "text",
      text: "That does not confirm a write. Send the exact CONFIRM XXXXXXXX phrase from the latest proposal.",
    };
  }
  if (currentHasToolResult && toolResult?.confirmationRequired === true) {
    return { type: "text", text: proposalReply(toolResult) };
  }
  if (currentHasToolResult && toolResult && Array.isArray(toolResult.tasks)) {
    return { type: "text", text: taskReply(toolResult) };
  }
  if (
    /(?:what|which|list|show).*(?:task|todo)|(?:task|todo).*(?:exist|open|blocked|priority)/i.test(
      lastUser,
    ) &&
    toolNames.includes("list_tasks")
  ) {
    return {
      type: "tool",
      tool: {
        type: "tool_use",
        id: `toolu_mock_${messageCalls}`,
        name: "list_tasks",
        input: { status: "all", priority: "all" },
      },
    };
  }
  if (
    /(?:create|add|capture).*(?:task|todo)|(?:task|todo).*(?:create|add)/i.test(
      lastUser,
    ) &&
    toolNames.includes("create_task")
  ) {
    return {
      type: "tool",
      tool: {
        type: "tool_use",
        id: `toolu_mock_${messageCalls}`,
        name: "create_task",
        input: {
          title: "Invite the pilot group",
          description: "Send the workshop invitation to the three pilot users.",
          status: "todo",
          priority: "high",
          dueDate: "",
        },
      },
    };
  }
  if (
    /(?:mark|change|update).*(?:task|#)\s*1.*(?:done|complete)/i.test(lastUser) &&
    toolNames.includes("update_task_status")
  ) {
    return {
      type: "tool",
      tool: {
        type: "tool_use",
        id: `toolu_mock_${messageCalls}`,
        name: "update_task_status",
        input: { taskId: 1, status: "done" },
      },
    };
  }
  if (/what is my launch called/i.test(lastUser)) {
    return {
      type: "text",
      text: /Lantern/i.test(previousText)
        ? "Your launch is called Lantern."
        : "I do not know the launch name yet.",
    };
  }
  if (/called Lantern/i.test(lastUser)) {
    return {
      type: "text",
      text: "Got it — I will remember that your launch is called Lantern.",
    };
  }
  if (/long response/i.test(lastUser)) {
    return { type: "text", text: "x".repeat(12_000) };
  }
  return { type: "text", text: `Mock Claude reply: ${lastUser}` };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/metrics") {
    sendJson(response, 200, {
      messageCalls,
      toolUseResponses,
      toolUseByName,
      lastRequest,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, {
      data: [
        {
          type: "model",
          id: MODEL,
          display_name: "Claude Sonnet 4.6",
          created_at: "2026-02-01T00:00:00Z",
        },
      ],
      has_more: false,
      first_id: MODEL,
      last_id: MODEL,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/messages") {
    try {
      const body = await readJson(request);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      messageCalls += 1;
      const selected = chooseResponse(body);
      if (selected.type === "tool") {
        toolUseResponses += 1;
        toolUseByName[selected.tool.name] =
          (toolUseByName[selected.tool.name] ?? 0) + 1;
      }
      lastRequest = {
        model: body.model,
        messageCount: messages.length,
        toolNames: Array.isArray(body.tools)
          ? body.tools.map((tool) => tool.name)
          : [],
        systemText: systemText(body.system),
        userMessages: messages
          .filter((message) => message.role === "user")
          .map((message) => contentText(message.content))
          .filter(Boolean),
      };

      const content =
        selected.type === "tool"
          ? [selected.tool]
          : [{ type: "text", text: selected.text }];
      const outputLength =
        selected.type === "tool"
          ? JSON.stringify(selected.tool).length
          : selected.text.length;

      sendJson(response, 200, {
        id: `msg_mock_${messageCalls}`,
        type: "message",
        role: "assistant",
        model: MODEL,
        content,
        stop_reason: selected.type === "tool" ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: Math.max(1, Math.ceil(JSON.stringify(messages).length / 4)),
          output_tokens: Math.max(1, Math.ceil(outputLength / 4)),
        },
      });
    } catch {
      sendJson(response, 400, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "The mock could not parse the request.",
        },
      });
    }
    return;
  }

  sendJson(response, 404, {
    type: "error",
    error: { type: "not_found_error", message: "Not found" },
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Phase 5 Anthropic mock listening on ${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
