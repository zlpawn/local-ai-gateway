// Minimal protobuf encoder/decoder for Antigravity v1internal gRPC.
// Hand-rolled to avoid adding protobufjs as a runtime dependency.
// Only covers the message types needed for GenerateContent request/response.

// ── Wire types ──
const WT_VARINT = 0;
const WT_64BIT = 1;
const WT_LEN = 2;
const WT_32BIT = 5;

// ── Encode primitives ──

function encodeVarint(n) {
  if (typeof n !== "number" || n < 0 || !Number.isFinite(n)) n = 0;
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

function tag(fieldNum, wireType) {
  return encodeVarint((fieldNum << 3) | wireType);
}

function encStr(fieldNum, str) {
  const b = Buffer.from(String(str), "utf8");
  return Buffer.concat([tag(fieldNum, WT_LEN), encodeVarint(b.length), b]);
}

function encBytes(fieldNum, buf) {
  return Buffer.concat([tag(fieldNum, WT_LEN), encodeVarint(buf.length), buf]);
}

function encMsg(fieldNum, buf) {
  return Buffer.concat([tag(fieldNum, WT_LEN), encodeVarint(buf.length), buf]);
}

function encVarintField(fieldNum, val) {
  return Buffer.concat([tag(fieldNum, WT_VARINT), encodeVarint(val)]);
}

function encFloat(fieldNum, val) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(val, 0);
  return Buffer.concat([tag(fieldNum, WT_32BIT), b]);
}

function encBool(fieldNum, val) {
  return encVarintField(fieldNum, val ? 1 : 0);
}

function concatBufs(arr) {
  return Buffer.concat(arr.filter((b) => b && b.length > 0));
}

// ── google.protobuf.Struct encode ──

function encodeValue(val) {
  if (val == null) return encVarintField(1, 0); // null_value = NULL_VALUE(0)
  if (typeof val === "number") return encFloat(2, val); // number_value (double, wire type 5)
  if (typeof val === "string") return encStr(3, val);
  if (typeof val === "boolean") return encBool(4, val);
  if (Array.isArray(val)) return encMsg(6, encodeListValue(val));
  if (typeof val === "object") return encMsg(5, encodeStruct(val));
  return encVarintField(1, 0);
}

function encodeListValue(arr) {
  return concatBufs(arr.map((v) => encMsg(1, encodeValue(v))));
}

function encodeStruct(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const entry = concatBufs([encStr(1, k), encMsg(2, encodeValue(v))]);
    parts.push(encMsg(1, entry));
  }
  return concatBufs(parts);
}

// ── Request encoding (JSON -> protobuf) ──
// Field numbers from extracted proto:
// v1internal.GenerateContentRequest:
//   1:project 2:request_id 3:request(msg) 4:model 5:user_prompt_id
//   6:user_agent 7:request_type 8:enabled_credit_types(rep enum)
// aiplatform.master.GenerateContentRequest:
//   1:endpoint 2:contents(rep) 3:safety_settings(rep) 4:generation_config(msg)
//   5:model 6:tools(rep) 7:tool_config(msg) 8:system_instruction(msg)
//   9:cached_content 13:session_id 16:service_tier
// Content: 1:role 2:parts(rep)
// Part: 1:text 2:inline_data 5:function_call(msg) 6:function_response(msg)
//        10:thought 11:thought_signature
// GenerationConfig: 1:temperature 2:top_p 3:top_k 5:max_output_tokens 25:thinking_config
// ThinkingConfig: 1:include_thoughts 3:thinking_budget
// FunctionCall: 1:name 2:args(Struct) 3:id
// FunctionResponse: 1:name 2:response(Struct) 3:id
// FunctionDeclaration: 1:name 2:description 3:parameters(Struct)
// Tool: 1:function_declarations(rep)
// ToolConfig: 1:function_calling_config(msg)
// FunctionCallingConfig: 1:mode(enum: 0=UNSPECIFIED 1=AUTO 2=ANY 3=NONE)

function encodePart(part) {
  const f = [];
  if (part.text != null) f.push(encStr(1, part.text));
  if (part.inlineData) f.push(encMsg(2, encodeInlineData(part.inlineData)));
  if (part.functionCall) f.push(encMsg(5, encodeFunctionCall(part.functionCall)));
  if (part.functionResponse) f.push(encMsg(6, encodeFunctionResponse(part.functionResponse)));
  if (part.thought != null) f.push(encBool(10, part.thought));
  if (part.thoughtSignature) f.push(encBytes(11, Buffer.from(part.thoughtSignature, "base64")));
  return concatBufs(f);
}

function encodeInlineData(data) {
  const f = [];
  if (data.mimeType) f.push(encStr(1, data.mimeType));
  if (data.data) f.push(encStr(2, data.data));
  return concatBufs(f);
}

function encodeContent(content) {
  const f = [];
  if (content.role) f.push(encStr(1, content.role));
  if (Array.isArray(content.parts)) {
    for (const p of content.parts) f.push(encMsg(2, encodePart(p)));
  }
  return concatBufs(f);
}

function encodeThinkingConfig(tc) {
  const f = [];
  if (tc.includeThoughts != null) f.push(encBool(1, tc.includeThoughts));
  if (tc.thinkingBudget != null) f.push(encVarintField(3, tc.thinkingBudget));
  return concatBufs(f);
}

function encodeGenerationConfig(gc) {
  const f = [];
  if (gc.temperature != null) f.push(encFloat(1, gc.temperature));
  if (gc.topP != null) f.push(encFloat(2, gc.topP));
  if (gc.topK != null) f.push(encFloat(3, gc.topK));
  if (gc.maxOutputTokens != null) f.push(encVarintField(5, gc.maxOutputTokens));
  if (gc.thinkingConfig) f.push(encMsg(25, encodeThinkingConfig(gc.thinkingConfig)));
  return concatBufs(f);
}

function encodeFunctionCall(fc) {
  const f = [];
  if (fc.name) f.push(encStr(1, fc.name));
  if (fc.args != null) f.push(encMsg(2, encodeStruct(typeof fc.args === "string" ? JSON.parse(fc.args) : fc.args)));
  if (fc.id) f.push(encStr(3, fc.id));
  return concatBufs(f);
}

function encodeFunctionResponse(fr) {
  const f = [];
  if (fr.name) f.push(encStr(1, fr.name));
  if (fr.response != null) f.push(encMsg(2, encodeStruct(fr.response)));
  if (fr.id) f.push(encStr(3, fr.id));
  return concatBufs(f);
}

function encodeFunctionDeclaration(fd) {
  const f = [];
  if (fd.name) f.push(encStr(1, fd.name));
  if (fd.description) f.push(encStr(2, fd.description));
  if (fd.parameters) f.push(encMsg(3, encodeStruct(fd.parameters)));
  return concatBufs(f);
}

function encodeTool(tool) {
  const f = [];
  if (Array.isArray(tool.functionDeclarations)) {
    for (const fd of tool.functionDeclarations) f.push(encMsg(1, encodeFunctionDeclaration(fd)));
  }
  return concatBufs(f);
}

function encodeToolConfig(tc) {
  const f = [];
  if (tc.functionCallingConfig) {
    const fcc = tc.functionCallingConfig;
    const inner = [];
    const modeMap = { MODE_UNSPECIFIED: 0, AUTO: 1, ANY: 2, NONE: 3, VALIDATED: 1 };
    const modeVal = modeMap[fcc.mode] ?? 1;
    inner.push(encVarintField(1, modeVal));
    if (Array.isArray(fcc.allowedFunctionNames)) {
      for (const n of fcc.allowedFunctionNames) inner.push(encStr(2, n));
    }
    f.push(encMsg(1, concatBufs(inner)));
  }
  return concatBufs(f);
}

function encodeMasterRequest(req) {
  const f = [];
  if (req.endpoint) f.push(encStr(1, req.endpoint));
  if (Array.isArray(req.contents)) {
    for (const c of req.contents) f.push(encMsg(2, encodeContent(c)));
  }
  if (req.generationConfig) f.push(encMsg(4, encodeGenerationConfig(req.generationConfig)));
  if (req.model) f.push(encStr(5, req.model));
  if (Array.isArray(req.tools)) {
    for (const t of req.tools) f.push(encMsg(6, encodeTool(t)));
  }
  if (req.toolConfig) f.push(encMsg(7, encodeToolConfig(req.toolConfig)));
  if (req.systemInstruction) f.push(encMsg(8, encodeContent(req.systemInstruction)));
  if (req.sessionId) f.push(encStr(13, req.sessionId));
  return concatBufs(f);
}

// Encode the full v1internal.GenerateContentRequest from the JSON body
// produced by request-builder.mjs.
export function encodeGenerateContentRequest(body) {
  const f = [];
  if (body.project) f.push(encStr(1, body.project));
  if (body.requestId) f.push(encStr(2, body.requestId));
  if (body.request) f.push(encMsg(3, encodeMasterRequest(body.request)));
  if (body.model) f.push(encStr(4, body.model));
  if (body.userPromptId) f.push(encStr(5, body.userPromptId));
  if (body.userAgent) f.push(encStr(6, body.userAgent));
  if (body.requestType) f.push(encStr(7, body.requestType));
  if (Array.isArray(body.enabledCreditTypes)) {
    const creditMap = { GOOGLE_ONE_AI: 1, CREDIT_TYPE_UNSPECIFIED: 0 };
    for (const ct of body.enabledCreditTypes) {
      f.push(encVarintField(8, creditMap[ct] ?? 0));
    }
  }
  return concatBufs(f);
}

// ── Response encoding (for testing / mock servers) ──

function encodeUsageMetadata(um) {
  const f = [];
  if (um.promptTokenCount != null) f.push(encVarintField(1, um.promptTokenCount));
  if (um.candidatesTokenCount != null) f.push(encVarintField(2, um.candidatesTokenCount));
  if (um.totalTokenCount != null) f.push(encVarintField(3, um.totalTokenCount));
  return concatBufs(f);
}

const FINISH_REASON_MAP = {
  FINISH_REASON_UNSPECIFIED: 0, STOP: 1, MAX_TOKENS: 2, SAFETY: 3,
  RECITATION: 4, OTHER: 5, BLOCKLIST: 6, PROHIBITED_CONTENT: 7,
};

function encodeCandidate(c) {
  const f = [];
  if (c.content) f.push(encMsg(2, encodeContent(c.content)));
  if (c.finishReason) f.push(encVarintField(3, FINISH_REASON_MAP[c.finishReason] ?? 0));
  return concatBufs(f);
}

function encodeMasterResponse(resp) {
  const f = [];
  if (Array.isArray(resp.candidates)) {
    for (const c of resp.candidates) f.push(encMsg(2, encodeCandidate(c)));
  }
  if (resp.usageMetadata) f.push(encMsg(4, encodeUsageMetadata(resp.usageMetadata)));
  if (resp.modelVersion) f.push(encStr(11, resp.modelVersion));
  return concatBufs(f);
}

// Encode a v1internal.GenerateContentResponse from a JSON object.
export function encodeGenerateContentResponse(obj) {
  const f = [];
  if (obj.response) f.push(encMsg(1, encodeMasterResponse(obj.response)));
  if (obj.traceId) f.push(encStr(2, obj.traceId));
  return concatBufs(f);
}

// ── Decode primitives ──

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; this.len = buf.length; }

  uint32() {
    let result = 0, shift = 0;
    while (this.pos < this.len) {
      const b = this.buf[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) { // overflow guard (5 bytes = 35 bits)
        while (this.pos < this.len && this.buf[this.pos - 1] & 0x80) this.pos++;
        break;
      }
    }
    return result >>> 0;
  }

  tag() {
    const val = this.uint32();
    return { fieldNum: val >>> 3, wireType: val & 7 };
  }

  bytes() {
    const len = this.uint32();
    const end = this.pos + len;
    const result = this.buf.subarray(this.pos, end);
    this.pos = end;
    return result;
  }

  string() { return this.bytes().toString("utf8"); }
  float() { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  bool() { return this.uint32() !== 0; }
  int32() { return this.uint32() | 0; }

  skip(wt) {
    switch (wt) {
      case 0: this.uint32(); break;
      case 1: this.pos += 8; break;
      case 2: this.pos += this.uint32(); break;
      case 5: this.pos += 4; break;
      default: this.pos = this.len; break; // give up
    }
  }
}

// ── google.protobuf.Struct decode ──

function decodeValue(buf) {
  const reader = new Reader(buf);
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    switch (fieldNum) {
      case 1: reader.uint32(); return null; // null_value
      case 2: return reader.float(); // number_value
      case 3: return reader.string(); // string_value
      case 4: return reader.bool(); // bool_value
      case 5: return decodeStruct(reader.bytes()); // struct_value
      case 6: return decodeListValue(reader.bytes()); // list_value
      default: reader.skip(wireType);
    }
  }
  return null;
}

function decodeListValue(buf) {
  const reader = new Reader(buf);
  const arr = [];
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    if (fieldNum === 1 && wireType === 2) arr.push(decodeValue(reader.bytes()));
    else reader.skip(wireType);
  }
  return arr;
}

function decodeStruct(buf) {
  const reader = new Reader(buf);
  const obj = {};
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    if (fieldNum === 1 && wireType === 2) {
      const entryReader = new Reader(reader.bytes());
      let key = "", value = null;
      while (entryReader.pos < entryReader.len) {
        const { fieldNum: ef, wireType: ew } = entryReader.tag();
        if (ef === 1) key = entryReader.string();
        else if (ef === 2) value = decodeValue(entryReader.bytes());
        else entryReader.skip(ew);
      }
      obj[key] = value;
    } else reader.skip(wireType);
  }
  return obj;
}

// ── Response decoding (protobuf -> JSON) ──
// v1internal.GenerateContentResponse:
//   1:response(msg) 2:trace_id(str) 3:consumed_credits 4:remaining_credits
// aiplatform.master.GenerateContentResponse:
//   2:candidates(rep) 4:usage_metadata(msg) 11:model_version 13:response_id
// Candidate: 1:index 2:content(msg) 3:finish_reason(enum) 5:finish_message
// Content: 1:role 2:parts(rep)
// Part: 1:text 5:function_call(msg) 6:function_response(msg) 10:thought 11:thought_signature
// FunctionCall: 1:name 2:args(Struct) 3:id
// UsageMetadata: 1:prompt_token_count 2:candidates_token_count 3:total_token_count

const FINISH_REASONS = [
  "FINISH_REASON_UNSPECIFIED", "STOP", "MAX_TOKENS", "SAFETY", "RECITATION",
  "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL",
  "MODEL_ARMOR", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION",
  "IMAGE_OTHER", "UNEXPECTED_TOOL_CALL", "NO_IMAGE",
];

function decodePart(buf) {
  const reader = new Reader(buf);
  const part = {};
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    switch (fieldNum) {
      case 1: part.text = reader.string(); break;
      case 5: part.functionCall = decodeFunctionCall(reader.bytes()); break;
      case 6: part.functionResponse = decodeFunctionResponse(reader.bytes()); break;
      case 10: part.thought = reader.bool(); break;
      case 11: part.thoughtSignature = reader.bytes().toString("base64"); break;
      default: reader.skip(wireType);
    }
  }
  return part;
}

function decodeFunctionCall(buf) {
  const reader = new Reader(buf);
  const fc = {};
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    switch (fieldNum) {
      case 1: fc.name = reader.string(); break;
      case 2: fc.args = decodeStruct(reader.bytes()); break;
      case 3: fc.id = reader.string(); break;
      default: reader.skip(wireType);
    }
  }
  return fc;
}

function decodeFunctionResponse(buf) {
  const reader = new Reader(buf);
  const fr = {};
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    switch (fieldNum) {
      case 1: fr.name = reader.string(); break;
      case 2: fr.response = decodeStruct(reader.bytes()); break;
      case 3: fr.id = reader.string(); break;
      default: reader.skip(wireType);
    }
  }
  return fr;
}

function decodeContent(buf) {
  const reader = new Reader(buf);
  const content = { parts: [] };
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    switch (fieldNum) {
      case 1: content.role = reader.string(); break;
      case 2: content.parts.push(decodePart(reader.bytes())); break;
      default: reader.skip(wireType);
    }
  }
  return content;
}

function decodeCandidate(buf) {
  const reader = new Reader(buf);
  const candidate = {};
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    switch (fieldNum) {
      case 1: candidate.index = reader.int32(); break;
      case 2: candidate.content = decodeContent(reader.bytes()); break;
      case 3: candidate.finishReason = FINISH_REASONS[reader.uint32()] || "UNKNOWN"; break;
      case 5: candidate.finishMessage = reader.string(); break;
      default: reader.skip(wireType);
    }
  }
  return candidate;
}

function decodeUsageMetadata(buf) {
  const reader = new Reader(buf);
  const meta = {};
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    switch (fieldNum) {
      case 1: meta.promptTokenCount = reader.int32(); break;
      case 2: meta.candidatesTokenCount = reader.int32(); break;
      case 3: meta.totalTokenCount = reader.int32(); break;
      case 5: meta.cachedContentTokenCount = reader.int32(); break;
      case 14: meta.thoughtsTokenCount = reader.int32(); break;
      default: reader.skip(wireType);
    }
  }
  return meta;
}

function decodeMasterResponse(buf) {
  const reader = new Reader(buf);
  const resp = { candidates: [] };
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    switch (fieldNum) {
      case 2: resp.candidates.push(decodeCandidate(reader.bytes())); break;
      case 4: resp.usageMetadata = decodeUsageMetadata(reader.bytes()); break;
      case 11: resp.modelVersion = reader.string(); break;
      case 13: resp.responseId = reader.string(); break;
      default: reader.skip(wireType);
    }
  }
  return resp;
}

// Decode v1internal.GenerateContentResponse -> JSON object matching
// the shape that response-streamer.mjs expects (wrapped in `response`).
export function decodeGenerateContentResponse(buf) {
  const reader = new Reader(buf);
  const result = {};
  while (reader.pos < reader.len) {
    const { fieldNum, wireType } = reader.tag();
    switch (fieldNum) {
      case 1: result.response = decodeMasterResponse(reader.bytes()); break;
      case 2: result.traceId = reader.string(); break;
      default: reader.skip(wireType);
    }
  }
  return result;
}
