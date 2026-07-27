import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeGenerateContentRequest,
  decodeGenerateContentResponse,
} from "../../lib/antigravity/proto-codec.mjs";

// Minimal wrapper body matching what request-builder.mjs produces.
function sampleBody() {
  return {
    project: "test-project-123",
    requestId: "agent/antigravity/abc12345/1",
    request: {
      systemInstruction: { role: "user", parts: [{ text: "You are helpful." }] },
      generationConfig: { temperature: 0.7, maxOutputTokens: 128 },
      sessionId: "session-xyz",
      contents: [{ role: "user", parts: [{ text: "Say hello" }] }],
    },
    model: "gemini-pro-agent",
    userAgent: "antigravity",
    requestType: "agent",
    requestId: "agent/antigravity/abc12345/1",
    enabledCreditTypes: ["GOOGLE_ONE_AI"],
  };
}

function readVarint(buf, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buf.length) {
    const byte = buf[offset++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("Truncated protobuf varint");
}

function lengthDelimitedFields(buf, wantedField) {
  const values = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x07;

    if (wireType === 0) {
      offset = readVarint(buf, offset).offset;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(buf, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > buf.length) throw new Error("Truncated protobuf field");
      if (fieldNumber === wantedField) values.push(buf.subarray(offset, end));
      offset = end;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }
  return values;
}

test("encodeGenerateContentRequest produces non-empty buffer", () => {
  const buf = encodeGenerateContentRequest(sampleBody());
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 10);
});

test("encodeGenerateContentRequest includes project string", () => {
  const buf = encodeGenerateContentRequest(sampleBody());
  assert.ok(buf.includes(Buffer.from("test-project-123")));
});

test("encodeGenerateContentRequest includes model string", () => {
  const buf = encodeGenerateContentRequest(sampleBody());
  assert.ok(buf.includes(Buffer.from("gemini-pro-agent")));
});

test("encodeGenerateContentRequest includes user message text", () => {
  const buf = encodeGenerateContentRequest(sampleBody());
  assert.ok(buf.includes(Buffer.from("Say hello")));
});

test("encodeGenerateContentRequest writes inline image data as raw bytes", () => {
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f, 0x80, 0xff,
  ]);
  const base64 = imageBytes.toString("base64");
  const body = sampleBody();
  body.request.contents = [{
    role: "user",
    parts: [{
      inlineData: {
        mimeType: "image/png",
        data: base64,
      },
    }],
  }];

  const wrapper = encodeGenerateContentRequest(body);
  const masterRequest = lengthDelimitedFields(wrapper, 3)[0];
  const content = lengthDelimitedFields(masterRequest, 2)[0];
  const part = lengthDelimitedFields(content, 2)[0];
  const inlineData = lengthDelimitedFields(part, 2)[0];
  const encodedImage = lengthDelimitedFields(inlineData, 2)[0];

  assert.deepEqual(encodedImage, imageBytes);
  assert.equal(encodedImage.equals(Buffer.from(base64, "utf8")), false);
});

test("encodeGenerateContentRequest handles tools", () => {
  const body = sampleBody();
  body.request.tools = [{
    functionDeclarations: [{
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    }],
  }];
  body.request.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  const buf = encodeGenerateContentRequest(body);
  assert.ok(buf.includes(Buffer.from("get_weather")));
});

test("decodeGenerateContentResponse extracts text from candidates", () => {
  // Build a minimal response manually using the encoder.
  // v1internal.GenerateContentResponse { response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } }
  // We need to construct the protobuf bytes. Use the encoder internals.
  // Instead, test with a hand-crafted buffer.
  // Content { parts: [{ text: "hi" }] } = field 2 (parts) repeated, each Part { text: "hi" }
  // Part: field 1 (text) = "hi" => 0a 02 68 69
  // Content: field 2 (parts) = Part => 12 04 0a 02 68 69
  // Candidate: field 2 (content) = Content => 12 06 12 04 0a 02 68 69
  // MasterResponse: field 2 (candidates) = Candidate => 12 08 12 06 12 04 0a 02 68 69
  // V1Response: field 1 (response) = MasterResponse => 0a 0a 12 08 12 06 12 04 0a 02 68 69
  const buf = Buffer.from([0x0a, 0x0a, 0x12, 0x08, 0x12, 0x06, 0x12, 0x04, 0x0a, 0x02, 0x68, 0x69]);
  const result = decodeGenerateContentResponse(buf);
  assert.ok(result.response, "should have response field");
  assert.ok(Array.isArray(result.response.candidates), "should have candidates array");
  assert.equal(result.response.candidates[0].content.parts[0].text, "hi");
});

test("decodeGenerateContentResponse extracts usage metadata", () => {
  // UsageMetadata { prompt_token_count: 10, candidates_token_count: 5, total_token_count: 15 }
  // field 1 (int32) = 10 => 08 0a
  // field 2 (int32) = 5 => 10 05
  // field 3 (int32) = 15 => 18 0f
  const usageBuf = Buffer.from([0x08, 0x0a, 0x10, 0x05, 0x18, 0x0f]);
  // MasterResponse: field 4 (usage_metadata) = UsageMetadata
  // 22 06 08 0a 10 05 18 0f
  const masterBuf = Buffer.concat([Buffer.from([0x22, 0x06]), usageBuf]);
  // V1Response: field 1 (response) = MasterResponse
  const v1Buf = Buffer.concat([Buffer.from([0x0a, masterBuf.length]), masterBuf]);
  const result = decodeGenerateContentResponse(v1Buf);
  assert.deepEqual(result.response.usageMetadata, {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 15,
  });
});

test("decodeGenerateContentResponse extracts finish reason", () => {
  // Candidate with finish_reason = STOP (1)
  // Candidate: field 3 (finish_reason) = 1 => 18 01
  const candidateBuf = Buffer.from([0x18, 0x01]);
  // MasterResponse: field 2 (candidates) = Candidate
  const masterBuf = Buffer.concat([Buffer.from([0x12, candidateBuf.length]), candidateBuf]);
  // V1Response: field 1 (response) = MasterResponse
  const v1Buf = Buffer.concat([Buffer.from([0x0a, masterBuf.length]), masterBuf]);
  const result = decodeGenerateContentResponse(v1Buf);
  assert.equal(result.response.candidates[0].finishReason, "STOP");
});

test("decodeGenerateContentResponse handles empty buffer", () => {
  const result = decodeGenerateContentResponse(Buffer.alloc(0));
  assert.deepEqual(result, {});
});

test("encode with function call in contents", () => {
  const body = sampleBody();
  body.request.contents.push({
    role: "model",
    parts: [{ functionCall: { name: "search", args: { query: "test" }, id: "call_0" } }],
  });
  body.request.contents.push({
    role: "user",
    parts: [{ functionResponse: { name: "search", response: { result: "found" }, id: "call_0" } }],
  });
  const buf = encodeGenerateContentRequest(body);
  assert.ok(buf.includes(Buffer.from("search")));
  assert.ok(buf.includes(Buffer.from("call_0")));
  assert.ok(buf.includes(Buffer.from("found")));
});

// --- Round-trip and edge case tests ---

test("round-trip: encode request then verify wire format decodes correctly", () => {
  const body = {
    project: "proj-rt",
    requestId: "req-rt-001",
    request: {
      systemInstruction: { role: "user", parts: [{ text: "System prompt" }] },
      generationConfig: { temperature: 0.5, topP: 0.9, topK: 40, maxOutputTokens: 512, thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } },
      sessionId: "sess-rt",
      contents: [
        { role: "user", parts: [{ text: "Hello" }] },
        { role: "model", parts: [{ text: "Hi there" }] },
        { role: "user", parts: [{ text: "How are you?" }] },
      ],
    },
    model: "gemini-3-flash",
    userAgent: "Antigravity/4.3.0",
    requestType: "agent",
    enabledCreditTypes: ["GOOGLE_ONE_AI"],
  };
  const buf = encodeGenerateContentRequest(body);
  assert.ok(buf.length > 50, "encoded buffer should be substantial");

  // Verify key strings are present in the wire format
  for (const s of ["proj-rt", "req-rt-001", "System prompt", "Hello", "Hi there",
    "How are you?", "gemini-3-flash", "Antigravity/4.3.0", "agent", "sess-rt"]) {
    assert.ok(buf.includes(Buffer.from(s)), `wire format should contain "${s}"`);
  }
});

test("encode handles empty contents array", () => {
  const body = {
    project: "p",
    request: { contents: [] },
    model: "m",
  };
  const buf = encodeGenerateContentRequest(body);
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 0);
});

test("encode handles missing optional fields", () => {
  const buf = encodeGenerateContentRequest({ project: "only-project" });
  assert.ok(buf.includes(Buffer.from("only-project")));
});

test("encode handles multiple enabledCreditTypes", () => {
  const body = {
    project: "p",
    enabledCreditTypes: ["GOOGLE_ONE_AI", "GOOGLE_ONE_AI"],
  };
  const buf = encodeGenerateContentRequest(body);
  // GOOGLE_ONE_AI = 1, should appear as varint field 8 twice
  assert.ok(buf.length > 5);
});

test("decode handles response with multiple candidates", () => {
  // Wire format (nested):
  //   Part { text: "a" }           = 0a 01 61              (3 bytes)
  //   Content { parts: [Part] }    = 12 03 0a 01 61         (5 bytes)
  //   Candidate { content: C }     = 12 05 12 03 0a 01 61   (7 bytes)
  //   MasterResp { candidates: [C1, C2] }
  //     = 12 07 <cand1> 12 07 <cand2>                       (18 bytes)
  //   V1Resp { response: MasterResp }
  //     = 0a 12 <masterResp>                                 (20 bytes)
  const buf = Buffer.from([
    0x0a, 0x12,
    0x12, 0x07, 0x12, 0x05, 0x12, 0x03, 0x0a, 0x01, 0x61,
    0x12, 0x07, 0x12, 0x05, 0x12, 0x03, 0x0a, 0x01, 0x62,
  ]);
  const result = decodeGenerateContentResponse(buf);
  assert.equal(result.response.candidates.length, 2);
  assert.equal(result.response.candidates[0].content.parts[0].text, "a");
  assert.equal(result.response.candidates[1].content.parts[0].text, "b");
});

test("decode extracts traceId from v1internal wrapper", () => {
  // V1Response with trace_id (field 2, string "trace-123")
  // field 2 string: 12 09 74 72 61 63 65 2d 31 32 33
  const buf = Buffer.concat([
    Buffer.from([0x12, 0x09]),
    Buffer.from("trace-123", "utf8"),
  ]);
  const result = decodeGenerateContentResponse(buf);
  assert.equal(result.traceId, "trace-123");
});

test("decode handles functionCall in response part", () => {
  // FunctionCall { name="fn", args={key:"val"}, id="call_0" }
  // Struct { fields: { key: { string_value: "val" } } }
  // This is complex to hand-craft, so let's build it with the encoder
  // Actually, we can test decodeFunctionCall indirectly through decodePart
  // Part with functionCall (field 5):
  // FunctionCall: name(1)="fn", id(3)="call_0"
  // name: 0a 02 66 6e
  // id: 1a 06 63 61 6c 6c 5f 30
  const fcBuf = Buffer.concat([
    Buffer.from([0x0a, 0x02]), Buffer.from("fn"),
    Buffer.from([0x1a, 0x06]), Buffer.from("call_0"),
  ]);
  // Part: field 5 (function_call) = fcBuf
  // 2a + length + fcBuf
  const partBuf = Buffer.concat([Buffer.from([0x2a, fcBuf.length]), fcBuf]);
  // Content: field 2 (parts) = partBuf
  const contentBuf = Buffer.concat([Buffer.from([0x12, partBuf.length]), partBuf]);
  // Candidate: field 2 (content) = contentBuf
  const candidateBuf = Buffer.concat([Buffer.from([0x12, contentBuf.length]), contentBuf]);
  // MasterResponse: field 2 (candidates) = candidateBuf
  const masterBuf = Buffer.concat([Buffer.from([0x12, candidateBuf.length]), candidateBuf]);
  // V1Response: field 1 (response) = masterBuf
  const v1Buf = Buffer.concat([Buffer.from([0x0a, masterBuf.length]), masterBuf]);
  const result = decodeGenerateContentResponse(v1Buf);
  const fc = result.response.candidates[0].content.parts[0].functionCall;
  assert.equal(fc.name, "fn");
  assert.equal(fc.id, "call_0");
});
