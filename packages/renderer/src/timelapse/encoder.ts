/**
 * The timelapse encoder. Runs in a hidden window, has no UI, and exists for one reason:
 * MediaRecorder is a browser API, and the main process is not a browser.
 *
 * This is what lets Uurwerk produce a real video with no ffmpeg and no native module —
 * neither of which this machine could build. Frames are drawn onto an off-screen canvas,
 * the canvas stream is recorded, and the resulting WebM goes back to the main process as
 * bytes.
 *
 * The pacing is the subtle part. MediaRecorder timestamps frames by wall clock, not by
 * however fast we feed it, so a video at N fps genuinely takes total/N seconds to record.
 * `captureStream(0)` plus an explicit `requestFrame()` per drawing is what keeps the output
 * frame count exactly equal to the input frame count instead of whatever the compositor
 * happened to sample.
 */

interface TimelapseJob {
  total: number
  width: number
  height: number
  fps: number
  date: string
}

interface EncoderBridge {
  ready(): Promise<TimelapseJob>
  frame(index: number): Promise<string | null>
  progress(done: number): void
  finish(bytes: Uint8Array): Promise<void>
  fail(message: string): Promise<void>
}

declare global {
  interface Window {
    encoder: EncoderBridge
  }
}

/** VP9 where the build has it, VP8 where it does not. Both play in Chrome, Edge and VLC. */
function pickMimeType(): string {
  for (const candidate of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  throw new Error('This build of Electron cannot record WebM video.')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('A frame could not be decoded.'))
    image.src = dataUrl
  })
}

async function encode(): Promise<void> {
  const job = await window.encoder.ready()

  const canvas = document.createElement('canvas')
  canvas.width = job.width
  canvas.height = job.height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('No 2D canvas context in the encoder window.')

  // A black first frame is better than a transparent one: WebM has no alpha here and an
  // uninitialised canvas would encode as noise.
  context.fillStyle = '#000000'
  context.fillRect(0, 0, canvas.width, canvas.height)

  // 0 fps means "only the frames I ask for", which is exactly the control we want.
  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined
  if (!track) throw new Error('The canvas produced no video track.')

  const chunks: Blob[] = []
  const recorder = new MediaRecorder(stream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: 2_500_000
  })
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  recorder.start()

  const frameMs = 1000 / Math.max(1, job.fps)
  for (let index = 0; index < job.total; index++) {
    const dataUrl = await window.encoder.frame(index)
    if (!dataUrl) continue

    const image = await loadImage(dataUrl)
    // Letterboxed rather than stretched — a portrait screenshot mixed into a landscape day
    // should not be distorted into something that misrepresents what was on screen.
    context.fillRect(0, 0, canvas.width, canvas.height)
    const scale = Math.min(canvas.width / image.width, canvas.height / image.height)
    const width = image.width * scale
    const height = image.height * scale
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)

    track.requestFrame()
    window.encoder.progress(index + 1)
    await sleep(frameMs)
  }

  // Hold the final frame briefly so the last thing you did is not clipped off the end.
  await sleep(Math.max(400, frameMs))
  recorder.stop()
  await stopped

  const blob = new Blob(chunks, { type: 'video/webm' })
  await window.encoder.finish(new Uint8Array(await blob.arrayBuffer()))
}

void encode().catch((error: unknown) => {
  void window.encoder.fail(error instanceof Error ? error.message : String(error))
})

export {}
