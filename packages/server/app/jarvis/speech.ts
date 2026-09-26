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
