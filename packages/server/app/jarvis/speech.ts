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
