// Antigravity identity system prompt. Extracted 1:1 from AG-Manager
// src-tauri/src/proxy/mappers/gemini/wrapper.rs:694-702 (the non-web-search
// branch) plus the web-search branch at line 695.
//
// IMPORTANT (deviation from original plan): the antigravity identity is a SHORT
// ~330-char stub, NOT a 17.5K string. The "~17,500 tokens" referenced in AG
// openai/request.rs:1240 is the SIZE of the assembled systemInstruction block
// (this identity stub + the preserved caller `instructions`), dominated by the
// caller's own instructions. Google's v1internal backend accepts this short
// identity - AG-Manager is a widely-used working proxy built on exactly this
// stub (see also openai/request.rs:1102: "Codex system/developer prompts are
// preserved ... must not be overwritten or summarized").

// Rust source uses line continuations ("\\" at end of line) which remove the
// newline AND leading whitespace on the next line, so the effective string is
// the four lines below joined by "\n".
export const ANTIGRAVITY_IDENTITY =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\n" +
  "You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n" +
  "**Absolute paths only**\n" +
  "**Proactiveness**";

export const ANTIGRAVITY_WEB_SEARCH_IDENTITY =
  "You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.";