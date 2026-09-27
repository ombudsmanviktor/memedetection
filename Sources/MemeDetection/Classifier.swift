import CoreML
import Foundation
import ImageIO
import Vision

struct ImageResult {
    var p: Double = 0          // P(meme)
    var logit: Double = 0      // log-odds de meme
    var error: String? = nil

    var json: [String: Any] {
        if let e = error { return ["error": e] }
        return ["p": p, "logit": logit]
    }
}

/// Classificador meme × foto com o modelo original (commit de6affb do
/// repositório maty-bohacek/meme-detection). O .mlmodel é compilado em tempo
/// de execução numa pasta temporária, apagada ao sair.
final class MemeClassifier {
    static let inputSide = 299
    static let imageExt: Set<String> = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "avif"]

    private let workDir: URL
    private let featureModel: VNCoreMLModel?   // caminho principal: features + GLM em Double
    private let head: GLMHead?
    private let pipelineModel: VNCoreMLModel?  // alternativa, se a separação falhar
    let usesExactLogit: Bool

    init(modelURL: URL) throws {
        workDir = FileManager.default.temporaryDirectory.appendingPathComponent("memedetection-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        let data = try Data(contentsOf: modelURL)
        var fm: VNCoreMLModel? = nil, h: GLMHead? = nil
        if let head = try? GLMHead.extract(from: data) {
            let url = workDir.appendingPathComponent("featureprint.mlmodel")
            try head.featureModel.write(to: url)
            if let compiled = try? MLModel.compileModel(at: url),
               let m = try? MLModel(contentsOf: compiled) {
                fm = try? VNCoreMLModel(for: m); h = head
            }
        }
        featureModel = fm; self.head = h
        usesExactLogit = fm != nil
        if fm == nil {
            let compiled = try MLModel.compileModel(at: modelURL)
            pipelineModel = try VNCoreMLModel(for: MLModel(contentsOf: compiled))
        } else {
            pipelineModel = nil
        }
    }

    deinit { cleanup() }

    func cleanup() {
        try? FileManager.default.removeItem(at: workDir)
    }

    /// Lê a imagem (primeiro quadro, com a orientação EXIF aplicada) e a
    /// redimensiona para 299×299 esticando, como o Create ML (scaleFill).
    /// Entregar a imagem já no tamanho da entrada também evita uma falha do
    /// Vision no macOS 26 ao processar imagens de tamanhos diferentes em sequência.
    static func loadInput(_ url: URL) throws -> CGImage {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(src) > 0, CGImageSourceGetType(src) != nil
        else { throw ClassifyError("não é uma imagem legível") }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 1024,
            kCGImageSourceShouldCacheImmediately: true
        ]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
                ?? CGImageSourceCreateImageAtIndex(src, 0, nil)
        else { throw ClassifyError("não foi possível decodificar a imagem") }
        let side = inputSide
        guard let ctx = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { throw ClassifyError("falha ao preparar a imagem") }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))   // fundo branco para PNG/GIF transparentes
        ctx.fill(CGRect(x: 0, y: 0, width: side, height: side))
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: side, height: side))
        guard let out = ctx.makeImage() else { throw ClassifyError("falha ao preparar a imagem") }
        return out
    }

    func classify(_ url: URL) -> ImageResult {
        let ext = url.pathExtension.lowercased()
        guard Self.imageExt.contains(ext) else {
            return ImageResult(error: ext.isEmpty ? "arquivo sem extensão de imagem" : "não é imagem (.\(ext))")
        }
        do {
            let img = try Self.loadInput(url)
            if let fm = featureModel, let head = head {
                let req = VNCoreMLRequest(model: fm)
                req.imageCropAndScaleOption = .scaleFill
                try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
                guard let obs = req.results?.first as? VNCoreMLFeatureValueObservation,
                      let arr = obs.featureValue.multiArrayValue
                else { throw ClassifyError("o modelo não devolveu features") }
                let n = arr.count
                var f = [Double](repeating: 0, count: n)
                for i in 0..<n { f[i] = arr[i].doubleValue }
                let z = head.logitMeme(f)
                return ImageResult(p: 1 / (1 + exp(-z)), logit: z)
            }
            guard let pm = pipelineModel else { throw ClassifyError("modelo indisponível") }
            let req = VNCoreMLRequest(model: pm)
            req.imageCropAndScaleOption = .scaleFill
            try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
            let obs = (req.results as? [VNClassificationObservation]) ?? []
            guard let meme = obs.first(where: { $0.identifier == "meme" }) else { throw ClassifyError("sem resultado") }
            let p = min(max(Double(meme.confidence), 1e-15), 1 - 1e-15)
            return ImageResult(p: p, logit: log(p / (1 - p)))
        } catch let e as ClassifyError {
            return ImageResult(error: e.message)
        } catch {
            return ImageResult(error: error.localizedDescription)
        }
    }
}

struct ClassifyError: Error {
    let message: String
    init(_ m: String) { message = m }
}

/// Localiza a pasta de recursos: dentro do .app (Contents/Resources) ou, em
/// desenvolvimento (swift run), a pasta Resources/ do repositório.
enum AppResources {
    static let dir: URL = {
        if let r = Bundle.main.resourceURL, FileManager.default.fileExists(atPath: r.appendingPathComponent("ui/core.js").path) {
            return r
        }
        var u = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<6 {
            let c = u.appendingPathComponent("Resources")
            if FileManager.default.fileExists(atPath: c.appendingPathComponent("ui/core.js").path) { return c }
            u.deleteLastPathComponent()
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("Resources")
    }()
    static var ui: URL { dir.appendingPathComponent("ui") }
    static var model: URL { dir.appendingPathComponent("model/meme-detection.mlmodel") }
    static var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0" }
}

/// Lista recursivamente os arquivos de uma pasta (sem ocultos), com caminhos relativos.
enum FolderScan {
    static func list(_ root: URL) -> [[String: Any]] {
        let fm = FileManager.default
        guard let en = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
                                     options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
        let base = root.standardizedFileURL.path
        var out: [[String: Any]] = []
        for case let u as URL in en {
            guard let v = try? u.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), v.isRegularFile == true else { continue }
            var rel = u.standardizedFileURL.path
            if rel.hasPrefix(base) { rel = String(rel.dropFirst(base.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
            out.append(["name": rel, "size": v.fileSize ?? 0])
        }
        return out
    }
}

/// Lê e grava CSVs. O BOM UTF-8 é tratado como um sinal à parte porque as
/// conversões de texto do Swift (String(data:), JSONSerialization, ponte com o
/// WebKit) o descartam silenciosamente.
enum TextFile {
    static func read(_ url: URL) throws -> (text: String, bom: Bool) {
        var d = try Data(contentsOf: url)
        let bom = d.starts(with: [0xEF, 0xBB, 0xBF])
        if bom { d = d.dropFirst(3) }
        if let s = String(data: d, encoding: .utf8) { return (s, bom) }
        if let s = String(data: d, encoding: .windowsCP1252) { return (s, false) }
        throw ClassifyError("não foi possível ler o arquivo como texto")
    }

    static func write(_ text: String, bom: Bool, to url: URL) throws {
        var d = bom ? Data([0xEF, 0xBB, 0xBF]) : Data()
        d.append(text.data(using: .utf8)!)
        try d.write(to: url, options: .atomic)
    }
}

/// Classifica uma lista de arquivos em paralelo (até `concurrency` de cada vez).
func classifyBatch(_ clf: MemeClassifier, root: URL, files: [String], concurrency: Int) -> [String: ImageResult] {
    var out = [String: ImageResult]()
    let lock = NSLock()
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = max(1, min(concurrency, 8))
    for f in files {
        queue.addOperation {
            let r = clf.classify(root.appendingPathComponent(f))
            lock.lock(); out[f] = r; lock.unlock()
        }
    }
    queue.waitUntilAllOperationsAreFinished()
    return out
}
