<div align="center">

<img src="public/icon.svg" width="96" alt="MediaTrove logo" />

# MediaTrove

**A cross-platform media companion for Windows, macOS, Linux and Android** — search, collect, and track your media journey (Movies, TV Series, Books, Comics, Short Dramas, Music).

![Release](https://img.shields.io/github/v/release/liumeteor11/mediatrove?include_prereleases&label=version)
![License](https://img.shields.io/github/license/liumeteor11/mediatrove)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-4f46e5)

[English](README.md) | [中文](README.zh.md)

📥 **[Download the latest build](https://github.com/liumeteor11/mediatrove/releases)**

</div>

Built with **React + Vite** (Frontend) and **Tauri 2 / Rust** (Backend). Designed for speed, privacy, and an excellent user experience.

## ✨ Key Features

### 🔍 AI-Powered Search & Discovery
- **Smart Search**: Find movies, books, and more using natural language queries (e.g., "Cyberpunk novels from the 90s"). Results are aggregated from TMDB, Bangumi, plugins and AI, ranked by relevance so fuzzy matches never bury the real work.
- **Trending Recommendations**: Fresh hot recommendations in three modes — time-based trending, taste-based (learned from your collection), or fully custom via your own prompt. Each round automatically avoids repeating recently shown items.
- **Consistent Language**: Search results, recommendations, and poster/metadata enrichment all follow the app's UI language (Chinese or English) end to end.
- **Fast First-Screen**: Instant results return from AI context, followed by asynchronous metadata enrichment.

### 📚 Comprehensive Collection Management
- **Multi-Type Support**: Manage Movies, TV Series, Books, Comics, Short Dramas, and Music albums in one place.
- **Status Tracking**: Organize items into "To Watch", "Watched", and "Favorites".
- **Ongoing Updates**: Track ongoing series with automatic update checks for new episodes/chapters — TV series use authoritative TMDB episode data, other types fall back to AI with web-search context when available.

### 📱 Device Sync & MCP Integration
- **LAN Sync**: Sync your collection between devices on the same network — nearby devices are discovered automatically via mDNS.
- **Built-in MCP Server**: The app exposes a local [Model Context Protocol](https://modelcontextprotocol.io) endpoint (`list_items`, `add_item`, `update_item`, `remove_item`, `get_stats`, …), so MCP-capable AI clients and agents can browse and manage your collection with your permission.

### 🎭 Character Distillation & Roleplay Chat
- **Distill Characters**: Turn characters from your collection (or any work by title) into structured persona profiles — personality traits, mental models, decision heuristics, boundaries, timeline and "expression DNA".
- **In-Character Chat**: Roleplay conversations that stay in character at all times, with streaming replies and per-character session history.
- **Persona Tuning**: Teach characters with corrections (scene → what not to do → what to do instead); they take effect from the next reply, override the distilled persona, and can be deleted again from the profile.
- **Incremental Re-distillation**: Re-distilling the same work merges new details into existing profiles, keeps your corrections, and bumps the profile version.
- **Background Distillation**: Distilling runs in the background — the dialog closes immediately, a progress badge tracks the run in the corner, and the finished profile appears on the page by itself.
- **Search-Grounded Research**: Distillation researches the work and the character with the AI's web-search tool before writing the profile; your extra material, the work metadata and TMDb credits still take priority over search results.

### 🛠️ Advanced Editing & Customization
- **Manual Entry**: Create custom media cards directly without searching.
- **Metadata Editing**: Full control over title, director, description, release date, and cast.
- **Custom Posters**: Upload your own cover images or let the app auto-fetch high-quality posters from the web.

### 📊 Insights & Analytics
- **Yearly Report**: Visualize your activity with annual statistics, including total items added, most active month, and favorite categories.
- **Search Diagnostics**: View detailed I/O logs of AI interactions and search provider performance (token usage, latency, per-call duration).

### 🤖 Flexible AI Integration
- **Bring Your Own AI**: Works with Moonshot/Kimi, OpenAI, DeepSeek, Qwen, Google, Mistral, MiMo, Zhipu (GLM), or any OpenAI-compatible custom endpoint.
- **Per-Model Adaptation**: Model quirks are handled automatically — models that fix the sampling temperature, reject the parameter or tool calling, or spend their whole output budget on reasoning are detected from the provider's own response and adapted (re-tested per session, so unknown/new models work too).
- **Optional Search Providers**: Plug in Vertex AI Search, Serper, Yandex, or DeepSeek Search keys to sharpen update tracking, trending freshness and search context. A keyless built-in DuckDuckGo engine works out of the box, and AI-native web search is used automatically when the provider supports it.

## 🚀 Technical Highlights

- **Privacy First**: API keys are stored locally with **AES encryption**. Collection data never leaves your devices (except optional LAN sync within your own network).
- **Cross-Platform**: One codebase ships desktop installers (Windows / macOS / Linux) and an Android APK from the same Tauri 2 core.
- **Offline Friendly**: Works gracefully with intermittent internet; caches metadata locally for instant loading.
- **Async Hydration**: Posters and detailed info are fetched in the background to keep the UI responsive.
- **Internationalization**: Full support for English and Chinese (Simplified), with auto-detection.

## 🛠️ Quick Start

### Prerequisites
- Node.js (v18+)
- Rust (latest stable)
- For Android builds: Android SDK + NDK (see [Tauri docs](https://v2.tauri.app/start/prerequisites/))

### Development
1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Run desktop app**:
   ```bash
   npm run tauri dev
   ```
3. **Run web-only mode**:
   ```bash
   npm run dev
   ```
4. **Run on Android** (first time needs `npm run tauri android init`):
   ```bash
   npm run tauri android dev
   ```
5. **Run Rust unit tests**:
   ```bash
   cd src-tauri && cargo test
   ```

### Build
To build the application for your OS:
```bash
npm run tauri build
```

## 📦 GitHub Actions Release

Push a tag starting with `v` (e.g., `v0.1.30`) — or trigger the workflow manually — to build Windows, macOS, Linux installers and an Android APK, published to GitHub Releases as a draft.

Android APK signing is picked up automatically from repository secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_PASSWORD`); without them the workflow falls back to an unsigned APK.

## 🔒 Privacy & Security
- **Local Storage**: All collection data is stored locally on your device.
- **Encrypted Keys**: Sensitive API keys are encrypted before storage.
- **No Tracking**: We do not track your search history or collection data.

## 📄 License

Licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only): free to use, study, share and modify — including commercially — as long as derivative works and network services built on it are released under the same license.

**Need to ship it closed-source or offer it as a paid service?** A separate [commercial license](COMMERCIAL.md) is available: open an issue on the repository to request one.

Third-party dependencies keep their own licenses (mostly MIT / Apache-2.0).
