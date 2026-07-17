export async function* iterateSse(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      let boundary = findBoundary(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
        boundary = findBoundary(buffer);
      }

      if (done) break;
    }

    if (buffer.trim()) {
      const parsed = parseFrame(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
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
