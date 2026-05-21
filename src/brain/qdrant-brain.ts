import { randomUUID } from "node:crypto";
import { chunkTextForEmbedding, embedTextChunks } from "./embeddings.js";
import {
  getEmbeddingDimensions,
  getQdrantCollectionName,
  isEmbeddingEnabled,
  isQdrantBrainEnabled,
} from "./config.js";

export interface QdrantSearchHit {
  score: number;
  text: string;
  source: string;
}

function getQdrantBaseUrl(): string {
  return (process.env.QDRANT_URL?.trim() ?? "").replace(/\/$/, "");
}

function getQdrantHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.QDRANT_API_KEY?.trim();
  if (apiKey) {
    headers["api-key"] = apiKey;
  }
  return headers;
}

async function qdrantRequest(
  method: string,
  relativePath: string,
  body?: unknown,
): Promise<Response> {
  const url = `${getQdrantBaseUrl()}${relativePath}`;
  return fetch(url, {
    method,
    headers: getQdrantHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function ensureQdrantCollection(workspaceId: string): Promise<void> {
  if (!isQdrantBrainEnabled() || !isEmbeddingEnabled()) {
    return;
  }
  const collectionName = getQdrantCollectionName(workspaceId);
  const existingResponse = await qdrantRequest("GET", `/collections/${collectionName}`);
  if (existingResponse.ok) {
    return;
  }
  const dimensions = getEmbeddingDimensions();
  const createResponse = await qdrantRequest("PUT", `/collections/${collectionName}`, {
    vectors: {
      size: dimensions,
      distance: "Cosine",
    },
  });
  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`Qdrant create collection: ${createResponse.status} ${errorText}`);
  }
}

export async function upsertQdrantChunks(
  workspaceId: string,
  chunks: Array<{ text: string; source: string; eventId?: string }>,
): Promise<void> {
  if (!isQdrantBrainEnabled() || !isEmbeddingEnabled() || chunks.length === 0) {
    return;
  }
  await ensureQdrantCollection(workspaceId);
  const collectionName = getQdrantCollectionName(workspaceId);
  const texts = chunks.map((chunk) => chunk.text);
  const embeddings = await embedTextChunks(texts);
  if (embeddings.length !== chunks.length) {
    throw new Error("Embedding count mismatch for Qdrant upsert.");
  }

  const points = chunks.map((chunk, index) => ({
    id: randomUUID(),
    vector: embeddings[index].values,
    payload: {
      text: chunk.text,
      source: chunk.source,
      workspace_id: workspaceId,
      event_id: chunk.eventId ?? null,
    },
  }));

  const upsertResponse = await qdrantRequest(
    "PUT",
    `/collections/${collectionName}/points?wait=true`,
    { points },
  );
  if (!upsertResponse.ok) {
    const errorText = await upsertResponse.text();
    throw new Error(`Qdrant upsert: ${upsertResponse.status} ${errorText}`);
  }
}

export async function searchQdrantBrain(
  workspaceId: string,
  queryText: string,
  topK = 6,
): Promise<QdrantSearchHit[]> {
  if (!isQdrantBrainEnabled() || !isEmbeddingEnabled() || !queryText.trim()) {
    return [];
  }
  await ensureQdrantCollection(workspaceId);
  const collectionName = getQdrantCollectionName(workspaceId);
  const queryEmbeddings = await embedTextChunks([queryText]);
  if (queryEmbeddings.length === 0) {
    return [];
  }

  const searchResponse = await qdrantRequest(
    "POST",
    `/collections/${collectionName}/points/search`,
    {
      vector: queryEmbeddings[0].values,
      limit: topK,
      with_payload: true,
    },
  );
  if (!searchResponse.ok) {
    const errorText = await searchResponse.text();
    throw new Error(`Qdrant search: ${searchResponse.status} ${errorText}`);
  }

  const searchJson = (await searchResponse.json()) as {
    result?: Array<{ score: number; payload?: { text?: string; source?: string } }>;
  };
  const hits: QdrantSearchHit[] = [];
  for (const row of searchJson.result ?? []) {
    const text = row.payload?.text ?? "";
    if (!text.trim()) {
      continue;
    }
    hits.push({
      score: row.score,
      text: text.trim(),
      source: row.payload?.source ?? "unknown",
    });
  }
  return hits;
}

export async function deleteQdrantCollection(workspaceId: string): Promise<void> {
  if (!isQdrantBrainEnabled()) {
    return;
  }
  const collectionName = getQdrantCollectionName(workspaceId);
  await qdrantRequest("DELETE", `/collections/${collectionName}`);
}

export async function backfillQdrantFromTexts(
  workspaceId: string,
  documents: Array<{ text: string; source: string; eventId?: string }>,
): Promise<number> {
  const allChunks: Array<{ text: string; source: string; eventId?: string }> = [];
  for (const document of documents) {
    const textChunks = chunkTextForEmbedding(document.text);
    for (const chunkText of textChunks) {
      allChunks.push({
        text: chunkText,
        source: document.source,
        eventId: document.eventId,
      });
    }
  }
  const batchSize = 32;
  let upserted = 0;
  for (let offset = 0; offset < allChunks.length; offset += batchSize) {
    const batch = allChunks.slice(offset, offset + batchSize);
    await upsertQdrantChunks(workspaceId, batch);
    upserted += batch.length;
  }
  return upserted;
}
