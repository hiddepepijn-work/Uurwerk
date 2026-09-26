# Adds the widget extension to the Xcode project that `npx cap add ios` generates on the
# GitHub Mac. The project is regenerated on every build, so this runs every build too.
#
#   ruby add-widget.rb <path to App.xcodeproj>
#
# Expects packages/mobile/native/widget/* copied to ios/App/UurwerkWidget/ and
# App.entitlements to ios/App/App/ beforehand (the workflow does both).

require 'xcodeproj'

project = Xcodeproj::Project.open(ARGV.fetch(0))
app = project.targets.find { |target| target.name == 'App' } or abort('No App target')

widget = project.new_target(:app_extension, 'UurwerkWidget', :ios, '17.0')

group = project.main_group.new_group('UurwerkWidget', 'UurwerkWidget')
widget.add_file_references([group.new_reference('UurwerkWidget.swift')])
group.new_reference('Info.plist')
group.new_reference('UurwerkWidget.entitlements')

widget.build_configurations.each do |config|
  settings = config.build_settings
  settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'nl.hiddepepijn.uurwerk.widget'
  settings['PRODUCT_NAME'] = '$(TARGET_NAME)'
  settings['INFOPLIST_FILE'] = 'UurwerkWidget/Info.plist'
  settings['GENERATE_INFOPLIST_FILE'] = 'NO'
  settings['CODE_SIGN_ENTITLEMENTS'] = 'UurwerkWidget/UurwerkWidget.entitlements'
  settings['SWIFT_VERSION'] = '5.0'
  settings['TARGETED_DEVICE_FAMILY'] = '1,2'
  settings['IPHONEOS_DEPLOYMENT_TARGET'] = '17.0'
  settings['SKIP_INSTALL'] = 'YES'
  settings['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  settings['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  settings['MARKETING_VERSION'] = app.build_configurations.first.build_settings['MARKETING_VERSION'] || '1.0'
  settings['CURRENT_PROJECT_VERSION'] = app.build_configurations.first.build_settings['CURRENT_PROJECT_VERSION'] || '1'
end

%w[WidgetKit SwiftUI AppIntents].each { |framework| widget.add_system_framework(framework) }

# The app carries the extension in PlugIns/ and builds it first.
embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
build_file = embed.add_file_reference(widget.product_reference, true)
build_file.settings = { 'ATTRIBUTES' => %w[RemoveHeadersOnCopy] }
app.add_dependency(widget)

# The app and the widget share one App Group: the app writes widget.json, the widget reads it.
app.build_configurations.each do |config|
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
end
project.main_group.find_subpath('App', false)&.new_reference('App.entitlements')

project.save
puts 'Widget extension added.'
