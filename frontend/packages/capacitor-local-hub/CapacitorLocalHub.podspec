require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorLocalHub'
  s.version = package['version']
  s.summary = package['description']
  # This pod is private and never published to a spec repo -- it's consumed only via a
  # local `:path =>` entry in ../../apps/mobile/ios/App/Podfile (see
  # capacitor_pods there). license/homepage/author are filler for CocoaPods' benefit,
  # not derived from package.json (which has neither field), matching this repo's
  # "Private & Confidential" status.
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
  s.swift_version = '5.1'
end
