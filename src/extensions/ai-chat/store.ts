import { CHAT_STORE, dataverseDB } from "../../util/dataverseDb.js";
import type { ChatSession } from "./types.js";

/*
 * Chat sessions live in the shared `dataverse-ide` IndexedDB database next to
 * workspace records, VSIX archives, and terminal history. Records are keyed by
 * chat id; the workspace URI is stored on each record so history can be
 * scoped to the current folder without a compound index.
 */

function asSession(value: unknown): ChatSession | undefined {
  if (value == null || typeof value !== "object") {
    return undefined;
  }

  const record = value as Partial<ChatSession>;

  if (
    typeof record.id !== "string" ||
    typeof record.workspace !== "string" ||
    !Array.isArray(record.messages)
  ) {
    return undefined;
  }

  return {
    id: record.id,
    title: typeof record.title === "string" ? record.title : "New chat",
    workspace: record.workspace,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
    messages: record.messages,
  };
}

export async function listChatSessions(workspace: string): Promise<ChatSession[]> {
  const db = await dataverseDB();
  const records = await db.getAll(CHAT_STORE);

  return records
    .map(asSession)
    .filter((session): session is ChatSession => session != null && session.workspace === workspace)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function loadChatSession(id: string): Promise<ChatSession | undefined> {
  const db = await dataverseDB();

  return asSession(await db.get(CHAT_STORE, id));
}

export async function saveChatSession(session: ChatSession): Promise<void> {
  const db = await dataverseDB();

  await db.put(CHAT_STORE, session, session.id);
}

export async function deleteChatSession(id: string): Promise<void> {
  const db = await dataverseDB();

  await db.delete(CHAT_STORE, id);
}
