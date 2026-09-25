import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'nl.hiddepepijn.uurwerk',
  appName: 'Uurwerk',
  webDir: 'dist',
  ios: {
    // The app draws its own safe-area padding (env(safe-area-inset-*)).
    contentInset: 'never',
    backgroundColor: '#0f1115'
  },
  plugins: {
    LocalNotifications: {
      sound: 'ochtend.caf'
    }
  }
}

export default config
