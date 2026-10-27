# iPhone app

The browser version still cannot vibrate in Safari or other iPhone browsers because iOS does not expose the Web Vibration API. This repository includes a Capacitor iOS app that uses Core Haptics for both uploaded audio and Live Listening.

## Run on an iPhone

You need a Mac with Xcode and an Apple developer account.

1. Install dependencies with `pnpm install`.
2. Build the web app and copy it into the native project with `pnpm ios:sync`.
3. Open the Xcode project with `pnpm ios:open`.
4. In Xcode, select the **App** target, open **Signing & Capabilities**, and choose your development team.
5. Connect an iPhone, select it as the run destination, and press **Run**.

Core Haptics is unavailable in the iOS Simulator, so vibration must be tested on a physical iPhone.

Run `pnpm ios:sync` again after changing the React app. Distribution to other users requires TestFlight or the App Store.
