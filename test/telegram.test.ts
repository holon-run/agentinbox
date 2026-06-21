import test from "node:test";
import assert from "node:assert/strict";
import { DeliveryAttempt, SourceStream } from "../src/model";
import {
  TelegramBotApiClient,
  TelegramDeliveryAdapter,
  type TelegramFetchClient,
  invokeTelegramDeliveryOperation,
  normalizeTelegramBotUpdate,
  telegramDeliveryOperationsForHandle,
} from "../src/sources/telegram";

class FakeTelegramFetchClient implements TelegramFetchClient {
  public calls: Array<{ url: string; init?: Parameters<TelegramFetchClient["fetch"]>[1] }> = [];

  async fetch(url: string, init?: Parameters<TelegramFetchClient["fetch"]>[1]) {
    this.calls.push({ url, init });
    return { ok: true, status: 200, text: async () => "{\"ok\":true}" };
  }
}

function telegramSource(config: Record<string, unknown> = {}): SourceStream {
  const now = new Date().toISOString();
  return {
    sourceId: "src_telegram",
    sourceType: "telegram_bot",
    sourceKey: "bot-default",
    configRef: null,
    config,
    status: "active",
    checkpoint: null,
    createdAt: now,
    updatedAt: now,
  };
}

function telegramMessageUpdate(chatId = 456): Record<string, unknown> {
  return {
    update_id: 123,
    message: {
      message_id: 7,
      date: 1710000000,
      text: "Hello",
      chat: { id: chatId, type: "private" },
      from: { id: 111, username: "operator", first_name: "Op" },
    },
  };
}

test("normalizeTelegramBotUpdate extracts metadata and delivery handle", () => {
  const normalized = normalizeTelegramBotUpdate(telegramSource(), {}, telegramMessageUpdate());

  assert.ok(normalized);
  assert.equal(normalized.sourceNativeId, "telegram:src_telegram:123");
  assert.equal(normalized.eventVariant, "message.text");
  assert.equal(normalized.metadata?.chatId, "456");
  assert.equal(normalized.metadata?.fromUsername, "operator");
  assert.equal(normalized.metadata?.content, "Hello");
  assert.equal(normalized.deliveryHandle?.provider, "telegram");
  assert.equal(normalized.deliveryHandle?.surface, "message_reply");
  assert.equal(normalized.deliveryHandle?.targetRef, "456");
  assert.equal(normalized.deliveryHandle?.threadRef, "7");
});

test("normalizeTelegramBotUpdate filters chats outside allowlist", () => {
  const normalized = normalizeTelegramBotUpdate(telegramSource(), { chatIds: ["999"] }, telegramMessageUpdate());

  assert.equal(normalized, null);
});

test("telegram delivery adapter sends message replies through bot API", async () => {
  const fake = new FakeTelegramFetchClient();
  const adapter = new TelegramDeliveryAdapter(new TelegramBotApiClient(fake));
  const attempt: DeliveryAttempt = {
    deliveryId: "dlv_tg_1",
    provider: "telegram",
    surface: "message_reply",
    targetRef: "456",
    threadRef: "7",
    replyMode: "reply",
    kind: "reply",
    payload: { text: "hello", botToken: "TOKEN", endpoint: "https://telegram.test/" },
    status: "accepted",
    createdAt: new Date().toISOString(),
  };

  await adapter.send({ kind: "reply", payload: attempt.payload } as never, attempt);

  assert.equal(fake.calls[0]?.url, "https://telegram.test/botTOKEN/sendMessage");
  assert.deepEqual(JSON.parse(String(fake.calls[0]?.init?.body)), {
    chat_id: "456",
    text: "hello",
    reply_to_message_id: 7,
  });
});

test("telegram delivery operations expose a canonical send_text action", () => {
  assert.deepEqual(
    telegramDeliveryOperationsForHandle({
      provider: "telegram",
      surface: "message_reply",
      targetRef: "456",
    }).map((operation) => operation.name),
    ["send_text"],
  );
});

test("telegram delivery invoke maps send_text to bot API", async () => {
  const fake = new FakeTelegramFetchClient();
  const client = new TelegramBotApiClient(fake);

  await invokeTelegramDeliveryOperation(
    {
      provider: "telegram",
      surface: "chat_message",
      targetRef: "456",
    },
    "send_text",
    {
      text: "team update",
      botToken: "TOKEN",
      endpoint: "https://telegram.test",
    },
    client,
  );

  assert.equal(fake.calls[0]?.url, "https://telegram.test/botTOKEN/sendMessage");
  assert.deepEqual(JSON.parse(String(fake.calls[0]?.init?.body)), {
    chat_id: "456",
    text: "team update",
  });
});

test("telegram delivery invoke can read token from an environment alias", async () => {
  process.env.TEST_TELEGRAM_BOT_TOKEN = "TOKEN";
  const fake = new FakeTelegramFetchClient();
  const client = new TelegramBotApiClient(fake);

  await invokeTelegramDeliveryOperation({ provider: "telegram", surface: "chat_message", targetRef: "456" }, "send_text", {
    text: "team update",
    tokenEnv: "TEST_TELEGRAM_BOT_TOKEN",
    endpoint: "https://telegram.test",
  }, client);

  assert.equal(fake.calls[0]?.url, "https://telegram.test/botTOKEN/sendMessage");
});
