import { createHash } from "node:crypto";
import { extname } from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { countWords, normaliseDocumentText } from "./normalise.mjs";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 150_000;
export const MAX_PDF_PAGES = 200;
export const MAX_DOCX_ENTRIES = 1_000;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export class DocumentError extends Error {
  constructor(status, code, publicMessage) {
    super(publicMessage);
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

function detectDocumentType(buffer, fileName, suppliedMimeType) {
  const extension = extname(fileName).toLowerCase();
  const prefix = buffer.subarray(0, 8).toString("latin1");

  if (
    suppliedMimeType === "application/pdf" ||
    extension === ".pdf"
  ) {
    if (!prefix.startsWith("%PDF-")) {
      throw new DocumentError(
        415,
        "INVALID_FILE_TYPE",
        "That file is not a valid PDF.",
      );
    }
    return "pdf";
  }

  if (
    suppliedMimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === ".docx"
  ) {
    if (!prefix.startsWith("PK")) {
      throw new DocumentError(
        415,
        "INVALID_FILE_TYPE",
        "That file is not a valid DOCX document.",
      );
    }
    return "docx";
  }

  if (
    suppliedMimeType === "text/plain" ||
    suppliedMimeType === "application/octet-stream" ||
    extension === ".txt"
  ) {
    if (buffer.includes(0)) {
      throw new DocumentError(
        415,
        "INVALID_FILE_TYPE",
        "That text file appears to contain binary data.",
      );
    }
    return "text";
  }

  throw new DocumentError(
    415,
    "UNSUPPORTED_FILE_TYPE",
    "Use a PDF, DOCX, or plain text file.",
  );
}

function pageTextFromItems(items) {
  const lines = [];
  let currentLine = [];
  let previousY = null;

  const flush = () => {
    const line = currentLine.join(" ").replace(/\s+/g, " ").trim();
    if (line) {
      lines.push(line);
    }
    currentLine = [];
  };

  for (const item of items) {
    if (!item || typeof item.str !== "string") {
      continue;
    }
    const y = Array.isArray(item.transform) ? Number(item.transform[5]) : NaN;
    if (
      previousY !== null &&
      Number.isFinite(y) &&
      Math.abs(y - previousY) > 2
    ) {
      flush();
    }
    if (item.str.trim()) {
      currentLine.push(item.str.trim());
    }
    if (item.hasEOL) {
      flush();
    }
    if (Number.isFinite(y)) {
      previousY = y;
    }
  }
  flush();
  return lines.join("\n");
}

async function extractPdf(buffer) {
  let loadingTask;
  let document;
  try {
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      isEvalSupported: false,
      useWorkerFetch: false,
      verbosity: 0,
    });
    document = await loadingTask.promise;
  } catch {
    await loadingTask?.destroy().catch(() => {});
    throw new DocumentError(
      422,
      "DOCUMENT_EXTRACTION_FAILED",
      "The PDF could not be read. It may be damaged or password protected.",
    );
  }

  try {
    if (document.numPages > MAX_PDF_PAGES) {
      throw new DocumentError(
        413,
        "DOCUMENT_TOO_LARGE",
        `PDFs may contain at most ${MAX_PDF_PAGES} pages.`,
      );
    }

    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        `--- Page ${pageNumber} ---\n\n${pageTextFromItems(content.items)}`,
      );
      page.cleanup();
    }
    return {
      text: pages.join("\n\n"),
      pageCount: document.numPages,
      warnings: [],
    };
  } finally {
    try {
      await document.cleanup();
    } finally {
      await loadingTask.destroy();
    }
  }
}

async function extractDocx(buffer) {
  try {
    const archive = await JSZip.loadAsync(buffer);
    const entries = Object.values(archive.files);
    if (entries.length > MAX_DOCX_ENTRIES) {
      throw new DocumentError(
        413,
        "DOCUMENT_TOO_LARGE",
        "The Word document contains too many internal files.",
      );
    }
    let uncompressedBytes = 0;
    for (const entry of entries) {
      if (entry.dir) {
        continue;
      }
      const entryBytes = Number(entry?._data?.uncompressedSize);
      if (!Number.isSafeInteger(entryBytes) || entryBytes < 0) {
        throw new DocumentError(
          422,
          "DOCUMENT_EXTRACTION_FAILED",
          "The Word document could not be read safely.",
        );
      }
      uncompressedBytes += entryBytes;
      if (uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
        throw new DocumentError(
          413,
          "DOCUMENT_TOO_LARGE",
          "The expanded Word document is too large to process safely.",
        );
      }
    }

    const result = await mammoth.extractRawText({ buffer });
    return {
      text: result.value,
      warnings: result.messages.map((message) => String(message.message)),
    };
  } catch (error) {
    if (error instanceof DocumentError) {
      throw error;
    }
    throw new DocumentError(
      422,
      "DOCUMENT_EXTRACTION_FAILED",
      "The Word document could not be read. Confirm that it is a valid DOCX file.",
    );
  }
}

function extractText(buffer) {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      warnings: [],
    };
  } catch {
    throw new DocumentError(
      422,
      "DOCUMENT_EXTRACTION_FAILED",
      "The text file must use UTF-8 encoding.",
    );
  }
}

export async function extractDocument({
  buffer,
  fileName,
  mimeType,
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new DocumentError(
      400,
      "EMPTY_DOCUMENT",
      "Choose a file that contains text.",
    );
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new DocumentError(
      413,
      "FILE_TOO_LARGE",
      "Files must be 20 MB or smaller.",
    );
  }

  const type = detectDocumentType(buffer, fileName, mimeType);
  const extracted =
    type === "pdf"
      ? await extractPdf(buffer)
      : type === "docx"
        ? await extractDocx(buffer)
        : extractText(buffer);
  const text = normaliseDocumentText(extracted.text);

  if (text.length < 20) {
    throw new DocumentError(
      422,
      "NO_EXTRACTABLE_TEXT",
      type === "pdf"
        ? "No readable text was found. This may be a scanned PDF; OCR is not available yet."
        : "No readable text was found in that document.",
    );
  }
  if (text.length > MAX_EXTRACTED_CHARACTERS) {
    throw new DocumentError(
      413,
      "DOCUMENT_TEXT_TOO_LARGE",
      "The extracted text is too long. Keep it under 150,000 characters.",
    );
  }

  return {
    type,
    text,
    characterCount: text.length,
    wordCount: countWords(text),
    ...(extracted.pageCount === undefined
      ? {}
      : { pageCount: extracted.pageCount }),
    warnings: extracted.warnings.slice(0, 10),
    sourceHash: createHash("sha256").update(buffer).digest("hex"),
  };
}
