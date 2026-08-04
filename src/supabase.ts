type QueryResult<T> = {
  data: T | null;
  error: { message: string } | null;
  count?: number | null;
};

function supabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set on this service"
    );
  }
  return { url, key };
}

async function rest<T>(
  pathAndQuery: string,
  init: RequestInit & { prefer?: string } = {}
): Promise<QueryResult<T>> {
  const { url, key } = supabaseConfig();
  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (init.prefer) headers.Prefer = init.prefer;

  const response = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string>) },
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data &&
      "message" in data &&
      typeof (data as { message: unknown }).message === "string"
        ? (data as { message: string }).message
        : typeof data === "string"
          ? data
          : JSON.stringify(data);
    return { data: null, error: { message }, count: null };
  }

  const countHeader = response.headers.get("content-range");
  let count: number | null = null;
  if (countHeader && countHeader.includes("/")) {
    const total = countHeader.split("/")[1];
    if (total && total !== "*") count = Number(total);
  }

  return { data: data as T, error: null, count };
}

/** Minimal PostgREST helper — no realtime/WebSocket dependency. */
export const db = {
  async countExact(
    table: string,
    filters: string
  ): Promise<QueryResult<null>> {
    return rest<null>(`${table}?${filters}`, {
      method: "GET",
      headers: { Prefer: "count=exact" },
      prefer: "count=exact",
    });
  },

  async select<T>(
    table: string,
    query: string
  ): Promise<QueryResult<T>> {
    return rest<T>(`${table}?${query}`, { method: "GET" });
  },

  async insert<T>(
    table: string,
    row: Record<string, unknown> | Record<string, unknown>[],
    options?: { returnRepresentation?: boolean }
  ): Promise<QueryResult<T>> {
    const prefer = options?.returnRepresentation
      ? "return=representation"
      : "return=minimal";
    return rest<T>(table, {
      method: "POST",
      prefer,
      body: JSON.stringify(row),
    });
  },

  async update(
    table: string,
    filters: string,
    patch: Record<string, unknown>
  ): Promise<QueryResult<null>> {
    return rest<null>(`${table}?${filters}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify(patch),
    });
  },
};

/** @deprecated kept for call-site clarity; prefer `db`. */
export function getSupabase() {
  return db;
}
