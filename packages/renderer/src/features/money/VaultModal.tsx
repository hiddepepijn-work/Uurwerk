import { useState } from 'react'

import type { MoneyVaultStatus } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { Field, input } from './parts.js'

/**
 * Turning on Geld's encrypted sync. The first device makes the vault with a passphrase; every
 * other device opens it with the same one. Nothing here is ever sent in the clear, and the
 * passphrase itself never leaves this device — only what it locks.
 */
export function VaultModal({ status, onClose }: { status: MoneyVaultStatus; onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async (): Promise<void> => {
    if (passphrase.length < 8) return setError('Minstens 8 tekens.')
    if (again && again !== passphrase) return setError('De twee keer zijn niet gelijk.')
    setBusy(true)
    setError(null)
    try {
      await api.money.vaultSetup(passphrase)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const forget = async (): Promise<void> => {
    await api.money.vaultForget()
    onClose()
  }

  if (status.enabled) {
    return (
      <Modal
        open
        width={520}
        title="Geld synchroniseert"
        subtitle="Versleuteld met je wachtwoordzin. De server ziet alleen onleesbare blokjes."
        onClose={onClose}
        footer={
          <>
            <Button variant="danger" onClick={() => void forget()}>
              Sleutel vergeten op dit apparaat
            </Button>
            <Button variant="primary" onClick={onClose}>
              Klaar
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-[14px] text-text-dim">
          <p>
            Laatste keer: <b className="text-text">{status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : 'nog niet'}</b>
            {status.pending > 0 ? ` · ${status.pending} wijzigingen wachten` : ''}
          </p>
          {status.lastError && <p className="font-bold text-danger-text">{status.lastError}</p>}
          <p>Vergeten wist alleen de sleutel hier; je gegevens blijven op dit apparaat en in de kluis.</p>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      width={520}
      title="Geld live op al je apparaten"
      subtitle="Eerste apparaat: kies een wachtwoordzin. Tweede apparaat: typ dezelfde."
      onClose={onClose}
      footer={
        <>
          <span className="text-[12px] text-text-dim">Kwijt = de kluis niet meer te openen. Bewaar hem goed.</span>
          <Button variant="primary" onClick={() => void open()} disabled={busy || !status.paired}>
            {busy ? 'Bezig…' : 'Openen'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!status.paired && (
          <p className="rounded-[14px] bg-warn-soft px-3 py-2.5 text-[13px] font-bold text-warn">
            Dit apparaat is nog niet aan de server gekoppeld. Doe dat eerst onder Settings → Sync.
          </p>
        )}
        <Field label="Wachtwoordzin">
          <input className={input} type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
        </Field>
        <Field label="Nog een keer (alleen bij het eerste apparaat)">
          <input className={input} type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} />
        </Field>
        <ul className="list-disc pl-5 text-[13px] leading-relaxed text-text-dim">
          <li>Elke rij wordt op dit apparaat versleuteld (AES-GCM) voordat hij weggaat.</li>
          <li>De server, je begeleider, je docent en Jarvis kunnen er niets mee.</li>
          <li>Wijzigingen staan binnen een paar seconden op je andere apparaat.</li>
        </ul>
        {error && <p className="text-[13px] font-bold text-danger-text">{error}</p>}
      </div>
    </Modal>
  )
}
