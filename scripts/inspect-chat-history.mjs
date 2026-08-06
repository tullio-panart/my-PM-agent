#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = join(projectRoot, "data", "chat", "chat.sqlite");
const showFullText = process.argv.includes("--full");

if (!existsSync(databasePath)) {
  console.error("No saved chat database exists yet. Start the local app and send a message first.");
  process.exit(1);
}

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const check = database.prepare("PRAGMA quick_check").get();
  const version = database.prepare("PRAGMA user_version").get();
  if (check.quick_check !== "ok") {
    throw new Error("SQLite integrity check failed.");
  }

  const totals = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM conversations) AS conversations,
         (SELECT COUNT(*) FROM messages) AS messages,
         (SELECT COUNT(*) FROM message_attachments) AS attachments`,
    )
    .get();

  console.log(`Chat database: ${databasePath}`);
  console.log(`Schema: ${version.user_version}; integrity: ok`);
  console.log(
    `Rows: ${totals.conversations} conversations, ${totals.messages} messages, ${totals.attachments} attachment snapshots`,
  );

  const conversations = database
    .prepare(
      `SELECT c.id, c.agent_id, c.title, c.created_at, c.updated_at,
              COUNT(m.id) AS message_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       GROUP BY c.id
       ORDER BY c.updated_at DESC, c.id DESC`,
    )
    .all();

  for (const conversation of conversations) {
    console.log("");
    console.log(
      `${conversation.id} · ${conversation.agent_id} · ${conversation.message_count} messages · ${conversation.updated_at}`,
    );
    console.log(
      showFullText
        ? `Title: ${conversation.title}`
        : `Title: [redacted; ${String(conversation.title).length} characters]`,
    );
    const messages = database
      .prepare(
        `SELECT role, status, content, created_at
         FROM messages
         WHERE conversation_id = ?
         ORDER BY sequence`,
      )
      .all(conversation.id);
    for (const message of messages) {
      const content = String(message.content);
      console.log(
        showFullText
          ? `  ${message.role}/${message.status}: ${content}`
          : `  ${message.role}/${message.status}: [redacted; ${content.length} characters]`,
      );
    }
  }

  if (!showFullText) {
    console.log("\nMessage text is redacted. Rerun with --full only when it is safe to display private chats.");
  }
} finally {
  database.close();
}
