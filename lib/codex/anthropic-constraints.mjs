export const noAssistantPrefill = {
  name: "no_assistant_prefill",
  description: "Strip trailing assistant messages so the conversation ends with a user turn.",
  apply(messages) {
    while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
      messages.pop();
    }
    const lastRole = messages[messages.length - 1]?.role;
    if (!lastRole || lastRole !== "user") {
      messages.push({ role: "user", content: [{ type: "text", text: " " }] });
    }
    return messages;
  },
};

export const textBeforeToolUse = {
  name: "text_before_tool_use",
  description: "Move assistant text blocks ahead of tool_use blocks within each message.",
  apply(messages) {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const firstToolUse = message.content.findIndex((part) => part?.type === "tool_use");
      if (firstToolUse < 0) continue;

      const beforeToolUse = message.content.slice(0, firstToolUse);
      const fromToolUse = message.content.slice(firstToolUse);
      const trailingText = fromToolUse.filter((part) => part?.type === "text");
      if (trailingText.length === 0) continue;

      message.content = [
        ...beforeToolUse,
        ...trailingText,
        ...fromToolUse.filter((part) => part?.type !== "text"),
      ];
    }
    return messages;
  },
};

const PROFILES = {
  strict: [noAssistantPrefill, textBeforeToolUse],
};

const DOMAIN_PROFILES = {
  "ark.cn-beijing.volces.com": "strict",
};

export function hostFromUrl(url) {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function constraintsForRoute(route) {
  const profile = profileNameForRoute(route);
  return PROFILES[profile] || PROFILES.strict;
}

function profileNameForRoute(route) {
  if (route?.kind === "official") return "strict";
  const host = hostFromUrl(route?.provider?.base_url);
  return DOMAIN_PROFILES[host] || "strict";
}

export function applyAnthropicConstraints(messages, route) {
  const constraints = constraintsForRoute(route);
  for (const constraint of constraints) {
    constraint.apply(messages);
  }
  return messages;
}
