# Smartlead MCP Server

Persistent [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the [Smartlead API](https://server.smartlead.ai/api/v1) for use as a Claude custom connector.

## Tools

| Tool | Smartlead endpoint |
|------|--------------------|
| `create_campaign` | `POST /campaigns/create` |
| `upload_sequence` | `POST /campaigns/{id}/sequences` |
| `link_mailboxes` | `POST /campaigns/{id}/email-accounts` |
| `import_leads` | `POST /campaigns/{id}/leads` (auto-chunks at 400) |
| `set_schedule` | `POST /campaigns/{id}/schedule` |
| `update_campaign_status` | `PATCH /campaigns/{id}/status` |
| `get_campaign_analytics` | `GET /campaigns/{id}/analytics` |

`import_leads` automatically batches into chunks of 400 (Smartlead's hard limit), waits briefly between chunks, retries `429` responses with exponential backoff, and returns a summary of total leads plus any failed chunks.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SMARTLEAD_API_KEY` | Yes | Smartlead API key (`?api_key=` query param) |
| `PORT` | No | HTTP port (default `3000`; Railway injects this) |

## Local development

```bash
npm install
npm run build
export SMARTLEAD_API_KEY=your_key
npm start
```

MCP endpoint: `http://localhost:3000/mcp` (Streamable HTTP).

## Deploy on Railway

This service must stay running (not a cron job) so Claude can open MCP connections.

```bash
railway up -y
railway variable set SMARTLEAD_API_KEY=your_key
railway domain
```

Add the public URL + `/mcp` as a custom connector in Claude (**Settings → Connectors**).

## Claude connector URL

Production (Railway):

```
https://workspace-production-9629.up.railway.app/mcp
```

Add that URL under Claude **Settings → Connectors** as a custom connector.
