import AVFoundation
let s = AVCaptureDevice.authorizationStatus(for: .video)
let names = [0:"notDetermined", 1:"restricted", 2:"denied", 3:"authorized"]
print("video authorizationStatus = \(s.rawValue) (\(names[s.rawValue] ?? "?"))")
for d in AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera], mediaType: .video, position: .unspecified).devices {
  print("device: \(d.localizedName) | uniqueID=\(d.uniqueID) | type=\(d.deviceType.rawValue) | connected=\(d.isConnected) | suspended=\(d.isSuspended)")
}
