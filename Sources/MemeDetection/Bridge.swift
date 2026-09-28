import AppKit
import UniformTypeIdentifiers
import WebKit

/// Ponte JS ↔ Swift. A página chama `window.webkit.messageHandlers.md.postMessage({cmd, …})`
/// e recebe a resposta pela Promise; eventos nativos chegam em `window.mdNativeEvent(tipo, dados)`.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    weak var webView: WKWebView?
    weak var window: NSWindow?
    let scheme: AppScheme

    private let modelQueue = DispatchQueue(label: "model")
    private var classifier: MemeClassifier?
    private var modelError: String?
    private let workQueue = DispatchQueue(label: "classify", qos: .userInitiated, attributes: .concurrent)

    init(scheme: AppScheme) { self.scheme = scheme }

    func preloadModel() { modelQueue.async { _ = self.loadClassifier() } }

    /// Carrega o modelo uma única vez (fila serial).
    private func loadClassifier() -> MemeClassifier? {
        if let c = classifier { return c }
        if modelError != nil { return nil }
        do { classifier = try MemeClassifier(modelURL: AppResources.model) }
        catch { modelError = error.localizedDescription }
        return classifier
    }

    func shutdown() { classifier?.cleanup() }

    func emit(_ type: String, _ data: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: data), let s = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.mdNativeEvent && window.mdNativeEvent(\(Self.jsString(type)), \(s))")
    }
    static func jsString(_ s: String) -> String {
        let d = try! JSONSerialization.data(withJSONObject: [s])
        return String(String(data: d, encoding: .utf8)!.dropFirst().dropLast())
    }

    // MARK: - Mensagens

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            return replyHandler(nil, "mensagem inválida")
        }
        let ok: (Any?) -> Void = { v in DispatchQueue.main.async { replyHandler(v ?? NSNull(), nil) } }
        let err: (String) -> Void = { e in DispatchQueue.main.async { replyHandler(nil, e) } }

        switch cmd {
        case "appInfo":
            ok(["version": AppResources.version,
                "executable": Bundle.main.executablePath ?? CommandLine.arguments[0],
                "macOS": ProcessInfo.processInfo.operatingSystemVersionString])

        case "modelStatus":
            modelQueue.async {
                let c = self.loadClassifier()
                let status: [String: Any] = ["ready": c != nil, "exactLogit": c?.usesExactLogit ?? false,
                                             "error": (self.modelError as Any?) ?? NSNull()]
                ok(status)
            }

        case "pickCSV":
            let p = NSOpenPanel()
            p.canChooseFiles = true; p.canChooseDirectories = false; p.allowsMultipleSelection = false
            p.allowedContentTypes = [.commaSeparatedText, .tabSeparatedText, .plainText, .delimitedText]
            p.message = "Escolha o CSV"
            runPanel(p) { url in
                guard let url = url else { return ok(nil) }
                self.readCSV(url, ok, err)
            }

        case "pickFolder":
            let p = NSOpenPanel()
            p.canChooseFiles = false; p.canChooseDirectories = true; p.allowsMultipleSelection = false
            p.canCreateDirectories = false
            p.message = "Escolha a pasta com as imagens"
            runPanel(p) { url in
                guard let url = url else { return ok(nil) }
                self.readFolder(url, ok)
            }

        case "openCSV":
            guard let path = body["path"] as? String else { return err("caminho ausente") }
            readCSV(URL(fileURLWithPath: path), ok, err)

        case "openFolder":
            guard let path = body["path"] as? String else { return err("caminho ausente") }
            readFolder(URL(fileURLWithPath: path), ok)

        case "classify":
            guard let root = body["root"] as? String, let files = body["files"] as? [String] else { return err("parâmetros ausentes") }
            let rootURL = URL(fileURLWithPath: root)
            let conc = (body["concurrency"] as? Int) ?? 2
            let rootPath = rootURL.standardizedFileURL.path + "/"
            let safe = files.filter { rootURL.appendingPathComponent($0).standardizedFileURL.path.hasPrefix(rootPath) }
            modelQueue.async {
                guard let clf = self.loadClassifier() else { return err("não foi possível carregar o modelo: \(self.modelError ?? "")") }
                self.workQueue.async {
                    let res = classifyBatch(clf, root: rootURL, files: safe, concurrency: conc)
                    var out = [String: Any]()
                    for (k, v) in res { out[k] = v.json }
                    for f in files where out[f] == nil { out[f] = ["error": "caminho fora da pasta escolhida"] }
                    ok(out)
                }
            }

        case "saveCSV":
            guard let text = body["text"] as? String else { return err("conteúdo ausente") }
            let p = NSSavePanel()
            p.allowedContentTypes = [.commaSeparatedText]
            p.nameFieldStringValue = (body["name"] as? String) ?? "memedetection.csv"
            if let dir = body["dir"] as? String { p.directoryURL = URL(fileURLWithPath: dir) }
            p.canCreateDirectories = true
            p.message = (body["message"] as? String) ?? ""
            runPanel(p) { url in
                guard let url = url else { return ok(nil) }
                do { try TextFile.write(text, bom: body["bom"] as? Bool ?? false, to: url); ok(["path": url.path]) }
                catch { err("não foi possível gravar: \(error.localizedDescription)") }
            }

        case "copyMemeImages":
            guard let root = body["root"] as? String, let files = body["files"] as? [String] else { return err("parâmetros ausentes") }
            let source = URL(fileURLWithPath: root)
            let p = NSSavePanel()
            p.nameFieldStringValue = (body["name"] as? String) ?? source.lastPathComponent + "_memes"
            p.nameFieldLabel = "Nova pasta:"
            p.directoryURL = source.deletingLastPathComponent()
            p.canCreateDirectories = true
            p.prompt = "Criar pasta"
            p.message = "Crie uma pasta nova para a cópia das \(files.count) imagens classificadas como meme. A pasta original não será alterada."
            let choose: (@escaping (URL?) -> Void) -> Void = { done in
                if let auto = DevHooks.copyDestination { done(auto) } else { self.runPanel(p, done) }
            }
            choose { url in
                guard let dest = url else { return ok(nil) }
                if let problem = ImageCopy.validate(source: source, destination: dest) { return err(problem) }
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        let r = try ImageCopy.copy(files: files, from: source, to: dest) { done, total in
                            DispatchQueue.main.async { self.emit("copy", ["done": done, "total": total]) }
                        }
                        ok(["path": dest.path, "copied": r.copied, "failed": r.failed])
                    } catch { err("não foi possível criar a pasta: \(error.localizedDescription)") }
                }
            }

        case "createSample":
            guard let root = body["root"] as? String, let files = body["files"] as? [String],
                  let csv = body["csv"] as? String, let params = body["params"] as? String else { return err("parâmetros ausentes") }
            let source = URL(fileURLWithPath: root)
            let csvName = (body["csvName"] as? String) ?? "amostra.csv"
            let rows = (body["rows"] as? Int) ?? 0
            let p = NSSavePanel()
            p.nameFieldStringValue = (body["name"] as? String) ?? "amostra"
            p.nameFieldLabel = "Nova pasta:"
            if let dir = body["dir"] as? String { p.directoryURL = URL(fileURLWithPath: dir) }
            p.canCreateDirectories = true
            p.prompt = "Criar amostra"
            p.message = "Crie uma pasta nova para a amostra: um CSV com \(rows) linhas de memes sorteadas, a cópia das \(files.count) imagens dessas linhas e os parâmetros do sorteio."
            let choose: (@escaping (URL?) -> Void) -> Void = { done in
                if let auto = DevHooks.copyDestination { done(auto) } else { self.runPanel(p, done) }
            }
            choose { url in
                guard let dest = url else { return ok(nil) }
                if let problem = ImageCopy.validate(source: source, destination: dest) { return err(problem) }
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        let r = try SampleWriter.write(to: dest, csvName: csvName, csv: csv, bom: body["bom"] as? Bool ?? false,
                                                       params: params, source: source, images: files) { done, total in
                            DispatchQueue.main.async { self.emit("copy", ["done": done, "total": total]) }
                        }
                        ok(["path": dest.path, "csv": r.csvURL.path, "copied": r.copy.copied, "failed": r.copy.failed])
                    } catch { err("não foi possível criar a amostra: \(error.localizedDescription)") }
                }
            }

        case "reveal":
            if let path = body["path"] as? String { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
            ok(true)

        case "copy":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString((body["text"] as? String) ?? "", forType: .string)
            ok(true)

        case "openURL":
            if let s = body["url"] as? String, let u = URL(string: s), ["https", "http"].contains(u.scheme ?? "") { NSWorkspace.shared.open(u) }
            ok(true)

        default:
            err("comando desconhecido: \(cmd)")
        }
    }

    private func runPanel(_ p: NSSavePanel, _ done: @escaping (URL?) -> Void) {
        let handler: (NSApplication.ModalResponse) -> Void = { r in done(r == .OK ? p.url : nil) }
        if let w = window { p.beginSheetModal(for: w, completionHandler: handler) } else { handler(p.runModal()) }
    }

    private func readCSV(_ url: URL, _ ok: @escaping (Any?) -> Void, _ err: @escaping (String) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let (text, bom) = try TextFile.read(url)
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                ok(["path": url.path, "name": url.lastPathComponent, "dir": url.deletingLastPathComponent().path,
                    "size": size, "text": text, "bom": bom])
            } catch { err("não foi possível ler \(url.lastPathComponent): \(error.localizedDescription)") }
        }
    }

    private func readFolder(_ url: URL, _ ok: @escaping (Any?) -> Void) {
        scheme.allow(url)
        DispatchQueue.global(qos: .userInitiated).async {
            let files = FolderScan.list(url)
            ok(["path": url.path, "name": url.lastPathComponent, "files": files])
        }
    }

    /// Arquivos arrastados para a janela: pasta → pasta de imagens; outro arquivo → CSV.
    func handleDrop(_ urls: [URL]) {
        for u in urls {
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir)
            emit("drop", ["path": u.path, "isDir": isDir.boolValue])
        }
    }

    // MARK: - Navegação: links externos abrem no navegador padrão

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == AppScheme.name { return decisionHandler(.allow) }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancelar")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
}
