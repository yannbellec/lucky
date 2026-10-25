<div align="center">

# 🍀 Lucky

### The Cursor-grade coding agent for **your own local model** — free, open-source, no account.

Lucky turns any local LLM served by **Ollama** into a fully agentic pair-programmer inside **Cursor** & **VS Code**: it reads your repo, edits files live with red/green diffs, runs commands, browses the web, and ships features — **100 % on your machine**.

<br/>

[![License](https://img.shields.io/github/license/yannbellec/lucky?style=for-the-badge&color=4c1)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/yannbellec/lucky?style=for-the-badge&logo=github&color=f5c518)](https://github.com/yannbellec/lucky/stargazers)
[![Issues](https://img.shields.io/github/issues/yannbellec/lucky?style=for-the-badge&color=orange)](https://github.com/yannbellec/lucky/issues)
[![Last commit](https://img.shields.io/github/last-commit/yannbellec/lucky?style=for-the-badge&color=blueviolet)](https://github.com/yannbellec/lucky/commits/main)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](#)
[![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](#)
[![Bun](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white)](#)
[![Ollama](https://img.shields.io/badge/Ollama-local-000000?style=for-the-badge&logo=ollama&logoColor=white)](#)
[![No Cloud](https://img.shields.io/badge/100%25-local%20%26%20private-brightgreen?style=for-the-badge)](#)

<br/>

### ⭐ If Lucky saves you time, **star the repo** — it genuinely helps.

[**⬇️ Install**](#-install) · [**✨ Features**](#-features) · [**🧠 Local model setup**](#-local-model-setup) · [**🛠️ Build from source**](#️-build-from-source)

</div>

---

## ✨ Features

| | |
|---|---|
| 🧠 **Your model, your rules** | Runs on **any Ollama model** (coder, uncensored, 70B, you name it). No sign-up, no API key, no cloud. |
| ✍️ **Live multi-file editing** | Watch it open the right tab and apply **red/green diffs in real time** — Cursor-style, right in your editor. |
| 🤖 **True agent mode** | It plans, edits across files, runs terminal commands, and self-corrects — with your approval at every step. |
| 🌐 **Internet access** | Plug in web-search / fetch tools via **MCP** so your local model can research docs and APIs before it codes. |
| ⚡ **Zero-config start** | Lands you **straight in the chat**, pre-wired to your local Ollama endpoint. No onboarding, no account screen. |
| 🔒 **Private by design** | Everything stays on your machine. Your code never leaves your laptop. |

---

## ⬇️ Install

1. Download the latest **`lucky.vsix`** from the [Releases](https://github.com/yannbellec/lucky/releases) page (or build it — see below).
2. In **Cursor / VS Code**: open the Extensions panel → `···` menu → **Install from VSIX…** → pick `lucky.vsix`.
3. **Reload the window** (`Cmd/Ctrl+Shift+P → Reload Window`).
4. Click the **🍀 Lucky icon** in the left activity bar — you land directly in the chat. That's it.

> Requires [**Ollama**](https://ollama.com) running locally. Lucky is pre-pointed at `http://localhost:11434`.

---

## 🧠 Local model setup

```bash
# 1. Install & start Ollama (https://ollama.com)
# 2. Pull a capable coding model, e.g. a Qwen coder:
ollama pull qwen3-coder:30b
# 3. In Lucky, pick your model from the selector at the bottom of the chat. Done.
```

Any tool-capable Ollama model works. Dense coder models and agentic MoE coders both shine here.

---

## 🛠️ Build from source

```bash
git clone https://github.com/yannbellec/lucky.git
cd lucky
bun install
bun run build:sdk                  # build internal packages
cd apps/vscode && bun run package  # compile extension + webview
bunx @vscode/vsce package --no-dependencies -o lucky.vsix
```

**Stack:** TypeScript · React · Vite · Tailwind · Bun · esbuild · gRPC (ProtoBus).

---

## 🙏 Credits

Lucky is a friendly, local-first fork of the excellent open-source **[Cline](https://github.com/cline/cline)** project, re-tuned to run entirely on your own hardware with zero onboarding. Huge thanks to the Cline authors for their work. Lucky is distributed under the same **Apache-2.0** license — see [`LICENSE`](./LICENSE).

---

<div align="center">

**Made for developers who want the full agentic experience — without renting a brain in the cloud.**

🍀 *Good code, good luck.*

</div>
