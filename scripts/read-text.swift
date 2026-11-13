// The text macOS Vision reads in each image given on the command line: one JSON line per image, each line of
// text with its confidence and box (0-1, origin bottom-left). Used by diarize.py to read the name on the tile
// Google Meet highlights while someone talks. Runs on this Mac; nothing is sent anywhere.
//
//   swift read-text.swift a.bmp b.bmp ...
import Foundation
import ImageIO
import Vision

for path in CommandLine.arguments.dropFirst() {
  var lines: [[String: Any]] = []
  if let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    // names aren't dictionary words
    request.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: image).perform([request])
    for observation in request.results ?? [] {
      guard let best = observation.topCandidates(1).first else { continue }
      let box = observation.boundingBox
      lines.append(["text": best.string, "confidence": best.confidence, "x": box.minX, "y": box.minY, "w": box.width, "h": box.height])
    }
  }
  let data = try JSONSerialization.data(withJSONObject: ["file": path, "lines": lines])
  print(String(decoding: data, as: UTF8.self))
}
