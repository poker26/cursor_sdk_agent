export function isSupabaseBrainEnabled(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_KEY?.trim(),
  );
}

export function isQdrantBrainEnabled(): boolean {
  return Boolean(process.env.QDRANT_URL?.trim());
}

export function isEmbeddingEnabled(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY?.trim() ||
      process.env.EMBEDDING_API_KEY?.trim() ||
      process.env.EMBEDDING_BASE_URL?.trim(),
  );
}

export function getQdrantCollectionName(workspaceId: string): string {
  const safeId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `brain_${safeId}`;
}

export function getEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
}

export function getEmbeddingDimensions(): number {
  const parsed = Number.parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1536;
}
