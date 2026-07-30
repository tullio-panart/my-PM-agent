import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import {
  DocumentError,
  extractDocument,
} from "../src/extractors.mjs";
import {
  countWords,
  normaliseDocumentText,
} from "../src/normalise.mjs";

function createTextPdf(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "latin1");
}

async function createTextDocx(text) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>` +
      "</w:document>",
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("normalises transcript whitespace without losing paragraphs", () => {
  assert.equal(
    normaliseDocumentText("Sam: Hello  \r\n\r\n\r\n\r\nAlex: Hi\u0000"),
    "Sam: Hello\n\n\nAlex: Hi",
  );
  assert.equal(countWords("Sam: Hello — Alex's project is ready."), 6);
});

test("extracts UTF-8 text and returns useful metadata", async () => {
  const result = await extractDocument({
    buffer: Buffer.from(
      "Sam: Welcome to the meeting.\n\nAlex: Here is the project update.",
    ),
    fileName: "meeting.txt",
    mimeType: "text/plain",
  });

  assert.equal(result.type, "text");
  assert.match(result.text, /project update/);
  assert.equal(result.wordCount, 11);
  assert.equal(result.sourceHash.length, 64);
});

test("extracts a searchable PDF and cleans up the PDF.js loading task", async () => {
  const result = await extractDocument({
    buffer: createTextPdf("Project meeting action item is ready."),
    fileName: "meeting.pdf",
    mimeType: "application/pdf",
  });

  assert.equal(result.type, "pdf");
  assert.equal(result.pageCount, 1);
  assert.match(result.text, /Project meeting action item is ready/);
});

test("explains that an image-only PDF needs OCR", async () => {
  await assert.rejects(
    extractDocument({
      buffer: createTextPdf(""),
      fileName: "scan.pdf",
      mimeType: "application/pdf",
    }),
    (error) =>
      error instanceof DocumentError &&
      error.code === "NO_EXTRACTABLE_TEXT" &&
      /OCR is not available/i.test(error.publicMessage),
  );
});

test("extracts a DOCX after checking its archive bounds", async () => {
  const result = await extractDocument({
    buffer: await createTextDocx(
      "Alex owns the release checklist and will finish it on Thursday.",
    ),
    fileName: "meeting.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  assert.equal(result.type, "docx");
  assert.match(result.text, /Alex owns the release checklist/);
});

test("rejects binary content disguised as text", async () => {
  await assert.rejects(
    extractDocument({
      buffer: Buffer.from([1, 0, 2, 3]),
      fileName: "meeting.txt",
      mimeType: "text/plain",
    }),
    (error) =>
      error instanceof DocumentError && error.code === "INVALID_FILE_TYPE",
  );
});

test("rejects unsupported files", async () => {
  await assert.rejects(
    extractDocument({
      buffer: Buffer.from("not an office document"),
      fileName: "meeting.rtf",
      mimeType: "application/rtf",
    }),
    (error) =>
      error instanceof DocumentError &&
      error.code === "UNSUPPORTED_FILE_TYPE",
  );
});
