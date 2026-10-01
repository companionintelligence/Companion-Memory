import Foundation

/// Lifecycle of a model on disk. Mirrors Android's `LocalLlmModelStatus` and the TS union in
/// `@ci/capacitor-local-llm`'s `definitions.ts`.
enum ModelStatus: String {
  case notDownloaded = "not_downloaded"
  case downloading
  case ready
  case error
}

struct ModelStatusResult {
  let status: ModelStatus
  let bytesDownloaded: Int64
  let totalBytes: Int64
  let error: String?

  var asDictionary: [String: Any] {
    var result: [String: Any] = ["status": status.rawValue]

    // Only meaningful mid-download or after a failure; omitted otherwise so a caller cannot
    // mistake a hardcoded 0 for "nothing downloaded yet".
    if status == .downloading || status == .error {
      result["bytesDownloaded"] = bytesDownloaded
      result["totalBytes"] = totalBytes
    }
    if let error { result["error"] = error }

    return result
  }
}

/// Resumable model download, the iOS counterpart to Android's WorkManager `ModelDownloadWorker`.
///
/// Deliberately built on a manual `Range` request streaming into a `.part` file rather than
/// `URLSessionDownloadTask`'s `resumeData`:
///
/// - It matches Android's on-disk convention exactly (`<name>.part`, promoted on completion), so
///   the two platforms are debuggable the same way.
/// - `resumeData` is opaque, is invalidated by app termination in several documented cases, and
///   cannot resume a download that was interrupted by the user force-quitting. A byte offset on
///   disk survives all of that: the next attempt just asks for `bytes=<size>-`.
///
/// One download per model at a time; a second `start` for the same model is ignored rather than
/// racing a second writer onto the same `.part` file.
final class ModelDownloader: NSObject {
  /// `error` is the failure message, present only with `.error` — the JS event carries it so the UI
  /// can say why (Android sends the same field).
  typealias ProgressHandler = (
    _ modelId: String, _ status: ModelStatus, _ downloaded: Int64, _ total: Int64, _ error: String?
  ) -> Void

  private let onProgress: ProgressHandler
  private var session: URLSession!
  private var active: [Int: Download] = [:]
  private let lock = NSLock()

  private final class Download {
    let info: LocalLLMModelInfo
    let task: URLSessionDataTask
    let handle: FileHandle
    let destination: URL
    let partial: URL
    /// Bytes already on disk when this attempt started — the base for reported progress, since the
    /// server only streams the remainder of a ranged request.
    let resumeOffset: Int64
    var received: Int64 = 0
    var expectedTotal: Int64
    /// Set (under the downloader's lock) by ``ModelDownloader/cancelDownload(_:)`` and
    /// ``ModelDownloader/delete(_:)`` before the task is cancelled, so `finish` can tell "the user
    /// abandoned this" — drop the `.part` — from "the connection paused", which keeps it to resume.
    var discardPartial = false

    init(
      info: LocalLLMModelInfo, task: URLSessionDataTask, handle: FileHandle, destination: URL,
      partial: URL, resumeOffset: Int64
    ) {
      self.info = info
      self.task = task
      self.handle = handle
      self.destination = destination
      self.partial = partial
      self.resumeOffset = resumeOffset
      self.expectedTotal = info.sizeBytes
    }

    var downloadedTotal: Int64 { resumeOffset + received }
  }

  init(onProgress: @escaping ProgressHandler) {
    self.onProgress = onProgress
    super.init()

    let configuration = URLSessionConfiguration.default
    // A half-gigabyte download over a slow link must not trip the default 60s resource timeout.
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 60 * 60 * 6
    self.session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }

  private func report(
    _ modelId: String, _ status: ModelStatus, _ downloaded: Int64, _ total: Int64, error: String? = nil
  ) {
    onProgress(modelId, status, downloaded, total, error)
  }

  /// Current on-disk state, with byte progress when a download is in flight or was interrupted.
  func status(of info: LocalLLMModelInfo) -> ModelStatusResult {
    guard
      let destination = try? LocalLLMModels.modelFile(info),
      let partial = try? LocalLLMModels.partialFile(info)
    else {
      return ModelStatusResult(status: .error, bytesDownloaded: 0, totalBytes: info.sizeBytes,
                               error: "Could not resolve the models directory")
    }

    if FileManager.default.fileExists(atPath: destination.path) {
      // A truncated file is worse than a missing one: it loads and then fails deep inside the
      // engine. Treat a size mismatch as "not downloaded" so the next call re-fetches it.
      let onDisk = fileSize(destination)

      if onDisk == info.sizeBytes {
        return ModelStatusResult(status: .ready, bytesDownloaded: onDisk, totalBytes: onDisk, error: nil)
      }

      return ModelStatusResult(
        status: .error, bytesDownloaded: onDisk, totalBytes: info.sizeBytes,
        error: "Downloaded file is \(onDisk) bytes, expected \(info.sizeBytes). Delete and re-download.")
    }

    if isDownloading(info.modelId) {
      let downloaded = fileSize(partial)

      return ModelStatusResult(status: .downloading, bytesDownloaded: downloaded,
                               totalBytes: info.sizeBytes, error: nil)
    }

    if FileManager.default.fileExists(atPath: partial.path) {
      let onDisk = fileSize(partial)

      switch LocalLLMPolicy.partialState(partialBytes: onDisk, expectedBytes: info.sizeBytes) {
      case .empty:
        break
      case .interrupted:
        // Not in flight (checked above) and short of the whole file: the download was interrupted.
        // Reported as an error, with the bytes it reached, so the UI offers Retry — `downloadModel`
        // resumes from this `.part` — rather than a "downloading" state that only offers Cancel.
        return ModelStatusResult(
          status: .error, bytesDownloaded: onDisk, totalBytes: info.sizeBytes,
          error: LocalLLMPolicy.interruptedDownloadMessage)
      case .finishing:
        return ModelStatusResult(
          status: .downloading, bytesDownloaded: onDisk, totalBytes: info.sizeBytes, error: nil)
      case .oversize:
        // Longer than the whole file: a different file than the catalog pins, not a slow download.
        return ModelStatusResult(
          status: .error, bytesDownloaded: onDisk, totalBytes: info.sizeBytes,
          error: "Downloaded file is \(onDisk) bytes, expected \(info.sizeBytes). Delete and re-download.")
      }
    }

    return ModelStatusResult(status: .notDownloaded, bytesDownloaded: 0, totalBytes: info.sizeBytes, error: nil)
  }

  /// Starts (or resumes) the download of the catalog's own pinned ``LocalLLMModelInfo/url`` — never a
  /// URL a caller supplied — and verifies the result against the catalog's
  /// ``LocalLLMModelInfo/sizeBytes``, never against whatever the server claims. Throws only on
  /// conditions the caller can act on; transport failures surface through the progress handler as
  /// `.error`.
  func start(_ info: LocalLLMModelInfo) throws {
    if isDownloading(info.modelId) { return }

    let destination = try LocalLLMModels.modelFile(info)
    if FileManager.default.fileExists(atPath: destination.path), fileSize(destination) == info.sizeBytes {
      report(info.modelId, .ready, info.sizeBytes, info.sizeBytes)

      return
    }

    let partial = try LocalLLMModels.partialFile(info)

    // A partial that is already as long as the whole file yet never got promoted cannot be resumed
    // (`Range` past the end is a 416) and cannot be trusted; start over.
    if LocalLLMPolicy.resumePlan(partialBytes: fileSize(partial), expectedBytes: info.sizeBytes) == .restart {
      try? FileManager.default.removeItem(at: partial)
    }

    // Only what is still to fetch has to fit: the bytes of a resumable `.part` are already on disk.
    let free = LocalLLMModels.freeDiskBytes()
    let onDisk = fileSize(partial)

    guard LocalLLMPolicy.hasEnoughDisk(freeBytes: free, sizeBytes: info.sizeBytes, bytesAlreadyOnDisk: onDisk) else {
      throw LocalLLMError.insufficientDisk(
        requiredBytes: LocalLLMPolicy.requiredFreeDiskBytes(sizeBytes: info.sizeBytes, bytesAlreadyOnDisk: onDisk),
        availableBytes: free ?? 0)
    }

    if !FileManager.default.fileExists(atPath: partial.path) {
      FileManager.default.createFile(atPath: partial.path, contents: nil)
    }

    let resumeOffset = fileSize(partial)
    let handle = try FileHandle(forWritingTo: partial)
    try handle.seekToEnd()

    var request = URLRequest(url: info.url)
    if resumeOffset > 0 {
      request.setValue("bytes=\(resumeOffset)-", forHTTPHeaderField: "Range")
    }

    let task = session.dataTask(with: request)
    let download = Download(info: info, task: task, handle: handle, destination: destination,
                            partial: partial, resumeOffset: resumeOffset)

    lock.lock()
    active[task.taskIdentifier] = download
    lock.unlock()

    report(info.modelId, .downloading, resumeOffset, info.sizeBytes)
    task.resume()
  }

  /// Cancels any in-flight download and removes both the finished file and the partial.
  func delete(_ info: LocalLLMModelInfo) {
    _ = abandonActiveDownload(of: info.modelId)

    if let destination = try? LocalLLMModels.modelFile(info) {
      try? FileManager.default.removeItem(at: destination)
    }
    if let partial = try? LocalLLMModels.partialFile(info) {
      try? FileManager.default.removeItem(at: partial)
    }
  }

  /// Stops an in-flight download and drops its `.part`, then reports `not_downloaded` — the final
  /// `modelDownloadProgress` the caller is promised. Also clears a `.part` left by an interrupted
  /// attempt (which `status` reports as `downloading`), so the UI's Cancel is never a dead button.
  /// A model that is already fully on disk is left alone.
  func cancelDownload(_ info: LocalLLMModelInfo) {
    if let destination = try? LocalLLMModels.modelFile(info),
      FileManager.default.fileExists(atPath: destination.path),
      fileSize(destination) == info.sizeBytes
    {
      return
    }

    // In flight: `finish` deletes the partial and reports once the task has actually stopped, so no
    // late byte can land after the file is gone.
    if abandonActiveDownload(of: info.modelId) { return }

    if let partial = try? LocalLLMModels.partialFile(info) {
      try? FileManager.default.removeItem(at: partial)
    }
    report(info.modelId, .notDownloaded, 0, info.sizeBytes)
  }

  /// Marks every in-flight download of `modelId` as abandoned and cancels its task. Returns whether
  /// there was one. (A cancel that is *not* an abandonment — the connection paused — leaves the
  /// `.part` for the next `start` to resume.)
  private func abandonActiveDownload(of modelId: String) -> Bool {
    lock.lock()
    let downloads = active.values.filter { $0.info.modelId == modelId }
    downloads.forEach { $0.discardPartial = true }
    lock.unlock()

    downloads.forEach { $0.task.cancel() }

    return !downloads.isEmpty
  }

  private func isDownloading(_ modelId: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }

    return active.values.contains { $0.info.modelId == modelId }
  }

  private func fileSize(_ url: URL) -> Int64 {
    (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int64 ?? 0
  }
}

extension ModelDownloader: URLSessionDataDelegate {
  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    lock.lock()
    let download = active[dataTask.taskIdentifier]
    lock.unlock()

    guard let download, let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)

      return
    }

    // 206 = ranged resume honoured. 200 with a resume offset means the server ignored the Range
    // header and is restarting from byte 0 — appending would corrupt the file, so truncate first.
    if download.resumeOffset > 0 && http.statusCode == 200 {
      try? download.handle.truncate(atOffset: 0)
      try? download.handle.seek(toOffset: 0)
    }

    guard (200..<300).contains(http.statusCode) else {
      finish(dataTask, error: IntentToolError.transport("Download failed (HTTP \(http.statusCode))"))
      completionHandler(.cancel)

      return
    }

    if http.expectedContentLength > 0 {
      let base = http.statusCode == 206 ? download.resumeOffset : 0
      download.expectedTotal = base + http.expectedContentLength
    }

    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock()
    let download = active[dataTask.taskIdentifier]
    lock.unlock()

    guard let download else { return }

    do {
      try download.handle.write(contentsOf: data)
    } catch {
      dataTask.cancel()
      finish(dataTask, error: error)

      return
    }

    download.received += Int64(data.count)
    report(download.info.modelId, .downloading, download.downloadedTotal, download.expectedTotal)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    finish(task, error: error)
  }

  private func finish(_ task: URLSessionTask, error: Error?) {
    lock.lock()
    guard let download = active.removeValue(forKey: task.taskIdentifier) else {
      lock.unlock()

      return
    }
    lock.unlock()

    try? download.handle.close()

    if download.discardPartial {
      // Abandoned by the user (cancelDownload / delete), including the case where the cancel raced
      // the last byte: nothing of it is kept.
      try? FileManager.default.removeItem(at: download.partial)
      report(download.info.modelId, .notDownloaded, 0, download.info.sizeBytes)

      return
    }

    if let error {
      // The `.part` file is intentionally left in place: the next start() resumes from it. It is an
      // `error` either way — a dropped connection, the app backgrounded, a stray cancellation — and
      // the message goes out with the event, because a UI that is told only "error" cannot say why
      // (and `status()` will report the same `.part` as interrupted on the next poll).
      let cancelled = (error as NSError).code == NSURLErrorCancelled
      let message = cancelled ? LocalLLMPolicy.interruptedDownloadMessage : error.localizedDescription

      report(download.info.modelId, .error, fileSize(download.partial), download.expectedTotal, error: message)

      if !cancelled {
        NSLog("[LocalLLM] model download failed: %@", error.localizedDescription)
      }

      return
    }

    let finalSize = fileSize(download.partial)

    guard finalSize == download.info.sizeBytes else {
      if finalSize > download.info.sizeBytes {
        // The server finished cleanly and sent MORE than the pinned file holds: this is a different
        // file, not a slow one, so retrying the same request cannot fix it. Surface it as an error
        // (`status` reports the same from the `.part`) instead of parking at "downloading" forever.
        NSLog("[LocalLLM] model download is larger than expected: %lld of %lld bytes", finalSize, download.info.sizeBytes)
        report(
          download.info.modelId, .error, finalSize, download.info.sizeBytes,
          error: "Downloaded file is \(finalSize) bytes, expected \(download.info.sizeBytes). Delete and re-download.")

        return
      }

      // Truncated rather than failed-outright: keep the partial so a retry resumes, and report the
      // mismatch instead of promoting a file that would fail deep inside the engine at load time.
      NSLog("[LocalLLM] model download incomplete: %lld of %lld bytes", finalSize, download.info.sizeBytes)
      report(
        download.info.modelId, .error, finalSize, download.info.sizeBytes,
        error: LocalLLMPolicy.interruptedDownloadMessage)

      return
    }

    do {
      if FileManager.default.fileExists(atPath: download.destination.path) {
        try FileManager.default.removeItem(at: download.destination)
      }
      try FileManager.default.moveItem(at: download.partial, to: download.destination)
      report(download.info.modelId, .ready, finalSize, finalSize)
    } catch {
      report(
        download.info.modelId, .error, finalSize, download.info.sizeBytes,
        error: "Could not save the downloaded model: \(error.localizedDescription)")
      NSLog("[LocalLLM] could not promote the downloaded model: %@", error.localizedDescription)
    }
  }
}
