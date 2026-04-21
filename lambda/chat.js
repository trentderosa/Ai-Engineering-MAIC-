"use strict";

/**
 * MAIC Chatbot Lambda Handler
 * Madison AI Club — James Madison University
 *
 * Responsibilities:
 *  - Verify Cognito JWT from Authorization header (never trust the client body)
 *  - Rate-limit guests via DynamoDB
 *  - Block only clearly unrelated guest queries (context-aware, not keyword-based)
 *  - Invoke Claude via Bedrock with tool use for agentic knowledge retrieval
 *  - Maintain server-side conversation history for members, accept client history for guests
 *  - Return structured, typed error responses
 */

const https   = require("https");
const crypto  = require("crypto");
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient }                           = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

// ── Clients ────────────────────────────────────────────────────────────────
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
const ddb     = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ── Constants ──────────────────────────────────────────────────────────────
const GUEST_DAILY_LIMIT   = 10;
const GUEST_MAX_TOKENS    = 500;  // Extra headroom for tool-use overhead
const MEMBER_MAX_TOKENS   = 2000;
const MAX_MESSAGE_LENGTH  = 2000;
const BEDROCK_MAX_RETRIES = 2;
const MAX_TOOL_ROUNDS     = 5;    // Max agentic loop iterations before giving up
const GUEST_TOKEN_BUDGET  = 800;  // ~3200 chars of guest history sent to Bedrock
const MEMBER_TOKEN_BUDGET = 3000; // ~12000 chars of member history sent to Bedrock
const SESSION_TTL_DAYS    = 7;

const TABLE_NAME          = process.env.USAGE_TABLE;
const KNOWLEDGE_TABLE     = process.env.KNOWLEDGE_TABLE;
const USER_POOL_ID        = process.env.USER_POOL_ID;
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID;
const REGION              = process.env.AWS_REGION || "us-east-1";

// Model: cross-region inference profile (required for on-demand throughput)
const MODEL_ID = "us.anthropic.claude-3-5-haiku-20241022-v1:0";

// ── System Prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the official assistant for MAIC (Madison AI Club) at James Madison University (JMU) in Harrisonburg, Virginia (VA 22807).

You help JMU students with questions about MAIC's programs, events, executive board, membership, and AI topics.
Be friendly, concise, and encouraging. If a question is broad or vague but could relate to the club, interpret it in the MAIC context.

KEY FACTS:
- Founded: 2025 | Mission: Learn. Inspire. Teach. All Things AI.
- Contact: madisonaiclub@gmail.com
- Executive Board (all Co-Founders): Mason Scofield (President), Alex Hollenbeck (VP), Jack Nelson (Secretary),
  Emily LaVal (Treasurer), Zachary Johnson (Education Chair), Ayan Jan (Professional Relations), Angeline Jackson (Social Media)
- Programs: Weekly Technical Workshops, Monthly Guest Speaker Series, Semester Community Projects (all members-only)
- Meetings: Bi-weekly on Tuesdays at 6:30 PM during the academic semester. Check BeInvolved or announcements for exact upcoming dates.
- Symposium (major event): April 26 — members showcase their semester work to faculty, students, and employers. This is MAIC's flagship end-of-semester event.
- Club Teams (project groups members join): AI Engineering, AI Ethics, Robotics, Cybersecurity, Website Development
- Featured in The Breeze (JMU student newspaper). Attended NVTC 10th Annual Cyber Summit.
- Past speakers: Joe Holmes (Codecademy), Yi Chen (World/Orb)

When asked about "teams" or "groups", list the five club teams above — NOT the executive board.
When asked about the "board", "officers", or "executive board", list the Co-Founders above.

You have access to a knowledge base tool. Use it proactively when someone asks for:
- Detailed speaker notes or presentation content
- Specific event details not listed above
- Any topic where you need more information than what's in your system prompt

If a question is CLEARLY unrelated to MAIC, JMU, or artificial intelligence (e.g., sports scores, weather, cooking recipes),
politely say: "I'm focused on MAIC and AI topics — feel free to ask about the club, our programs, or anything AI!"`;

// ── Tool Definitions ───────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "search_knowledge",
    description: "Search the MAIC knowledge base for detailed information about speakers, events, notes, or topics. Use this when you need specific details not covered by your system prompt — e.g., speaker presentation notes, event schedules, topic deep-dives.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search terms to find relevant entries (e.g., 'Joe Holmes Codecademy talk', 'April symposium agenda', 'machine learning workshop')",
        },
        type: {
          type: "string",
          enum: ["speaker", "event", "note", "topic"],
          description: "Optional: narrow results to a specific category",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_knowledge_item",
    description: "Retrieve complete details for a specific knowledge entry by its unique ID. Use this after search_knowledge returns a result with a 'pk' field to get the full content.",
    input_schema: {
      type: "object",
      properties: {
        pk: {
          type: "string",
          description: "The unique key of the entry returned from search_knowledge (e.g., 'speaker#joe-holmes', 'event#april-symposium-2025')",
        },
      },
      required: ["pk"],
    },
  },
];

// ── Conversation History Helpers ───────────────────────────────────────────

// ~4 chars/token heuristic — avoids a count_tokens API call
function estimateTokens(text) {
  return Math.ceil((text ?? '').length / 4);
}

function trimToTokenBudget(messages, budget) {
  let total = 0;
  const result = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(messages[i].content);
    if (total + cost > budget) break;
    total += cost;
    result.unshift(messages[i]);
  }
  return result;
}

function sanitizeLocalTurns(turns) {
  return turns
    .filter(t => t.role === 'user' || t.role === 'assistant')
    .map(t => ({ role: t.role, content: String(t.content ?? '').slice(0, 2000) }));
}

// ── JWKS Verification (pure Node built-ins, no external deps) ──────────────
let jwksCache     = null;
let jwksCacheTime = 0;

function base64UrlDecode(str) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function fetchJwks() {
  const now = Date.now();
  if (jwksCache && now - jwksCacheTime < 3_600_000) return jwksCache;

  const url = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          jwksCache     = JSON.parse(data);
          jwksCacheTime = Date.now();
          resolve(jwksCache);
        } catch (e) {
          reject(new Error("Failed to parse JWKS response"));
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Verifies a Cognito ID token using RS256 + JWKS.
 * Throws an error with a `code` property on failure.
 * Returns the decoded payload on success.
 */
async function verifyToken(token) {
  if (!token) throw Object.assign(new Error("No token"), { code: "NO_TOKEN" });

  const parts = token.split(".");
  if (parts.length !== 3) throw Object.assign(new Error("Malformed token"), { code: "BAD_TOKEN" });

  let header, payload;
  try {
    header  = JSON.parse(base64UrlDecode(parts[0]));
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    throw Object.assign(new Error("Cannot decode token"), { code: "BAD_TOKEN" });
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error("Token expired"), { code: "EXPIRED" });
  }

  const expectedIss = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
  if (payload.iss !== expectedIss) {
    throw Object.assign(new Error("Invalid issuer"), { code: "BAD_TOKEN" });
  }

  if (payload.aud !== USER_POOL_CLIENT_ID) {
    throw Object.assign(new Error("Invalid audience"), { code: "BAD_TOKEN" });
  }

  const jwks = await fetchJwks();
  const key  = jwks.keys.find((k) => k.kid === header.kid);
  if (!key) throw Object.assign(new Error("Signing key not found"), { code: "BAD_TOKEN" });

  const publicKey     = crypto.createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" });
  const verifier      = crypto.createVerify("SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  const signatureValid = verifier.verify(publicKey, base64UrlDecode(parts[2]));
  if (!signatureValid) throw Object.assign(new Error("Invalid signature"), { code: "BAD_TOKEN" });

  return payload;
}

// ── Context-Aware Topic Filter ─────────────────────────────────────────────
const UNRELATED_PATTERNS = [
  /\b(weather|forecast|temperature|humidity)\b/i,
  /\b(nfl|nba|nhl|mlb|nascar|nfl score|nba score|soccer score|game score)\b/i,
  /\b(recipe|how to cook|bake|ingredient|dinner idea)\b/i,
  /\b(horoscope|zodiac|astrology)\b/i,
  /\b(bitcoin price|crypto price|stock price|dogecoin)\b/i,
  /\b(relationship advice|dating tip|breakup)\b/i,
];

function isGuestTopicBlocked(message) {
  return UNRELATED_PATTERNS.some((re) => re.test(message));
}

// ── Knowledge Base Tool Implementations ───────────────────────────────────

/**
 * Scans the knowledge table and scores results by keyword relevance.
 * Optionally filters by `type` via the GSI to reduce scan volume.
 */
async function searchKnowledge(query, type) {
  if (!KNOWLEDGE_TABLE) return { error: "Knowledge base not configured", results: [] };

  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (queryTerms.length === 0) return { results: [], count: 0 };

  try {
    let items;

    if (type) {
      const result = await ddb.send(new QueryCommand({
        TableName: KNOWLEDGE_TABLE,
        IndexName: "type-index",
        KeyConditionExpression: "#t = :type",
        ExpressionAttributeNames: { "#t": "type" },
        ExpressionAttributeValues: { ":type": type },
      }));
      items = result.Items || [];
    } else {
      const result = await ddb.send(new ScanCommand({ TableName: KNOWLEDGE_TABLE }));
      items = result.Items || [];
    }

    const scored = items
      .map((item) => {
        const searchText = [
          item.title || "",
          item.summary || "",
          (item.tags || []).join(" "),
          item.type || "",
        ].join(" ").toLowerCase();

        const score = queryTerms.filter((term) => searchText.includes(term)).length;
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ item }) => ({
        pk: item.pk,
        type: item.type,
        title: item.title,
        summary: item.summary || (item.content || "").slice(0, 300),
        tags: item.tags,
      }));

    return { results: scored, count: scored.length };
  } catch (err) {
    console.error("[MAIC] Knowledge search error:", err.message);
    return { error: "Search failed", results: [] };
  }
}

/**
 * Fetches a single knowledge entry by primary key.
 */
async function getKnowledgeItem(pk) {
  if (!KNOWLEDGE_TABLE) return { error: "Knowledge base not configured" };

  try {
    const result = await ddb.send(new GetCommand({
      TableName: KNOWLEDGE_TABLE,
      Key: { pk },
    }));

    if (!result.Item) return { error: `No entry found for key: ${pk}` };
    return result.Item;
  } catch (err) {
    console.error("[MAIC] Knowledge get error:", err.message);
    return { error: "Retrieval failed" };
  }
}

async function executeToolCall(toolName, toolInput) {
  console.info(`[MAIC] Tool call: ${toolName}`, JSON.stringify(toolInput));
  switch (toolName) {
    case "search_knowledge":
      return searchKnowledge(toolInput.query, toolInput.type);
    case "get_knowledge_item":
      return getKnowledgeItem(toolInput.pk);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Bedrock Invocation (single raw call with retry) ────────────────────────
async function invokeBedrockRaw(messages, maxTokens, attempt = 0) {
  try {
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId:     MODEL_ID,
        contentType: "application/json",
        accept:      "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: maxTokens,
          system:     SYSTEM_PROMPT,
          tools:      TOOLS,
          messages,
        }),
      })
    );

    let result;
    try {
      result = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      throw Object.assign(new Error("Bedrock returned non-JSON body"), { code: "BAD_RESPONSE" });
    }

    return result;

  } catch (err) {
    if (err.code === "BAD_RESPONSE") throw err;

    const isRetryable =
      err.name === "ThrottlingException"        ||
      err.name === "ServiceUnavailableException" ||
      err.name === "InternalServerException"     ||
      err.$retryable?.throttling               ||
      err.$metadata?.httpStatusCode === 429    ||
      err.$metadata?.httpStatusCode === 503;

    if (isRetryable && attempt < BEDROCK_MAX_RETRIES) {
      const delay = (attempt + 1) * 1000;
      console.warn(`[MAIC] Bedrock retry ${attempt + 1}/${BEDROCK_MAX_RETRIES} after ${delay}ms — ${err.name || err.message}`);
      await new Promise((r) => setTimeout(r, delay));
      return invokeBedrockRaw(messages, maxTokens, attempt + 1);
    }

    throw err;
  }
}

// ── Agentic Tool Loop ──────────────────────────────────────────────────────
/**
 * Runs a multi-turn conversation with Claude, executing tool calls as they
 * come in, until Claude produces a final text response or the round limit
 * is reached. Accepts optional pastMessages for conversation memory.
 */
async function invokeWithTools(userMessage, maxTokens, pastMessages = []) {
  const messages = [...pastMessages, { role: "user", content: userMessage }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await invokeBedrockRaw(messages, maxTokens);

    const { stop_reason, content } = result;

    if (!content || !Array.isArray(content)) {
      throw Object.assign(new Error("Unexpected Bedrock response shape"), { code: "BAD_RESPONSE" });
    }

    if (stop_reason === "end_turn" || stop_reason === "max_tokens") {
      const textBlock = content.find((b) => b.type === "text");
      if (!textBlock?.text) {
        throw Object.assign(new Error("No text block in Bedrock response"), { code: "BAD_RESPONSE" });
      }
      return textBlock.text;
    }

    if (stop_reason === "tool_use") {
      // Append Claude's response (including tool_use blocks) to the conversation
      messages.push({ role: "assistant", content });

      // Execute all tool calls in parallel and collect results
      const toolUseBlocks = content.filter((b) => b.type === "tool_use");
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const toolResult = await executeToolCall(block.name, block.input);
          return {
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(toolResult),
          };
        })
      );

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unexpected stop_reason — return whatever text we have
    const textBlock = content.find((b) => b.type === "text");
    return textBlock?.text || "";
  }

  throw Object.assign(new Error("Tool loop exceeded maximum rounds"), { code: "TOOL_LOOP_LIMIT" });
}

// ── Utility ────────────────────────────────────────────────────────────────
function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

function respond(statusCode, headers, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

async function loadMemberHistory(userId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `session#${userId}` },
  }));
  return result.Item?.history || [];
}

async function saveMemberHistory(userId, history) {
  const ttl = Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86400;
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { pk: `session#${userId}`, history, ttl },
  }));
}

// ── Main Handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":"Content-Type,Authorization",
    "Access-Control-Allow-Methods":"POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // ── 1. Parse request body ─────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, headers, { error: "Invalid JSON in request body.", code: "BAD_REQUEST" });
  }

  const { message, history = [], localTurns = [] } = body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return respond(400, headers, { error: "A non-empty message is required.", code: "BAD_REQUEST" });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return respond(400, headers, {
      error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
      code: "MESSAGE_TOO_LONG",
    });
  }

  // ── 2. Verify auth via Authorization header ───────────────────────────────
  let isAuthenticated = false;
  let userId = null;
  const authHeader = event.headers?.Authorization || event.headers?.authorization || "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (token) {
    try {
      const payload = await verifyToken(token);
      userId = payload.sub;
      isAuthenticated = true;
      console.info("[MAIC] Authenticated member request");
    } catch (err) {
      console.warn(`[MAIC] Token invalid (${err.code}): ${err.message} — downgrading to guest`);
    }
  }

  // ── 3. Guest-only checks ──────────────────────────────────────────────────
  if (!isAuthenticated) {

    if (isGuestTopicBlocked(message)) {
      console.info("[MAIC] Guest topic blocked");
      return respond(403, headers, {
        error: "I'm focused on MAIC and AI topics! Sign in as a member for broader access.",
        code: "TOPIC_BLOCKED",
      });
    }

    const ip       = event.requestContext?.identity?.sourceIp || "unknown";
    const usageKey = `guest#${ip}#${getTodayKey()}`;
    let count = 0;

    try {
      const usage = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: usageKey } }));
      count = usage.Item?.count || 0;
    } catch (err) {
      console.error("[MAIC] DynamoDB read error:", err.message);
    }

    if (count >= GUEST_DAILY_LIMIT) {
      console.info(`[MAIC] Guest rate limit hit for ${ip}`);
      return respond(429, headers, {
        error: `Daily guest limit of ${GUEST_DAILY_LIMIT} messages reached. Sign in as a MAIC member for unlimited access!`,
        code: "RATE_LIMITED",
      });
    }

    try {
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk:    usageKey,
          count: count + 1,
          ttl:   Math.floor(Date.now() / 1000) + 86400,
        },
      }));
    } catch (err) {
      console.error("[MAIC] DynamoDB write error:", err.message);
    }
  }

  // ── 4. Build conversation history ─────────────────────────────────────────
  const maxTokens   = isAuthenticated ? MEMBER_MAX_TOKENS : GUEST_MAX_TOKENS;
  const tokenBudget = isAuthenticated ? MEMBER_TOKEN_BUDGET : GUEST_TOKEN_BUDGET;

  let pastMessages = [];
  if (isAuthenticated && userId) {
    const ddbHistory = await loadMemberHistory(userId);
    pastMessages = [...ddbHistory, ...sanitizeLocalTurns(localTurns)];
  } else {
    pastMessages = sanitizeLocalTurns(Array.isArray(history) ? history : []);
  }
  pastMessages = trimToTokenBudget(pastMessages, tokenBudget);

  // ── 5. Invoke Bedrock with agentic tool loop ──────────────────────────────
  console.info(`[MAIC] Invoking Bedrock — authenticated=${isAuthenticated}, maxTokens=${maxTokens}`);

  try {
    const reply = await invokeWithTools(message, maxTokens, pastMessages);

    if (isAuthenticated && userId) {
      const updatedHistory = trimToTokenBudget([
        ...pastMessages,
        { role: "user", content: message },
        { role: "assistant", content: reply },
      ], MEMBER_TOKEN_BUDGET);
      await saveMemberHistory(userId, updatedHistory);
    }

    return respond(200, headers, { reply, authenticated: isAuthenticated });

  } catch (err) {
    console.error("[MAIC] Bedrock error:", { name: err.name, message: err.message, code: err.code });

    if (err.name === "ThrottlingException" || err.$metadata?.httpStatusCode === 429) {
      return respond(429, headers, {
        error: "The AI service is temporarily busy. Please wait a moment and try again.",
        code: "AI_BUSY",
      });
    }

    if (err.code === "BAD_RESPONSE") {
      return respond(502, headers, {
        error: "The AI returned an unexpected response. Please try again.",
        code: "BAD_RESPONSE",
      });
    }

    if (err.code === "TOOL_LOOP_LIMIT") {
      return respond(500, headers, {
        error: "The AI took too many steps to answer. Please try a more specific question.",
        code: "TOOL_LOOP_LIMIT",
      });
    }

    return respond(500, headers, {
      error: "Something went wrong on our end. Please try again shortly.",
      code: "SERVER_ERROR",
    });
  }
};
