import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CatalogEndpoint = {
  category: string;
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  description: string;
};

export type Catalog = {
  base_url: string;
  source: string;
  count: number;
  endpoints: CatalogEndpoint[];
};

const here = dirname(fileURLToPath(import.meta.url));

function loadCatalog(): Catalog {
  // Works from both src/ (dev) and dist/ (prod) when catalog.json is copied beside output.
  const candidates = [
    join(here, "catalog.json"),
    join(here, "..", "src", "catalog.json"),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as Catalog;
    } catch {
      // try next
    }
  }
  throw new Error("Unable to load catalog.json");
}

export const catalog = loadCatalog();

export function listEndpoints(filter?: {
  category?: string;
  search?: string;
}): CatalogEndpoint[] {
  let items = catalog.endpoints;
  if (filter?.category) {
    const category = filter.category.toLowerCase();
    items = items.filter((e) => e.category.toLowerCase() === category);
  }
  if (filter?.search) {
    const q = filter.search.toLowerCase();
    items = items.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.path.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q)
    );
  }
  return items;
}

export function listCategories(): Array<{ category: string; count: number }> {
  const counts = new Map<string, number>();
  for (const endpoint of catalog.endpoints) {
    counts.set(endpoint.category, (counts.get(endpoint.category) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category));
}
