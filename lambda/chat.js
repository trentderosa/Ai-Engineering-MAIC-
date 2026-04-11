"use strict";

/**
 * MAIC Chatbot Lambda Handler
 * Madison AI Club — James Madison University
 *
 * Responsibilities:
 *  - Verify Cognito JWT from Authorization header (never trust the client body)
 *  - Rate-limit guests via DynamoDB
 *  - Block only clearly unrelated guest queries (context-aware, not keyword-based)
 *  - Invoke Claude via Bedrock with retry logic
 *  - Return structured, typed error responses
 */

const https   = require("https");
const crypto  = require("crypto");
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient }                           = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

// ── Clients ────────────────────────────────────────────────────────────────
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
const ddb     = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ── Constants ──────────────────────────────────────────────────────────────
const GUEST_DAILY_LIMIT  = 10;
const GUEST_MAX_TOKENS   = 300;
const MEMBER_MAX_TOKENS  = 2000;
const MAX_MESSAGE_LENGTH = 2000;
const BEDROCK_MAX_RETRIES = 2;

const TABLE_NAME         = process.env.USAGE_TABLE;
const USER_POOL_ID       = process.env.USER_POOL_ID;
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID;
const REGION             = process.env.AWS_REGION || "us-east-1";

// Model: cross-region inference profile (required for on-demand throughput)
const MODEL_ID = "us.anthropic.claude-3-5-haiku-20241022-v1:0";

// ── System Prompt ──────────────────────────────────────────────────────────
// FIX: was "University of Wisconsin-Madison" — corrected to James Madison University
const SYSTEM_PROMPT = `You are the official assistant for MAIC (Madison AI Club) at James Madison University (JMU) in Harrisonburg, Virginia (VA 22807).

You help JMU students with questions about MAIC's programs, events, executive board, membership, and AI topics.
Be friendly, concise, and encouraging. If a question is broad or vague but could relate to the club, interpret it in the MAIC context.

KEY FACTS:
- Founded: 2025 | Mission: Learn. Inspire. Teach. All Things AI.
- Contact: madisonaiclub@gmail.com
- Executive Board (all Co-Founders): Mason Scofield (President), Alex Hollenbeck (VP), Jack Nelson (Secretary),
  Emily LaVal (Treasurer), Zachary Johnson (Education Chair), Ayan Jan (Professional Relations), Angeline Jackson (Social Media)
- Programs: Weekly Technical Workshops, Monthly Guest Speaker Series, Semester Community Projects (all members-only)
- Club Teams (project groups members join): AI Engineering, AI Ethics, Robotics, Cybersecurity, Website Development
- Featured in The Breeze (JMU student newspaper). Attended NVTC 10th Annual Cyber Summit.
- Past speakers: Joe Holmes (Codecademy), Yi Chen (World/Orb)

When asked about "teams" or "groups", list the five club teams above — NOT the executive board.
When asked about the "board", "officers", or "executive board", list the Co-Founders above.

If a question is CLEARLY unrelated to MAIC, JMU, or artificial intelligence (e.g., sports scores, weather, cooking recipes),
politely say: "I'm focused on MAIC and AI topics — feel free to ask about the club, our programs, or anything AI!"`;

// ── JWKS Verification (pure Node built-ins, no external deps) ──────────────
// Caches the public key set for 1 hour to avoid fetching on every request.
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

  // Expiration
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error("Token expired"), { code: "EXPIRED" });
  }

  // Issuer — must match OUR Cognito pool (prevents tokens from other pools)
  const expectedIss = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
  if (payload.iss !== expectedIss) {
    throw Object.assign(new Error("Invalid issuer"), { code: "BAD_TOKEN" });
  }

  // Audience — must match OUR app client ID
  if (payload.aud !== USER_POOL_CLIENT_ID) {
    throw Object.assign(new Error("Invalid audience"), { code: "BAD_TOKEN" });
  }

  // Signature — fetch JWKS and verify RS256 signature using Node crypto
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
// FIX: replaced exhaustive keyword allow-list with a small BLOCK-list.
// Default = ALLOW. Only block messages that are unmistakably off-topic.
// Ambiguous questions ("what's happening this week?", "who runs this?") pass through
// and are handled naturally by the AI's system prompt.
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

// ── Bedrock Invocation with Retry ──────────────────────────────────────────
// Retries on throttling or service errors (up to BEDROCK_MAX_RETRIES times).
// Uses exponential backoff: 1s, 2s.
async function invokeBedrockWithRetry(message, maxTokens, attempt = 0) {
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
          messages:   [{ role: "user", content: message }],
        }),
      })
    );

    // FIX: validate response shape before accessing .content[0].text
    let result;
    try {
      result = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      throw Object.assign(new Error("Bedrock returned non-JSON body"), { code: "BAD_RESPONSE" });
    }

    if (!result?.content?.[0]?.text) {
      throw Object.assign(new Error("Unexpected Bedrock response shape"), { code: "BAD_RESPONSE" });
    }

    return result.content[0].text;

  } catch (err) {
    // Don't retry logic/validation errors
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
      return invokeBedrockWithRetry(message, maxTokens, attempt + 1);
    }

    throw err;
  }
}

// ── Utility ────────────────────────────────────────────────────────────────
function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

function respond(statusCode, headers, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

// ── Main Handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":"Content-Type,Authorization",
    "Access-Control-Allow-Methods":"POST,OPTIONS",
  };

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // ── 1. Parse request body safely ──────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, headers, { error: "Invalid JSON in request body.", code: "BAD_REQUEST" });
  }

  const { message } = body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return respond(400, headers, { error: "A non-empty message is required.", code: "BAD_REQUEST" });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return respond(400, headers, {
      error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
      code: "MESSAGE_TOO_LONG",
    });
  }

  // ── 2. Verify auth via Authorization header (NEVER trust the request body) ─
  // FIX: the old code read isAuthenticated from body — that's client-controlled
  // and completely insecure. We now read the Bearer token from the header and
  // cryptographically verify it against our Cognito user pool.
  let isAuthenticated = false;
  const authHeader = event.headers?.Authorization || event.headers?.authorization || "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (token) {
    try {
      await verifyToken(token);
      isAuthenticated = true;
      console.info("[MAIC] Authenticated member request");
    } catch (err) {
      // Log but don't hard-fail — downgrade to guest access.
      // If you want strict enforcement (reject invalid tokens entirely), return 401 here.
      console.warn(`[MAIC] Token invalid (${err.code}): ${err.message} — downgrading to guest`);
      isAuthenticated = false;
    }
  }

  // ── 3. Guest-only checks ───────────────────────────────────────────────────
  if (!isAuthenticated) {

    // Context-aware topic filter — only block clearly unrelated queries
    if (isGuestTopicBlocked(message)) {
      console.info("[MAIC] Guest topic blocked");
      return respond(403, headers, {
        error: "I'm focused on MAIC and AI topics! Sign in as a member for broader access.",
        code: "TOPIC_BLOCKED",
      });
    }

    // Rate limit by IP + day
    const ip       = event.requestContext?.identity?.sourceIp || "unknown";
    const usageKey = `guest#${ip}#${getTodayKey()}`;
    let count = 0;

    try {
      const usage = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: usageKey } }));
      count = usage.Item?.count || 0;
    } catch (err) {
      // DynamoDB read failure — log and continue rather than blocking the user
      console.error("[MAIC] DynamoDB read error:", err.message);
    }

    if (count >= GUEST_DAILY_LIMIT) {
      console.info(`[MAIC] Guest rate limit hit for ${ip}`);
      return respond(429, headers, {
        error: `Daily guest limit of ${GUEST_DAILY_LIMIT} messages reached. Sign in as a MAIC member for unlimited access!`,
        code: "RATE_LIMITED",
      });
    }

    // Increment counter (non-fatal if this fails)
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk:  usageKey,
          count: count + 1,
          ttl: Math.floor(Date.now() / 1000) + 86400, // auto-expire after 24h
        },
      }));
    } catch (err) {
      console.error("[MAIC] DynamoDB write error:", err.message);
    }
  }

  // ── 4. Invoke Bedrock ──────────────────────────────────────────────────────
  const maxTokens = isAuthenticated ? MEMBER_MAX_TOKENS : GUEST_MAX_TOKENS;
  console.info(`[MAIC] Invoking Bedrock — authenticated=${isAuthenticated}, maxTokens=${maxTokens}`);

  try {
    const reply = await invokeBedrockWithRetry(message, maxTokens);
    return respond(200, headers, { reply, authenticated: isAuthenticated });

  } catch (err) {
    console.error("[MAIC] Bedrock error:", { name: err.name, message: err.message, code: err.code });

    if (
      err.name === "ThrottlingException" ||
      err.$metadata?.httpStatusCode === 429
    ) {
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

    return respond(500, headers, {
      error: "Something went wrong on our end. Please try again shortly.",
      code: "SERVER_ERROR",
    });
  }
};
