/**
 * MAIC Chatbot — Lambda Handler Tests
 *
 * Tests cover:
 *  - Input validation (missing/empty/too-long message)
 *  - Guest topic filtering (context-aware block list)
 *  - Guest rate limiting (DynamoDB usage counter)
 *  - Successful guest + member responses
 *  - Auth token verification (header-based, not body)
 *  - Bedrock response shape validation
 *  - Bedrock throttling error handling
 *  - Generic server error handling
 *  - CORS preflight (OPTIONS)
 */

// ── Mock AWS SDK modules BEFORE any imports ─────────────────────────────────
// jest.mock is hoisted to the top of the file by ts-jest, so these run
// before the Lambda module is required below.

const mockBedrockSend = jest.fn();
const mockDdbSend     = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand:   jest.fn().mockImplementation((params: unknown) => params),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockImplementation(() => ({ send: mockDdbSend })),
  },
  GetCommand: jest.fn().mockImplementation((params: unknown) => params),
  PutCommand: jest.fn().mockImplementation((params: unknown) => params),
}));

// Mock https (used for JWKS fetch in verifyToken)
jest.mock('https', () => ({
  get: jest.fn(),
}));

// ── Import handler AFTER mocks are in place ──────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/chat') as { handler: Function };

// ── Set required env vars ────────────────────────────────────────────────────
beforeAll(() => {
  process.env.USAGE_TABLE          = 'maic-chat-usage';
  process.env.USER_POOL_ID         = 'us-east-1_testPool';
  process.env.USER_POOL_CLIENT_ID  = 'testClientId';
  process.env.AWS_REGION           = 'us-east-1';
});

// ── Reset mocks between tests ────────────────────────────────────────────────
beforeEach(() => {
  mockBedrockSend.mockReset();
  mockDdbSend.mockReset();

  // Default DynamoDB: no prior usage (count = 0)
  mockDdbSend.mockImplementation(async (cmd: { Key?: { pk?: string }; Item?: unknown }) => {
    if (cmd?.Key) return { Item: null }; // GetCommand — no usage record
    return {};                            // PutCommand — success
  });

  // Default Bedrock: successful response
  mockBedrockSend.mockResolvedValue({
    body: new TextEncoder().encode(
      JSON.stringify({ content: [{ text: 'Hello from MAIC!' }] })
    ),
  });
});

// ── Helper: build a minimal API Gateway event ────────────────────────────────
function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    httpMethod: 'POST',
    headers:    {},
    body:       JSON.stringify({ message: 'What is MAIC?' }),
    requestContext: { identity: { sourceIp: '1.2.3.4' } },
    ...overrides,
  };
}

function parseBody(response: { body: string }) {
  return JSON.parse(response.body);
}

// ════════════════════════════════════════════════════════════════════════════
// INPUT VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe('Input validation', () => {
  test('returns 400 when message is missing', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({}) }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe('BAD_REQUEST');
  });

  test('returns 400 when message is empty string', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ message: '   ' }) }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe('BAD_REQUEST');
  });

  test('returns 400 when message exceeds length limit', async () => {
    const longMsg = 'a'.repeat(2001);
    const res = await handler(makeEvent({ body: JSON.stringify({ message: longMsg }) }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe('MESSAGE_TOO_LONG');
  });

  test('returns 400 on malformed JSON body', async () => {
    const res = await handler(makeEvent({ body: 'not json at all' }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe('BAD_REQUEST');
  });

  test('accepts a message exactly at the length limit', async () => {
    const maxMsg = 'a'.repeat(2000);
    const res = await handler(makeEvent({ body: JSON.stringify({ message: maxMsg }) }));
    // Should reach Bedrock (default mock returns 200)
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CORS PREFLIGHT
// ════════════════════════════════════════════════════════════════════════════

describe('CORS preflight', () => {
  test('returns 200 with CORS headers for OPTIONS', async () => {
    const res = await handler(makeEvent({ httpMethod: 'OPTIONS' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GUEST TOPIC FILTERING
// ════════════════════════════════════════════════════════════════════════════

describe('Guest topic filtering', () => {
  // These are the clearly unrelated queries that SHOULD be blocked
  const blockedMessages = [
    "What's the weather like today?",
    "Who won the NBA game last night?",
    "Give me a recipe for pasta",
    "What's my horoscope?",
    "What is the bitcoin price?",
    "Any relationship advice?",
  ];

  test.each(blockedMessages)('blocks clearly unrelated: "%s"', async (message) => {
    const res = await handler(makeEvent({ body: JSON.stringify({ message }) }));
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).code).toBe('TOPIC_BLOCKED');
  });

  // These are broad/ambiguous questions that SHOULD pass through to the AI
  const allowedMessages = [
    'What events are happening this week?',
    'Who runs this?',
    'When do you meet?',
    'How do I join?',
    'What do you guys do?',
    'Any projects going on?',
    'Tell me about the club',
  ];

  test.each(allowedMessages)('allows ambiguous club question: "%s"', async (message) => {
    const res = await handler(makeEvent({ body: JSON.stringify({ message }) }));
    // Should reach Bedrock, not be blocked at 403
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GUEST RATE LIMITING
// ════════════════════════════════════════════════════════════════════════════

describe('Guest rate limiting', () => {
  test('returns 429 when daily guest limit is reached', async () => {
    // Simulate DynamoDB returning a count at the limit
    mockDdbSend.mockImplementation(async (cmd: { Key?: unknown }) => {
      if (cmd?.Key) return { Item: { count: 10 } }; // at limit
      return {};
    });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(429);
    expect(parseBody(res).code).toBe('RATE_LIMITED');
    // Should NOT have called Bedrock
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  test('allows request when count is below limit', async () => {
    mockDdbSend.mockImplementation(async (cmd: { Key?: unknown }) => {
      if (cmd?.Key) return { Item: { count: 5 } }; // below limit
      return {};
    });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  test('increments usage counter after successful request', async () => {
    mockDdbSend.mockImplementation(async (cmd: { Key?: unknown; Item?: { count?: number } }) => {
      if (cmd?.Key) return { Item: { count: 3 } };
      return {};
    });

    await handler(makeEvent());

    // PutCommand should have been called (the second DDB call)
    const putCall = mockDdbSend.mock.calls.find(
      (call: unknown[]) => (call[0] as { Item?: unknown })?.Item !== undefined
    );
    expect(putCall).toBeDefined();
    const putItem = (putCall![0] as { Item: { count: number } }).Item;
    expect(putItem.count).toBe(4); // incremented from 3
  });

  test('does not block when DynamoDB read fails (fail-open)', async () => {
    // If DynamoDB is down, we allow the request through rather than blocking all guests
    mockDdbSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SUCCESSFUL RESPONSES
// ════════════════════════════════════════════════════════════════════════════

describe('Successful responses', () => {
  test('returns 200 with reply for valid guest request', async () => {
    const res  = await handler(makeEvent());
    const body = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(body.reply).toBe('Hello from MAIC!');
    expect(body.authenticated).toBe(false);
  });

  test('response has correct CORS headers', async () => {
    const res = await handler(makeEvent());
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers['Content-Type']).toBe('application/json');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION — header-based, NOT body-based
// ════════════════════════════════════════════════════════════════════════════

describe('Authentication', () => {
  test('treats request as guest when no Authorization header is present', async () => {
    const res  = await handler(makeEvent({ headers: {} }));
    const body = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(body.authenticated).toBe(false);
  });

  test('ignores isAuthenticated field in the request body (insecure pattern)', async () => {
    // Even if the client sends isAuthenticated: true in the body, the backend
    // must NOT trust it — auth comes from the header only.
    const res = await handler(makeEvent({
      body: JSON.stringify({ message: 'Hello', isAuthenticated: true }),
      headers: {}, // no Authorization header
    }));
    const body = parseBody(res);
    // Should be treated as guest (not authenticated)
    expect(body.authenticated).toBe(false);
  });

  test('downgrades to guest when Authorization header has a malformed token', async () => {
    const res  = await handler(makeEvent({
      headers: { Authorization: 'Bearer this.is.not.a.real.jwt' },
    }));
    const body = parseBody(res);
    // Should succeed as guest, not crash
    expect(res.statusCode).toBe(200);
    expect(body.authenticated).toBe(false);
  });

  test('downgrades to guest when Authorization value is not a Bearer token', async () => {
    const res  = await handler(makeEvent({
      headers: { Authorization: 'Basic somebase64string' },
    }));
    const body = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(body.authenticated).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BEDROCK ERROR HANDLING
// ════════════════════════════════════════════════════════════════════════════

describe('Bedrock error handling', () => {
  test('returns 429 when Bedrock throws ThrottlingException', async () => {
    const err: NodeJS.ErrnoException & { $metadata?: { httpStatusCode: number } } = new Error('Too many requests') as NodeJS.ErrnoException & { $metadata?: { httpStatusCode: number } };
    err.name = 'ThrottlingException';
    mockBedrockSend.mockRejectedValue(err);

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(429);
    expect(parseBody(res).code).toBe('AI_BUSY');
  });

  test('returns 500 when Bedrock throws a generic error', async () => {
    mockBedrockSend.mockRejectedValue(new Error('Internal Bedrock failure'));

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(parseBody(res).code).toBe('SERVER_ERROR');
  });

  test('returns 502 when Bedrock response has no content array', async () => {
    mockBedrockSend.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ content: [] })),
    });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(502);
    expect(parseBody(res).code).toBe('BAD_RESPONSE');
  });

  test('returns 502 when Bedrock response is missing .text field', async () => {
    mockBedrockSend.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text' }] })),
    });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(502);
    expect(parseBody(res).code).toBe('BAD_RESPONSE');
  });

  test('returns 502 when Bedrock returns non-JSON body', async () => {
    mockBedrockSend.mockResolvedValue({
      body: new TextEncoder().encode('not json'),
    });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(502);
    expect(parseBody(res).code).toBe('BAD_RESPONSE');
  });

  test('retries Bedrock on ThrottlingException before succeeding', async () => {
    const throttle: NodeJS.ErrnoException = new Error('Throttled') as NodeJS.ErrnoException;
    throttle.name = 'ThrottlingException';

    // Fail once, then succeed
    mockBedrockSend
      .mockRejectedValueOnce(throttle)
      .mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({ content: [{ text: 'Retry succeeded!' }] })
        ),
      });

    const res  = await handler(makeEvent());
    const body = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(body.reply).toBe('Retry succeeded!');
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  }, 10000); // allow extra time for retry delay
});
