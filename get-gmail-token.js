/**
 * Run this once locally to get a Gmail refresh token.
 * 
 * Usage:
 *   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=xxx node get-gmail-token.js
 * 
 * It will print a URL — open it, authorize with Jake's Google account,
 * then paste the code back. The refresh token will be printed.
 * Copy it into Render as GMAIL_REFRESH_TOKEN.
 */

const https = require("https");
const readline = require("readline");

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI  = "urn:ietf:wg:oauth:2.0:oob";
const SCOPE         = "https://www.googleapis.com/auth/gmail.send";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET environment variables first");
  process.exit(1);
}

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${CLIENT_ID}&` +
  `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
  `response_type=code&` +
  `scope=${encodeURIComponent(SCOPE)}&` +
  `access_type=offline&` +
  `prompt=consent`;

console.log("\n1. Open this URL in your browser (use Jake's Google account):");
console.log("\n" + authUrl + "\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("2. Paste the authorization code here: ", async (code) => {
  rl.close();

  const params = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const postData = params.toString();
  const options = {
    hostname: "oauth2.googleapis.com",
    path: "/token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
      const json = JSON.parse(data);
      if (json.refresh_token) {
        console.log("\n✅ Success! Add this to Render as GMAIL_REFRESH_TOKEN:");
        console.log("\n" + json.refresh_token + "\n");
      } else {
        console.error("Error:", json);
      }
    });
  });
  req.write(postData);
  req.end();
});
