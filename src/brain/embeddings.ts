import {
  getBgeM3ServiceUrl,
  getEmbeddingDimensions,
  getEmbeddingModel,
  isBgeM3EmbeddingEnabled,
  isEmbeddingEnabled,
} from "./config.js";

export interface EmbeddingVector {
  values: number[];
}

function extractVectorFromUnknown(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (value.length === 0) {
    return undefined;
  }
  if (typeof value[0] === "number") {
    return value as number[];
  }
  if (Array.isArray(value[0])) {
    return value[0] as number[];
  }
  return undefined;
}

function parseOpenAiStyleEmbeddingResponse(responseJson: unknown): EmbeddingVector[] {
  if (typeof responseJson !== "object" || responseJson === null) {
    return [];
  }
  const record = responseJson as Record<string, unknown>;
  const dataRows = record.data;
  if (Array.isArray(dataRows)) {
    const vectors: EmbeddingVector[] = [];
    for (const row of dataRows) {
      if (typeof row === "object" && row !== null && "embedding" in row) {
        const embedding = extractVectorFromUnknown((row as { embedding: unknown }).embedding);
        if (embedding) {
          vectors.push({ values: embedding });
        }
      }
    }
    if (vectors.length > 0) {
      return vectors;
    }
  }
  const directEmbedding = extractVectorFromUnknown(record.embedding);
  if (directEmbedding) {
    return [{ values: directEmbedding }];
  }
  return [];
}

function parseTeiStyleEmbeddingResponse(responseJson: unknown): EmbeddingVector[] {
  if (Array.isArray(responseJson)) {
    const vectors: EmbeddingVector[] = [];
    for (const row of responseJson) {
      const embedding = extractVectorFromUnknown(row);
      if (embedding) {
        vectors.push({ values: embedding });
      }
    }
    if (vectors.length > 0) {
      return vectors;
    }
  }
  if (typeof responseJson === "object" && responseJson !== null) {
    const record = responseJson as Record<string, unknown>;
    const embeddings = record.embeddings;
    if (Array.isArray(embeddings)) {
      const vectors: EmbeddingVector[] = [];
      for (const row of embeddings) {
        const embedding = extractVectorFromUnknown(row);
        if (embedding) {
          vectors.push({ values: embedding });
        }
      }
      if (vectors.length > 0) {
        return vectors;
      }
    }
    const single = extractVectorFromUnknown(record.embedding);
    if (single) {
      return [{ values: single }];
    }
  }
  return [];
}

async function embedSingleChunkViaBgeM3(
  serviceUrl: string,
  textChunk: string,
): Promise<EmbeddingVector> {
  const modelId = getEmbeddingModel();

  const openAiResponse = await fetch(`${serviceUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: textChunk,
      model: modelId,
      encoding_format: "float",
    }),
  });
  if (openAiResponse.ok) {
    const vectors = parseOpenAiStyleEmbeddingResponse(await openAiResponse.json());
    if (vectors.length > 0) {
      return vectors[0];
    }
  }

  const teiResponse = await fetch(`${serviceUrl}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: textChunk }),
  });
  if (teiResponse.ok) {
    const vectors = parseTeiStyleEmbeddingResponse(await teiResponse.json());
    if (vectors.length > 0) {
      return vectors[0];
    }
  }

  const openAiError = openAiResponse.ok ? "" : await openAiResponse.text();
  const teiError = teiResponse.ok ? "" : await teiResponse.text();
  throw new Error(
    `BGE-M3 (${serviceUrl}): /v1/embeddings ${openAiResponse.status} ${openAiError.slice(0, 200)}; /embed ${teiResponse.status} ${teiError.slice(0, 200)}`,
  );
}

async function embedTextChunksViaBgeM3(textChunks: string[]): Promise<EmbeddingVector[]> {
  const serviceUrl = getBgeM3ServiceUrl();
  if (!serviceUrl) {
    return [];
  }

  const modelId = getEmbeddingModel();
  const batchResponse = await fetch(`${serviceUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: textChunks,
      model: modelId,
      encoding_format: "float",
    }),
  });
  if (batchResponse.ok) {
    const vectors = parseOpenAiStyleEmbeddingResponse(await batchResponse.json());
    if (vectors.length === textChunks.length) {
      return vectors;
    }
  }

  const vectors: EmbeddingVector[] = [];
  for (const textChunk of textChunks) {
    vectors.push(await embedSingleChunkViaBgeM3(serviceUrl, textChunk));
  }
  return vectors;
}

async function embedTextChunksViaOpenAiCompatible(
  textChunks: string[],
): Promise<EmbeddingVector[]> {
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

  return parseOpenAiStyleEmbeddingResponse(await response.json());
}

export async function embedTextChunks(textChunks: string[]): Promise<EmbeddingVector[]> {
  if (!isEmbeddingEnabled() || textChunks.length === 0) {
    return [];
  }

  if (isBgeM3EmbeddingEnabled()) {
    return embedTextChunksViaBgeM3(textChunks);
  }

  return embedTextChunksViaOpenAiCompatible(textChunks);
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
