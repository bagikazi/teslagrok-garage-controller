# Voice assistant (Grok) over MCP

The API includes a small [Model Context Protocol](https://modelcontextprotocol.io)
server so a voice assistant, for example Grok in a car, can read the door state and
send door commands. It is implemented in `server/api/src/mcp.ts` and mounted in
`server/api/src/app.ts`.

There is no direct link between the car and the garage. The assistant calls the
API over HTTPS; the API publishes the command on MQTT exactly like the web panel
does, and the ESP32-S3 still checks its own sensors before pulsing a relay.

```
Grok (car) --HTTPS + token--> /api/mcp --> API --MQTT/TLS--> ESP32-S3 --> relay
```

## Enable it

Set these in `.env` (or the API's environment):

| Variable | Meaning |
| --- | --- |
| `MCP_TOKEN` | Secret, at least 32 characters. Empty disables `/api/mcp` entirely (404). Generate one with `openssl rand -hex 32`. |
| `MCP_OPEN_PIN` | Optional 4-8 digit PIN the user must say before the door opens. |

The endpoint is stateless Streamable HTTP, JSON only (no SSE stream):

- `POST /api/mcp` with `Authorization: Bearer <MCP_TOKEN>`, or
- `POST /api/mcp/<MCP_TOKEN>` for clients whose connector dialog only accepts a URL
  (Grok's custom connector is one). Request logs mask the token in the path.

`GET` and `DELETE` return 405. The route is rate-limited to 30 requests per minute.

## Connect Grok

In Grok, add a custom connector (MCP) with the URL:

```
https://<your-domain>/api/mcp/<MCP_TOKEN>
```

Treat that URL as a password: anyone holding it can open your garage (subject to
the PIN, if you set one).

## Tools

| Tool | What it does |
| --- | --- |
| `garage_status` | Says whether the door is open, closed, moving, or the controller is offline. |
| `garage_open` | Opens the door. With `MCP_OPEN_PIN` set it requires a `pin` argument; after 5 wrong PINs opening is locked for 15 minutes. |
| `garage_close` | Closes the door. The controller refuses if the doorway sensor reports an obstacle. |
| `garage_stop` | Stops a moving door. |

Replies are short Turkish sentences meant to be read aloud; change `STATE_TEXT`
and `ACTION_TEXT` in `mcp.ts` for another language.

## Try it with curl

```bash
TOKEN=...   # your MCP_TOKEN
curl -s https://<your-domain>/api/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"garage_status","arguments":{}}}'
```
