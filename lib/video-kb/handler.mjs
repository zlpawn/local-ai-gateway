/**
 * Task queue handler for video KB pipeline.
 * Registers the pipeline as a "video_kb" task type.
 */

import { runVideoKbPipeline, getPipelineNodes } from "./pipeline.mjs";

export const videoKbHandler = {
  type: "video_kb",

  /**
   * Return step definitions for UI display before task starts.
   */
  steps(payload) {
    return getPipelineNodes().map((n) => ({
      id: n.id,
      label: n.label,
      status: "pending",
    }));
  },

  /**
   * Validate payload before submission.
   */
  validate(payload) {
    const issues = [];
    if (!payload?.url) issues.push("Missing 'url'");
    if (!payload?.whisperTool) issues.push("Missing 'whisperTool'");
    if (!payload?.whisperModel) issues.push("Missing 'whisperModel'");
    if (!payload?.embeddingEndpointId) issues.push("Missing 'embeddingEndpointId'");
    return issues.length ? issues : null;
  },

  /**
   * Run the pipeline.
   */
  async run(payload, { signal, onProgress, onSteps, taskId }) {
    // The embeddingFn is injected by server.js at registration time
    // (it needs access to the gateway's embedding endpoint configuration).
    // The payload should already contain embeddingFn if set up correctly.
    return runVideoKbPipeline(payload, { signal, onProgress, onSteps });
  },
};
