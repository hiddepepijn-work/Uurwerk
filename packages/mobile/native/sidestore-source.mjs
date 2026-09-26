// Writes source.json: the SideStore source for the build just made. Added once in SideStore
// (Sources → +), it makes every new build show up there as an Update.
//   RUN=<github run number> MESSAGE=<commit message> node sidestore-source.mjs <ipa>
import { statSync, writeFileSync } from 'node:fs'

const [ipa] = process.argv.slice(2)
const run = process.env.RUN ?? '0'
const note = (process.env.MESSAGE ?? '').split('\n')[0] || 'Nieuwe build.'

const source = {
  name: 'Uurwerk',
  identifier: 'nl.hiddepepijn.uurwerk.source',
  subtitle: 'Uren, planning en Jarvis',
  apps: [
    {
      name: 'Uurwerk',
      bundleIdentifier: 'nl.hiddepepijn.uurwerk',
      developerName: 'Hidde',
      subtitle: 'Uren, planning en Jarvis',
      localizedDescription: 'Uren, planning en Jarvis.',
      iconURL: 'https://raw.githubusercontent.com/hiddepepijn-work/Uurwerk/vps-bron/resources/icon.png',
      tintColor: '3ECF73',
      versions: [
        {
          // The same numbers the workflow writes into Info.plist.
          version: `0.1.${run}`,
          buildVersion: run,
          date: new Date().toISOString(),
          localizedDescription: note,
          downloadURL: 'https://github.com/hiddepepijn-work/Uurwerk/releases/download/ios-latest/Uurwerk.ipa',
          size: statSync(ipa).size,
          minOSVersion: '15.0'
        }
      ],
      appPermissions: {
        entitlements: ['com.apple.security.application-groups'],
        privacy: {
          NSMicrophoneUsageDescription: 'Om met Jarvis te praten.',
          NSSpeechRecognitionUsageDescription: 'Om te verstaan wat je tegen Jarvis zegt.'
        }
      }
    }
  ],
  news: []
}

writeFileSync('source.json', JSON.stringify(source, null, 2))
console.log(`source.json for 0.1.${run}`)
