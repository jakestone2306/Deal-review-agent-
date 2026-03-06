const express = require("express");
const fetch   = require("node-fetch");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json({ limit: "10mb" }));

const {
  FATHOM_API_KEY, FATHOM_WEBHOOK_SECRET, ANTHROPIC_API_KEY,
  HUBSPOT_ACCESS_TOKEN, SLACK_BOT_TOKEN,
  GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
  PORT = 3000,
} = process.env;

const OWNERS = {
  "jacob.bolton@adaptinsurance.com": { name: "Jacob Bolton",  slackId: "U07R34DT45S", hubspotOwnerId: "300195503" },
  "jake@adaptinsurance.com":         { name: "Jake Stone",    slackId: "U08357HEYJF", hubspotOwnerId: "170827178" },
  "brandon@adaptinsurance.com":      { name: "Brandon Perez", slackId: null,           hubspotOwnerId: "88178787"  },
  "octavio@adaptinsurance.com":      { name: "Octavio Pala",  slackId: null,           hubspotOwnerId: "85012029"  },
  "jacob.simon@adaptinsurance.com":  { name: "Jacob Simon",   slackId: null,           hubspotOwnerId: "299068163" },
  "mike@adaptinsurance.com":         { name: "Mike Nelson",   slackId: null,           hubspotOwnerId: "5742259"   },
};

const MANAGER_EMAIL        = "jake@adaptinsurance.com";
const MANAGER_SLACK        = "U08357HEYJF";
const HUBSPOT_PORTAL       = "23695809";
const DEMO_SCORING_CHANNEL = "C0AJQ2Y7SDR"; // #demo-scoring

// ─── TRAINING DATA ────────────────────────────────────────────────────────────
const TRAINING_FILE = "/tmp/adapt_training_examples.json";
const REVIEWS_FILE  = "/tmp/adapt_reviews.json";

function loadTrainingData() {
  try { return fs.existsSync(TRAINING_FILE) ? JSON.parse(fs.readFileSync(TRAINING_FILE, "utf8")) : { examples: [] }; }
  catch (e) { return { examples: [] }; }
}
function saveTrainingData(data) {
  try { fs.writeFileSync(TRAINING_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}
function loadReviews() {
  try { return fs.existsSync(REVIEWS_FILE) ? JSON.parse(fs.readFileSync(REVIEWS_FILE, "utf8")) : {}; }
  catch (e) { return {}; }
}
function saveReviews(data) {
  try { fs.writeFileSync(REVIEWS_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

// ─── DYNAMIC SCORING PROMPT ───────────────────────────────────────────────────
const BASE_PROMPT = `You are an expert sales call coach for Adapt Insurance, a B2B SaaS that automates carrier portal data into agency management systems (Epic, HawkSoft, AMS360).

Evaluate this RAW TRANSCRIPT against 7 criteria. Score based on actual words spoken — cite timestamps or direct quotes.

Criteria (score 1-10, pass = >=7):
1. Discovery & Context Gathering: Did rep ask about AMS, workflow tools, specific carriers, book size, P&C split, staffing?
2. Tailored Demo: Was demo customized to their pain points? Specific carriers referenced? Pending cancel tracker shown?
3. Value Articulation: 98-99% match rate mentioned? Multi-channel delivery? Pending cancel tracker? Time/cost savings connected?
4. Pricing Discussion: $10/login, $0.11/notification, $0.85/doc explained? Cost estimate given? Notifications-first pilot positioned?
5. Objection Handling & Trust: MFA addressed proactively? 7-day lookback mentioned? Peer agency social proof? Carrier error process explained?
6. Next Steps & Close: Concrete next step scheduled? Kyleen introduced by name? Follow-up email committed? Point person confirmed?
7. Rapport & Communication: Rep listened more than talked? Consultative tone? Checked understanding? Natural rapport?

Return ONLY valid JSON (no markdown):
{"overall_score":X.X,"criteria":[{"name":"Discovery & Context Gathering","score":X,"feedback":"cite evidence","passed":true},{"name":"Tailored Demo","score":X,"feedback":"cite evidence","passed":true},{"name":"Value Articulation","score":X,"feedback":"cite evidence","passed":true},{"name":"Pricing Discussion","score":X,"feedback":"cite evidence","passed":true},{"name":"Objection Handling & Trust","score":X,"feedback":"cite evidence","passed":true},{"name":"Next Steps & Close","score":X,"feedback":"cite evidence","passed":true},{"name":"Rapport & Communication","score":X,"feedback":"cite evidence","passed":true}],"summary":"3-4 sentence summary","top_strengths":["strength 1","strength 2","strength 3"],"action_items":["coaching action 1","coaching action 2","coaching action 3"]}`;

function buildScoringPrompt() {
  const { examples = [] } = loadTrainingData();
  if (!examples.length) return BASE_PROMPT;

  const good = examples.filter(e => e.rating === "good").slice(-5);
  const bad  = examples.filter(e => e.rating === "bad").slice(-5);
  let section = "\n\n─── TRAINING EXAMPLES FROM REAL REVIEWED CALLS ───\nUse these to calibrate your scoring:\n";

  if (good.length) {
    section += "\n✅ STRONG CALLS — score similar patterns highly:\n";
    good.forEach((ex, i) => {
      section += `\n${i+1}. ${ex.prospect} (${ex.repName}, ${ex.score}/10): ${ex.summary}\n`;
      if (ex.highlights?.length) section += `   Strengths: ${ex.highlights.join(" | ")}\n`;
      if (ex.notes) section += `   Manager notes: ${ex.notes}\n`;
    });
  }
  if (bad.length) {
    section += "\n⚠️ CALLS NEEDING IMPROVEMENT — flag similar patterns:\n";
    bad.forEach((ex, i) => {
      section += `\n${i+1}. ${ex.prospect} (${ex.repName}, ${ex.score}/10): ${ex.summary}\n`;
      if (ex.weaknesses?.length) section += `   Issues: ${ex.weaknesses.join(" | ")}\n`;
      if (ex.notes) section += `   Manager notes: ${ex.notes}\n`;
    });
  }
  return BASE_PROMPT + section;
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
const log = (msg, data = "") => console.log(`[${new Date().toISOString()}] ${msg}`, data || "");
const fmtDate = iso => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function verifyFathomSignature(req) {
  if (!FATHOM_WEBHOOK_SECRET) return true;
  const sig = req.headers["x-fathom-signature"] || req.headers["x-webhook-signature"] || "";
  const secret = FATHOM_WEBHOOK_SECRET.replace("whsec_", "");
  const expected = crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(JSON.stringify(req.body)).digest("hex");
  return sig === `sha256=${expected}` || sig === expected;
}

// ─── FETCH TRANSCRIPT ─────────────────────────────────────────────────────────
async function fetchTranscript(recordingId) {
  log(`Fetching transcript for recording ${recordingId}`);
  const res = await fetch(`https://api.fathom.ai/external/v1/recordings/${recordingId}/transcript`, { headers: { "X-Api-Key": FATHOM_API_KEY } });
  if (!res.ok) throw new Error(`Fathom transcript API ${res.status}: ${await res.text()}`);
  const lines = (await res.json()).transcript || [];
  const text = lines.map(l => `[${l.timestamp}] ${l.speaker?.display_name || "Unknown"}: ${l.text}`).join("\n");
  return { text: text.length > 42000 ? text.slice(0, 42000) + "\n[capped]" : text, lines: lines.length };
}

// ─── SCORE WITH CLAUDE ────────────────────────────────────────────────────────
async function scoreTranscript(call, transcript) {
  const prompt = buildScoringPrompt();
  const count = loadTrainingData().examples?.length || 0;
  log(`Scoring ${call.prospect} — ${count} training example(s) in prompt`);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 2000, system: prompt,
      messages: [{ role: "user", content: `Rep: ${call.repName}\nProspect: ${call.prospect}\nDate: ${fmtDate(call.created_at)}\n\nRAW TRANSCRIPT:\n${transcript.text}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const raw = (await res.json()).content?.filter(b => b.type === "text").map(b => b.text).join("").trim();
  const clean = raw.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s === -1) throw new Error(`No JSON: ${raw.slice(0, 100)}`);
  return JSON.parse(clean.slice(s, e + 1));
}

// ─── HUBSPOT NOTE ─────────────────────────────────────────────────────────────
async function postHubspotNote(call, result) {
  const owner = OWNERS[call.repEmail] || {};
  const e = s => s >= 8.5 ? "🟢" : s >= 7 ? "🟡" : s >= 5 ? "🟠" : "🔴";
  const body = `<h3>⚡ Adapt Demo AI Review — ${result.overall_score}/10 ${e(result.overall_score)}</h3><p><strong>Rep:</strong> ${call.repName} | <strong>Date:</strong> ${fmtDate(call.created_at)} | <strong>Source:</strong> Raw transcript (${call.transcriptLines} lines)</p><p>${result.summary}</p><h4>Scorecard</h4><ul>${result.criteria.map(c => `<li>${e(c.score)} <strong>${c.name}:</strong> ${c.score}/10 — ${c.feedback}</li>`).join("")}</ul><h4>✅ Strengths</h4><ul>${result.top_strengths.map(s => `<li>${s}</li>`).join("")}</ul><h4>🎯 Coaching</h4><ol>${result.action_items.map(a => `<li>${a}</li>`).join("")}</ol><p><em>Auto-generated by Adapt Demo Review Server</em></p>`;
  const r = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` },
    body: JSON.stringify({ properties: { hs_note_body: body, hubspot_owner_id: owner.hubspotOwnerId || "300195503", hs_timestamp: new Date().toISOString() } }),
  });
  if (!r.ok) throw new Error(`HubSpot: ${await r.text()}`);
  const noteId = (await r.json()).id;
  log(`HubSpot note: ${noteId}`);
  if (call.dealId) await fetch(`https://api.hubapi.com/crm/v3/objects/notes/${noteId}/associations/deals/${call.dealId}/note_to_deal`, { method: "PUT", headers: { "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` } }).catch(() => {});
  if (call.contactId) await fetch(`https://api.hubapi.com/crm/v3/objects/notes/${noteId}/associations/contacts/${call.contactId}/note_to_contact`, { method: "PUT", headers: { "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` } }).catch(() => {});
  return noteId;
}

// ─── SLACK DM ─────────────────────────────────────────────────────────────────
async function sendSlackDM(call, result) {
  const owner = OWNERS[call.repEmail] || {};
  const channel = owner.slackId || MANAGER_SLACK;
  const e = s => s >= 8.5 ? "🟢" : s >= 7 ? "🟡" : s >= 5 ? "🟠" : "🔴";
  const text = `*📊 Adapt Demo Review — ${call.prospect}*\nRep: ${call.repName} | Score: *${result.overall_score}/10* ${e(result.overall_score)} | ${call.transcriptLines} lines\n\n${result.criteria.map(c => `${e(c.score)} *${c.name}* \`${c.score}/10\``).join("\n")}\n\n*Summary:* ${result.summary}\n\n*✅ Strengths:*\n${result.top_strengths.map(s => `• ${s}`).join("\n")}\n\n*🎯 Coaching:*\n${result.action_items.map((a, i) => `${i+1}. ${a}`).join("\n")}\n\n_Add to training: \`curl -X POST https://deal-review-agent.onrender.com/feedback/${call.recording_id} -H "Content-Type: application/json" -d '{"rating":"good","notes":"your notes"}'\`_${call.dealId ? `\n<https://app.hubspot.com/contacts/${HUBSPOT_PORTAL}/record/0-3/${call.dealId}|View Deal>` : ""}`;
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, text }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`Slack: ${d.error}`);
  log(`Slack DM → ${owner.name || channel}`);

  // Also post to #demo-scoring channel
  const channelText = `*📊 Demo Review — ${call.prospect}* | Rep: ${call.repName} | Score: *${result.overall_score}/10* ${e(result.overall_score)}
${result.criteria.map(c => `${e(c.score)} ${c.name.split(" ")[0]}: ${c.score}/10`).join(" · ")}

*Summary:* ${result.summary}

*✅ Strengths:* ${result.top_strengths.join(" · ")}

*🎯 Coaching:* ${result.action_items.join(" · ")}

_<https://deal-review-agent.onrender.com/dashboard|View Dashboard> · Add to training from dashboard_`;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: DEMO_SCORING_CHANNEL, text: channelText }),
  }).then(r => r.json()).then(d => {
    if (d.ok) log(`Posted to #demo-scoring`);
    else log(`#demo-scoring error: ${d.error}`);
  }).catch(err => log(`#demo-scoring error: ${err.message}`));
}

// ─── EMAIL ────────────────────────────────────────────────────────────────────
async function sendManagerEmail(call, result) {
  if (!GMAIL_REFRESH_TOKEN) { log("Gmail not configured — skipping"); return; }
  const t = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET, refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token" }) });
  const { access_token } = await t.json();
  const e = s => s >= 8.5 ? "🟢" : s >= 7 ? "🟡" : s >= 5 ? "🟠" : "🔴";
  const body = `Adapt Demo Review: ${call.prospect}\nRep: ${call.repName} | Score: ${result.overall_score}/10 ${e(result.overall_score)}\n\n${result.summary}\n\nSCORECARD\n${result.criteria.map(c => `${e(c.score)} ${c.name}: ${c.score}/10 — ${c.feedback}`).join("\n")}\n\nSTRENGTHS\n${result.top_strengths.map(s => `• ${s}`).join("\n")}\n\nCOACHING\n${result.action_items.map((a,i) => `${i+1}. ${a}`).join("\n")}\n\nAdd to training:\ncurl -X POST https://deal-review-agent.onrender.com/feedback/${call.recording_id} -H "Content-Type: application/json" -d '{"rating":"good","notes":"your notes here"}'\n\nAuto-generated by Adapt Demo Review Server`;
  const email = [`To: ${MANAGER_EMAIL}`, `Subject: Adapt Demo Review: ${call.prospect} — ${result.overall_score}/10 (${call.repName})`, `Content-Type: text/plain; charset=utf-8`, `MIME-Version: 1.0`, ``, body].join("\n");
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${access_token}` }, body: JSON.stringify({ raw: Buffer.from(email).toString("base64url") }) });
  if (!r.ok) throw new Error(`Gmail: ${await r.text()}`);
  log(`Email → ${MANAGER_EMAIL}`);
}

// ─── PIPELINE ─────────────────────────────────────────────────────────────────
function identifyRep(invitees = []) {
  const adapt = invitees.filter(i => i.email?.includes("adaptinsurance.com"));
  return (adapt.find(i => i.email !== "jake@adaptinsurance.com") || adapt[0])?.email || "jacob.bolton@adaptinsurance.com";
}
function identifyProspect(invitees = [], title = "") {
  const ext = invitees.filter(i => !i.email?.includes("adaptinsurance.com"));
  if (ext.length) { const n = ext[0].name || ext[0].email?.split("@")[1]?.split(".")[0] || ""; return n.length > 2 ? n : title; }
  return title;
}

async function runReview(recordingId, meetingData = {}) {
  log(`\n${"─".repeat(60)}\nStarting review for recording ${recordingId}`);
  const repEmail = meetingData.repEmail || identifyRep(meetingData.calendar_invitees);
  const owner = OWNERS[repEmail] || { name: repEmail, slackId: null, hubspotOwnerId: "300195503" };
  const call = {
    recording_id: recordingId,
    created_at: meetingData.created_at || new Date().toISOString(),
    repEmail, repName: owner.name,
    prospect: meetingData.prospect || identifyProspect(meetingData.calendar_invitees, meetingData.title || "Unknown"),
    dealId: meetingData.dealId || null, contactId: meetingData.contactId || null, transcriptLines: 0,
  };
  log(`Call: ${call.prospect} — ${call.repName}`);
  const transcript = await fetchTranscript(recordingId);
  call.transcriptLines = transcript.lines;
  const result = await scoreTranscript(call, transcript);
  log(`Score: ${result.overall_score}/10`);

  // Save review summary for feedback lookup later
  const reviews = loadReviews();
  reviews[recordingId] = { recording_id: recordingId, prospect: call.prospect, repName: call.repName, repEmail: call.repEmail, score: result.overall_score, summary: result.summary, highlights: result.top_strengths, weaknesses: result.action_items, criteria: result.criteria, created_at: call.created_at, reviewed_at: new Date().toISOString() };
  saveReviews(reviews);

  const [hs, sl, em] = await Promise.allSettled([postHubspotNote(call, result), sendSlackDM(call, result), sendManagerEmail(call, result)]);
  const delivery = { hubspot: hs.status === "fulfilled" ? "done" : "error", slack: sl.status === "fulfilled" ? "done" : "error", email: em.status === "fulfilled" ? "done" : "error" };
  if (hs.status === "rejected") log(`HubSpot error: ${hs.reason}`);
  if (sl.status === "rejected") log(`Slack error: ${sl.reason}`);
  if (em.status === "rejected") log(`Email error: ${em.reason}`);
  log(`Done. HubSpot=${delivery.hubspot} Slack=${delivery.slack} Email=${delivery.email}`);
  return { call, result, delivery };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.post("/webhook/fathom", async (req, res) => {
  log("Webhook received", JSON.stringify(req.body).slice(0, 200));
  if (!verifyFathomSignature(req)) { log("Invalid signature — rejected"); return res.status(401).json({ error: "Invalid signature" }); }
  const meeting = req.body.data || req.body.meeting || req.body.recording || req.body;
  const title = (meeting.title || meeting.meeting_title || "").toLowerCase();
  if (!title.includes("adapt demo")) { log(`Skipping: "${meeting.title}"`); return res.json({ skipped: true }); }
  const recordingId = meeting.recording_id || meeting.id;
  if (!recordingId) return res.status(400).json({ error: "No recording_id" });
  res.json({ received: true, recording_id: recordingId });
  runReview(recordingId, { created_at: meeting.created_at, title: meeting.title, calendar_invitees: meeting.calendar_invitees || [] }).catch(err => log(`Pipeline error: ${err.message}`));
});

app.post("/review/:recordingId", async (req, res) => {
  log(`Manual review: ${req.params.recordingId}`);
  try {
    const out = await runReview(parseInt(req.params.recordingId), req.body);
    res.json({ success: true, score: out.result.overall_score, delivery: out.delivery });
  } catch (err) { log(`Error: ${err.message}`); res.status(500).json({ error: err.message }); }
});

// ─── FEEDBACK ROUTES ──────────────────────────────────────────────────────────
app.post("/feedback/:recordingId", (req, res) => {
  const { rating, notes, highlights, weaknesses } = req.body;
  if (!rating || !["good", "bad"].includes(rating)) return res.status(400).json({ error: 'rating must be "good" or "bad"' });
  const reviews = loadReviews();
  const review = reviews[req.params.recordingId];
  if (!review) return res.status(404).json({ error: `No review found for recording ${req.params.recordingId}` });
  const example = {
    recording_id: parseInt(req.params.recordingId), rating,
    prospect: review.prospect, repName: review.repName, score: review.score,
    summary: review.summary, highlights: highlights || review.highlights || [],
    weaknesses: weaknesses || review.weaknesses || [], notes: notes || "",
    added_at: new Date().toISOString(),
  };
  const training = loadTrainingData();
  training.examples = (training.examples || []).filter(e => e.recording_id !== parseInt(req.params.recordingId));
  training.examples.push(example);
  saveTrainingData(training);
  log(`Training example added: ${review.prospect} (${rating}) — ${training.examples.length} total`);
  res.json({ success: true, message: `${review.prospect} added as "${rating}" example. ${training.examples.length} total training example(s) now active.`, example });
});

app.get("/feedback", (req, res) => {
  const { examples = [] } = loadTrainingData();
  res.json({ total: examples.length, good: examples.filter(e => e.rating === "good").length, bad: examples.filter(e => e.rating === "bad").length, examples: examples.map(e => ({ recording_id: e.recording_id, prospect: e.prospect, repName: e.repName, score: e.score, rating: e.rating, notes: e.notes, added_at: e.added_at })) });
});

app.delete("/feedback/:recordingId", (req, res) => {
  const id = parseInt(req.params.recordingId);
  const training = loadTrainingData();
  const before = training.examples.length;
  training.examples = training.examples.filter(e => e.recording_id !== id);
  saveTrainingData(training);
  res.json({ success: true, removed: before - training.examples.length, remaining: training.examples.length });
});

app.get("/reviews", (req, res) => {
  res.json(Object.values(loadReviews()).sort((a, b) => new Date(b.reviewed_at) - new Date(a.reviewed_at)));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Adapt Demo Review Server", configured: { fathom: !!FATHOM_API_KEY, anthropic: !!ANTHROPIC_API_KEY, hubspot: !!HUBSPOT_ACCESS_TOKEN, slack: !!SLACK_BOT_TOKEN, gmail: !!GMAIL_REFRESH_TOKEN }, training_examples: loadTrainingData().examples?.length || 0, uptime: Math.round(process.uptime()) + "s" });
});

app.listen(PORT, () => {
  log(`Adapt Demo Review Server on port ${PORT}`);
  log(`POST /webhook/fathom | POST /review/:id | POST /feedback/:id | GET /feedback | GET /reviews | GET /health`);
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  const reviews  = Object.values(loadReviews()).sort((a, b) => new Date(b.reviewed_at) - new Date(a.reviewed_at));
  const training = loadTrainingData();
  const examples = training.examples || [];
  const trainingIds = new Set(examples.map(e => String(e.recording_id)));

  const scoreColor = s => s >= 8.5 ? "#22c55e" : s >= 7 ? "#eab308" : s >= 5 ? "#f97316" : "#ef4444";
  const scoreEmoji = s => s >= 8.5 ? "🟢" : s >= 7 ? "🟡" : s >= 5 ? "🟠" : "🔴";
  const fmtD = iso => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const reviewCards = reviews.map(r => {
    const trainingEx = examples.find(e => String(e.recording_id) === String(r.recording_id));
    const inTraining = !!trainingEx;
    const rating = trainingEx?.rating;
    return `<div class="card">
      <div class="card-header">
        <div><div class="prospect">${r.prospect}</div><div class="meta">${r.repName} &middot; ${fmtD(r.reviewed_at)}</div></div>
        <div class="score" style="color:${scoreColor(r.score)}">${r.score}/10 ${scoreEmoji(r.score)}</div>
      </div>
      <div class="summary">${r.summary}</div>
      <div class="criteria-grid">${(r.criteria||[]).map(c=>`<div class="criterion ${c.passed?"pass":"fail"}">${c.name.split(" ")[0]}: ${c.score}/10</div>`).join("")}</div>
      <div id="fb-${r.recording_id}">
        ${inTraining ? `
          <div class="training-badge ${rating}">${rating==="good"?"✅ Good Example":"⚠️ Needs Work"} &middot; In training data</div>
          ${trainingEx?.notes?`<div class="training-notes">"${trainingEx.notes}"</div>`:""}
          <button class="btn btn-remove" onclick="removeFeedback(${r.recording_id})">Remove from training</button>
        ` : `
          <textarea id="notes-${r.recording_id}" placeholder="Coaching notes (optional)" rows="2"></textarea>
          <div class="btn-row">
            <button class="btn btn-good" onclick="addFeedback(${r.recording_id},'good')">👍 Good Example</button>
            <button class="btn btn-bad" onclick="addFeedback(${r.recording_id},'bad')">👎 Needs Work</button>
          </div>
        `}
      </div>
    </div>`;
  }).join("");

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Adapt Demo Review Dashboard</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.header{background:#1e293b;border-bottom:1px solid #334155;padding:20px 32px;display:flex;align-items:center;justify-content:space-between}
.header h1{font-size:20px;font-weight:700;color:#f8fafc}.header h1 span{color:#6366f1}
.stats{display:flex;gap:24px}.stat{text-align:center}.stat-num{font-size:22px;font-weight:700;color:#6366f1}.stat-label{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
.container{max-width:900px;margin:0 auto;padding:28px 24px}
.section-title{font-size:13px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:16px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px;margin-bottom:16px;transition:border-color .2s}.card:hover{border-color:#475569}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
.prospect{font-size:16px;font-weight:600;color:#f1f5f9}.meta{font-size:13px;color:#64748b;margin-top:2px}
.score{font-size:22px;font-weight:700;white-space:nowrap}
.summary{font-size:13px;color:#94a3b8;line-height:1.6;margin-bottom:14px}
.criteria-grid{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
.criterion{font-size:11px;padding:3px 8px;border-radius:4px;font-weight:500}
.criterion.pass{background:#14532d;color:#86efac}.criterion.fail{background:#450a0a;color:#fca5a5}
textarea{width:100%;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 12px;color:#e2e8f0;font-size:13px;resize:vertical;outline:none;font-family:inherit;margin-bottom:10px}
textarea:focus{border-color:#6366f1}
.btn-row{display:flex;gap:10px}
.btn{border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}.btn:hover{opacity:.85}
.btn-good{background:#166534;color:#bbf7d0}.btn-bad{background:#7f1d1d;color:#fecaca}
.btn-remove{background:#1e293b;border:1px solid #475569;color:#94a3b8;padding:6px 12px;font-size:12px;border-radius:6px;cursor:pointer;margin-top:8px;display:block}.btn-remove:hover{border-color:#ef4444;color:#ef4444}
.training-badge{display:inline-block;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600;margin-bottom:6px}
.training-badge.good{background:#14532d;color:#86efac}.training-badge.bad{background:#450a0a;color:#fca5a5}
.training-notes{font-size:12px;color:#64748b;font-style:italic;margin-bottom:6px}
.top-bar{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:14px 20px;margin-bottom:24px;display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.t-stat{font-size:13px;color:#94a3b8}.t-stat strong{color:#e2e8f0}
.refresh-btn{margin-left:auto;background:#334155;color:#94a3b8;border:none;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer}.refresh-btn:hover{background:#475569;color:#e2e8f0}
.toast{position:fixed;bottom:24px;right:24px;background:#6366f1;color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;font-weight:500;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999}.toast.show{opacity:1}
.empty{text-align:center;color:#475569;padding:60px 20px;font-size:15px}
</style></head><body>
<div class="header">
  <h1>Adapt Demo <span>Review Dashboard</span></h1>
  <div class="stats">
    <div class="stat"><div class="stat-num">${reviews.length}</div><div class="stat-label">Reviewed</div></div>
    <div class="stat"><div class="stat-num">${reviews.length?(reviews.reduce((s,r)=>s+r.score,0)/reviews.length).toFixed(1):"—"}</div><div class="stat-label">Avg Score</div></div>
    <div class="stat"><div class="stat-num">${examples.length}</div><div class="stat-label">Training</div></div>
  </div>
</div>
<div class="container">
  <div class="top-bar">
    <div class="t-stat">Training library: <strong>${examples.filter(e=>e.rating==="good").length} good</strong> &middot; <strong>${examples.filter(e=>e.rating==="bad").length} needs work</strong></div>
    <div class="t-stat" style="color:#64748b;font-size:12px">Every future call is scored against these examples</div>
    <button class="refresh-btn" onclick="location.reload()">&#8635; Refresh</button>
  </div>
  <div class="section-title">Recent Calls (${reviews.length})</div>
  ${reviews.length ? reviewCards : '<div class="empty">No reviewed calls yet. They will appear here automatically after each Adapt Demo.</div>'}
</div>
<div class="toast" id="toast"></div>
<script>
function showToast(msg){const t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),3000)}
async function addFeedback(id,rating){
  const notes=document.getElementById("notes-"+id)?.value||"";
  const res=await fetch("/feedback/"+id,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rating,notes})});
  const d=await res.json();
  if(d.success){showToast(rating==="good"?"✅ Added as good example!":"⚠️ Added as needs work!");setTimeout(()=>location.reload(),1200)}
  else showToast("Error: "+(d.error||"Unknown"));
}
async function removeFeedback(id){
  const res=await fetch("/feedback/"+id,{method:"DELETE"});
  const d=await res.json();
  if(d.success){showToast("Removed from training data");setTimeout(()=>location.reload(),1200)}
}
</script>
</body></html>`);
});

// ─── DAILY DIGEST ─────────────────────────────────────────────────────────────
// Sends a summary DM to Jake at 6:00 PM PT (02:00 UTC) every day
async function sendDailyDigest() {
  const reviews = Object.values(loadReviews());

  // Get calls reviewed today (PT timezone — UTC-7 or UTC-8 depending on DST)
  const now = new Date();
  const ptOffset = -8; // PST; will be -7 during PDT — close enough for daily digest
  const ptMidnight = new Date(now);
  ptMidnight.setUTCHours(-ptOffset, 0, 0, 0); // midnight PT in UTC

  const todayReviews = reviews.filter(r => new Date(r.reviewed_at) >= ptMidnight);

  if (todayReviews.length === 0) {
    log("Daily digest: no calls reviewed today — skipping");
    return;
  }

  const e = s => s >= 8.5 ? "🟢" : s >= 7 ? "🟡" : s >= 5 ? "🟠" : "🔴";
  const avg = (todayReviews.reduce((s, r) => s + r.score, 0) / todayReviews.length).toFixed(1);
  const passing = todayReviews.filter(r => r.score >= 7).length;

  // Group by rep
  const byRep = {};
  todayReviews.forEach(r => {
    if (!byRep[r.repName]) byRep[r.repName] = [];
    byRep[r.repName].push(r);
  });

  // Collect all action items across today's calls, find most common themes
  const allActions = todayReviews.flatMap(r => r.weaknesses || []);

  // Build rep breakdown
  const repLines = Object.entries(byRep).map(([rep, calls]) => {
    const repAvg = (calls.reduce((s, r) => s + r.score, 0) / calls.length).toFixed(1);
    const callList = calls.map(c => `  ${e(c.score)} ${c.prospect}: ${c.score}/10`).join("\n");
    return `*${rep}* — avg ${repAvg}/10 (${calls.length} call${calls.length > 1 ? "s" : ""})\n${callList}`;
  }).join("\n\n");

  // Top coaching themes (deduplicated, max 5)
  const coachingThemes = [...new Set(allActions)].slice(0, 5);

  const text = `*📋 Daily Demo Digest — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/Los_Angeles" })}*

*${todayReviews.length} demo${todayReviews.length > 1 ? "s" : ""} reviewed today* | Avg score: *${avg}/10* | ${passing}/${todayReviews.length} passing ${e(parseFloat(avg))}

${repLines}

${coachingThemes.length ? `*🎯 Key Coaching Focus Areas Today:*\n${coachingThemes.map((a, i) => `${i + 1}. ${a}`).join("\n")}` : ""}

_<https://deal-review-agent.onrender.com/dashboard|View Dashboard & Add Training Examples>_`;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: MANAGER_SLACK, text }),
  });
  const data = await res.json();
  if (data.ok) log(`Daily digest sent to Jake — ${todayReviews.length} calls`);
  else log(`Daily digest Slack error: ${data.error}`);
}

// Check every minute if it's time to send the digest (02:00 UTC = 6:00 PM PT)
function startDailyDigestScheduler() {
  let lastDigestDate = "";
  setInterval(() => {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const today = now.toISOString().slice(0, 10);
    if (utcH === 2 && utcM === 0 && lastDigestDate !== today) {
      lastDigestDate = today;
      log("Sending daily digest...");
      sendDailyDigest().catch(err => log(`Daily digest error: ${err.message}`));
    }
  }, 60 * 1000); // check every minute
  log("Daily digest scheduler started — fires at 6:00 PM PT");
}

// Manual trigger for testing
app.post("/digest", async (req, res) => {
  log("Manual digest triggered");
  try {
    await sendDailyDigest();
    res.json({ success: true, message: "Digest sent" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start the scheduler when server boots
startDailyDigestScheduler();
