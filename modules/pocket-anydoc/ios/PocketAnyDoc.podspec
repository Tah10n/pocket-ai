require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
xcframework = File.join(__dir__, 'generated', 'PocketAnyDoc.xcframework')

unless File.directory?(xcframework)
  raise <<~MESSAGE
    PocketAnyDoc.xcframework is missing.
    Run `node modules/pocket-anydoc/scripts/build-ios.mjs` before `pod install`.
    EAS builds must wire modules/pocket-anydoc/scripts/eas-build-pre-install.mjs.
  MESSAGE
end

Pod::Spec.new do |s|
  s.name             = 'PocketAnyDoc'
  s.version          = package['version']
  s.summary          = package['description']
  s.description      = package['description']
  s.license          = package['license']
  s.author           = 'Pocket AI contributors'
  s.homepage         = 'https://github.com/Tah10n/pocket-ai'
  s.source           = { :path => '.' }
  s.platforms        = { :ios => '15.1' }
  s.swift_version    = '5.9'
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.source_files = [
    'PocketAnyDocModule.swift',
    'PocketAnyDocBridge.h'
  ]
  s.public_header_files = 'PocketAnyDocBridge.h'
  s.header_mappings_dir = '.'
  s.vendored_frameworks = 'generated/PocketAnyDoc.xcframework'
  s.preserve_paths = 'generated/PocketAnyDoc.xcframework'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/../include"',
    'IPHONEOS_DEPLOYMENT_TARGET' => '15.1',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
