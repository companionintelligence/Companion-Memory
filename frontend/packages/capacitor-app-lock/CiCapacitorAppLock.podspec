require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  # `Ci` + PascalCase of the unscoped package name, matching what `cap sync ios`
  # derives from `@ci/capacitor-app-lock` when it regenerates the Podfile's
  # capacitor_pods block -- see the same note in CiCapacitorLocalHub.podspec.
  s.name = 'CiCapacitorAppLock'
  s.version = package['version']
  s.summary = package['description']
  # Private, never published; consumed only via the generated `:path =>` entry in
  # ../../apps/ios/ios/App/Podfile. license/homepage/author are filler for CocoaPods.
  s.license = 'UNLICENSED'
  s.homepage = 'https://github.com/companionintelligence/CI-Server'
  s.author = 'Lifescope Inc.'
  s.source = { :git => 'https://github.com/companionintelligence/CI-Server.git' }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  # LocalAuthentication and UIKit are system frameworks, linked by their imports.
  s.swift_version = '5.1'
end
