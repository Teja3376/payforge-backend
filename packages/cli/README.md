# @payforge/cli

Local development toolkit for PayForge integrations.

```bash
npm install -g @payforge/cli
```

## Commands

| Command | What it does |
| --- | --- |
| `payforge login` | Stores an API key in `~/.payforge/config.json` (mode 0600) and verifies it |
| `payforge doctor` | Checks your key and the API's health together |
| `payforge cards` | Prints test card numbers |
| `payforge webhook verify '<signed-header>' --secret <secret>` | Verifies a signature exactly as `@payforge/node` does |
| `payforge listen` | *Stub.* Needs a tunnel daemon; use `ngrok http 3000` instead |

## Forwarding webhooks locally

```bash
ngrok http 3000
# then register the https URL it prints as a webhook endpoint
```
