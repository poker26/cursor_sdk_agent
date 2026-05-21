export function isSupabaseBrainEnabled(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_KEY?.trim(),
  );
}

export function isQdrantBrainEnabled(): boolean {
  return Boolean(process.env.QDRANT_URL?.trim());
}

export function getBgeM3ServiceUrl(): string | undefined {
  const baseUrl =
    process.env.BGE_M3_URL?.trim() || process.env.EMBEDDING_SERVICE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }

  const portValue = process.env.BGE_M3_PORT?.trim();
  if (!portValue) {
    return baseUrl.replace(/\/$/, "");
  }

  try {
    const parsedUrl = new URL(baseUrl.includes("://") ? baseUrl : `http://${baseUrl}`);
    parsedUrl.port = portValue;
    return parsedUrl.toString().replace(/\/$/, "");
  } catch {
    const withoutTrailingSlash = baseUrl.replace(/\/$/, "");
    if (/:\d+$/.test(withoutTrailingSlash)) {
      return withoutTrailingSlash;
    }
    return `${withoutTrailingSlash}:${portValue}`;
  }
}

export function isBgeM3EmbeddingEnabled(): boolean {
  return Boolean(getBgeM3ServiceUrl());
}

export function isEmbeddingEnabled(): boolean {
  return (
    isBgeM3EmbeddingEnabled() ||
    Boolean(
      process.env.OPENAI_API_KEY?.trim() ||
        process.env.EMBEDDING_API_KEY?.trim() ||
        process.env.EMBEDDING_BASE_URL?.trim(),
    )
  );
}

export function getEmbeddingProviderLabel(): string {
  if (isBgeM3EmbeddingEnabled()) {
    return "bge-m3";
  }
  if (process.env.EMBEDDING_BASE_URL?.trim() || process.env.EMBEDDING_API_KEY?.trim()) {
    return "openai-compatible";
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return "openai";
  }
  return "none";
}

export function getQdrantCollectionName(workspaceId: string): string {
  const safeId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `brain_${safeId}`;
}

export function getEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL?.trim() || "bge-m3";
}

export function getEmbeddingDimensions(): number {
  const parsed = Number.parseInt(process.env.EMBEDDING_DIMENSIONS || "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  if (isBgeM3EmbeddingEnabled()) {
    return 1024;
  }
  return 1536;
}
