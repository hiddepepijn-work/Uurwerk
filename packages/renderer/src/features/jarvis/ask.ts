import type { JarvisAsk, JarvisReply } from '@core/contract/api.js'

import { api } from '../../api/client.js'

/**
 * One turn with Jarvis, as a job on the server: the server keeps working when the phone
 * loses the connection mid-answer ("Load failed") or goes to the background, and this asks
 * how it went until the reply is there. A missed poll is retried; only the server saying
 * the turn failed, or a long silence, ends it.
 */

class JobFailed extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function askJarvis(input: JarvisAsk): Promise<JarvisReply> {
  const { jobId } = await api.jarvis.askStart(input)
  const started = Date.now()
  let misses = 0
  while (Date.now() - started < 180_000) {
    await sleep(misses === 0 ? 700 : 1500)
    try {
      const job = await api.jarvis.askJob(jobId)
      misses = 0
      if (job.status === 'done' && job.reply) return job.reply
      if (job.status === 'failed') throw new JobFailed(job.error ?? 'Jarvis kon dit niet afmaken.')
    } catch (error) {
      if (error instanceof JobFailed) throw error
      misses += 1
      if (misses > 30) throw error
    }
  }
  throw new Error('Jarvis doet er te lang over. Vraag het nog een keer; wat al gebeurd was, blijft staan.')
}
