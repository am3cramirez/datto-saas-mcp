# datto-saas-mcp

An MCP (Model Context Protocol) server for the [Datto SaaS Protection API](https://saasprotection.datto.com/help/M365/Content/Other_Administrative_Tasks/using-rest-api-saas-protection.htm), focused on reporting.

## Tools

| Tool | Description |
|------|-------------|
| `list_domains` | List all SaaS-protected customer domains (returns `saasCustomerId` + `externalSubscriptionId`) |
| `list_seats` | List all licensed seats for a customer (users, mailboxes, sites, teams) |
| `get_applications` | Backup health report for a single customer — the primary reporting endpoint |
| `get_all_applications_report` | Full-fleet backup health report across all customers in one call |

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

### 3. Configure credentials

The server reads credentials from environment variables:

```bash
export DATTO_PUBLIC_KEY=your_public_key
export DATTO_SECRET_KEY=your_secret_key
```

Or copy `.env.example` to `.env` and fill in your keys (use a tool like `dotenv` or your shell's env loading).

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

## Usage with Claude Code (CLI)

```bash
claude mcp add datto-saas -- node /path/to/datto-saas-mcp/dist/index.js
```

Then set the env vars in your shell before starting Claude Code, or add them to the MCP config.

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
