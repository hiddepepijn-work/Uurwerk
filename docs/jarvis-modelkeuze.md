# Jarvis: welk spraakmodel? — briefing voor een adviserende AI

> Deze tekst is geschreven om in zijn geheel aan Claude of ChatGPT te geven. Doel: het
> goedkoopste model (of de goedkoopste combinatie van modellen) vinden dat Jarvis net zo
> goed laat werken als nu, en precies zeggen hoe het aan onze bestaande code koppelt.
> Alle cijfers hieronder zijn gemeten op 28 september 2026, tenzij anders vermeld.

## 1. Wat Jarvis is

Jarvis is de spraakassistent in **Uurwerk**, een persoonlijke planner- en urenapp van één
gebruiker (Hidde, Nederlands, student met een stage). Jarvis beheert via tools zijn agenda,
taken en dagplanning. Hij praat Nederlands, hardop, als een telefoongesprek: Hidde praat,
Jarvis antwoordt binnen een à twee seconden met een stem, en Hidde kan hem onderbreken.

Typisch gebruik:

- **08:30, in de auto** (iPhone, via de speakers en microfoon van de auto/CarPlay): Jarvis
  opent zelf: wat ligt er vandaag vast, wat wil je doen, zet het in het dagplan.
- **21:00, dagafsluiting**: wat is af, wat niet (streng), hoe ging het opruimen, wat staat
  er morgen.
- **Tussendoor**: "zet morgen om acht uur een uur kast fixen erin", "wat heb ik volgende
  week donderdag?", "de kapper een uur later", "start de timer op BO".
- **Op de laptop**: wekwoord "Hey Jarvis" (lokaal, openWakeWord), klein venster rechtsonder.

Geschat volume: **2 gesprekken per dag × ~6 beurten = ~12 beurten per dag, ~360 per maand**.
Een beurt = één keer Hidde praten + één antwoord van Jarvis (eventueel met tool-rondes).

## 2. Architectuur zoals die nu is (TypeScript)

```
iPhone-app (Capacitor/WKWebView)  ─┐
Laptop-app (Electron)             ─┼─ renderer: LiveCall  ── WebSocket ──►  realtime model
                                   │    (mic 24 kHz PCM, afspelen 24 kHz PCM, onderbreken)
                                   │    tools draaien OP HET APPARAAT tegen de lokale
                                   │    SQLite-kopie (offline-first, rij-sync met de server)
VPS-server (Node, geen GPU)       ─┘─ jarvis.liveSession(): maakt een kortlevend token met
                                       model + instructie + tools + stem vastgezet, houdt de
                                       kosten bij (maandplafond $10), en de typ-route
```

- **Twee realtime-"wires" achter één gesprekslaag** (`packages/renderer/src/features/jarvis/live.ts`):
  - `GeminiWire`: Gemini Live via `@google/genai`, ephemeral token (`authTokens.create`, v1alpha).
  - `OpenAIWire`: OpenAI Realtime via WebSocket, `client_secrets`, subprotocol-key.
  - Een nieuwe provider is: een wire die `audio(pcm)`, `paused()`, `text()`, `cutOff(ms)`,
    `close()` implementeert en events teruggeeft (`heard`, `interrupted`, `replyStart`,
    `audio(base64 pcm24k)`, `replyText`, `turnDone`, `usage`, `tools(calls) → results`, `closed`).
  - Plus een server-functie die een token/sessie maakt (`packages/server/app/jarvis/live.ts`).
- **Microfoon-gate op het apparaat**: alleen audio versturen terwijl er gepraat wordt (+ 2 s
  stilte erna), om niet voor stilte te betalen. Echo van Jarvis zelf wordt weggefilterd.
- **Typ-route (bestaat al, is de fallback)**: tekst → Gemini 3.8 Flash (OpenAI-compatibele
  API, met prompt caching) → tekst, en voor spraak: TTS-keten Gemini flash-tts → Azure →
  Edge TTS (gratis). Deze route was trager (8–15 s zonder streaming).
- **Tools**: 23 functies met JSON Schema (get_snapshot, create_task, schedule_task,
  create_appointment, move_appointment, propose_plan, plan_range, add_rule, confirm, cancel,
  start_timer, …). Schrijvende tools maken een **voorstel**; pas na Hiddes "ja" voert
  `confirm` het uit (en verifieert het in de database).
- **Instructie per sessie** (~6.000 tokens): taal-pin (NL), regels (~900), de brief van Hidde
  (~1.700), tool-definities (~2.450), en de actuele stand: datum/tijd, datumtabel van deze en
  volgende week, uren gepland per gebied, planning van vandaag en morgen, open taken met
  RISICO/TE LAAT-markeringen, regels (~500–700).

## 3. Harde eisen

1. **Nederlands** spraak in én uit, natuurlijk (geen robotstem, geen Engelse woorden).
2. **Snel**: eerste geluid ≤ ~1,5 s na het einde van Hiddes zin (p50), p90 ≤ ~3 s.
   Dit was een harde eis van Hidde ("zo snel als de ChatGPT-app").
3. **Betrouwbaar met tools**: meerdere tool-calls per beurt, correcte argumenten
   (datums als YYYY-MM-DD, tijden HH:MM), voorstel → bevestiging → uitvoeren.
4. **Verzint niets** (datums, afspraken, uren). In de benchmark was "verzonnen" de
   grootste zwakte van goedkope modellen.
5. **Werkt vanaf de iPhone in de auto**, dus zonder dat de laptop aan hoeft te staan.
6. **Onderbreken** moet kunnen (barge-in).
7. **Kosten**: totaal **ruim onder €10 per maand**, liefst **€2–4**, inclusief alles.

## 4. Waarom goedkoper

- Hidde betaalt zelf; €10/maand is het plafond, en dat voelt al te veel.
- Gemini Live rekent per beurt de **hele context opnieuw** (geen caching in Live):
  gemiddeld **26.000 invoer-tokens per beurt** (meerdere generaties per beurt door
  tool-rondes), dat is 62% van de kosten; denken ("thinking") 24%; uitgesproken audio 9%.
- OpenAI Realtime cachet wél (78% van de invoer uit cache), maar daar is de
  **uitgesproken audio** 76% van de kosten ($20 per 1M audio-tokens bij mini).
- Let op: van de ~€8,20 die Google deze maand rekende, kwam volgens de eigen teller van de
  server maar **$1,55 uit echte gesprekken**; de rest was ontwikkelen en testen
  (benchmarks, testruns, TTS-clips) op dezelfde API-sleutel. Het echte gebruik ligt dus
  lager, maar de prijs per beurt is nog steeds de kern.

## 5. Benchmark (eigen, `npm run bench:jarvis`)

19 scenario's, elk op een verse kopie van de echte database: 7 dagelijks (planning
morgen, wat vandaag, taak op een tijd + ja, afspraak vs taak, verzetten, afvinken, timer) en
12 "verder dan standaard" (avond vullen rond een training, botsing met afspraak, vaste regel,
doorvragen bij vaagheid, geheugen "die van net", niet verzinnen, "volgende week donderdag",
deadline-risico opmerken, avondronde, uren optellen, "toch niet", twee verzoeken in één zin).
Harde checks op de database + blinde jury (Gemini Flash) op juist/behulpzaam/beknopt/
Nederlands/initiatief/verzonnen.

| | gpt-realtime-2.1-mini | Gemini 3.8 Live extended thinking (low) | gpt-realtime-2.1 |
|---|---|---|---|
| Geslaagd totaal | 42% | **74%** | 50% (8 van 19 gedraaid) |
| Verder dan standaard | 33% | **75%** | – |
| Jury-totaalscore | 57% | **79%** | 49% |
| Verzonnen (scenario's) | **21%** | **0%** | 0% |
| Eerste geluid p50 / p90 | 1,6 / 7,2 s | **1,2 / 3,0 s** | 2,3 / 8,4 s |
| Woorden per antwoord | 47 | 27 | 67 |
| Kosten per beurt | **$0,009** | $0,032 → **$0,027** na optimalisatie | $0,061 |
| Geschat per maand (360 beurten) | $3,3 | $11,6 → **$9,9** | $22 |

Na optimalisatie (datumtabel, risico-markeringen door de code, kortere antwoorden, minder
brief per sessie) bleef Gemini even goed en werd 20% goedkoper; de mini bleef ook met
reasoning "medium" onbetrouwbaar (1 van 8 op de lastige scenario's).

Conclusie tot nu toe: **kwaliteit van Gemini Live is goed genoeg, de prijs niet; de mini is
goedkoop genoeg, de kwaliteit niet.**

## 6. Wat we al weten over lokaal draaien

Laptop: Acer Nitro ANV15-52, **RTX 5060 Laptop (8 GB VRAM)**, i9-13900H, 32 GB RAM, Windows 11.
De VPS heeft geen GPU.

- Lokaal kan: STT (Whisper/faster-whisper, Parakeet), een LLM van ~8–9B in 4-bit
  (bijv. Qwen3.5-9B, Gemma 4 E4B) en TTS (Piper nl_NL, Chatterbox Multilingual).
- Beperkingen: 8 GB VRAM moet STT + LLM + TTS delen; een 9B-model is duidelijk minder
  sterk dan Gemini Live met thinking (vooral in tool-betrouwbaarheid en niet-verzinnen);
  en **in de auto om 08:30 staat de laptop thuis** — dan moet hij aan staan en bereikbaar
  zijn (bijv. Tailscale), anders werkt Jarvis niet.

## 7. Wat we van je willen

Geef een concreet advies, met voor elke optie:

1. **Welke modellen/API's precies** (naam, versie), en de **prijs per 1M tokens of per
   minuut** voor STT, LLM en TTS, met bron en datum.
2. **Geschatte kosten per beurt** voor ons profiel: ~6.000 tokens vaste instructie (goed
   cachebaar: het statische deel staat vooraan, de stand van vandaag achteraan), gemiddeld
   0,7 tool-calls per beurt, antwoorden van ~25 woorden (~8 s spraak), invoer ~5 s spraak.
3. **Latentie** tot het eerste geluid, realistisch, met streaming.
4. **Nederlands**: hoe goed zijn STT en TTS in het Nederlands?
5. **Tool-betrouwbaarheid**: benchmarks (bijv. τ-bench, BFCL) of eigen ervaring.
6. **Hoe het in onze architectuur past**: nieuwe wire (browser-WebSocket/WebRTC vanaf de
   iPhone), of via de server (die dan audio doorstuurt), en wat er aan de server moet.

Opties die we in elk geval vergeleken willen zien:

- **A. Gekoppelde keten ("cascade") met caching**: streaming STT (bijv. Deepgram, Groq
  Whisper, Gemini/OpenAI transcribe) → snelle goedkope LLM met prompt caching en goede
  tool calling (bijv. Gemini Flash / Flash-Lite, GPT-mini-klasse, Claude Haiku, DeepSeek,
  Qwen via een goedkope host) → streaming TTS (bijv. Azure Neural nl-NL, Gemini TTS,
  ElevenLabs Flash, OpenAI TTS, of gratis Edge TTS). Onze verwachting: ~10× goedkoper dan
  Gemini Live, maar hoeveel trager?
- **B. Een goedkoper realtime-model** dat wél even goed is (bestaat dat per september 2026?).
- **C. Hybride**: Gemini Live alleen voor de twee vaste momenten; tussendoor de cascade.
- **D. Lokaal** op de laptop (zie §6) of op een goedkope GPU-server — alleen als het echt
  kan tippen aan de kwaliteit en in de auto werkt.

Ontwerpvoorwaarden voor je antwoord: de tools blijven op het apparaat draaien; de
API-sleutels blijven op de server (het apparaat krijgt alleen een kortlevend token of
praat via de server); en de gemeten benchmark (§5) moet opnieuw te draaien zijn op de
nieuwe optie, dus een optie moet een realtime-achtige interface bieden (audio in → audio
+ transcript + tool-calls uit).
