/**
 * Task queue handler for video KB pipeline.
 * Registers the pipeline as a "video_kb" task type.
 */

import {
  runVideoKbPipeline,
  getPipelineNodes,
  resolveSelectedSteps,
  validateSelectedSteps,
  getDefaultSelectedSteps,
} from "./pipeline.mjs";

export const videoKbHandler = {
  type: "video_kb",

  /**
   * Return step definitions for UI display before task starts.
   */
  steps(payload) {
    const selected = resolveSelectedSteps(payload?.selectedSteps || payload?.steps || payload?.enabled_steps);
    const selectedSet = new Set(selected);
    return getPipelineNodes()
      .filter((n) => selectedSet.has(n.id))
      .map((n) => ({
        id: n.id,
        label: n.label,
        status: "pending",
      }));
  },

  /**
   * Validate payload before submission.
   */
  validate(payload) {
    const selected = resolveSelectedSteps(payload?.selectedSteps || payload?.steps || payload?.enabled_steps);
    const issues = [];
    if (!payload?.url) issues.push("Missing 'url'");
    issues.push(...(validateSelectedSteps(selected, payload) || []));
    return issues.length ? issues : null;
  },

  /**
   * Run the pipeline.
   */
  async run(payload, { signal, onProgress, onSteps }) {
    const selectedSteps = resolveSelectedSteps(payload?.selectedSteps || payload?.steps || payload?.enabled_steps);
    return runVideoKbPipeline({
      ...payload,
      selectedSteps,
    }, { signal, onProgress, onSteps });
  },
};

export { getDefaultSelectedSteps };
