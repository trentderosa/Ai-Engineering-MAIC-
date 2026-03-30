const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const GUEST_DAILY_LIMIT = 10;
const GUEST_MAX_TOKENS = 300;
const MEMBER_MAX_TOKENS = 2000;
const TABLE_NAME = process.env.USAGE_TABLE;
const MODEL_ID = "us.anthropic.claude-3-5-haiku-20241022-v1:0";

const ALLOWED_GUEST_KEYWORDS = [
  "ai", "artificial intelligence", "machine learning", "maic", "madison",
  "club", "event", "meeting", "join", "membership", "schedule", "project",
  "neural network", "deep learning", "data science", "python", "nlp"
];

const SYSTEM_PROMPT = `You are the MAIC (Madison Artificial Intelligence Club) assistant. 
You help students learn about AI, answer questions about the club, its events, projects, and membership.
Be friendly, encouraging, and educational. Keep responses concise and helpful.
The club focuses on AI/ML education, hands-on projects, and building a community of AI enthusiasts at the University of Wisconsin-Madison.`;

function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

function isTopicAllowed(message) {
  const lower = message.toLowerCase();
  return ALLOWED_GUEST_KEYWORDS.some(kw => lower.includes(kw));
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { message, userId, isAuthenticated } = body;

    if (!message || message.trim().length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Message is required" }) };
    }

    // Guest rate limiting and topic filtering
    if (!isAuthenticated) {
      if (!isTopicAllowed(message)) {
        return {
          statusCode: 403, headers,
          body: JSON.stringify({ 
            error: "As a guest, I can only answer questions about AI, machine learning, and the MAIC club. Sign in as a member for unrestricted access!"
          })
        };
      }

      const ip = event.requestContext?.identity?.sourceIp || "unknown";
      const usageKey = `guest#${ip}#${getTodayKey()}`;
      const usage = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: usageKey } }));
      const count = usage.Item?.count || 0;

      if (count >= GUEST_DAILY_LIMIT) {
        return {
          statusCode: 429, headers,
          body: JSON.stringify({ 
            error: `Guest limit of ${GUEST_DAILY_LIMIT} messages per day reached. Sign in as a MAIC member for unlimited access!`
          })
        };
      }

      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: usageKey, count: count + 1, ttl: Math.floor(Date.now() / 1000) + 86400 }
      }));
    }

    const maxTokens = isAuthenticated ? MEMBER_MAX_TOKENS : GUEST_MAX_TOKENS;

    const response = await bedrock.send(new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: message }]
      })
    }));

    const result = JSON.parse(new TextDecoder().decode(response.body));
    const reply = result.content[0].text;

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ reply, isAuthenticated: !!isAuthenticated })
    };

  } catch (err) {
    console.error("Error:", err);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "Something went wrong. Please try again." })
    };
  }
};
