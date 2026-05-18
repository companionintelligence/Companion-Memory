# 16 — Voice & Multimodal

> **Status:** draft &nbsp;•&nbsp; **Phase:** P2
>
> Merge the in-flight voice-mode branch, then generalize STT/TTS behind providers and add a vision capture path.

---

## 1. Summary

`feat/voice-mode` is substantial: it adds voice mode, transcription, synthesis, audio playback, and reshapes the chat surface. It's ready to merge but should land alongside a provider abstraction so we can swap Whisper for other STT or local for cloud TTS without surgery.

## 2. Current state (`feat/voice-mode`)

- Frontend: `VoiceMode/`, `VoiceModeProvider`, `useVoiceMode`, `useCompanionAudioPlayback`, transcription + synthesis services.
- Backend: SST service converts audio to a form usable by Whisper; max body size raised to support base64 audio.
- Voice toggle in the chat input; markdown stripped for TTS.

Not yet:
- A provider interface for STT/TTS.
- Server-side TTS streaming.
- Vision (image) input via the same conversational surface.

## 3. Target state

### 3.1 Providers

```ts
interface SttProvider { transcribe(audio: AudioBuffer, opts): Promise<{text, ts_ranges?}>; }
interface TtsProvider { synthesize(text: string, opts): AsyncIterable<AudioChunk>; }
interface VisionProvider { describe(image: ImageBuffer, opts): Promise<{caption, tags, ocr?}>; }
```

Concrete:
- STT: `WhisperLocalProvider` (default), `WhisperApiProvider`, optionally `DeepgramProvider`.
- TTS: `PiperLocalProvider` (default), `OpenAiTtsProvider`, optionally `ElevenLabsProvider`.
- Vision: `GemmaVisionProvider` (gemma3:27b already in the codebase), `GptVisionProvider`, `ClaudeVisionProvider`.

Routed by [04 LLM router](04-llm-routing.md) with task `voice.stt`, `voice.tts`, `vision.describe`.

### 3.2 Audio + image as first-class memories

Captures already exist (`frontend/packages/capture`). On ingest:

- Audio → `Recording` entity (episodic) → transcribe → write transcript to `properties.transcript` → embed → link to source thread.
- Image → `Image` entity (episodic) → vision describe → write caption + OCR → embed → link.
- Video → break into keyframes; treat each as image + add `Recording` for audio track.

`memory_kind = 'episodic'` for all of these by default.

### 3.3 Voice-first MCP

Expose `voice.transcribe` and `voice.speak` as MCP tools so any agent can do speech I/O against the twin's local providers — useful for hands-free wearables.

### 3.4 Streaming TTS

Server streams audio chunks via SSE (built on [05 streaming](05-streaming-subscriptions.md)) so the SPA and other clients can play with low latency.

## 4. Branch disposition

| Branch | Action |
|---|---|
| `feat/voice-mode` | Merge as-is, then layer providers on top in a follow-up PR. |
| `spike/voice-recorder` | Compare; cherry-pick anything useful (the JWT auth bit could match [10 multi-actor](10-multi-actor.md)). |

## 5. Phased steps

| # | Increment |
|---|---|
| 1 | Merge `feat/voice-mode` |
| 2 | Extract `SttProvider` interface; current Whisper code becomes `WhisperLocalProvider` |
| 3 | Add `OpenAiTtsProvider` and `WhisperApiProvider` (BYO key via `provider_keys`) |
| 4 | Vision pipeline: ingest image → describe → embed |
| 5 | MCP voice tools (`voice.transcribe`, `voice.speak`) |
| 6 | Streaming TTS over SSE |
| 7 | Optional: `ElevenLabsProvider`, `DeepgramProvider` |

## 6. Risks

| Risk | Mitigation |
|---|---|
| Voice latency unacceptable with local TTS | Bench Piper vs OpenAI/ElevenLabs; offer per-task policy. |
| Audio body sizes blow up payloads | Already mitigated on the branch; add stream upload for long recordings. |
| Vision model hallucinates captions on captures | Store caption with confidence; require user accept before it becomes semantic. |

## 7. Eval / acceptance

- Voice mode toggles in the SPA and round-trips speech → text → response → speech with no manual reload.
- An external agent can call `voice.transcribe` over MCP with an audio blob and get a transcript.
- A captured image becomes an episodic entity with a caption + tags + OCR text.
