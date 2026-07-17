export class ResponsesWriter {
  constructor({ model, emit, responseId = `resp_${Date.now()}` }) {
    this.model = model;
    this.emit = emit;
    this.responseId = responseId;
    this.terminal = false;
    this.createdSent = false;
    this.nextOutputIndex = 0;
    this.textItem = null;
    this.reasoningItem = null;
    this.toolItems = new Map();
  }

  created() {
    if (this.createdSent || this.terminal) return;
    this.createdSent = true;
    this.emit("response.created", {
      type: "response.created",
      response: this.response("in_progress"),
    });
  }

  textDelta(delta) {
    if (this.terminal) return;
    this.created();
    if (!this.textItem) {
      this.textItem = this.addItem({
        id: `msg_${this.responseId}`,
        type: "message",
        role: "assistant",
        content: [],
      });
      this.textItem.text = "";
    }
    this.textItem.text += String(delta);
    this.emit("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: this.textItem.outputIndex,
      content_index: 0,
      delta: String(delta),
    });
  }

  reasoningDelta(delta) {
    if (this.terminal) return;
    this.created();
    if (!this.reasoningItem) {
      this.reasoningItem = this.addItem({
        id: `rs_${this.responseId}`,
        type: "reasoning",
        summary: [],
      });
      this.reasoningItem.text = "";
    }
    this.reasoningItem.text += String(delta);
    this.emit("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      output_index: this.reasoningItem.outputIndex,
      summary_index: 0,
      delta: String(delta),
    });
  }

  functionArgumentsDelta({ index, callId, name, delta, kind }) {
    if (this.terminal) return;
    this.created();
    const key = `${kind}:${index}`;
    if (!this.toolItems.has(key)) {
      const type = kind === "custom" ? "custom_tool_call" : "function_call";
      this.toolItems.set(key, this.addItem({
        id: `fc_${callId}`,
        type,
        call_id: callId,
        name,
        ...(kind === "custom" ? { input: "" } : { arguments: "" }),
      }));
    }
    const item = this.toolItems.get(key);
    if (item.done) return;
    const event = kind === "custom"
      ? "response.custom_tool_call_input.delta"
      : "response.function_call_arguments.delta";
    this.emit(event, {
      type: event,
      output_index: item.outputIndex,
      item_id: item.item.id,
      delta: String(delta),
    });
  }

  finishFunction({ index, callId, name, argumentsText, kind }) {
    if (this.terminal) return;
    const key = `${kind}:${index}`;
    if (!this.toolItems.has(key)) {
      this.functionArgumentsDelta({
        index,
        callId,
        name,
        delta: "",
        kind,
      });
    }
    const record = this.toolItems.get(key);
    if (!record || record.done) return;
    const finalItem = {
      ...record.item,
      ...(kind === "custom"
        ? { input: unwrapCustomInput(argumentsText) }
        : { arguments: argumentsText }),
    };
    const doneEvent = kind === "custom"
      ? "response.custom_tool_call_input.done"
      : "response.function_call_arguments.done";
    this.emit(doneEvent, {
      type: doneEvent,
      output_index: record.outputIndex,
      item_id: record.item.id,
      ...(kind === "custom"
        ? { input: finalItem.input }
        : { arguments: finalItem.arguments }),
    });
    this.emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: record.outputIndex,
      item: finalItem,
    });
    record.done = true;
  }

  completed(usage) {
    if (this.terminal) return;
    this.finishOpenItems();
    this.terminal = true;
    this.emit("response.completed", {
      type: "response.completed",
      response: { ...this.response("completed"), usage },
    });
  }

  failed({ code, message }) {
    if (this.terminal) return;
    this.terminal = true;
    this.emit("response.failed", {
      type: "response.failed",
      response: {
        ...this.response("failed"),
        error: { code, message },
      },
    });
  }

  addItem(item) {
    const record = {
      item,
      outputIndex: this.nextOutputIndex,
      done: false,
    };
    this.nextOutputIndex += 1;
    this.emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: record.outputIndex,
      item,
    });
    return record;
  }

  finishOpenItems() {
    for (const record of [this.reasoningItem, this.textItem]) {
      if (!record || record.done) continue;
      const finalItem = record === this.textItem
        ? {
            ...record.item,
            content: [{
              type: "output_text",
              text: record.text,
              annotations: [],
            }],
          }
        : {
            ...record.item,
            summary: [{
              type: "summary_text",
              text: record.text,
            }],
          };
      this.emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: record.outputIndex,
        item: finalItem,
      });
      record.done = true;
    }
  }

  response(status) {
    return {
      id: this.responseId,
      object: "response",
      model: this.model,
      status,
    };
  }
}

function unwrapCustomInput(argumentsText) {
  const parsed = JSON.parse(argumentsText);
  if (typeof parsed.input !== "string") {
    throw new Error("Wrapped custom tool arguments must contain a string input.");
  }
  return parsed.input;
}
