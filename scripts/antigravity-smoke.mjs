#!/usr/bin/env node
// Antigravity v1internal LIVE smoke test (gRPC).
//
// Hits the REAL Google v1internal PredictionService via gRPC.
// Requires a logged-in token: run `node bin/cli.js antigravity login` first.
// This is NOT part of the unit test suite (no mocks) - run it manually.
//
// Usage:
//   node scripts/antigravity-smoke.mjs                 # default model gemini-pro-agent
//   node scripts/antigravity-smoke.mjs gemini-3-flash  # pick a model
//
// Verifies the full chain end-to-end:
//   OAuth refresh -> loadCodeAssist (project) -> buildGenerateContentRequest
//   -> gRPC GenerateContent -> streamGrpcResponses (Codex events printed live).
import {
  ensureFreshToken,
  loadCodeAssist,
  grpcGenerateContent,
  buildGenerateContentRequest,
  streamGrpcResponses,
  getClientCredentials,
  getStoredToken,
  saveSecrets,
} from "../lib/antigravity/index.mjs";
import { ResponsesWriter } from "../lib/codex/responses-writer.mjs";

const MODEL = process.argv[2] || "gemini-pro-agent";

async function main() {
  const creds = getClientCredentials();
  const token = getStoredToken();
  if (!token.refresh_token) {
    console.error("[smoke] No token. Run first: node bin/cli.js antigravity login");
    process.exit(1);
  }
  if (!token.account_id) {
    console.error("[smoke] Token has no account_id. Re-run: node bin/cli.js antigravity login");
    process.exit(1);
  }

  console.log(`[smoke] model=${MODEL}  account_id=${token.account_id}`);

  console.log("[smoke] 1/4  ensureFreshToken (refresh if needed)...");
  const fresh = await ensureFreshToken({
    store: { getStoredToken, saveSecrets },
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
  });
  console.log(`[smoke]      access_token present, expires_at=${fresh.expires_at}`);

  console.log("[smoke] 2/4  loadCodeAssist (resolve cloudaicompanionProject)...");
  const { project } = await loadCodeAssist({ accessToken: fresh.access_token });
  console.log(`[smoke]      project=${project}`);

  console.log("[smoke] 3/4  buildGenerateContentRequest + gRPC GenerateContent...");
  const body = buildGenerateContentRequest(
    {
      model: MODEL,
      instructions: "Be concise.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Reply with exactly: hello from antigravity" }],
        },
      ],
    },
    { project, accountId: fresh.account_id, model: MODEL },
  );

  const responses = grpcGenerateContent({ accessToken: fresh.access_token, body });

  console.log("[smoke] 4/4  streamGrpcResponses (live output below):");
  const seen = [];
  const writer = new ResponsesWriter({
    model: MODEL,
    emit: (event, data) => {
      seen.push(event);
      if (event === "response.output_text.delta") process.stdout.write(data.delta);
    },
  });
  await streamGrpcResponses(responses, writer);
  process.stdout.write("\n");

  const hasText = seen.includes("response.output_text.delta");
  const hasCompleted = seen.includes("response.completed");
  console.log(`[smoke] events: ${seen.join(", ")}`);
  if (hasText && hasCompleted) {
    console.log("[smoke] DONE - gRPC v1internal path works end-to-end.");
  } else {
    console.error("[smoke] INCOMPLETE - expected output_text.delta + completed.");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("[smoke] FAILED:", e?.message || e);
  process.exit(1);
});
