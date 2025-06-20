const fs = require("fs");
const path = require("path");
const readline = require("readline");
const axios = require("axios");
const { google } = require("googleapis");
const { OpenAI } = require("openai");
require("dotenv").config();

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const TOKEN_PATH = path.join(__dirname, "token.json");

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Load client secrets from a local file
fs.readFile("credentials.json", (err, content) => {
  if (err) return console.error("❌ Error loading client secret file:", err);
  authorize(JSON.parse(content), processEmails);
});

async function authorize(credentials, callback) {
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  // Check if we have previously stored a token
  try {
    const token = fs.readFileSync(TOKEN_PATH);
    const auth = createOAuthClient(client_id, client_secret, redirect_uris[0]);
    auth.setCredentials(JSON.parse(token));
    callback(auth);
  } catch (err) {
    getNewToken(client_id, client_secret, redirect_uris[0], callback);
  }
}

function createOAuthClient(clientId, clientSecret, redirectUri) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getNewToken(clientId, clientSecret, redirectUri, callback) {
  // Manually construct the authorization URL
  const authUrl = `https://accounts.google.com/o/oauth2/auth?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(SCOPES.join(" "))}&` +
    `access_type=offline&` +
    `prompt=consent`;

  console.log("📎 Authorize this app by visiting this URL:\n", authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question("\n📥 Enter the code from that page here: ", async (code) => {
    rl.close();

    try {
      // Manually exchange the code for tokens using axios
      const response = await axios.post("https://oauth2.googleapis.com/token", {
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        transformRequest: [(data) => new URLSearchParams(data).toString()],
      });

      const token = response.data;
      const auth = createOAuthClient(clientId, clientSecret, redirectUri);
      auth.setCredentials(token);

      // Save the token
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
      console.log("✅ Token stored to", TOKEN_PATH);

      callback(auth);
    } catch (err) {
      console.error("❌ Error retrieving access token:", err.response?.data || err.message);
    }
  });
}

async function processEmails(auth) {
  const gmail = google.gmail({ version: "v1", auth });

  try {
    // List unread emails
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread -from:me", // Process unread emails not sent by you
      maxResults: 5, // Limit to 5 emails for testing
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) {
      console.log("No unread emails found.");
      return;
    }

    console.log(`Found ${messages.length} unread emails.`);

    for (const message of messages) {
      // Get email details
      const email = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "full",
      });

      // Extract email headers
      const headers = email.data.payload.headers;
      const from = headers.find((h) => h.name === "From")?.value || "";
      const to = headers.find((h) => h.name === "To")?.value || "";
      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const messageId = email.data.id;
      const threadId = email.data.threadId;

      // Extract email body
      let body = "";
      if (email.data.payload.parts) {
        const textPart = email.data.payload.parts.find(
          (part) => part.mimeType === "text/plain"
        );
        if (textPart && textPart.body.data) {
          body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
        }
      } else if (email.data.payload.body.data) {
        body = Buffer.from(email.data.payload.body.data, "base64").toString(
          "utf-8"
        );
      }

      console.log(`Processing email from ${from} with subject: ${subject}`);

      // Generate AI response
      const aiResponse = await generateAIResponse(from, subject, body);

      // Send reply
      await sendReply(gmail, from, to, subject, aiResponse, threadId, messageId);

      // Mark email as read
      await gmail.users.messages.modify({
        userId: "me",
        id: message.id,
        resource: {
          removeLabelIds: ["UNREAD"],
        },
      });

      console.log(`Replied to email from ${from} and marked as read.`);
    }
  } catch (err) {
    console.error("❌ Error processing emails:", err.message);
  }
}

async function generateAIResponse(from, subject, body) {
  try {
    const prompt = `
      You are an AI assistant responding to an email.
      Email details:
      - From: ${from}
      - Subject: ${subject}
      - Body: ${body}

      Generate a polite and professional response. If the email asks a question, answer it concisely. If it's informational, acknowledge receipt and offer assistance if needed. Keep the tone friendly and professional.
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful email assistant." },
        { role: "user", content: prompt },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error("❌ Error generating AI response:", err.message);
    return "Thank you for your email. I'll get back to you shortly.";
  }
}

async function sendReply(gmail, to, from, subject, body, threadId, messageId) {
  try {
    const emailContent = [
      `To: ${to}`,
      `From: ${from}`,
      `Subject: Re: ${subject}`,
      `In-Reply-To: <${messageId}>`,
      `References: <${messageId}>`,
      "",
      body,
    ].join("\n");

    const encodedMessage = Buffer.from(emailContent)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      resource: {
        raw: encodedMessage,
        threadId: threadId,
      },
    });
  } catch (err) {
    console.error("❌ Error sending reply:", err.message);
    throw err;
  }
}