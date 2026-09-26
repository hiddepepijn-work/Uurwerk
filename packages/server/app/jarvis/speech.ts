/**
 * Jarvis's voice: Azure Speech, neural voice nl-NL-FennaNeural — the same voice as the
 * notification clips. Plain REST, no SDK: one POST with SSML in, MP3 out.
 *
 * The free tier (F0) covers 500,000 characters a month; Jarvis says roughly a fifth of that.
 */

const VOICE = 'nl-NL-FennaNeural'

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export async function speak(text: string, key: string, region: string): Promise<Uint8Array> {
  const ssml =
    `<speak version="1.0" xml:lang="nl-NL"><voice name="${VOICE}">` +
    `<prosody rate="+5%">${escapeXml(text)}</prosody></voice></speak>`

  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'uurwerk-jarvis'
    },
    body: ssml,
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`Azure Speech ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * The same voice without an Azure key: Microsoft Edge's read-aloud service (msedge-tts).
 * Free and keyless, but unofficial — it can change or stop without notice, which is why
 * Azure stays the first choice when a key is set.
 */
export async function speakFree(text: string): Promise<Uint8Array> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts')
  const tts = new MsEdgeTTS()
  try {
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    const { audioStream } = tts.toStream(escapeXml(text), { rate: '+5%' })
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Edge TTS timed out')), 20_000)
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      audioStream.on('data', (chunk: Buffer) => chunks.push(chunk))
      audioStream.on('end', done)
      audioStream.on('close', done)
      audioStream.on('error', (error: Error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    return new Uint8Array(Buffer.concat(chunks))
  } finally {
    tts.close()
  }
}

/**
 * Gemini's own voices (gemini-3.8-flash-tts): natural Dutch with a tone the prompt can set,
 * on the same free key as the model. The first choice when a Gemini key is there.
 * Returns WAV.
 */
export async function speakGemini(text: string, key: string, voice: string, model: string): Promise<Uint8Array> {
  const prompt = `Zeg in het Nederlands, direct en zakelijk met een klein beetje humor, als een assistent die je goed kent: ${text}`
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        }
      }),
      signal: AbortSignal.timeout(30_000)
    }
  )
  if (!response.ok) throw new Error(`Gemini TTS ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const body = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType: string; data: string } }> } }>
  }
  const audio = body.candidates?.[0]?.content?.parts?.[0]?.inlineData
  if (!audio) throw new Error('Gemini TTS gaf geen audio terug')
  const bytes = new Uint8Array(Buffer.from(audio.data, 'base64'))
  // Some models send raw 24 kHz PCM; a WAV header makes it playable everywhere.
  return audio.mimeType.startsWith('audio/L16') ? wav(bytes, 24_000) : bytes
}

function wav(pcm: Uint8Array, rate: number): Uint8Array {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]))
}
