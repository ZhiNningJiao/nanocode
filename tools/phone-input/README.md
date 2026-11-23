# Phone input board

Dictate on the phone (any voice keyboard) into a chat group that only you and
the bot are in; about a second later the text is pasted at the cursor on your
Windows desktop. Made for a desktop without a microphone.

- Plain message → pasted, no Enter. A message ending in `回车` → the word is
  removed, the rest pasted, then Enter is pressed (`回车` alone = just Enter).
- The bot reacts on the message once the desktop answered: ✅ pasted,
  ❌ not pasted (screen locked, Windows client not running, or the message
  arrived while this tool was down — it is never pasted late).

## Two halves

| | runs where | does |
|---|---|---|
| `phone-input.mjs` | WSL / Linux, systemd user unit | polls the group with `lark-cli`, filters (owner, text only), dedupes, keeps a short in-memory queue, serves it on `127.0.0.1` |
| `phone-input-client.ps1` | Windows, your logon session (scheduled task at logon) | long-polls `GET /next`, sets the clipboard, `Ctrl+V` (+ `Enter`), `POST /ack` |

WSL2 forwards Windows `localhost` into WSL, so the client reaches the WSL half
on `127.0.0.1:<port>` with no firewall or port opening. Both halves share a key
(header `X-Phone-Input-Key`); the WSL half answers 401 without it.

Why polling and not the chat event stream: the event stream hands each event
to only one of the bot's connections, so a second subscriber would steal
messages from any other process that already subscribes with the same bot.

## Files and privacy

- `config/phone-input.local.json` (gitignored; see `config/phone-input.example.json`).
- Key file (default `~/.config/phone-input/key`, ≥ 32 chars, chmod 600).
- State file: seen message ids + last successful poll time. Never text.
- Logs: message id, length, timings, result. Never text. The Windows client
  keeps no log and writes the text nowhere but the clipboard.

## Self checks (read-only)

    node tools/phone-input/phone-input.mjs --config config/phone-input.local.json --self-check
    powershell -NoProfile -Sta -ExecutionPolicy Bypass -File phone-input-client.ps1 -SelfCheck

The first lists the group once and prints counts; the second prints the
PowerShell version, whether the desktop can take a paste, and the answer of
`GET /next?probe=1` (which hands nothing out).
