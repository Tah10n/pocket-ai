require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
root = File.expand_path('..', __dir__)
raise 'Pinned offline phonemizer source verification failed' unless system('node', File.join(root, 'scripts/prepare-source.mjs'))
raise 'Pinned offline phonemizer data verification failed' unless system('node', File.join(root, 'scripts/verify-data.mjs'))
source = File.join(root, 'generated/source/espeak-ng')
raise 'Prepare pinned offline phonemizer source and data before pod install' unless File.file?(File.join(source, 'src/libespeak-ng/speech.c')) && File.file?(File.join(root, 'cpp/data-identity.h'))
Pod::Spec.new do |s|
  s.name = 'PocketPhonemizer'
  s.version = package['version']
  s.summary = package['description']
  s.description = package['description']
  s.license = package['license']
  s.author = 'Pocket AI contributors'
  s.homepage = 'https://github.com/Tah10n/pocket-ai'
  s.source = { :path => '.' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  core = %w[common mnemonics error ieee80 compiledata compiledict dictionary encoding intonation langopts numbers phoneme phonemelist readclause setlengths soundicon spect ssml synthdata synthesize tr_languages translate translateword voices wavegen speech espeak_api]
  unicode = %w[case categories ctype proplist scripts tostring]
  s.source_files = ['*.{swift,h,mm}', '../cpp/PhonemizerCore.{h,cpp}', '../cpp/data-identity.h', 'include/config.h',
    '../generated/source/espeak-ng/src/**/*.h'] + core.map { |name| "../generated/source/espeak-ng/src/libespeak-ng/#{name}.c" } + unicode.map { |name| "../generated/source/espeak-ng/src/ucd-tools/src/#{name}.c" }
  s.public_header_files = 'PocketPhonemizerBridge.h'
  s.private_header_files = ['include/config.h', '../cpp/*.h', '../generated/source/espeak-ng/src/**/*.h']
  # Directory entries are folder resources: preserve espeak-ng-data's nested language/voice paths.
  s.resource_bundles = { 'PocketPhonemizerData' => ['../assets/data-manifest.json', '../assets/espeak-ng-data'] }
  s.frameworks = 'Foundation', 'CryptoKit'
  s.libraries = 'c++'
  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) LIBESPEAK_NG_EXPORT=1 N_PATH_HOME=512 PATH_ESPEAK_DATA=\\"/nonexistent\\"',
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/include" "${PODS_TARGET_SRCROOT}/../generated/source/espeak-ng/src/include" "${PODS_TARGET_SRCROOT}/../generated/source/espeak-ng/src/include/compat" "${PODS_TARGET_SRCROOT}/../generated/source/espeak-ng/src/ucd-tools/src/include"'
  }
end
