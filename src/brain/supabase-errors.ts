export function formatSupabaseTransportError(operation: string, error: unknown): string {
  const parts: string[] = [`Supabase ${operation}: fetch failed`];
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  if (supabaseUrl) {
    parts.push(`URL=${supabaseUrl}`);
  }

  if (error instanceof Error) {
    if (error.message && error.message !== "fetch failed") {
      parts.push(error.message);
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      parts.push(`cause=${cause.message}`);
      const code = (cause as NodeJS.ErrnoException).code;
      if (code) {
        parts.push(`code=${code}`);
      }
    }
  }

  parts.push(
    "Проверьте: SUPABASE_URL доступен с этого сервера (curl /rest/v1/), не localhost другой машины, TLS/файрвол.",
  );
  return parts.join(" — ");
}

export function throwSupabaseTransportError(operation: string, error: unknown): never {
  throw new Error(formatSupabaseTransportError(operation, error));
}
