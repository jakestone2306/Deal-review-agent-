const express = require("express");
const fetch   = require("node-fetch");
const crypto  = require("crypto");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ─── CONFIG (set these as environment variables in Render) ────────────────────
const {
  FATHOM_API_KEY,        // Fathom API key
  FATHOM_WEBHOOK_SECRET, // Fathom webhook signing secret (whsec_...)
  ANTHROPIC_API_KEY,     // Anthropic API key
  HUBSPOT_ACCESS_TOKEN,  // HubSpot private app token
  SLACK_BOT_TOKEN,       // Slack bot token
  GMAIL_REFRESH_TOKEN,   // Gmail OAuth refresh token  (optional - see README)
  GMAIL_CLIENT_ID,       // Gmail OAuth client ID      (optional)
  GMAIL_CLIENT_SECRET,   // Gmail OAuth client secret  (optional)
  PORT = 3000,
} = process.env;

// ─── OWNER MAP ────────────────────────────────────────────────────────────────
const OWNERS = {
  "jacob.bolton@adaptinsurance.com": { name: "Jacob Bolton",  slackId: "U07R34DT45S", hubspotOwnerId: "300195503" },
  "jake@adaptinsurance.com":         { name: "Jake Stone",    slackId: "U08357HEYJF", hubspotOwnerId: "170827178" },
  "brandon@adaptinsurance.com":      { name: "Brandon Perez", slackId: null,           hubspotOwnerId: "88178787"  },
  "octavio@adaptinsurance.com":      { name: "Octavio Pala",  slackId: null,           hubspotOwnerId: "85012029"  },
  "jacob.simon@adaptinsurance.com":  { name: "Jacob Simon",   slackId: null,           hubspotOwnerId: "299068163" },
  "mike@adaptinsurance.com":         { name: "Mike Nelson",   slackId: null,           hubspotOwnerId: "5742259"   },
};

const MANAGER_EMAIL = "jake@adaptinsurance.com";
const MANAGER_SLACK = "U08357HEYJF";
const HUBSPOT_PORTAL = "23695809";

// ─── SCORING PROMPT ───────────────────────────────────────────────────────────
const SCORING_SYSTEM = `You are an expert sales call coach for Adapt Insurance, a B2B SaaS that automates carrier portal data into agency management systems (Epic, HawkSoft, AMS360).

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

// ─── UTILS ────────────────────────────────────────────────────────────────────
const log = (msg, data = "") => console.log(`[${new Date().toISOString()}] ${msg}`, data || "");
const fmtDate = iso => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// ─── VERIFY FATHOM WEBHOOK SIGNATURE ─────────────────────────────────────────
function verifyFathomSignature(req) {
  if (!FATHOM_WEBHOOK_SECRET) return true; // skip verification if no secret configured
  const sig = req.headers["x-fathom-signature"] || req.headers["x-webhook-signature"] || "";
  const payload = JSON.stringify(req.body);
  const secret = FATHOM_WEBHOOK_SECRET.replace("whsec_", "");
  const expected = crypto
    .createHmac("sha256", Buffer.from(secret, "base64"))
    .update(payload)
    .digest("hex");
  return sig === `sha256=${expected}` || sig === expected;
}

// ─── STEP 1: FETCH TRANSCRIPT FROM FATHOM ────────────────────────────────────
async function fetchTranscript(recordingId) {
  log(`Fetching transcript for recording ${recordingId}`);
  const res = await fetch(
    `https://api.fathom.ai/external/v1/recordings/${recordingId}/transcript`,
    { headers: { "X-Api-Key": FATHOM_API_KEY } }
  );
  if (!res.ok) throw new Error(`Fathom transcript API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const lines = data.transcript || [];
  const text = lines
    .map(l => `[${l.timestamp}] ${l.speaker?.display_name || "Unknown"}: ${l.text}`)
    .join("\n");
  // Cap at 42k chars — covers ~50-55 min of dialogue, plenty for scoring
  return {
    text: text.length > 42000 ? text.slice(0, 42000) + "\n[transcript capped]" : text,
    lines: lines.length,
  };
}

// ─── STEP 2: SCORE WITH CLAUDE ────────────────────────────────────────────────
async function scoreTranscript(call, transcript) {
  log(`Scoring call for ${call.prospect} (${transcript.lines} lines)`);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: SCORING_SYSTEM,
      messages: [{
        role: "user",
        content: `Rep: ${call.repName}\nProspect: ${call.prospect}\nDate: ${fmtDate(call.created_at)}\n\nRAW TRANSCRIPT:\n${transcript.text}`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.content?.filter(b => b.type === "text").map(b => b.text).join("").trim();
  const clean = raw.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
  if (start === -1) throw new Error(`No JSON in Claude response: ${raw.slice(0, 200)}`);
  return JSON.parse(clean.slice(start, end + 1));
}

// ─── STEP 3a: POST HUBSPOT NOTE ───────────────────────────────────────────────
async function postHubspotNote(call, result) {
  const owner = OWNERS[call.repEmail] || {};
  const ownerId = owner.hubspotOwnerId || "300195503";
  const e = s => s >= 8.5 ? "🟢" : s >= 7 ? "🟡" : s >= 5 ? "🟠" : "🔴";

  const noteBody = `<h3>⚡ Adapt Demo AI Review — ${result.overall_score}/10 ${e(result.overall_score)}</h3>
<p><strong>Rep:</strong> ${call.repName} | <strong>Date:</strong> ${fmtDate(call.created_at)} | <strong>Source:</strong> Raw Fathom transcript (${call.transcriptLines} lines)</p>
<p>${result.summary}</p>
<h4>Scorecard</h4>
<ul>${result.criteria.map(c => `<li>${e(c.score)} <strong>${c.name}:</strong> ${c.score}/10 — ${c.feedback}</li>`).join("")}</ul>
<h4>✅ Top Strengths</h4>
<ul>${result.top_strengths.map(s => `<li>${s}</li>`).join("")}</ul>
<h4>🎯 Coaching Actions</h4>
<ol>${result.action_items.map(a => `<li>${a}</li>`).join("")}</ol>
<p><em>Auto-generated by Adapt Demo Review Server</em></p>`;

  // Create note
  const noteRes = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      properties: {
        hs_note_body: noteBody,
        hubspot_owner_id: ownerId,
        hs_timestamp: new Date().toISOString(),
      },
    }),
  });
  if (!noteRes.ok) {
    const err = await noteRes.text();
    throw new Error(`HubSpot note creation failed: ${err}`);
  }
  const note = await noteRes.json();
  const noteId = note.id;
  log(`HubSpot note created: ${noteId}`);

  // Associate with deal if available
  if (call.dealId) {
    await fetch(`https://api.hubapi.com/crm/v3/objects/notes/${noteId}/associations/deals/${call.dealId}/note_to_deal`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` },
    }).catch(e => log(`Note→deal association failed: ${e.message}`));
  }

  // Associate with contact if available
  if (call.contactId) {
    await fetch(`https://api.hubapi.com/crm/v3/objects/notes/${noteId}/associations/contacts/${call.contactId}/note_to_contact`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${HUBSPOT_ACCESS_TOKEN}` },
    }).catch(e => log(`Note→contact association failed: ${e.message}`));
  }

  return noteId;
}

// ─── STEP 3b: SEND SLACK DM ───────────────────────────────────────────────────
async function sendSlackDM(call, result) {
  const owner = OWNERS[call.repEmail] || {};
  const channel = owner.slackId || MANAGER_SLACK;
  const e = s => s >= 8.5 ? "🟢" : s >= 7 ? "🟡" : s >= 5 ? "🟠" : "🔴";

  const text = `*📊 Adapt Demo Review — ${call.prospect}*
Rep: ${call.repName} | Date: ${fmtDate(call.created_at)} | Score: *${result.overall_score}/10* ${e(result.overall_score)}
_Scored from raw Fathom transcript (${call.transcriptLines} lines)_

${result.criteria.map(c => `${e(c.score)} *${c.name}* \`${c.score}/10\``).join("\n")}

*Summary:* ${result.summary}

*✅ Top Strengths:*
${result.top_strengths.map(s => `• ${s}`).join("\n")}

*🎯 Coaching Actions:*
${result.action_items.map((a, i) => `${i + 1}. ${a}`).join("\n")}
${call.dealId ? `\n<https://app.hubspot.com/contacts/${HUBSPOT_PORTAL}/record/0-3/${call.dealId}|View Deal in HubSpot>` : ""}`;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  log(`Slack DM sent to ${channel} (${owner.name || "manager"})`);
}

// ─── STEP 3c: SEND MANAGER EMAIL via Gmail API ────────────────────────────────
async function sendManagerEmail(call, result) {
  if (!GMAIL_REFRESH_TOKEN || !GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
    log("Gmail not configured — skipping email");
    return;
  }

  // Refresh access token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const { access_token } = await tokenRes.json();

  const e = s => s >= 8.5 ? "🟢" : s >= 7 ? "🟡" : s >= 5 ? "🟠" : "🔴";
  const subject = `Adapt Demo Review: ${call.prospect} — ${result.overall_score}/10 (${call.repName})`;
  const body = `Adapt Demo Review: ${call.prospect}

Rep: ${call.repName} | Date: ${fmtDate(call.created_at)} | Score: ${result.overall_score}/10 ${e(result.overall_score)}
Source: Raw Fathom transcript (${call.transcriptLines} lines)

SUMMARY
${result.summary}

SCORECARD
${result.criteria.map(c => `${e(c.score)} ${c.name}: ${c.score}/10\n   ${c.feedback}`).join("\n\n")}

TOP STRENGTHS
${result.top_strengths.map(s => `• ${s}`).join("\n")}

COACHING ACTIONS
${result.action_items.map((a, i) => `${i + 1}. ${a}`).join("\n")}
${call.dealId ? `\nView Deal: https://app.hubspot.com/contacts/${HUBSPOT_PORTAL}/record/0-3/${call.dealId}` : ""}

Auto-generated by Adapt Demo Review Server`;

  const email = [
    `To: ${MANAGER_EMAIL}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    body,
  ].join("\n");

  const encoded = Buffer.from(email).toString("base64url");

  const gmailRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${access_token}`,
    },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!gmailRes.ok) throw new Error(`Gmail send failed: ${await gmailRes.text()}`);
  log(`Email sent to ${MANAGER_EMAIL}`);
}

// ─── IDENTIFY REP from meeting invitees ───────────────────────────────────────
function identifyRep(invitees = []) {
  const adaptInvitees = invitees.filter(i => i.email?.includes("adaptinsurance.com"));
  // Prefer the rep (not jake/manager if someone else is also on the call)
  const rep = adaptInvitees.find(i => i.email !== "jake@adaptinsurance.com") || adaptInvitees[0];
  return rep?.email || "jacob.bolton@adaptinsurance.com";
}

function identifyProspect(invitees = [], title = "") {
  const external = invitees.filter(i => !i.email?.includes("adaptinsurance.com"));
  if (external.length) {
    const domain = external[0].email?.split("@")[1] || "";
    // Try to get company name from domain (e.g. highstreetins.com → Highstreet Insurance)
    const name = external[0].name || domain.split(".")[0];
    return name.length > 2 ? name : title;
  }
  return title;
}

// ─── MAIN REVIEW PIPELINE ─────────────────────────────────────────────────────
async function runReview(recordingId, meetingData = {}) {
  log(`\n${"─".repeat(60)}`);
  log(`Starting review pipeline for recording ${recordingId}`);

  const repEmail = meetingData.repEmail || identifyRep(meetingData.calendar_invitees);
  const owner = OWNERS[repEmail] || { name: repEmail, slackId: null, hubspotOwnerId: "300195503" };
  const call = {
    recording_id: recordingId,
    created_at: meetingData.created_at || new Date().toISOString(),
    repEmail,
    repName: owner.name,
    prospect: meetingData.prospect || identifyProspect(meetingData.calendar_invitees, meetingData.title || "Unknown"),
    dealId: meetingData.dealId || null,
    contactId: meetingData.contactId || null,
    transcriptLines: 0,
  };

  log(`Call: ${call.prospect} — Rep: ${call.repName}`);

  // 1. Fetch transcript
  const transcript = await fetchTranscript(recordingId);
  call.transcriptLines = transcript.lines;
  log(`Transcript: ${transcript.lines} lines, ${transcript.text.length} chars`);

  // 2. Score
  const result = await scoreTranscript(call, transcript);
  log(`Score: ${result.overall_score}/10`);

  // 3. Deliver in parallel
  const [hubspotResult, slackResult, emailResult] = await Promise.allSettled([
    postHubspotNote(call, result),
    sendSlackDM(call, result),
    sendManagerEmail(call, result),
  ]);

  const delivery = {
    hubspot: hubspotResult.status === "fulfilled" ? "done" : "error",
    slack:   slackResult.status === "fulfilled"   ? "done" : "error",
    email:   emailResult.status === "fulfilled"   ? "done" : "error",
  };

  if (hubspotResult.status === "rejected") log(`HubSpot error: ${hubspotResult.reason}`);
  if (slackResult.status === "rejected")   log(`Slack error: ${slackResult.reason}`);
  if (emailResult.status === "rejected")   log(`Email error: ${emailResult.reason}`);

  log(`Review complete. Delivery: HubSpot=${delivery.hubspot} Slack=${delivery.slack} Email=${delivery.email}`);
  return { call, result, delivery };
}

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────────────────────
app.post("/webhook/fathom", async (req, res) => {
  log("Webhook received", JSON.stringify(req.body).slice(0, 200));

  // Verify signature
  if (!verifyFathomSignature(req)) {
    log("Invalid webhook signature — rejected");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.body;
  const eventType = event.type || event.event_type || "";
  const meeting = event.data || event.meeting || event.recording || event;

  // Only process completed recordings titled "Adapt Demo"
  const title = (meeting.title || meeting.meeting_title || "").toLowerCase();
  if (!title.includes("adapt demo")) {
    log(`Skipping non-demo call: "${meeting.title || "untitled"}"`);
    return res.json({ skipped: true, reason: "Not an Adapt Demo call" });
  }

  const recordingId = meeting.recording_id || meeting.id;
  if (!recordingId) {
    log("No recording_id in payload");
    return res.status(400).json({ error: "No recording_id" });
  }

  // Respond immediately so Fathom doesn't retry
  res.json({ received: true, recording_id: recordingId });

  // Run review async (don't block the webhook response)
  runReview(recordingId, {
    created_at: meeting.created_at,
    title: meeting.title || meeting.meeting_title,
    calendar_invitees: meeting.calendar_invitees || [],
  }).catch(err => log(`Review pipeline error for ${recordingId}: ${err.message}`));
});

// ─── MANUAL TRIGGER (for testing) ────────────────────────────────────────────
app.post("/review/:recordingId", async (req, res) => {
  const { recordingId } = req.params;
  log(`Manual review triggered for recording ${recordingId}`);
  try {
    const outcome = await runReview(parseInt(recordingId), req.body);
    res.json({ success: true, score: outcome.result.overall_score, delivery: outcome.delivery });
  } catch (err) {
    log(`Manual review error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Adapt Demo Review Server",
    configured: {
      fathom:    !!FATHOM_API_KEY,
      anthropic: !!ANTHROPIC_API_KEY,
      hubspot:   !!HUBSPOT_ACCESS_TOKEN,
      slack:     !!SLACK_BOT_TOKEN,
      gmail:     !!GMAIL_REFRESH_TOKEN,
    },
    uptime: Math.round(process.uptime()) + "s",
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`Adapt Demo Review Server running on port ${PORT}`);
  log(`Webhook URL: POST /webhook/fathom`);
  log(`Health check: GET /health`);
  log(`Manual trigger: POST /review/:recordingId`);
});
