import Foundation
import JavaScriptCore

/// Modo linha de comando. Usa o mesmo core.js da interface (via JavaScriptCore)
/// para ligar linhas a imagens e montar o CSV, garantindo resultados idênticos.
enum CLI {
    static let usage = """
    MemeDetection \(AppResources.version) — classifica imagens de um CSV como meme ou foto
    (modelo original de Bohacek, VisionFeaturePrint + GLM, rodando no Core ML do macOS)

    Uso:
      MemeDetection --csv dados.csv --images pasta/ [opções]

    Opções:
      --csv ARQ            CSV de entrada (obrigatório)
      --images PASTA       pasta com as imagens (obrigatório; subpastas incluídas)
      --column COL         coluna que liga a linha à imagem (nome do arquivo ou ID);
                           use "#linha" para o número da linha. Padrão: detectada
      --mode MODO          file (célula tem o nome do arquivo), id (arquivos <id>.jpg,
                           <id>_1.jpg…) ou auto (padrão)
      --threshold X        limiar de P(meme) para rotular como meme (padrão 0.5)
      --only-memes         grava só as linhas rotuladas como meme
      --no-metrics         não acrescenta as colunas md_* (útil com --only-memes)
      --truth COL          coluna com o rótulo verdadeiro: calcula acurácia, precisão,
                           recall e F1 e grava <saída>_avaliacao.csv
      --out ARQ            CSV de saída (padrão: <csv>_memedetection.csv ou
                           <csv>_memes.csv com --only-memes). Pode ser o próprio --csv
      --copy-memes PASTA   cria PASTA (nova ou vazia, fora da pasta de imagens) com uma
                           cópia só das imagens classificadas como meme, mantendo as
                           subpastas; a pasta original não é alterada
      --concurrency N      imagens analisadas em paralelo (1–8, padrão 4)
      --quiet              sem progresso no terminal
      --help, --version

    Nada é enviado pela rede: tudo roda neste Mac.
    """

    static func shouldRun(_ args: [String]) -> Bool {
        args.contains { ["--csv", "--images", "--help", "-h", "--version"].contains($0) }
    }

    static func fail(_ msg: String) -> Int32 {
        FileHandle.standardError.write(("erro: " + msg + "\n").data(using: .utf8)!)
        return 2
    }

    static func run(_ args: [String]) -> Int32 {
        var opt = [String: String](), flags = Set<String>()
        var i = 0
        let valued: Set<String> = ["--csv", "--images", "--column", "--mode", "--threshold", "--truth", "--out", "--concurrency", "--copy-memes"]
        while i < args.count {
            let a = args[i]
            if valued.contains(a) {
                guard i + 1 < args.count else { return fail("\(a) precisa de um valor") }
                opt[a] = args[i + 1]; i += 2
            } else if a.hasPrefix("--") || a == "-h" {
                flags.insert(a); i += 1
            } else { return fail("argumento desconhecido: \(a)") }
        }
        if flags.contains("--help") || flags.contains("-h") { print(usage); return 0 }
        if flags.contains("--version") { print("MemeDetection \(AppResources.version)"); return 0 }
        let known: Set<String> = ["--only-memes", "--no-metrics", "--quiet"]
        if let bad = flags.first(where: { !known.contains($0) }) { return fail("opção desconhecida: \(bad)") }
        guard let csvPath = opt["--csv"], let imgPath = opt["--images"] else { return fail("informe --csv e --images (veja --help)") }

        let csvURL = URL(fileURLWithPath: (csvPath as NSString).expandingTildeInPath)
        let imgURL = URL(fileURLWithPath: (imgPath as NSString).expandingTildeInPath)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: imgURL.path, isDirectory: &isDir), isDir.boolValue else { return fail("pasta não encontrada: \(imgURL.path)") }
        let threshold = Double(opt["--threshold"] ?? "0.5") ?? -1
        guard threshold > 0, threshold < 1 else { return fail("--threshold deve estar entre 0 e 1") }
        let onlyMemes = flags.contains("--only-memes"), quiet = flags.contains("--quiet")
        let concurrency = Int(opt["--concurrency"] ?? "4") ?? 4
        if let m = opt["--mode"], !["file", "id", "auto"].contains(m) { return fail("--mode deve ser file, id ou auto") }

        let copyURL = opt["--copy-memes"].map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
        if let c = copyURL, let problem = ImageCopy.validate(source: imgURL, destination: c) { return fail(problem) }

        let csvText: String, csvBOM: Bool
        do { (csvText, csvBOM) = try TextFile.read(csvURL) } catch { return fail("não foi possível ler \(csvURL.path): \(error.localizedDescription)") }
        let stem = csvURL.deletingPathExtension().lastPathComponent
        let outURL = opt["--out"].map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
            ?? csvURL.deletingLastPathComponent().appendingPathComponent(stem + (onlyMemes ? "_memes.csv" : "_memedetection.csv"))

        // core.js no JavaScriptCore
        guard let ctx = JSContext() else { return fail("JavaScriptCore indisponível") }
        var jsError: String? = nil
        ctx.exceptionHandler = { _, e in jsError = e?.toString() }
        for f in ["vendor/papaparse.min.js", "core.js"] {
            guard let src = try? String(contentsOf: AppResources.ui.appendingPathComponent(f), encoding: .utf8) else { return fail("recurso ausente: \(f)") }
            ctx.evaluateScript(src)
        }
        if let e = jsError { return fail("core.js: \(e)") }
        let cli = ctx.objectForKeyedSubscript("MDCore")!.objectForKeyedSubscript("cli")!

        func toJSON(_ o: Any) -> String { String(data: try! JSONSerialization.data(withJSONObject: o), encoding: .utf8)! }
        func fromJSON(_ v: JSValue?) -> [String: Any] {
            guard let s = v?.toString(), let d = s.data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return ["error": jsError ?? "falha interna"] }
            return o
        }

        var opts: [String: Any] = ["threshold": threshold, "onlyMemes": onlyMemes,
                                   "includeMetrics": !flags.contains("--no-metrics"), "csvName": csvURL.lastPathComponent, "bom": csvBOM]
        if let c = opt["--column"] { opts["column"] = c }
        if let m = opt["--mode"] { opts["mode"] = m }
        if let t = opt["--truth"] { opts["truth"] = t }

        let files = FolderScan.list(imgURL)
        let plan = fromJSON(cli.invokeMethod("plan", withArguments: [csvText, toJSON(files), toJSON(opts)]))
        if let e = plan["error"] as? String { return fail(e) }
        let images = plan["images"] as? [String] ?? []
        let log: (String) -> Void = { s in if !quiet { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) } }
        log("CSV: \(csvURL.lastPathComponent) · \(plan["rows"] ?? 0) linhas · coluna \"\(plan["column"] ?? "")\" (modo \(plan["mode"] ?? ""))")
        log("Pasta: \(files.count) arquivos · \(plan["rowsWithImage"] ?? 0) linhas com imagem · \(images.count) imagens a analisar")

        let clf: MemeClassifier
        do { clf = try MemeClassifier(modelURL: AppResources.model) } catch { return fail("não foi possível carregar o modelo: \(error.localizedDescription)") }
        defer { clf.cleanup() }

        var results = [String: Any]()
        let chunk = 32
        var done = 0
        let started = Date()
        for start in stride(from: 0, to: images.count, by: chunk) {
            let part = Array(images[start..<min(start + chunk, images.count)])
            for (k, r) in classifyBatch(clf, root: imgURL, files: part, concurrency: concurrency) { results[k] = r.json }
            done += part.count
            if !quiet { FileHandle.standardError.write("\r[\(done)/\(images.count)] analisando…".data(using: .utf8)!) }
        }
        if !quiet && !images.isEmpty { FileHandle.standardError.write("\n".data(using: .utf8)!) }

        let res = fromJSON(cli.invokeMethod("finish", withArguments: [toJSON(results)]))
        if let e = res["error"] as? String { return fail(e) }
        guard let csv = res["csv"] as? String else { return fail("falha ao montar o CSV") }
        do { try TextFile.write(csv, bom: (res["bom"] as? Bool) ?? false, to: outURL) } catch { return fail("não foi possível gravar \(outURL.path): \(error.localizedDescription)") }

        let s = res["summary"] as? [String: Any] ?? [:]
        log(String(format: "Concluído em %.1f s · memes: %@ · fotos: %@ · sem imagem: %@ · erros: %@ · baixa confiança: %@",
                   Date().timeIntervalSince(started), "\(s["meme"] ?? 0)", "\(s["foto"] ?? 0)", "\(s["sem_imagem"] ?? 0)", "\(s["erro"] ?? 0)", "\(s["baixa"] ?? 0)"))
        log("Gravado: \(outURL.path) (\(res["written"] ?? 0) linhas)")
        if let dest = copyURL {
            let memes = res["memeImages"] as? [String] ?? []
            do {
                let r = try ImageCopy.copy(files: memes, from: imgURL, to: dest) { done, total in
                    if !quiet { FileHandle.standardError.write("\r[\(done)/\(total)] copiando imagens de memes…".data(using: .utf8)!) }
                }
                if !quiet && !memes.isEmpty { FileHandle.standardError.write("\n".data(using: .utf8)!) }
                log("Copiadas \(r.copied) imagens de memes para \(dest.path)" + (r.failed.isEmpty ? "" : " · \(r.failed.count) falharam"))
                for f in r.failed.prefix(10) { log("  falhou: \(f)") }
            } catch { return fail("não foi possível criar \(dest.path): \(error.localizedDescription)") }
        }
        if let ev = res["evaluation"] as? [String: Any], let evCSV = res["evaluationCSV"] as? String {
            let evURL = outURL.deletingLastPathComponent()
                .appendingPathComponent(outURL.deletingPathExtension().lastPathComponent + "_avaliacao.csv")
            try? evCSV.write(to: evURL, atomically: true, encoding: .utf8)
            func f(_ k: String) -> String { (ev[k] as? Double).map { String(format: "%.3f", $0) } ?? "—" }
            log("Avaliação (\(ev["n"] ?? 0) linhas): acurácia \(f("accuracy")) · precisão \(f("precision")) · recall \(f("recall")) · F1 \(f("f1"))")
            log("Gravado: \(evURL.path)")
        }
        return 0
    }
}
