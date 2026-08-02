import { openaiCompatibleStrategy } from "./openai-compatible.mjs";
import { codexSubscriptionStrategy } from "./codex-subscription.mjs";
import { antigravityStrategy } from "./antigravity.mjs";
import { grokSubscriptionStrategy } from "./grok-subscription.mjs";
import { huoshanArkStrategy } from "./huoshan-ark.mjs";

export function createDefaultStrategies(extraStrategies = []) {
  // Special strategies first, generic base_url fallback last.
  return [
    codexSubscriptionStrategy,
    antigravityStrategy,
    grokSubscriptionStrategy,
    huoshanArkStrategy,
    ...extraStrategies,
    openaiCompatibleStrategy,
  ];
}

export {
  openaiCompatibleStrategy,
  codexSubscriptionStrategy,
  antigravityStrategy,
  grokSubscriptionStrategy,
  huoshanArkStrategy,
};
