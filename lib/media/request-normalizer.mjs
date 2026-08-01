import fs from "node:fs";
import path from "node:path";

const MAX_REFERENCE_IMAGES = 3;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

export function normalizeMediaReferenceImages(body) {
  const imagePaths = body?.image_paths;
  if (imagePaths == null) return { ...body };
  if (!Array.isArray(imagePaths)) throw mediaReferenceError("image_paths must be an array of local image file paths.");
  if (imagePaths.length > MAX_REFERENCE_IMAGES) throw mediaReferenceError(`At most ${MAX_REFERENCE_IMAGES} reference images are supported.`);

  const imageB64List = [];
  const imageMimeTypes = [];
  for (const requestedPath of imagePaths) {
    if (typeof requestedPath !== "string" || !requestedPath.trim()) {
      throw mediaReferenceError("Each image_paths entry must be a non-empty local image file path.");
    }
    const filePath = path.resolve(requestedPath);
    const extension = path.extname(filePath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES.get(extension);
    if (!mimeType) throw mediaReferenceError(`Reference path '${requestedPath}' is not a supported image file.`);
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      throw mediaReferenceError(`Reference image '${requestedPath}' does not exist or cannot be read.`);
    }
    if (!stats.isFile()) throw mediaReferenceError(`Reference image '${requestedPath}' is not a file.`);
    if (stats.size <= 0) throw mediaReferenceError(`Reference image '${requestedPath}' is empty.`);
    if (stats.size > MAX_REFERENCE_IMAGE_BYTES) {
      throw mediaReferenceError(`Reference image '${requestedPath}' exceeds the ${MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024} MB limit.`);
    }
    try {
      imageB64List.push(fs.readFileSync(filePath).toString("base64"));
      imageMimeTypes.push(mimeType);
    } catch {
      throw mediaReferenceError(`Reference image '${requestedPath}' cannot be read.`);
    }
  }
  return { ...body, image_paths: imagePaths, imageB64List, imageMimeTypes };
}

function mediaReferenceError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
