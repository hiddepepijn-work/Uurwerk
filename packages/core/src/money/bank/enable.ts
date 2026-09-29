/**
 * Enable Banking: read-only access to your own ABN AMRO accounts (PSD2 AIS, "restricted"
 * mode — free, and only for accounts you linked in their portal yourself).
 *
 * Every call carries a JWT signed with the application's RSA key (RS256, `kid` = application
 * id, at most a day valid). The key never leaves the machine that holds it; this module signs
 * with WebCrypto, so it runs in the laptop's main process and, if ever needed, a web view.
 *
 * Read-only by law: nothing here can move money, and nothing here tries to.
 */

const BASE = 'https://api.enablebanking.com'

export interface BankAmount {
  amount: string
  currency: string
}

export interface BankAccount {
  uid: string
  account_id?: { iban?: string }
  name?: string
  details?: string
  cash_account_type?: string
  product?: string
}

export interface BankTransaction {
  entry_reference?: string | null
  transaction_id?: string | null
  transaction_amount: BankAmount
  credit_debit_indicator: string
  status?: string
  booking_date?: string | null
  value_date?: string | null
  transaction_date?: string | null
  remittance_information?: string[] | null
  creditor?: { name?: string | null } | null
  creditor_account?: { iban?: string | null } | null
  debtor?: { name?: string | null } | null
  debtor_account?: { iban?: string | null } | null
  bank_transaction_code?: { description?: string | null } | null
  note?: string | null
}

export interface BankBalance {
  balance_amount: BankAmount
  balance_type: string
  reference_date?: string | null
}

export interface EnableCredentials {
  applicationId: string
  /** PKCS#8 PEM ("BEGIN PRIVATE KEY"), as Enable Banking's portal downloads it. */
  privateKeyPem: string
}

/** Headers that say you are looking right now: the bank then allows more than 4 reads a day. */
export interface PresentUser {
  ip?: string
  userAgent?: string
}

// ------------------------------------------------------------------ JWT

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem)
  if (!match) throw new Error('Dit is geen privésleutel (.pem met BEGIN PRIVATE KEY).')
  if (match[1]) throw new Error('Deze sleutel is PKCS#1 ("RSA PRIVATE KEY"); Uurwerk verwacht PKCS#8 zoals Enable Banking hem geeft.')
  const raw = atob(match[2]!.replace(/\s+/g, ''))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return bytes
}

const keyCache = new Map<string, Promise<CryptoKey>>()

function signingKey(pem: string): Promise<CryptoKey> {
  let key = keyCache.get(pem)
  if (!key) {
    key = globalThis.crypto.subtle.importKey('pkcs8', pemBody(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
    keyCache.set(pem, key)
  }
  return key
}

export async function makeJwt(credentials: EnableCredentials, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: credentials.applicationId })))
  const claims = base64url(
    encoder.encode(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: nowSeconds, exp: nowSeconds + 3600 }))
  )
  const input = `${header}.${claims}`
  const signature = await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(credentials.privateKeyPem), encoder.encode(input))
  return `${input}.${base64url(new Uint8Array(signature))}`
}

// ------------------------------------------------------------------ calls

export class EnableBanking {
  constructor(
    private readonly credentials: EnableCredentials,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, present?: PresentUser): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await makeJwt(this.credentials)}`,
      Accept: 'application/json'
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (present?.ip) headers['Psu-Ip-Address'] = present.ip
    if (present?.userAgent) headers['Psu-User-Agent'] = present.userAgent
    const response = await this.fetcher(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    if (!response.ok) {
      let detail = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: string; detail?: unknown }
        detail = parsed.message ?? parsed.error ?? detail
      } catch {
        // Not JSON: the raw text says enough.
      }
      const error = new Error(`Bank (${response.status}): ${detail}`) as Error & { status?: number }
      error.status = response.status
      throw error
    }
    return (text ? JSON.parse(text) : null) as T
  }

  /** Step 1: a link to the bank. You confirm in the ABN AMRO app; the bank sends you back with a code. */
  startAuthorization(options: { redirectUrl: string; state: string; validUntil: Date; aspsp?: { name: string; country: string } }) {
    return this.call<{ url: string; authorization_id: string }>('POST', '/auth', {
      access: { valid_until: options.validUntil.toISOString(), balances: true, transactions: true },
      aspsp: options.aspsp ?? { name: 'ABN AMRO', country: 'NL' },
      state: options.state,
      redirect_url: options.redirectUrl,
      psu_type: 'personal'
    })
  }

  /** Step 2: the code becomes a session with your accounts. */
  createSession(code: string) {
    return this.call<{ session_id: string; accounts: BankAccount[]; access?: { valid_until?: string } }>('POST', '/sessions', { code })
  }

  session(sessionId: string) {
    return this.call<{ status?: string; accounts?: string[]; access?: { valid_until?: string } }>('GET', `/sessions/${encodeURIComponent(sessionId)}`)
  }

  endSession(sessionId: string) {
    return this.call<unknown>('DELETE', `/sessions/${encodeURIComponent(sessionId)}`)
  }

  balances(accountUid: string, present?: PresentUser) {
    return this.call<{ balances: BankBalance[] }>('GET', `/accounts/${encodeURIComponent(accountUid)}/balances`, undefined, present)
  }

  /** Every page from `dateFrom` on; the API pages with a continuation key. */
  async transactions(accountUid: string, dateFrom: string, present?: PresentUser): Promise<BankTransaction[]> {
    const out: BankTransaction[] = []
    let continuation: string | undefined
    for (let page = 0; page < 50; page += 1) {
      const query = new URLSearchParams({ date_from: dateFrom })
      if (continuation) query.set('continuation_key', continuation)
      const result = await this.call<{ transactions?: BankTransaction[]; continuation_key?: string | null }>(
        'GET',
        `/accounts/${encodeURIComponent(accountUid)}/transactions?${query.toString()}`,
        undefined,
        present
      )
      out.push(...(result.transactions ?? []))
      if (!result.continuation_key) break
      continuation = result.continuation_key
    }
    return out
  }
}
