import UIKit
import Capacitor
import Vision

/// The app's web view controller. It registers Blue Board's own native plugins.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ReceiptScanPlugin())
    }
}

/// Reads the text on a receipt photo with Apple's on-device text recognition (no internet needed).
/// JS: Capacitor.Plugins.ReceiptScan.recognize({ image: <base64 JPEG> }) -> { lines: [String] }
@objc(ReceiptScanPlugin)
public class ReceiptScanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReceiptScanPlugin"
    public let jsName = "ReceiptScan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise)
    ]

    @objc func recognize(_ call: CAPPluginCall) {
        guard let b64 = call.getString("image"),
              let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
              let image = UIImage(data: data)?.cgImage else {
            call.reject("Could not read the photo")
            return
        }
        let request = VNRecognizeTextRequest { request, error in
            if let error = error { call.reject(error.localizedDescription); return }
            let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
            // Top to bottom, as printed on the receipt.
            let lines = observations
                .sorted { $0.boundingBox.midY > $1.boundingBox.midY }
                .compactMap { $0.topCandidates(1).first?.string }
            call.resolve(["lines": lines])
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}
