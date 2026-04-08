const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const GUEST_DAILY_LIMIT = 10;
const GUEST_MAX_TOKENS = 300;
const MEMBER_MAX_TOKENS = 2000;
const TABLE_NAME = process.env.USAGE_TABLE;
const MODEL_ID = "us.anthropic.claude-3-5-haiku-20241022-v1:0";

const ALLOWED_GUEST_KEYWORDS = [
  // Club & identity
  "maic", "madison", "club", "member", "membership", "join", "officer",
  "board", "executive", "founder", "president", "vice", "treasurer", "secretary",
  "jmu", "james madison", "harrisonburg",
  // Events & schedule
  "event", "meeting", "workshop", "hackathon", "seminar", "speaker", "schedule",
  "calendar", "upcoming", "when", "where",
  // AI & tech topics
  "ai", "artificial intelligence", "machine learning", "ml", "deep learning",
  "neural network", "nlp", "natural language", "computer vision", "data science",
  "llm", "large language model", "gpt", "claude", "chatgpt", "openai", "anthropic",
  "model", "training", "dataset", "algorithm", "automation", "robot",
  "python", "pytorch", "tensorflow", "transformer", "embedding",
  "prompt", "inference", "generative", "diffusion", "classification",
  // General question starters (so common questions aren't blocked)
  "what", "who", "how", "when", "where", "why", "tell me", "explain",
  "help", "learn", "project", "research", "career", "internship",
  // Greetings & small talk
  "hi", "hello", "hey", "thanks", "thank you", "bye", "goodbye"
];

const SYSTEM_PROMPT = `You are the MAIC (Madison Artificial Intelligence Club) assistant at James Madison University (JMU) in Harrisonburg, VA.
You help students learn about AI and answer questions about the club, its events, projects, and membership.
Be friendly, encouraging, and educational. Keep responses concise and helpful.

ABOUT MAIC:
- Founded in 2025 at JMU. Motto: "Learn. Inspire. Teach. All Things AI."
- Mission: promote ethical, responsible engagement with AI, connecting JMU students with industry professionals, applied research, and practical tools.
- Contact: madisonaiclub@gmail.com | LinkedIn: linkedin.com/company/madison-artificial-intelligence-club

PROGRAMS (members only):
- Weekly Technical Workshops: hands-on sessions on AI models, tools, and frameworks
- Monthly Guest Speaker Series: talks from industry professionals
- Semester-long Community Projects: applied AI projects targeting real-world challenges

EXECUTIVE BOARD (all Co-Founders):
- Mason Scofield — President: leads club strategy, partnerships, and long-term growth
- Alex Hollenbeck — Vice President: he drives operations and supports execution of programs, events, and member development
- Jack Nelson — Secretary: keeps club communications, records, and coordination organized
- Emily LaVal — Treasurer: manages budgeting, funding, and financial planning
- Zachary Johnson — Education Chair: designs technical learning experiences, workshops, and AI skill-building resources
- Ayan Jan — Professional Relations: builds relationships with alumni and professionals to expand career opportunities
- Angeline Jackson — Social Media: leads digital presence, content strategy, and storytelling across club channels

NOTABLE EVENTS:
- Joe Holmes (Codecademy) spoke on AI curriculum and career paths
- Yi Chen (World/the Orb) hosted a virtual session
- Board members attended the NVTC 10th Annual Cyber Summit (AI, defense, cybersecurity)
- Featured in The Breeze, JMU's student newspaper

If you don't know specific details (like exact meeting times or locations), say so honestly and direct them to madisonaiclub@gmail.com.`;

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
    const { message, isAuthenticated } = body;

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
