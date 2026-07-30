import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PASTED_CHARACTERS = 150_000;
export const MAX_DOCUMENTS_PER_MESSAGE = 3;
export const MAX_COMBINED_DOCUMENT_CHARACTERS = 200_000;
const DOCUMENT_TTL_MS = 24 * 60 * 60 * 1_000;
const DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DocumentRecord {
  id: string;
  sessionId: string;
  name: string;
  type: "pdf" | "docx" | "text" | "pasted-text";
  mimeType: string;
  text: string;
  wordCount: number;
  characterCount: number;
  sourceHash: string;
  createdAt: string;
  expiresAt: string;
  pageCount?: number;
  warnings: string[];
}

export interface PublicDocument {
  id: string;
  name: string;
  type: DocumentRecord["type"];
  mimeType: string;
  wordCount: number;
  characterCount: number;
  preview: string;
  expiresAt: string;
  pageCount?: number;
  warnings: string[];
}

interface ExtractionResponse {
  type: "pdf" | "docx" | "text";
  text: string;
  wordCount: number;
  characterCount: number;
  sourceHash: string;
  pageCount?: number;
  warnings: string[];
}

interface DocumentWorkerError {
  error?: {
    code?: string;
    message?: string;
  };
}

export class DocumentStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

function countWords(value: string): number {
  return (
    value.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0
  );
}

function normalisePastedText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function normaliseDocumentName(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function publicDocument(record: DocumentRecord): PublicDocument {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    mimeType: record.mimeType,
    wordCount: record.wordCount,
    characterCount: record.characterCount,
    preview:
      record.text.length > 240
        ? `${record.text.slice(0, 237).trimEnd()}…`
        : record.text,
    expiresAt: record.expiresAt,
    ...(record.pageCount === undefined
      ? {}
      : { pageCount: record.pageCount }),
    warnings: record.warnings,
  };
}

function validateRecord(value: unknown): DocumentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid stored document");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !DOCUMENT_ID_PATTERN.test(candidate.id) ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.type !== "string" ||
    !["pdf", "docx", "text", "pasted-text"].includes(candidate.type) ||
    typeof candidate.mimeType !== "string" ||
    typeof candidate.text !== "string" ||
    typeof candidate.wordCount !== "number" ||
    typeof candidate.characterCount !== "number" ||
    typeof candidate.sourceHash !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    !Array.isArray(candidate.warnings)
  ) {
    throw new Error("Invalid stored document");
  }
  return candidate as unknown as DocumentRecord;
}

export class DocumentStore {
  constructor(
    private readonly directory: string,
    private readonly workerUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  private pathFor(id: string): string {
    if (!DOCUMENT_ID_PATTERN.test(id)) {
      throw new DocumentStoreError(
        404,
        "DOCUMENT_NOT_FOUND",
        "That document is no longer available. Add it again.",
      );
    }
    return join(this.directory, `${id}.json`);
  }

  private async save(record: DocumentRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.pathFor(record.id), JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private async read(id: string): Promise<DocumentRecord> {
    try {
      return validateRecord(
        JSON.parse(await readFile(this.pathFor(id), "utf8")) as unknown,
      );
    } catch (error) {
      if (error instanceof DocumentStoreError) {
        throw error;
      }
      throw new DocumentStoreError(
        404,
        "DOCUMENT_NOT_FOUND",
        "That document is no longer available. Add it again.",
      );
    }
  }

  async cleanupExpired(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const now = Date.now();
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const id = entry.name.slice(0, -5);
      try {
        const record = await this.read(id);
        if (Date.parse(record.expiresAt) <= now) {
          await rm(this.pathFor(id), { force: true });
        }
      } catch {
        await rm(join(this.directory, entry.name), { force: true });
      }
    }
  }

  async createPastedText(
    sessionId: string,
    suppliedName: string,
    rawText: string,
  ): Promise<PublicDocument> {
    const text = normalisePastedText(rawText);
    if (text.length < 20) {
      throw new DocumentStoreError(
        400,
        "EMPTY_DOCUMENT",
        "Paste some transcript or document text first.",
      );
    }
    if (text.length > MAX_PASTED_CHARACTERS) {
      throw new DocumentStoreError(
        413,
        "DOCUMENT_TEXT_TOO_LARGE",
        "Pasted text must be 150,000 characters or fewer.",
      );
    }

    const now = new Date();
    const record: DocumentRecord = {
      id: randomUUID(),
      sessionId,
      name: normaliseDocumentName(suppliedName, "Pasted transcript"),
      type: "pasted-text",
      mimeType: "text/plain",
      text,
      wordCount: countWords(text),
      characterCount: text.length,
      sourceHash: createHash("sha256").update(text, "utf8").digest("hex"),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DOCUMENT_TTL_MS).toISOString(),
      warnings: [],
    };
    await this.save(record);
    return publicDocument(record);
  }

  async createFile(
    sessionId: string,
    fileName: string,
    mimeType: string,
    buffer: Buffer,
  ): Promise<PublicDocument> {
    if (buffer.length > MAX_FILE_BYTES) {
      throw new DocumentStoreError(
        413,
        "FILE_TOO_LARGE",
        "Files must be 20 MB or smaller.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.workerUrl}/extract`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": buffer.length.toString(),
          "X-Document-Name": encodeURIComponent(fileName),
          "X-Document-Type": mimeType || "application/octet-stream",
        },
        body: new Uint8Array(buffer),
        signal: controller.signal,
      });
    } catch {
      throw new DocumentStoreError(
        503,
        "DOCUMENT_SERVICE_UNAVAILABLE",
        "The local document reader is not ready. Restart the local stack and try again.",
      );
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => null)) as
      | ExtractionResponse
      | DocumentWorkerError
      | null;
    if (!response.ok) {
      const errorBody = body as DocumentWorkerError | null;
      throw new DocumentStoreError(
        response.status,
        errorBody?.error?.code ?? "DOCUMENT_EXTRACTION_FAILED",
        errorBody?.error?.message ?? "The document could not be read.",
      );
    }
    const extraction = body as ExtractionResponse;
    if (
      !extraction ||
      !["pdf", "docx", "text"].includes(extraction.type) ||
      typeof extraction.text !== "string" ||
      typeof extraction.wordCount !== "number"
    ) {
      throw new DocumentStoreError(
        502,
        "DOCUMENT_EXTRACTION_FAILED",
        "The document reader returned an unexpected result.",
      );
    }

    const now = new Date();
    const record: DocumentRecord = {
      id: randomUUID(),
      sessionId,
      name: normaliseDocumentName(fileName, "Document"),
      type: extraction.type,
      mimeType: mimeType || "application/octet-stream",
      text: extraction.text,
      wordCount: extraction.wordCount,
      characterCount: extraction.characterCount,
      sourceHash: extraction.sourceHash,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DOCUMENT_TTL_MS).toISOString(),
      ...(extraction.pageCount === undefined
        ? {}
        : { pageCount: extraction.pageCount }),
      warnings: Array.isArray(extraction.warnings)
        ? extraction.warnings.slice(0, 10)
        : [],
    };
    await this.save(record);
    return publicDocument(record);
  }

  async resolveForMessage(
    sessionId: string,
    ids: string[],
  ): Promise<DocumentRecord[]> {
    if (ids.length > MAX_DOCUMENTS_PER_MESSAGE) {
      throw new DocumentStoreError(
        400,
        "TOO_MANY_DOCUMENTS",
        `Add no more than ${MAX_DOCUMENTS_PER_MESSAGE} documents to one message.`,
      );
    }
    if (new Set(ids).size !== ids.length) {
      throw new DocumentStoreError(
        400,
        "INVALID_DOCUMENTS",
        "The document list contains a duplicate.",
      );
    }

    const records = [];
    let combinedCharacters = 0;
    for (const id of ids) {
      const record = await this.read(id);
      if (
        record.sessionId !== sessionId ||
        Date.parse(record.expiresAt) <= Date.now()
      ) {
        throw new DocumentStoreError(
          404,
          "DOCUMENT_NOT_FOUND",
          "That document is no longer available in this conversation. Add it again.",
        );
      }
      combinedCharacters += record.characterCount;
      records.push(record);
    }

    if (combinedCharacters > MAX_COMBINED_DOCUMENT_CHARACTERS) {
      throw new DocumentStoreError(
        413,
        "DOCUMENT_CONTEXT_TOO_LARGE",
        "The combined document text is too long. Remove one document and try again.",
      );
    }
    return records;
  }

  async remove(sessionId: string, id: string): Promise<void> {
    const record = await this.read(id);
    if (record.sessionId !== sessionId) {
      throw new DocumentStoreError(
        404,
        "DOCUMENT_NOT_FOUND",
        "That document is no longer available.",
      );
    }
    await rm(this.pathFor(id), { force: true });
  }
}
