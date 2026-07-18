const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

export async function pipeResponsesSsePassthrough({
  readable,
  write,
  end,
  model = null,
  responseId = null,
}) {
  let sawTerminal = false;
  let observedResponseId = responseId;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = readable.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        write(Buffer.from(value));
        buffer += decoder.decode(value, { stream: !done });
        ({ buffer, sawTerminal, observedResponseId } = consumeFrames(
          buffer,
          sawTerminal,
          observedResponseId,
        ));
      }
      if (done) break;
    }

    if (buffer) {
      buffer += decoder.decode();
      ({ buffer, sawTerminal, observedResponseId } = consumeFrames(
        buffer,
        sawTerminal,
        observedResponseId,
        true,
      ));
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawTerminal) {
    const failedId = observedResponseId || `resp_${Date.now()}`;
    const payload = {
      type: "response.failed",
      response: {
        id: failedId,
        object: "response",
        model,
        status: "failed",
        error: {
          code: "upstream_stream_closed",
          message: "Responses upstream closed without a terminal event.",
        },
      },
    };
    write(Buffer.from(
      `event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`,
    ));
  }

  end();
  return { sawTerminal, responseId: observedResponseId };
}

function consumeFrames(buffer, sawTerminal, responseId, flush = false) {
  let nextTerminal = sawTerminal;
  let nextResponseId = responseId;
  let rest = buffer;

  let boundary = findBoundary(rest);
  while (boundary) {
    const frame = rest.slice(0, boundary.index);
    rest = rest.slice(boundary.index + boundary.length);
    const parsed = parseFrame(frame);
    if (parsed) {
      ({ sawTerminal: nextTerminal, responseId: nextResponseId } = inspectFrame(
        parsed,
        nextTerminal,
        nextResponseId,
      ));
    }
    boundary = findBoundary(rest);
  }

  if (flush && rest.trim()) {
    const parsed = parseFrame(rest);
    rest = "";
    if (parsed) {
      ({ sawTerminal: nextTerminal, responseId: nextResponseId } = inspectFrame(
        parsed,
        nextTerminal,
        nextResponseId,
      ));
    }
  }

  return {
    buffer: rest,
    sawTerminal: nextTerminal,
    observedResponseId: nextResponseId,
  };
}

function inspectFrame(frame, sawTerminal, responseId) {
  let nextTerminal = sawTerminal;
  let nextResponseId = responseId;
  const eventName = frame.event || "message";
  let payloadType = "";
  let payload = null;

  if (frame.data && frame.data !== "[DONE]") {
    try {
      payload = JSON.parse(frame.data);
      payloadType = payload?.type || "";
      if (!nextResponseId) {
        nextResponseId = payload?.response?.id || payload?.id || nextResponseId;
      }
    } catch {
      // Keep passthrough even when a frame is not JSON.
    }
  }

  if (
    TERMINAL_EVENTS.has(eventName)
    || TERMINAL_EVENTS.has(payloadType)
  ) {
    nextTerminal = true;
  }

  return {
    sawTerminal: nextTerminal,
    responseId: nextResponseId,
  };
}

function findBoundary(buffer) {
  const match = /\r\n\r\n|\n\n/.exec(buffer);
  return match && { index: match.index, length: match[0].length };
}

function parseFrame(frame) {
  let event = "message";
  const data = [];
  for (const rawLine of frame.replaceAll("\r\n", "\n").split("\n")) {
    if (rawLine.startsWith("event:")) event = rawLine.slice(6).trim();
    if (rawLine.startsWith("data:")) data.push(rawLine.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}
