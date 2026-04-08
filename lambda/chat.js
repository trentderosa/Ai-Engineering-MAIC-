const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const GUEST_DAILY_LIMIT = 10;
const GUEST_MAX_TOKENS = 300;
const MEMBER_MAX_TOKENS = 2000;
const GUEST_HISTORY_WINDOW = 4;
const MEMBER_HISTORY_WINDOW = 10;
const SESSION_TTL_DAYS = 7;
const TABLE_NAME = process.env.USAGE_TABLE;
const MODEL_ID = "us.anthropic.claude-3-5-haiku-20241022-v1:0";

const ALLOWED_GUEST_KEYWORDS = [
  "ai", "artificial intelligence", "machine learning", "maic", "madison",
  "club", "event", "meeting", "join", "membership", "schedule", "project",
  "neural network", "deep learning", "data science", "python", "nlp"
];

// Full MAIC context lives here as the system prompt — not in every history turn.
// Bedrock's system field is static context; messages[] is the conversation.
const SYSTEM_PROMPT = `You are the official assistant for MAIC — the Madison AI Club at James Madison University (JMU), established in 2025.

ABOUT MAIC:
MAIC brings together JMU students, industry professionals, and researchers to explore, build, and apply artificial intelligence — from weekly workshops to real-world projects. The club promotes ethical, responsible engagement with AI, connecting JMU students to industry professionals, applied research, and career opportunities.

MISSION: Learn. Inspire. Teach. All Things AI.

LOCATION: James Madison University, Harrisonburg, VA 22807

CONTACT: madisonaiclub@gmail.com

PROGRAMS:
1. Technical Workshops — Hands-on weekly sessions led by the Education Chair covering the latest AI models, tools, frameworks, and research. Members only.
2. Guest Speaker Series — Monthly sessions with industry professionals sharing insights on their careers and work in AI. Past speakers include leaders from Codecademy (Joe Holmes) and World/Orb (Yi Chen). Members only.
3. Community Projects — Semester-long committee projects where members use AI to tackle real-world challenges and build practical technical experience. Members only.

KEY BENEFITS:
- Mentorship: Experienced members guide newcomers through AI projects and career development.
- Industry Exposure: Monthly guest speakers from leading tech companies and AI organizations.
- Impact: Semester-long projects using AI to address real challenges.

EXECUTIVE BOARD (Co-Founders):
- Mason Scofield — President & Co-Founder. Leads club strategy, partnerships, and long-term growth.
- Alex Hollenbeck — Vice President & Co-Founder. Drives operations and supports execution of programs and events.
- Jack Nelson — Secretary & Co-Founder. Keeps club communications, records, and coordination organized.
- Emily LaVal — Treasurer & Co-Founder. Manages budgeting, funding, and financial planning.
- Zachary Johnson — Education Chair & Co-Founder. Designs technical learning experiences and workshops.
- Ayan Jan — Professional Relations & Co-Founder. Builds relationships with alumni and professionals for career opportunities.
- Angeline Jackson — Social Media & Co-Founder. Leads digital presence, content strategy, and storytelling.

NEWS & HIGHLIGHTS:
- Featured in The Breeze (JMU's student newspaper): "What is the Madison Artificial Intelligence Club?"
- Speaker Series: Joe Holmes from Codecademy joined MAIC, sharing insights about his career path and the evolving AI landscape.
- Conference: Board members Ayan Jan, Mason Scofield, Errett Wallace, and John Nelson attended the NVTC 10th Annual Cyber Summit.

MEMBERSHIP: Open to JMU students. Sign in via the Member Portal for full access to workshops, speakers, and projects. Affiliated with JMU Student Life.

Only answer questions related to MAIC, its programs, team, AI topics, and JMU. For anything unrelated, politely redirect the user to MAIC topics.
Be friendly, encouraging, and educational. Keep responses concise and helpful.`;

function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

function isTopicAllowed(message) {
  const lower = message.toLowerCase();
  return ALLOWED_GUEST_KEYWORDS.some(kw => lower.includes(kw));
}

async function loadMemberHistory(userId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `session#${userId}` }
  }));
  return result.Item?.history || [];
}

async function saveMemberHistory(userId, history) {
  const ttl = Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86400;
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { pk: `session#${userId}`, history, ttl }
  }));
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
    const { message, userId, isAuthenticated, history = [] } = body;

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
    const historyWindow = isAuthenticated ? MEMBER_HISTORY_WINDOW : GUEST_HISTORY_WINDOW;

    // Members: load history server-side (DDB) — client history is ignored.
    // Guests: trust client-sent history (no stable identity to key on).
    let pastMessages;
    if (isAuthenticated && userId) {
      pastMessages = await loadMemberHistory(userId);
    } else {
      pastMessages = Array.isArray(history) ? history : [];
    }
    pastMessages = pastMessages.slice(-historyWindow);

    const messages = [...pastMessages, { role: "user", content: message }];

    const response = await bedrock.send(new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages
      })
    }));

    const result = JSON.parse(new TextDecoder().decode(response.body));
    const reply = result.content[0].text;

    // Persist updated history for members, capped at window size
    if (isAuthenticated && userId) {
      const updatedHistory = [
        ...pastMessages,
        { role: "user", content: message },
        { role: "assistant", content: reply }
      ].slice(-MEMBER_HISTORY_WINDOW);
      await saveMemberHistory(userId, updatedHistory);
    }

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
