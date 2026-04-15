# datto-saas-mcp

An MCP (Model Context Protocol) server for the [Datto SaaS Protection API](https://saasprotection.datto.com/help/M365/Content/Other_Administrative_Tasks/using-rest-api-saas-protection.htm), focused on reporting and management.

Created by **Juan Carlos Ramirez**.

## Tools

| Tool | Description |
|------|-------------|
| `list_domains` | List all SaaS-protected customer domains — returns `saasCustomerId`, `externalSubscriptionId`, seats used, and backup health percentage per domain |
| `list_seats` | List all licensed seats for a customer (users, shared mailboxes, sites, team sites, teams, shared drives) with seat state and billing status |
| `get_applications` | Backup health report for a single customer — per-app-type history (Exchange, OneDrive, SharePoint, Teams) with Perfect / Good / Fair / Poor status |
| `get_all_applications_report` | Full-fleet backup health report across all customers in one call |
| `get_activity_log` | Filtered activity log — search by client name, user, or target; supports lookbacks up to 30 days with automatic pagination |
| `bulk_seat_change` | Add or remove seats in bulk for a customer subscription |

## Prerequisites

- Node.js 18+
- Datto Partner Portal access to generate API keys

## Setup

### 1. Get API credentials

In the Datto Partner Portal: **Admin > Integrations > API Keys > Create API Key**

You will get a **Public Key** and a **Secret Key**.

### 2. Install and build

```bash
npm install
npm run build
```

## Usage with Claude Code (CLI)

Install directly with a single command — credentials are stored in the MCP config so no shell environment setup is needed:

```bash
claude mcp add datto-saas \
  -e DATTO_PUBLIC_KEY=your_public_key \
  -e DATTO_SECRET_KEY=your_secret_key \
  -- node /path/to/datto-saas-mcp/dist/index.js
```

To verify it was added:

```bash
claude mcp list
```

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "datto-saas": {
      "command": "node",
      "args": ["/path/to/datto-saas-mcp/dist/index.js"],
      "env": {
        "DATTO_PUBLIC_KEY": "your_public_key",
        "DATTO_SECRET_KEY": "your_secret_key"
      }
    }
  }
}
```

## Development

```bash
npm run dev   # run with tsx (no build step needed)
npm run build # compile to dist/
```

## API Rate Limits

- GET requests: 600 per 60-second window
- The server automatically retries once on HTTP 429 (waits 60 s)

## License

MIT
