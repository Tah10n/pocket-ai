#!/usr/bin/env ruby
# Inspect actual CocoaPods resolution and generated build phases after pod install.
require 'cocoapods'
require 'xcodeproj'
require 'json'
require 'pathname'
root = Pathname.new(File.expand_path('..', __dir__))
app = root.join('../..').cleanpath
spec = Pod::Specification.from_file(app.join('ios/Pods/Local Podspecs/PocketPhonemizer.podspec.json'))
accessor = Pod::Sandbox::FileAccessor.new(root, spec.consumer(:ios))
core = %w[common mnemonics error ieee80 compiledata compiledict dictionary encoding intonation langopts numbers phoneme phonemelist readclause setlengths soundicon spect ssml synthdata synthesize tr_languages translate translateword voices wavegen speech espeak_api]
unicode = %w[case categories ctype proplist scripts tostring]
expected = %w[cpp/PhonemizerCore.cpp ios/PocketPhonemizerBridge.mm ios/PocketPhonemizerModule.swift] +
  core.map { |name| "generated/source/espeak-ng/src/libespeak-ng/#{name}.c" } +
  unicode.map { |name| "generated/source/espeak-ng/src/ucd-tools/src/#{name}.c" }
canonical = ->(paths) { paths.map { |p| Pathname.new(p).realpath.to_s }.uniq }
expected_paths = canonical.call(expected.map { |p| root.join(p) })
missing = expected_paths - canonical.call(accessor.source_files)
raise "PocketPhonemizer CocoaPods source list missing #{missing.length} required files" unless missing.empty?
project = Xcodeproj::Project.open(app.join('ios/Pods/Pods.xcodeproj'))
targets = project.targets.select { |t| t.name == 'PocketPhonemizer' }
raise 'Expected exactly one PocketPhonemizer target' unless targets.length == 1
compiled = canonical.call(targets.first.source_build_phase.files_references.map(&:real_path))
missing = expected_paths - compiled
raise "PocketPhonemizer compile phase missing #{missing.length} required files" unless missing.empty?
# Headers are copied by visibility into flat framework directories. Do not let
# upstream duplicate basenames enter that phase; keep them as on-disk includes.
public_headers = canonical.call([root.join('ios/PocketPhonemizerBridge.h')])
private_headers = canonical.call(%w[ios/include/config.h cpp/PhonemizerCore.h cpp/data-identity.h].map { |p| root.join(p) })
raise 'Unexpected public phonemizer headers' unless canonical.call(accessor.public_headers).sort == public_headers.sort
raise 'Unexpected private phonemizer headers' unless canonical.call(accessor.private_headers).sort == private_headers.sort
projected = {}
copied = []
upstream_root = root.join('generated/source/espeak-ng/src').realpath.to_s + File::SEPARATOR
targets.first.headers_build_phase.files.each do |build_file|
  header = build_file.file_ref.real_path.realpath.to_s
  raise 'Upstream phonemizer header entered copy phase' if header.start_with?(upstream_root)
  attributes = Array((build_file.settings || {})['ATTRIBUTES'])
  visibility = attributes.include?('Public') ? 'Public' : (attributes.include?('Private') ? 'Private' : 'Project')
  key = [visibility, File.basename(header).downcase]
  raise "Duplicate projected phonemizer #{visibility} header basename" if projected.key?(key)
  projected[key] = header
  copied << header
end
raise 'Required phonemizer headers absent from copy phase' unless ((public_headers + private_headers) - copied).empty?
resources = canonical.call(%w[assets/data-manifest.json assets/espeak-ng-data].map { |p| root.join(p) })
resolved_resources = canonical.call(accessor.resource_bundles.fetch('PocketPhonemizerData'))
raise 'PocketPhonemizer resolved data resources missing' unless (resources - resolved_resources).empty?
bundles = project.targets.select { |t| t.name == 'PocketPhonemizer-PocketPhonemizerData' }
raise 'Expected exactly one PocketPhonemizer data bundle target' unless bundles.length == 1
bundled = canonical.call(bundles.first.resources_build_phase.files_references.map(&:real_path))
raise 'PocketPhonemizer data resources absent from bundle phase' unless (resources - bundled).empty?
puts JSON.generate(status: 'passed', required_compile_sources: expected_paths.length, required_bundle_resources: resources.length, scope: 'actual CocoaPods resolution and generated build phases; not runtime inference')