import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { basename, extname, resolve, sep } from "node:path";
import Busboy from "busboy";
import {
  DEFAULT_AGENTS,
  publicAgentDefinitions,
  type AgentDefinition,
} from "./agents.js";
import {
  DocumentStore,
  DocumentStoreError,
  MAX_FILE_BYTES,
  MAX_PASTED_CHARACTERS,
  type DocumentRecord,
} from "./documents.js";

const MAX_MESSAGE_LENGTH = 8_000;
const MAX_REQUEST_BYTES = 65_536;
const MAX_UPSTREAM_BYTES = 65_536;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

type ErrorCode =
  | "AGENT_ERROR"
  | "AGENT_TIMEOUT"
  | "AGENT_UNAVAILABLE"
  | "DOCUMENT_ERROR"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_SERVICE_UNAVAILABLE"
  | "DOCUMENT_TEXT_TOO_LARGE"
  | "FILE_TOO_LARGE"
  | "INVALID_REQUEST"
  | "MESSAGE_TOO_LONG"
  | "RATE_LIMITED"
  | "TOO_MANY_DOCUMENTS"
  | "UNSUPPORTED_FILE_TYPE";

interface ChatRequest {
  sessionId: string;
  agentId: string;
  message: string;
  documentIds: string[];
}

interface UpstreamChatRequest {
  schemaVersion: 2;
  sessionId: string;
  agentId: string;
  message: string;
  documents: Array<{
    id: string;
    name: string;
    type: DocumentRecord["type"];
    wordCount: number;
    characterCount: number;
    text: string;
    pageCount?: number;
  }>;
}

interface ChatResponse {
  sessionId: string;
  reply: string;
  runId?: string;
}

export interface ChatGatewayOptions {
  publicDirectory: string;
  upstreamUrl: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
  logError?: (message: string, error?: unknown) => void;
  agents?: readonly AgentDefinition[];
  documentStore?: DocumentStore;
}

class PublicError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload).toString(),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: PublicError): void {
  sendJson(
    response,
    error.status,
    {
      error: {
        code: error.code,
        message: error.publicMessage,
      },
    },
    error.status === 429 ? { "Retry-After": "30" } : {},
  );
}

async function readRequestBody(
  request: IncomingMessage,
  maximumBytes = MAX_REQUEST_BYTES,
): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new PublicError(
      400,
      "INVALID_REQUEST",
      "Send the message as JSON and try again.",
    );
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) {
      throw new PublicError(
        413,
        "MESSAGE_TOO_LONG",
        "That request is too large.",
      );
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PublicError(
      400,
      "INVALID_REQUEST",
      "That message could not be read. Check it and try again.",
    );
  }
}

function validateSessionId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new PublicError(
      400,
      "INVALID_REQUEST",
      "The conversation could not be identified. Reset it and try again.",
    );
  }
  return value;
}

function validateChatRequest(
  body: unknown,
  agents: readonly AgentDefinition[],
): ChatRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PublicError(
      400,
      "INVALID_REQUEST",
      "Enter a message and try again.",
    );
  }

  const candidate = body as Record<string, unknown>;
  const sessionId = validateSessionId(candidate.sessionId);
  const rawAgentId =
    typeof candidate.agentId === "string"
      ? candidate.agentId.trim()
      : "project-manager";
  const rawMessage = candidate.message;
  const rawDocumentIds =
    candidate.documentIds === undefined ? [] : candidate.documentIds;

  const agent = agents.find((item) => item.id === rawAgentId);
  if (!agent || agent.status !== "active") {
    throw new PublicError(
      400,
      "INVALID_REQUEST",
      "That agent is not available yet.",
    );
  }

  if (typeof rawMessage !== "string") {
    throw new PublicError(
      400,
      "INVALID_REQUEST",
      "Enter a message and try again.",
    );
  }

  const message = rawMessage.trim();
  if (message.length === 0) {
    throw new PublicError(
      400,
      "INVALID_REQUEST",
      "Enter a message and try again.",
    );
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new PublicError(
      413,
      "MESSAGE_TOO_LONG",
      "That instruction is too long. Keep it under 8,000 characters.",
    );
  }

  if (
    !Array.isArray(rawDocumentIds) ||
    !rawDocumentIds.every((id) => typeof id === "string")
  ) {
    throw new PublicError(
      400,
      "INVALID_REQUEST",
      "The attached document list is invalid.",
    );
  }

  return {
    sessionId,
    agentId: agent.id,
    message,
    documentIds: rawDocumentIds,
  };
}

interface UploadedFile {
  sessionId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

async function readMultipartUpload(
  request: IncomingMessage,
): Promise<UploadedFile> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new PublicError(
      400,
      "INVALID_REQUEST",
      "Upload the document using the file picker.",
    );
  }

  return await new Promise<UploadedFile>((resolveUpload, rejectUpload) => {
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: {
          fields: 2,
          files: 1,
          fileSize: MAX_FILE_BYTES,
          parts: 3,
        },
      });
    } catch {
      rejectUpload(
        new PublicError(
          400,
          "INVALID_REQUEST",
          "The uploaded document could not be read.",
        ),
      );
      return;
    }

    let settled = false;
    let sessionId = "";
    let fileName = "";
    let mimeType = "";
    let fileSeen = false;
    let fileTooLarge = false;
    const chunks: Buffer[] = [];

    const fail = (error: PublicError) => {
      if (!settled) {
        settled = true;
        rejectUpload(error);
      }
    };

    parser.on("field", (name, value) => {
      if (name === "sessionId") {
        sessionId = value;
      }
    });
    parser.on("file", (fieldName, stream, info) => {
      if (fieldName !== "file" || fileSeen) {
        stream.resume();
        return;
      }
      fileSeen = true;
      fileName = basename(info.filename || "document");
      mimeType = info.mimeType || "application/octet-stream";
      stream.on("limit", () => {
        fileTooLarge = true;
      });
      stream.on("data", (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk));
      });
      stream.on("error", () => {
        fail(
          new PublicError(
            400,
            "INVALID_REQUEST",
            "The uploaded document could not be read.",
          ),
        );
      });
    });
    parser.on("partsLimit", () => {
      fail(
        new PublicError(
          400,
          "INVALID_REQUEST",
          "Upload one document at a time.",
        ),
      );
    });
    parser.on("filesLimit", () => {
      fail(
        new PublicError(
          400,
          "INVALID_REQUEST",
          "Upload one document at a time.",
        ),
      );
    });
    parser.on("error", () => {
      fail(
        new PublicError(
          400,
          "INVALID_REQUEST",
          "The uploaded document could not be read.",
        ),
      );
    });
    parser.on("finish", () => {
      if (settled) {
        return;
      }
      if (fileTooLarge) {
        fail(
          new PublicError(
            413,
            "FILE_TOO_LARGE",
            "Files must be 20 MB or smaller.",
          ),
        );
        return;
      }
      if (!fileSeen || chunks.length === 0) {
        fail(
          new PublicError(
            400,
            "INVALID_REQUEST",
            "Choose a PDF, DOCX, or text file.",
          ),
        );
        return;
      }
      try {
        settled = true;
        resolveUpload({
          sessionId: validateSessionId(sessionId),
          fileName,
          mimeType,
          buffer: Buffer.concat(chunks),
        });
      } catch (error) {
        settled = true;
        rejectUpload(error);
      }
    });

    request.pipe(parser);
  });
}

function asPublicError(error: DocumentStoreError): PublicError {
  const supportedCode: ErrorCode =
    error.code === "DOCUMENT_NOT_FOUND"
      ? "DOCUMENT_NOT_FOUND"
      : error.code === "DOCUMENT_SERVICE_UNAVAILABLE"
        ? "DOCUMENT_SERVICE_UNAVAILABLE"
        : error.code === "DOCUMENT_TEXT_TOO_LARGE"
          ? "DOCUMENT_TEXT_TOO_LARGE"
          : error.code === "FILE_TOO_LARGE"
            ? "FILE_TOO_LARGE"
            : error.code === "TOO_MANY_DOCUMENTS"
              ? "TOO_MANY_DOCUMENTS"
              : error.code === "UNSUPPORTED_FILE_TYPE"
                ? "UNSUPPORTED_FILE_TYPE"
                : "DOCUMENT_ERROR";
  return new PublicError(error.status, supportedCode, error.publicMessage);
}

async function readUpstreamBody(response: Response): Promise<unknown> {
  const rawBody = await response.text();
  if (Buffer.byteLength(rawBody) > MAX_UPSTREAM_BYTES) {
    throw new PublicError(
      502,
      "AGENT_ERROR",
      "The agent returned an unexpected response. Check the workflow and try again.",
    );
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new PublicError(
      502,
      "AGENT_ERROR",
      "The agent returned an unexpected response. Check the workflow and try again.",
    );
  }
}

function validateUpstreamResponse(
  body: unknown,
  request: ChatRequest,
): ChatResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PublicError(
      502,
      "AGENT_ERROR",
      "The agent returned an unexpected response. Check the workflow and try again.",
    );
  }

  const candidate = body as Record<string, unknown>;
  const reply =
    typeof candidate.reply === "string" ? candidate.reply.trim() : "";

  if (
    candidate.sessionId !== request.sessionId ||
    reply.length === 0 ||
    (candidate.runId !== undefined && typeof candidate.runId !== "string")
  ) {
    throw new PublicError(
      502,
      "AGENT_ERROR",
      "The agent returned an unexpected response. Check the workflow and try again.",
    );
  }

  const result: ChatResponse = {
    sessionId: request.sessionId,
    reply,
  };
  if (typeof candidate.runId === "string") {
    result.runId = candidate.runId;
  }
  return result;
}

async function callAgent(
  request: ChatRequest,
  agent: AgentDefinition,
  documents: DocumentRecord[],
  options: Required<
    Pick<ChatGatewayOptions, "fetchImplementation" | "timeoutMs" | "upstreamUrl">
  >,
): Promise<ChatResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  let upstreamResponse: Response;

  try {
    const configuredUrl = new URL(options.upstreamUrl);
    const upstreamUrl =
      configuredUrl.pathname === agent.workflowPath
        ? configuredUrl
        : new URL(
            agent.workflowPath,
            `${configuredUrl.protocol}//${configuredUrl.host}`,
          );
    const upstreamRequest: UpstreamChatRequest = {
      schemaVersion: 2,
      sessionId: request.sessionId,
      agentId: request.agentId,
      message: request.message,
      documents: documents.map((document) => ({
        id: document.id,
        name: document.name,
        type: document.type,
        wordCount: document.wordCount,
        characterCount: document.characterCount,
        text: document.text,
        ...(document.pageCount === undefined
          ? {}
          : { pageCount: document.pageCount }),
      })),
    };

    upstreamResponse = await options.fetchImplementation(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamRequest),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PublicError(
        504,
        "AGENT_TIMEOUT",
        "The agent took too long to reply. Wait a moment and try again.",
      );
    }
    throw new PublicError(
      503,
      "AGENT_UNAVAILABLE",
      "The local agent is not ready. Check that n8n is running and the chat workflow is active.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (upstreamResponse.status === 429) {
    throw new PublicError(
      429,
      "RATE_LIMITED",
      "The agent is busy right now. Wait a moment and try again.",
    );
  }

  if (upstreamResponse.status === 404) {
    throw new PublicError(
      503,
      "AGENT_UNAVAILABLE",
      "The local agent is not ready. Check that n8n is running and the chat workflow is active.",
    );
  }

  if (!upstreamResponse.ok) {
    throw new PublicError(
      502,
      "AGENT_ERROR",
      "The agent could not complete that request. Check the n8n workflow and try again.",
    );
  }

  const responseBody = await readUpstreamBody(upstreamResponse);
  return validateUpstreamResponse(responseBody, request);
}

async function serveStaticFile(
  request: IncomingMessage,
  response: ServerResponse,
  publicDirectory: string,
  pathname: string,
): Promise<void> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400, SECURITY_HEADERS);
    response.end("Bad request");
    return;
  }

  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const root = resolve(publicDirectory);
  const filePath = resolve(root, `.${requestedPath}`);

  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(404, SECURITY_HEADERS);
    response.end("Not found");
    return;
  }

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      throw new Error("Not a file");
    }

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      "Content-Length": fileStats.size.toString(),
      "Content-Type":
        MIME_TYPES[extname(filePath).toLowerCase()] ??
        "application/octet-stream",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Not found");
  }
}

export function createChatHandler(options: ChatGatewayOptions): RequestListener {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const agents = options.agents ?? DEFAULT_AGENTS;
  const documentStore = options.documentStore;

  return (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (url.pathname === "/health") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          sendJson(response, 405, {
            error: {
              code: "INVALID_REQUEST",
              message: "That method is not supported.",
            },
          }, { Allow: "GET, HEAD" });
          return;
        }
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (url.pathname === "/api/agents") {
        if (request.method !== "GET") {
          sendJson(
            response,
            405,
            {
              error: {
                code: "INVALID_REQUEST",
                message: "That method is not supported.",
              },
            },
            { Allow: "GET" },
          );
          return;
        }
        sendJson(response, 200, {
          schemaVersion: 1,
          agents: publicAgentDefinitions(agents),
        });
        return;
      }

      if (url.pathname === "/api/documents/text") {
        if (request.method !== "POST") {
          sendJson(
            response,
            405,
            {
              error: {
                code: "INVALID_REQUEST",
                message: "Add pasted text with POST.",
              },
            },
            { Allow: "POST" },
          );
          return;
        }
        if (!documentStore) {
          sendError(
            response,
            new PublicError(
              503,
              "DOCUMENT_SERVICE_UNAVAILABLE",
              "The local document reader is not configured.",
            ),
          );
          return;
        }

        try {
          await documentStore.cleanupExpired();
          const body = await readRequestBody(
            request,
            MAX_PASTED_CHARACTERS * 4 + 4_096,
          );
          if (
            typeof body !== "object" ||
            body === null ||
            Array.isArray(body)
          ) {
            throw new PublicError(
              400,
              "INVALID_REQUEST",
              "Paste some transcript or document text first.",
            );
          }
          const candidate = body as Record<string, unknown>;
          const sessionId = validateSessionId(candidate.sessionId);
          if (typeof candidate.text !== "string") {
            throw new PublicError(
              400,
              "INVALID_REQUEST",
              "Paste some transcript or document text first.",
            );
          }
          const document = await documentStore.createPastedText(
            sessionId,
            typeof candidate.name === "string"
              ? candidate.name
              : "Pasted transcript",
            candidate.text,
          );
          sendJson(response, 201, { document });
        } catch (error) {
          if (error instanceof DocumentStoreError) {
            sendError(response, asPublicError(error));
          } else if (error instanceof PublicError) {
            sendError(response, error);
          } else {
            options.logError?.("Unexpected pasted document error", error);
            sendError(
              response,
              new PublicError(
                502,
                "DOCUMENT_ERROR",
                "The pasted text could not be prepared.",
              ),
            );
          }
        }
        return;
      }

      if (url.pathname === "/api/documents") {
        if (request.method !== "POST") {
          sendJson(
            response,
            405,
            {
              error: {
                code: "INVALID_REQUEST",
                message: "Upload documents with POST.",
              },
            },
            { Allow: "POST" },
          );
          return;
        }
        if (!documentStore) {
          sendError(
            response,
            new PublicError(
              503,
              "DOCUMENT_SERVICE_UNAVAILABLE",
              "The local document reader is not configured.",
            ),
          );
          return;
        }

        try {
          await documentStore.cleanupExpired();
          const upload = await readMultipartUpload(request);
          const document = await documentStore.createFile(
            upload.sessionId,
            upload.fileName,
            upload.mimeType,
            upload.buffer,
          );
          sendJson(response, 201, { document });
        } catch (error) {
          if (error instanceof DocumentStoreError) {
            sendError(response, asPublicError(error));
          } else if (error instanceof PublicError) {
            sendError(response, error);
          } else {
            options.logError?.("Unexpected document upload error", error);
            sendError(
              response,
              new PublicError(
                502,
                "DOCUMENT_ERROR",
                "The document could not be read.",
              ),
            );
          }
        }
        return;
      }

      if (url.pathname.startsWith("/api/documents/")) {
        if (request.method !== "DELETE") {
          sendJson(
            response,
            405,
            {
              error: {
                code: "INVALID_REQUEST",
                message: "Remove documents with DELETE.",
              },
            },
            { Allow: "DELETE" },
          );
          return;
        }
        if (!documentStore) {
          sendError(
            response,
            new PublicError(
              503,
              "DOCUMENT_SERVICE_UNAVAILABLE",
              "The local document reader is not configured.",
            ),
          );
          return;
        }

        try {
          const sessionId = validateSessionId(
            url.searchParams.get("sessionId"),
          );
          const id = decodeURIComponent(
            url.pathname.slice("/api/documents/".length),
          );
          await documentStore.remove(sessionId, id);
          response.writeHead(204, {
            ...SECURITY_HEADERS,
            "Cache-Control": "no-store",
          });
          response.end();
        } catch (error) {
          if (error instanceof DocumentStoreError) {
            sendError(response, asPublicError(error));
          } else if (error instanceof PublicError) {
            sendError(response, error);
          } else {
            options.logError?.("Unexpected document removal error", error);
            sendError(
              response,
              new PublicError(
                502,
                "DOCUMENT_ERROR",
                "The document could not be removed.",
              ),
            );
          }
        }
        return;
      }

      if (url.pathname === "/api/chat") {
        if (request.method !== "POST") {
          sendJson(
            response,
            405,
            {
              error: {
                code: "INVALID_REQUEST",
                message: "Send chat messages with POST.",
              },
            },
            { Allow: "POST" },
          );
          return;
        }

        try {
          const body = await readRequestBody(request);
          const chatRequest = validateChatRequest(body, agents);
          const agent = agents.find(
            (candidate) => candidate.id === chatRequest.agentId,
          );
          if (!agent) {
            throw new PublicError(
              400,
              "INVALID_REQUEST",
              "That agent is not available yet.",
            );
          }
          if (chatRequest.documentIds.length > 0 && !documentStore) {
            throw new PublicError(
              503,
              "DOCUMENT_SERVICE_UNAVAILABLE",
              "The local document reader is not configured.",
            );
          }
          const documents = documentStore
            ? await documentStore.resolveForMessage(
                chatRequest.sessionId,
                chatRequest.documentIds,
              )
            : [];
          const chatResponse = await callAgent(
            chatRequest,
            agent,
            documents,
            {
              fetchImplementation,
              timeoutMs,
              upstreamUrl: options.upstreamUrl,
            },
          );
          sendJson(response, 200, chatResponse);
        } catch (error) {
          if (error instanceof DocumentStoreError) {
            sendError(response, asPublicError(error));
            return;
          } else if (error instanceof PublicError) {
            sendError(response, error);
            return;
          }
          options.logError?.("Unexpected chat gateway error", error);
          sendError(
            response,
            new PublicError(
              502,
              "AGENT_ERROR",
              "The agent could not complete that request. Check the n8n workflow and try again.",
            ),
          );
        }
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, {
          ...SECURITY_HEADERS,
          Allow: "GET, HEAD",
        });
        response.end("Method not allowed");
        return;
      }

      await serveStaticFile(
        request,
        response,
        options.publicDirectory,
        url.pathname,
      );
    })().catch((error: unknown) => {
      options.logError?.("Unexpected request error", error);
      if (!response.headersSent) {
        sendError(
          response,
          new PublicError(
            502,
            "AGENT_ERROR",
            "The chat service hit an unexpected problem. Try again.",
          ),
        );
      } else {
        response.destroy();
      }
    });
  };
}

export function createChatServer(options: ChatGatewayOptions): Server {
  return createServer(createChatHandler(options));
}
