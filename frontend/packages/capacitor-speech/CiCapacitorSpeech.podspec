require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  # `Ci` + PascalCase of the unscoped package name, matching what `cap sync ios`
  # derives from `@ci/capacitor-speech` when it regenerates the Podfile's
  # capacitor_pods block -- see the same note in CiCapacitorLocalHub.podspec.
  s.name = 'CiCapacitorSpeech'
  s.version = package['version']
  s.summary = package['description']
  # This pod is private and never published to a spec repo -- it's consumed only via the
  # generated `:path =>` entry in ../../apps/mobile/ios/App/Podfile (see capacitor_pods
  # there), exactly like CiCapacitorLocalHub. license/homepage/author are filler for
  # CocoaPods' benefit, not derived from package.json (which has neither field),
  # matching this repo's "Private & Confidential" status.
  s.license = 'UNLICENSED'
  s.homepage = 'https://github.com/companionintelligence/CI-Server'
  s.author = 'Lifescope Inc.'
  s.source = { :git => 'https://github.com/companionintelligence/CI-Server.git' }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  # No third-party dependency: Speech (SFSpeechRecognizer) and AVFoundation
  # (AVSpeechSynthesizer, AVAudioEngine) are system frameworks, linked automatically by
  # their `import` statements under CocoaPods' default module-based linking.
  s.swift_version = '5.1'
end
