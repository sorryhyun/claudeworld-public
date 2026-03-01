export interface ImageData {
  data: string; // Base64 encoded (without data URL prefix)
  mediaType: string; // MIME type
  preview: string; // Full data URL for preview
}

export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB max

export function fileToBase64(file: File): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64Data = result.split(",")[1];
      resolve({
        data: base64Data,
        mediaType: file.type,
        preview: result,
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
