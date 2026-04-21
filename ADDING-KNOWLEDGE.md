# Adding Knowledge to the MAIC Chatbot

This guide is for anyone who wants to teach the MAIC chatbot new information — no coding experience required.

---

## What is the knowledge base?

The chatbot has a built-in knowledge base it can search whenever someone asks a question. When a user asks something like *"What did Joe Holmes talk about?"* or *"What's the Symposium schedule?"*, the chatbot looks up the answer from this knowledge base instead of guessing.

You add knowledge by editing one file and running one command.

---

## Step 1 — Open the seed file

Open this file in any text editor (Notepad, VS Code, etc.):

```
scripts/seed-knowledge.js
```

Scroll down until you see a section that starts with:

```
const ENTRIES = [
```

Everything between the `[` and the closing `];` is the knowledge base. Each block inside is one "entry" — a piece of information the chatbot can look up.

---

## Step 2 — Understand an entry

Each entry looks like this:

```js
{
  pk:      "speaker#joe-holmes",
  type:    "speaker",
  title:   "Joe Holmes — Codecademy",
  summary: "A short 1-2 sentence description shown in search results.",
  content: `The full notes go here.
You can write as much as you want.
Multiple lines are fine.`,
  tags: ["joe holmes", "codecademy", "career", "ai"],
},
```

Here's what each field means:

| Field | What it is | Rules |
|---|---|---|
| `pk` | Unique ID for this entry | Must start with the type, then `#`, then a short slug with no spaces. Example: `speaker#jane-doe` |
| `type` | Category | Must be one of: `speaker`, `event`, `note`, `topic` |
| `title` | Display name | Plain text, shown in search results |
| `summary` | Short description | 1-2 sentences. The chatbot sees this first before deciding to read the full content |
| `content` | Full details | Write as much as you want. This is what the chatbot reads to answer detailed questions |
| `tags` | Search keywords | Lowercase words that help find this entry. Include names, topics, and common ways someone might ask about it |

---

## Step 3 — Add your entry

Copy one of the existing entries, paste it at the end of the list (before the `];`), and fill in your information.

**Make sure:**
- The `pk` is unique — don't reuse an existing one
- You put a comma `,` after the closing `}` of your entry (unless it's the very last entry)
- The backtick `` ` `` characters around `content` are kept — they allow multi-line text

### Example: Adding a new speaker

```js
{
  pk:      "speaker#jane-smith",
  type:    "speaker",
  title:   "Jane Smith — Google DeepMind",
  summary: "Jane Smith from Google DeepMind spoke about reinforcement learning and its real-world applications in robotics.",
  content: `Speaker: Jane Smith
Company: Google DeepMind
Talk Title: Reinforcement Learning in the Real World

Key Points:
- Reinforcement learning (RL) trains agents by rewarding good behavior.
- DeepMind used RL to create AlphaGo and AlphaFold.
- Real-world RL is harder than games because environments are noisy and unpredictable.
- Sim-to-real transfer: train in simulation, deploy on physical robots.
- Recommended reading: Sutton & Barto "Reinforcement Learning: An Introduction" (free online).

Q&A Highlights:
- How long does RL training take? Days to weeks for complex tasks.
- Is RL used in LLMs? Yes — RLHF (Reinforcement Learning from Human Feedback) is how ChatGPT was fine-tuned.

Hosted by: MAIC at JMU`,
  tags: ["jane smith", "deepmind", "google", "reinforcement learning", "rl", "robotics", "alphago", "speaker"],
},
```

### Example: Adding an event

```js
{
  pk:      "event#fall-kickoff-2025",
  type:    "event",
  title:   "MAIC Fall Kickoff — September 9, 2025",
  summary: "MAIC's first meeting of the Fall 2025 semester. Learn about the club, meet the board, and sign up for a team.",
  content: `Event: MAIC Fall Kickoff
Date: September 9, 2025
Location: TBD — check BeInvolved for room

Schedule:
6:30 PM — Welcome and introductions
6:45 PM — President's overview of MAIC's mission and this semester's goals
7:00 PM — Team presentations (each team has 5 minutes)
7:25 PM — Sign-up sheets and networking
7:30 PM — End

What to Bring:
- Your JMU ID
- Questions about which team to join
- Enthusiasm!`,
  tags: ["fall kickoff", "fall 2025", "first meeting", "orientation", "september", "event"],
},
```

### Example: Adding a general note or policy

```js
{
  pk:      "note#workshop-schedule-fall-2025",
  type:    "note",
  title:   "Workshop Schedule — Fall 2025",
  summary: "Weekly technical workshops run every Thursday at 7 PM in Showker Hall, Room 109.",
  content: `MAIC Workshop Schedule — Fall 2025

Time: Thursdays, 7:00 PM – 8:30 PM
Location: Showker Hall, Room 109

Schedule:
Week 1 (Sep 4)  — Python Refresher and Environment Setup
Week 2 (Sep 11) — Intro to Machine Learning with scikit-learn
Week 3 (Sep 18) — Neural Networks from Scratch
Week 4 (Sep 25) — Fine-tuning LLMs with Hugging Face
Week 5 (Oct 2)  — Building AI APIs with FastAPI
...

Workshops are recorded and shared with members afterward via the MAIC Discord.`,
  tags: ["workshop", "schedule", "fall 2025", "thursday", "showker", "training"],
},
```

---

## Step 4 — Save the file

Save `scripts/seed-knowledge.js` after making your changes.

---

## Step 5 — Run the seed command

Open a terminal in the project folder and run:

```bash
AWS_REGION=us-east-1 node scripts/seed-knowledge.js
```

You should see output like:

```
Seeding 6 entries into maic-knowledge…
  Seeded: speaker#joe-holmes
  Seeded: speaker#yi-chen
  Seeded: speaker#jane-smith
  ...
Done. Knowledge base is ready.
```

The chatbot will immediately start using the new information — no redeployment needed.

---

## Updating an existing entry

Find the entry in `ENTRIES` by its `pk`, edit the fields you want to change, save, and re-run the seed command. Running the seed command always overwrites existing entries with the same `pk`, so it's safe to run multiple times.

## Removing an entry

Delete the entire `{ ... },` block for that entry from the `ENTRIES` array, then run:

```bash
AWS_REGION=us-east-1 node scripts/seed-knowledge.js --reset
```

The `--reset` flag clears the entire table first, then re-seeds from the current `ENTRIES` list.

> **Warning:** `--reset` deletes everything in the knowledge base before re-seeding. Make sure all the entries you want to keep are still in the `ENTRIES` array before running it.

---

## Tips for writing good entries

**Tags are the most important field for search.** Include:
- The person's full name and nickname variations
- The company or organization name
- Topic keywords (what the talk or event was *about*)
- Common ways someone might phrase a question about it

**The summary is what the chatbot reads first.** Keep it to 1-2 sentences that clearly answer "what is this about?" A good summary helps the chatbot decide whether to read the full content.

**Write content as if explaining to a student.** Use plain language, bullet points, and headers. The chatbot reads this verbatim and uses it to form its answer.

---

## Type reference

| Type | Use for |
|---|---|
| `speaker` | Guest speaker talks — notes, key points, Q&A |
| `event` | Club events — schedule, location, what to expect |
| `note` | Policies, FAQs, how-to guides, announcements |
| `topic` | Deep-dives on AI topics, team descriptions, resources |
