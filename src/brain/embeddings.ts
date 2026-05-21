import { getEmbeddingDimensions, getEmbeddingModel, isEmbeddingEnabled } from "./config.js";

export interface EmbeddingVector {
  values: number[];
}

export async function embedTextChunks(textChunks: string[]): Promise<EmbeddingVector[]> {
  if (!isEmbeddingEnabled() || textChunks.length === 0) {
    return [];
  }

  const apiKey =
    process.env.EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return [];
  }

  const baseUrl =
    process.env.EMBEDDING_BASE_URL?.trim() || "https://api.openai.com/v1";
  const modelId = getEmbeddingModel();
  const endpointUrl = `${baseUrl.replace(/\/$/, "")}/embeddings`;

  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      input: textChunks,
      dimensions: getEmbeddingDimensions(),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Embedding API ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const responseJson = (await response.json()) as {
    data?: Array<{ embedding: number[] }>;
  };
  const rows = responseJson.data ?? [];
  return rows.map((row) => ({ values: row.embedding }));
}

export function chunkTextForEmbedding(text: string, maxChunkChars = 1200): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let buffer = "";

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) {
      continue;
    }
    if (`${buffer}\n\n${trimmedParagraph}`.length <= maxChunkChars) {
      buffer = buffer ? `${buffer}\n\n${trimmedParagraph}` : trimmedParagraph;
      continue;
    }
    if (buffer) {
      chunks.push(buffer);
    }
    if (trimmedParagraph.length <= maxChunkChars) {
      buffer = trimmedParagraph;
    } else {
      for (let offset = 0; offset < trimmedParagraph.length; offset += maxChunkChars) {
        chunks.push(trimmedParagraph.slice(offset, offset + maxChunkChars));
      }
      buffer = "";
    }
  }
  if (buffer) {
    chunks.push(buffer);
  }
  return chunks;
}
