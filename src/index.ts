import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { catalog, listCategories } from "./catalog.js";
import { registerTools } from "./tools.js";

function createServer(): McpServer {
  const server = new McpServer({
    name: "smartlead-mcp",
    version: "1.1.0",
  });
  registerTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/", (_req, res) => {
  res.json({
    name: "smartlead-mcp",
    version: "1.1.0",
    mcp: "/mcp",
    status: "ok",
    catalog: {
      endpoint_count: catalog.count,
      categories: listCategories(),
    },
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/catalog", (_req, res) => {
  res.json(catalog);
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use POST for Streamable HTTP MCP.",
    },
    id: null,
  });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Smartlead MCP server listening on 0.0.0.0:${port}`);
  console.log(`MCP endpoint: http://0.0.0.0:${port}/mcp`);
  console.log(`Catalog endpoints: ${catalog.count}`);
});
