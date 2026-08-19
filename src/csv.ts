export type CsvLeadRow = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  location?: string;
  local_sports_team?: string;
  /** Smartlead merge field {{vendor}}; brand is a back-compat CSV alias. */
  vendor?: string;
  job_title?: string;
};

const HEADER_ALIASES: Record<keyof Omit<CsvLeadRow, "email"> | "email", string[]> = {
  email: ["email", "email_address", "e-mail", "mail"],
  first_name: ["first_name", "firstname", "first name", "first", "fname"],
  last_name: ["last_name", "lastname", "last name", "last", "lname"],
  company_name: [
    "company_name",
    "company",
    "company name",
    "organization",
    "org",
  ],
  location: ["location", "city", "city_state", "geo", "region"],
  local_sports_team: [
    "local_sports_team",
    "local sports team",
    "localsportsteam",
    "sports_team",
    "sports team",
    "team",
  ],
  // Prefer an explicit vendor column; brand is accepted as a back-compat alias.
  vendor: ["vendor", "brand"],
  job_title: [
    "job_title",
    "job title",
    "jobtitle",
    "title",
    "position",
  ],
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/^\uFEFF/, "");
}

/** RFC-style CSV parse supporting quotes and commas inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      // skip empty trailing lines
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
    } else if (ch === "\r") {
      // ignore; handle on \n
    } else {
      field += ch;
    }
  }

  // last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  }

  return rows;
}

function mapHeaders(headerRow: string[]): Partial<Record<keyof CsvLeadRow, number>> {
  const map: Partial<Record<keyof CsvLeadRow, number>> = {};
  const normalized = headerRow.map(normalizeHeader);

  (Object.keys(HEADER_ALIASES) as Array<keyof typeof HEADER_ALIASES>).forEach(
    (key) => {
      const aliases = HEADER_ALIASES[key];
      const idx = normalized.findIndex((h) => aliases.includes(h));
      if (idx >= 0) map[key] = idx;
    }
  );

  return map;
}

export function csvToLeadRows(csvText: string): {
  rows: CsvLeadRow[];
  skipped: number;
  total_data_rows: number;
} {
  const table = parseCsv(csvText);
  if (table.length === 0) {
    return { rows: [], skipped: 0, total_data_rows: 0 };
  }

  const headerMap = mapHeaders(table[0]);
  if (headerMap.email === undefined) {
    throw new Error(
      `CSV is missing an email column. Found headers: ${table[0].join(", ")}`
    );
  }

  const rows: CsvLeadRow[] = [];
  let skipped = 0;

  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    const email = (cells[headerMap.email] || "").trim();
    if (!email || !email.includes("@")) {
      skipped += 1;
      continue;
    }

    const pick = (key: keyof Omit<CsvLeadRow, "email">): string | undefined => {
      const idx = headerMap[key];
      if (idx === undefined) return undefined;
      const value = (cells[idx] || "").trim();
      return value || undefined;
    };

    rows.push({
      email,
      first_name: pick("first_name"),
      last_name: pick("last_name"),
      company_name: pick("company_name"),
      location: pick("location"),
      local_sports_team: pick("local_sports_team"),
      vendor: pick("vendor"),
      job_title: pick("job_title"),
    });
  }

  return {
    rows,
    skipped,
    total_data_rows: Math.max(0, table.length - 1),
  };
}
