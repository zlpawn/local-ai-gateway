const IMAGE_ERROR_PATTERNS = [
  /image (?:input )?is not supported/i,
  /images? (?:are|is) not supported/i,
  /unsupported (?:input )?modality[^]*image/i,
  /multimodal (?:input )?(?:is )?(?:not supported|unsupported)/i,
  /vision (?:is )?not supported/i,
  /does not support[^]*image/i,
  /only supports? text input/i,
];

export function isVisionFallbackEndpoint(endpoint) {
  return endpoint?.purpose === "vision_fallback";
}

export function selectVisionFallback(endpoints = []) {
  const endpoint = endpoints.find((item) =>
    isVisionFallbackEndpoint(item)
    && item.vision_fallback_enabled !== false
    && String(item.vision_model || "").trim()
    && (item.models || []).includes(item.vision_model),
  );
  return endpoint ? { endpoint, model: endpoint.vision_model } : null;
}

export function shouldPreprocessImages({ endpoint, upstreamModel }) {
  const modelValue = endpoint?.model_capabilities?.[upstreamModel]?.image;
  if (modelValue === false) return true;
  return Array.isArray(endpoint?.capabilities?.input_modalities)
    && !endpoint.capabilities.input_modalities.includes("image");
}

export function containsImages(value) {
  if (!value || typeof value !== "object") return false;
  if (isImagePart(value)) return true;
  return Object.values(value).some(containsImages);
}

export function collectImages(value, images = []) {
  if (!value || typeof value !== "object") return images;
  if (isImagePart(value)) {
    images.push(value);
    return images;
  }
  for (const child of Object.values(value)) collectImages(child, images);
  return images;
}

export function replaceImagesWithDescription(body, description) {
  let inserted = false;
  const visit = (value) => {
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) {
        if (isImagePart(item)) {
          if (!inserted) {
            result.push(textPartForImage(item, `[视觉兜底解析结果]\n${description}`));
            inserted = true;
          }
        } else {
          result.push(visit(item));
        }
      }
      return result;
    }
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = visit(child);
    return result;
  };
  return visit(structuredClone(body));
}

export function isImageCapabilityError(status, text) {
  if (Number(status) < 400 || Number(status) >= 500) return false;
  return IMAGE_ERROR_PATTERNS.some((pattern) => pattern.test(String(text || "")));
}

export function imagePartToUrl(part) {
  if (part?.type === "image") {
    const source = part.source || {};
    if (source.type === "base64" && source.data) {
      return `data:${source.media_type || "image/png"};base64,${source.data}`;
    }
    if (source.type === "url" && source.url) return String(source.url);
  }
  if (part?.type === "image_url") {
    return String(typeof part.image_url === "string" ? part.image_url : part.image_url?.url || "");
  }
  if (part?.type === "input_image") return String(part.image_url || part.url || "");
  return "";
}

function isImagePart(part) {
  return part?.type === "image"
    || part?.type === "image_url"
    || part?.type === "input_image";
}

function textPartForImage(part, text) {
  if (part.type === "input_image") return { type: "input_text", text };
  return { type: "text", text };
}
