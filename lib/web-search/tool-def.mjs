export const GATEWAY_WEB_SEARCH_TOOL_NAME = "web_search";

export function buildGatewayWebSearchTool() {
  return {
    type: "function",
    name: GATEWAY_WEB_SEARCH_TOOL_NAME,
    description:
      "Search the live web for up-to-date information. Use for current events, facts that may have changed, documentation lookups, and questions requiring citations.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Prefer the user's language when appropriate.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Optional result count override.",
        },
        time_range: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Optional recency filter.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}
