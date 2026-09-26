// swift-tools-version: 5.9
import PackageDescription

// The name must be what the Capacitor CLI derives from the npm name "uurwerk-audio-focus".
let package = Package(
    name: "UurwerkAudioFocus",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "UurwerkAudioFocus",
            targets: ["AudioFocusPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "AudioFocusPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/AudioFocusPlugin")
    ]
)
