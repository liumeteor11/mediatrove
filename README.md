# MediaTrove AI

[English](README.md) | [中文](README.zh.md)

A cross-platform desktop application to search, collect, and track your media journey (Movies, TV Series, Books, Comics, Short Dramas, Music). 

Built with **React + Vite** (Frontend) and **Tauri/Rust** (Backend). 

Designed for speed, privacy, and an excellent user experience.

## 📌 Current Version

v0.1.24

## ✨ Key Features

### 🔍 AI-Powered Search & Discovery
- **Smart Search**: Find movies, books, and more using natural language queries (e.g., "Cyberpunk novels from the 90s"). Results are aggregated from TMDB, Bangumi, plugins and AI, ranked by relevance so fuzzy matches never bury the real work.
- **Trending Recommendations**: Get personalized "Hot Recommendations" based on current trends, with auto-refresh logic that avoids repeating recently seen items.
- **Fast First-Screen**: Instant results return from AI context, followed by asynchronous metadata enrichment.

### 📚 Comprehensive Collection Management
- **Multi-Type Support**: Manage Movies, TV Series, Books, Comics, Short Dramas, and Music albums in one place.
- **Status Tracking**: Organize items into "To Watch", "Watched", and "Favorites".
- **Ongoing Updates**: Track ongoing series (TV shows, comics) with automatic update checks for new episodes/chapters — TV series use authoritative TMDB episode data, other types fall back to AI with web-search context when available.

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
- **Search Diagnostics**: View detailed logs of AI interactions and search provider performance (Token usage, latency, API calls).

### 🤖 Flexible AI Integration
- **Bring Your Own AI**: Works with Moonshot/Kimi, OpenAI, DeepSeek, Qwen, Google, Mistral, MiMo, Zhipu (GLM), or any OpenAI-compatible custom endpoint.
- **Per-Model Adaptation**: Model quirks are handled automatically — models that fix the sampling temperature, reject the parameter or tool calling, or spend their whole output budget on reasoning are detected from the provider's own response and adapted (re-tested per session, so unknown/new models work too).
- **Optional Search Providers**: Plug in Google CSE, Serper or Yandex keys to sharpen update tracking, trending freshness and search context; AI-native web search is used automatically when the provider supports it.

## 🚀 Technical Highlights

- **Privacy First**: API Keys (OpenAI, Google, etc.) are stored locally using **AES encryption**. No data is sent to our servers.
- **Offline Friendly**: Works gracefully with intermittent internet; caches metadata locally for instant loading.
- **Async Hydration**: Posters and detailed info are fetched in the background to keep the UI responsive.
- **Internationalization**: Full support for English and Chinese (Simplified), with auto-detection.

## 🛠️ Quick Start

### Prerequisites
- Node.js (v18+)
- Rust (latest stable)

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

### Build
To build the application for your OS:
```bash
npm run tauri build
```

## 📦 GitHub Actions Release
Push a tag starting with `v` (e.g., `v0.1.16`) to automatically trigger the build workflow. It will generate installers for Windows, macOS, and Linux and publish them to GitHub Releases as a draft.

## 🔒 Privacy & Security
- **Local Storage**: All collection data is stored locally on your device.
- **Encrypted Keys**: Sensitive API keys are encrypted before storage.
- **No Tracking**: We do not track your search history or collection data.

## 📄 License
Licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only): free to use, study, share and modify — including commercially — as long as derivative works and network services built on it are released under the same license.

**Need to ship it closed-source or offer it as a paid service?** A separate [commercial license](COMMERCIAL.md) is available: open an issue on the repository to request one.

Third-party dependencies keep their own licenses (mostly MIT / Apache-2.0).

**Commercial use is not permitted without a separate license** — open an issue on the repository to request one.

Third-party dependencies keep their own licenses (mostly MIT / Apache-2.0).
