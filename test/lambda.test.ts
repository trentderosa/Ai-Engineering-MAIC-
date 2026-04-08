/**
 * Unit tests for lambda/chat.js
 *
 * Strategy: test pure helper functions directly (no AWS calls),
 * and test handler behavior via mocked AWS SDK modules.
 */

// ---- Mock AWS SDK clients before requiring the module ----
// Use a stable send mock so it can be re-configured per test
const mockBedrockSend = jest.fn().mockResolvedValue({
  body: new TextEncoder().encode(
    JSON.stringify({ content: [{ text: "Mocked AI reply" }] })
  ),
});

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockBedrockSend,
  })),
  InvokeModelCommand: jest.fn(),
}));

const mockDdbSend = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend }) ) },
  GetCommand: jest.fn(),
  PutCommand: jest.fn(),
  UpdateCommand: jest.fn(),
}));

// Mock aws-jwt-verify — behavior is set per-test in beforeEach
const mockJwtVerify = jest.fn();
jest.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: jest.fn(() => ({ verify: mockJwtVerify })),
  },
}));

// Set required env vars before loading the module
process.env.USAGE_TABLE = "test-usage-table";
process.env.USER_POOL_ID = "us-east-1_testPool";
process.env.USER_POOL_CLIENT_ID = "testClientId";
process.env.AWS_REGION = "us-east-1";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isTopicAllowed, getTodayKey, handler } = require("../lambda/chat");

// Reset volatile mocks before every test so they don't bleed across describes
beforeEach(() => {
  mockJwtVerify.mockRejectedValue(new Error("invalid token")); // default: guest
  mockDdbSend.mockResolvedValue({ Item: { count: 0 } });       // default: under limit
});

// ============================================================
// Pure helper: isTopicAllowed
// ============================================================
describe("isTopicAllowed", () => {
  it("allows MAIC-related topics", () => {
    expect(isTopicAllowed("Tell me about MAIC")).toBe(true);
    expect(isTopicAllowed("What AI events are coming up?")).toBe(true);
    expect(isTopicAllowed("How do I join the club?")).toBe(true);
    expect(isTopicAllowed("Explain machine learning to me")).toBe(true);
    expect(isTopicAllowed("What is a neural network?")).toBe(true);
    expect(isTopicAllowed("I want to learn Python")).toBe(true);
  });

  it("blocks off-topic messages", () => {
    expect(isTopicAllowed("Write me a poem about cats")).toBe(false);
    expect(isTopicAllowed("What is the capital of France?")).toBe(false);
    expect(isTopicAllowed("Help me with my math homework")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isTopicAllowed("MACHINE LEARNING IS COOL")).toBe(true);
    expect(isTopicAllowed("Tell me About AI")).toBe(true);
  });
});

// ============================================================
// Pure helper: getTodayKey
// ============================================================
describe("getTodayKey", () => {
  it("returns an ISO date string (YYYY-MM-DD)", () => {
    const key = getTodayKey();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches today's UTC date", () => {
    const expected = new Date().toISOString().split("T")[0];
    expect(getTodayKey()).toBe(expected);
  });
});

// ============================================================
// Handler: auth — JWT verification
// ============================================================
describe("handler — auth", () => {
  it("treats requests without Authorization header as guest", async () => {
    const event = makeGuestEvent("What is MAIC?");
    const res = await handler(event);
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.isAuthenticated).toBe(false);
  });

  it("treats a valid JWT as authenticated (member)", async () => {
    mockJwtVerify.mockResolvedValueOnce({ sub: "user-123" });
    const event = makeMemberEvent("Tell me about deep learning");
    const res = await handler(event);
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.isAuthenticated).toBe(true);
  });

  it("treats an invalid JWT as guest (does NOT grant member access)", async () => {
    // mockJwtVerify already rejects by default
    const event = makeMemberEvent("Tell me about deep learning");
    const res = await handler(event);
    const body = JSON.parse(res.body);
    expect(body.isAuthenticated).toBe(false);
  });
});

// ============================================================
// Handler: guest rate limiting
// ============================================================
describe("handler — guest rate limiting", () => {
  it("blocks off-topic messages with 403", async () => {
    const event = makeGuestEvent("Write me a poem about cats");
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
  });

  it("allows on-topic messages under the limit", async () => {
    mockDdbSend.mockResolvedValue({ Item: { count: 5 } }); // under limit of 10
    const event = makeGuestEvent("What is MAIC?");
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
  });

  it("blocks guests who have hit the daily limit with 429", async () => {
    mockDdbSend.mockResolvedValue({ Item: { count: 10 } }); // at limit
    const event = makeGuestEvent("What is MAIC?");
    const res = await handler(event);
    expect(res.statusCode).toBe(429);
  });

  // TODO: Add your rate limit edge case tests below
  // (see contribution request in the conversation)
});

// ============================================================
// Handler: input validation
// ============================================================
describe("handler — input validation", () => {
  it("returns 400 for empty message", async () => {
    const event = makeGuestEvent("  ");
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for missing message field", async () => {
    const event = { httpMethod: "POST", headers: {}, body: JSON.stringify({}) };
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });

  it("handles OPTIONS preflight", async () => {
    const res = await handler({ httpMethod: "OPTIONS", headers: {}, body: "" });
    expect(res.statusCode).toBe(200);
  });
});

// ============================================================
// Helpers
// ============================================================
function makeGuestEvent(message: string) {
  return {
    httpMethod: "POST",
    headers: {},
    requestContext: { identity: { sourceIp: "1.2.3.4" } },
    body: JSON.stringify({ message }),
  };
}

function makeMemberEvent(message: string) {
  return {
    httpMethod: "POST",
    headers: { Authorization: "Bearer fake.jwt.token" },
    requestContext: { identity: { sourceIp: "1.2.3.4" } },
    body: JSON.stringify({ message }),
  };
}
