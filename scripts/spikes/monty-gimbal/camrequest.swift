import AVFoundation
import Foundation
let sem = DispatchSemaphore(value: 0)
var granted = false
AVCaptureDevice.requestAccess(for: .video) { g in granted = g; sem.signal() }
if sem.wait(timeout: .now() + 50) == .timedOut {
  print("RESULT: requestAccess TIMED OUT after 50s - no consent dialog could be presented from this context")
} else {
  print("RESULT: requestAccess returned granted=\(granted)")
}
print("final authorizationStatus = \(AVCaptureDevice.authorizationStatus(for: .video).rawValue)")
