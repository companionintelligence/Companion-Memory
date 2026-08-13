require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  # MUST be `Ci` + PascalCase of the unscoped package name, and the file MUST be named
  # `<s.name>.podspec`. `cap sync ios` REGENERATES the `def capacitor_pods` block of
  # ../../apps/mobile/ios/App/Podfile from the installed plugins, deriving the pod name
  # from package.json's `name` (`@ci/capacitor-local-hub` -> `CiCapacitorLocalHub`) and
  # the path from node_modules. A hand-written `pod 'CapacitorLocalHub', :path => ...`
  # line does not survive a sync, and CocoaPods then fails with
  # "No podspec found for `CiCapacitorLocalHub`". Renaming here instead of fighting the
  # generator is what makes `cap sync` idempotent.
  s.name = 'CiCapacitorLocalHub'
  s.version = package['version']
  s.summary = package['description']
  # This pod is private and never published to a spec repo -- it's consumed only via the
  # generated `:path =>` entry in ../../apps/mobile/ios/App/Podfile (see capacitor_pods
  # there). license/homepage/author are filler for CocoaPods' benefit, not derived from
  # package.json (which has neither field), matching this repo's "Private &
  # Confidential" status.
  s.license = 'UNLICENSED'
  s.homepage = 'https://github.com/companionintelligence/CI-Server'
  s.author = 'Lifescope Inc.'
  s.source = { :git => 'https://github.com/companionintelligence/CI-Server.git' }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  # swisspol/GCDWebServer -- embedded HTTP server. Only the default 'Core' subspec is
  # needed (plain routing + JSON responses); we don't use the WebDAV/WebUploader
  # subspecs. Pinned to the 3.5.x line (latest tagged release at the time of writing is
  # 3.5.4); bump the constraint if a newer major is verified compatible.
  s.dependency 'GCDWebServer', '~> 3.5'
  # The durable outbox (ios/Sources/LocalHubPlugin/OutboxStore.swift) uses the system
  # SQLite via `import SQLite3`. The iOS SDK's SQLite3 module map already declares
  # `link "sqlite3"`, so autolinking usually covers this -- declaring it explicitly
  # costs nothing and removes the "undefined symbol: _sqlite3_open_v2" failure mode if
  # autolinking is disabled by a build setting. NOT SQLCipher: encryption at rest is a
  # deliberate follow-up slice, see README.md.
  s.library = 'sqlite3'
  s.swift_version = '5.1'
end
