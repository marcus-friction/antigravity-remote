Pod::Spec.new do |s|
  s.name = 'RemoteSession'
  s.version = '1.0.0'
  s.summary = 'Clear the persistent WebView profile during sign-out'
  s.description = s.summary
  s.author = 'Friction Ventures'
  s.homepage = 'https://github.com/frictionventures/antigravity-remote'
  s.license = { :type => 'MIT' }
  s.platforms = { :ios => '15.1' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
