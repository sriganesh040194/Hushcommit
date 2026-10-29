# Hushcommit

A private VS Code extension that writes your git commit message from the staged diff, using a local or self-chosen OpenAI-compatible model. No runtime dependencies, no telemetry; your code goes only to the server you configure.

It adds a ✨ button to the Source Control panel. The button sends your **staged** diff to the chat API you set in Settings, then writes the reply into the commit message box. It works with Ollama, LM Studio, llama.cpp (`llama-server`), vLLM, or a hosted OpenAI-compatible API.

In VS Code it appears as "Commit Message (OpenAI-compatible)".

## What it sends, and where

- It makes one `POST {baseUrl}/chat/completions` per click. "Select model" also makes one `GET {baseUrl}/models`. Nothing else goes over the network: no telemetry, no logging.
- The request carries the staged diff (cut to `maxDiffChars`, with a warning when it's cut) and the system prompt.
- `baseUrl` must point to this machine (`localhost`, `127.0.0.1` or `::1`) unless you turn on `localCommitMsg.allowRemote`.
- An API key is optional. It lives in VS Code SecretStorage (the OS keychain), never in `settings.json`, and is sent as `Authorization: Bearer <key>` only when one is set.
- Git data comes only from VS Code's built-in Git extension API. The extension never runs `git` itself.
- There are no runtime dependencies. The packaged extension is `package.json`, `out/extension.js` and `out/llm.js`.

## Build and install

Requires Node 22+.

```sh
git clone git@github.com:sriganesh040194/Hushcommit.git
cd Hushcommit
npm ci
npm run compile
npx vsce package --no-dependencies
```

This produces `local-commit-msg-0.0.1.vsix`. In VS Code, go to Extensions → `⋯` → **Install from VSIX…** and pick that file.

To try it without installing, open this folder in VS Code, run `npm run compile`, then press **F5** to launch an Extension Development Host.

## Use

1. Run **Commit Message: Select model** from the Command Palette and pick a model. It is saved to the `localCommitMsg.model` user setting.
2. Stage your changes.
3. Click ✨ in the Source Control **title bar** (tooltip: "Generate commit message (OpenAI-compatible)"). If GitHub Copilot is installed, the ✨ inside the commit message box is Copilot's, not this extension's.

The built-in prompt asks for the [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) format, e.g. `fix(llm): report the server URL on connection errors`. The model is asked for this format, but the reply isn't checked, so review it before committing. To use a different format, set `localCommitMsg.instructions`.

If you have several repositories open, the button uses the one whose title bar you clicked. From the Command Palette, you're asked to pick one.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `localCommitMsg.baseUrl` | `http://localhost:11434/v1` | Server base URL, ending in `/v1` |
| `localCommitMsg.model` | `""` | Model id |
| `localCommitMsg.instructions` | `""` | Custom system prompt; replaces the built-in one |
| `localCommitMsg.maxDiffChars` | `40000` | Longer staged diffs are cut, with a warning |
| `localCommitMsg.temperature` | `0.2` | Sampling temperature |
| `localCommitMsg.maxTokens` | `0` | `max_tokens`; `0` means don't send it |
| `localCommitMsg.requestTimeoutSeconds` | `120` | Request timeout |
| `localCommitMsg.allowRemote` | `false` | Allow a non-loopback `baseUrl` |

API key commands: **Commit Message: Set API key** and **Commit Message: Clear API key**.

## Ollama

1. Install Ollama and pull a model, e.g. `ollama pull qwen3-coder:30b`.
2. Leave `baseUrl` at the default `http://localhost:11434/v1`. No API key is needed.
3. Run **Commit Message: Select model**. Ollama serves `GET /v1/models` in the OpenAI shape `{ data: [{ id }] }`. This was checked against a running Ollama.

## LM Studio

1. In LM Studio, open the Developer tab, start the local server, and load a model.
2. Set `localCommitMsg.baseUrl` to `http://localhost:<port>/v1`. LM Studio's docs use port `1234` in every example (`http://localhost:1234/v1`). The docs don't call 1234 the default, though, and `lms server start` reuses the last port you used. Use the port the Developer tab shows.
3. Run **Commit Message: Select model**. LM Studio's docs list `GET /v1/models` but don't document the response shape. If the list fails to load, the error message offers to let you type the model id by hand.

## Other servers

For llama.cpp's `llama-server`, vLLM, or a hosted API, set `baseUrl` to the server's `/v1` URL. For a hosted API, also turn on `allowRemote` and run **Set API key**. If the server needs `max_tokens`, set `maxTokens` above 0.
