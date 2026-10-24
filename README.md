# Momentbuddy

Log small moments by **voice or text**, then **listen to your year**: a recap that is narrated aloud with themed sound effects, plus a written summary built only from what you logged.

Built for the *Best Use of ElevenLabs* track at Hacktoberfest Hack Day Barcelona.

## 1. What it is and who it is for

For people who want a private journal of the things that stayed with them (films, books, matches, trips, meals, feelings) and a year-end recap they can *hear*, not just read.

- **Speak a moment**: tap the mic, talk, and your words are transcribed (ElevenLabs Scribe) into the box. You check the text, pick a mood (1–5, your own) and an optional feeling word, and save. You can also attach photos, take a photo with the camera, or attach a file.
- **Hear the recap**: the Recap tab plays Instagram-story-style slides. A voice (ElevenLabs text-to-speech) reads each slide and a short themed sound effect plays (ball bounces for sport, page turns for books, cheering at the end). The slides advance when the narration ends, so the audio drives the experience.
- **Read the recap**: "Your year, in words" is a short written story with pictures, plus Insights (mood over time, topics, feeling words).

**Why ElevenLabs is essential.** Voice is both the input and the output. Without it, there is no voice capture and no narrated, sound-designed recap. What remains is a text journal. (There is a browser-voice fallback so the demo never breaks if the API is down or the key is missing; it is a fallback, not the product.)

## 2. How to run it

Requires Node 20.12+. No npm dependencies.

```bash
git clone <this repo> && cd momentbuddy
cp .env.example .env        # then put your ElevenLabs API key in .env
npm start                   # http://localhost:3000
npm test                    # 11 tests, upstream calls are mocked
```

- The API key lives only in `.env` on the server. The browser never sees it: the page calls `/api/tts`, `/api/sfx`, `/api/stt` on the same origin.
- Microphone and camera need `localhost` or HTTPS.
- Without a key the app still runs and uses the browser voice; voice notes are disabled with a clear message.
- Demo protection (see `.env.example`): per-IP rate limit, daily caps on characters, sound effects and transcriptions, request size limits, fixed sound-effect prompts on the server.
- To try without the server, open `public/index.html` directly and paste a key in Settings. It stays in tab memory, is never saved, and calls ElevenLabs straight from the browser (which ElevenLabs may block via CORS; the server path is the supported one).

Environment variables: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (optional), `PORT`, `RATE_LIMIT_PER_MIN`, `DAILY_TTS_CHARS`, `DAILY_SFX_CALLS`, `DAILY_STT_CALLS`, `TRUST_PROXY`.

## 3. Expertise: what is built in and where it comes from

The "expertise" is a careful way of reading a personal log, written as rules in code (`public/index.html`):

- **Mood is the user's own** 1–5 rating. The app never infers mood from the voice. We tested a voice-tone emotion API (Modulate) informally; in our one test it labelled a happy voice "Disgusted", so it is not used in the product. A voice-tone label exists only as an opt-in, experimental switch that never changes the mood score.
- **Feeling words are chosen or confirmed by the user.** Words are grouped by two axes, pleasantness and energy (four quadrants of four words each), following the circumplex idea of affect and the way the How We Feel "Mood Meter" arranges words. Suggestions come from keyword rules (English and Russian stems, with a negation guard), and nothing is saved until the user picks a word.
- **All numbers are computed by code**, not generated: counts, averages, best and worst months, most-used words. Sources are shown ("Based on N moments") and each list opens the underlying moments.
- **Honest labelling**: patterns are marked "Hypothesis"; no diagnoses, no predictions; nothing is shown below 4 moments (`MIN_N`).
- Why not infer emotion automatically: even research on speech emotion recognition finds models struggle across languages (see references), and our own voice-tone test was unreliable.

References
- Russell, J. A. (1980). A circumplex model of affect. *Journal of Personality and Social Psychology*, 39(6), 1161–1178. PDF: https://pdodds.w3.uvm.edu/research/papers/others/1980/russell1980a.pdf
- How We Feel (Mood Meter, 144 words): https://howwefeel.org
- Demszky et al. (2020). GoEmotions, 27 emotion categories: https://arxiv.org/abs/2005.00547
- Cross-Lingual Speech Emotion Recognition: Humans vs. Self-Supervised Models (humans cope better than models when emotion recognition crosses languages): https://arxiv.org/abs/2409.16920

Sample data (about 85 moments) is synthetic, written for the demo. It contains no real personal data and is marked "sample" in the UI.

## 4. Models and licenses

| Use | Model | Terms |
|---|---|---|
| Narration (text-to-speech) | ElevenLabs `eleven_multilingual_v2` | https://elevenlabs.io/terms-of-use |
| Voice notes (speech-to-text) | ElevenLabs `scribe_v2` | https://elevenlabs.io/terms-of-use |
| Sound effects | ElevenLabs sound generation | https://elevenlabs.io/terms-of-use |

Model list: https://elevenlabs.io/docs/overview/models. These are hosted models, used through the ElevenLabs API under your own account and plan; check your plan's terms for commercial use and attribution. **No language model generates the written text**: the recap wording is template-based, filled with numbers computed in code. Project code: MIT (see `LICENSE`).

## 5. Proof that it does better than the same model without it

We did **not** run a benchmark or user study, so we make no measured claim. What can be verified in this repo:

- The recap numbers are computed, not generated, so they cannot be invented. A bare text or voice model given no access to the user's log cannot produce them; with the log pasted in, it could, but without our source lists, minimum-data rule or hypothesis labelling.
- `npm test` checks the server's guarantees: the key never reaches the client or error messages, input and size limits, rate limits, fixed sound-effect kinds, and graceful errors.
- The voice paths (mic to Scribe, recap to text-to-speech and sound effects) were exercised end to end in a headless browser against a **mocked** ElevenLabs. The real ElevenLabs responses and audio quality were not verified in that run.

## Safety and privacy notes

- **Not medical, psychological, legal or financial advice.** The app says so in Settings and under Insights. A "Health" topic exists for logging only.
- **Keys**: only in `.env` (git-ignored); `.env.example` has no values; no key in client code. If a key ever leaks, revoke it in ElevenLabs and create a new one.
- **Personal data**: moments live in the browser tab's memory and are not stored on the server (use Export to keep them). Voice recordings are sent to ElevenLabs for transcription; recap text is sent to ElevenLabs for narration. Consent is requested in onboarding (GDPR Art. 9 style). Get legal review before a public launch.
- **Prompt injection**: user text is never sent to a language model, so there is no instruction-following surface. User text is escaped before rendering. If an LLM is added later, treat journal text as untrusted data (OWASP Top 10 for LLM).
- **Dangerous actions**: the app has no tools that send, pay or delete on the user's behalf. "Delete my moments" asks for a second tap to confirm.
- **Dependencies**: none (Node built-ins only), `npm audit` reports 0 vulnerabilities.

## Layout

```
server.js            static server + ElevenLabs proxy (no dependencies)
public/index.html    the whole app (HTML, CSS, JS)
test/server.test.js  node:test suite
.env.example  LICENSE  README.md
```
