import AppKit
import UniformTypeIdentifiers
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: DropWebView!
    var bridge: Bridge!

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        let scheme = AppScheme()
        config.setURLSchemeHandler(scheme, forURLScheme: AppScheme.name)
        bridge = Bridge(scheme: scheme)
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "md")

        webView = DropWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = bridge
        webView.uiDelegate = bridge
        if #available(macOS 13.3, *) { webView.isInspectable = ProcessInfo.processInfo.environment["MD_DEBUG"] != nil }
        webView.onDrop = { [weak self] urls in self?.bridge.handleDrop(urls) }
        webView.onDragState = { [weak self] on in self?.bridge.emit("drag", ["on": on]) }
        bridge.webView = webView

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "MemeDetection"
        window.minSize = NSSize(width: 720, height: 560)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("MemeDetectionMain")
        window.delegate = self
        bridge.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        webView.load(URLRequest(url: URL(string: "\(AppScheme.name)://app/index.html")!))
        bridge.preloadModel()
        DevHooks.runIfRequested(bridge, webView)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) { bridge?.shutdown() }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Sobre o MemeDetection", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Ocultar MemeDetection", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Encerrar MemeDetection", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Editar")
        edit.addItem(withTitle: "Desfazer", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Refazer", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Recortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Colar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Selecionar tudo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Janela")
        win.addItem(withTitle: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Fechar", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.windowsMenu = win
        NSApp.mainMenu = main
    }
}

/// WKWebView que recebe arquivos e pastas arrastados do Finder com o caminho
/// real (a página sozinha só receberia o conteúdo, sem saber onde está).
final class DropWebView: WKWebView {
    var onDrop: (([URL]) -> Void)?
    var onDragState: ((Bool) -> Void)?

    private func fileURLs(_ info: NSDraggingInfo) -> [URL] {
        (info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if !fileURLs(sender).isEmpty { onDragState?(true); return .copy }
        return super.draggingEntered(sender)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURLs(sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }
    override func draggingExited(_ sender: NSDraggingInfo?) {
        onDragState?(false)
        super.draggingExited(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = fileURLs(sender)
        if urls.isEmpty { return super.performDragOperation(sender) }
        onDragState?(false)
        onDrop?(urls)
        return true
    }
}

/// memedetection://app/…    → arquivos da interface (Resources/ui)
/// memedetection://thumb/?path=…&s=… → miniatura de uma imagem local, só dentro
///                            das pastas que o usuário escolheu
final class AppScheme: NSObject, WKURLSchemeHandler {
    static let name = "memedetection"
    private let lock = NSLock()
    private var roots = Set<String>()
    private let queue = DispatchQueue(label: "thumbs", qos: .userInitiated, attributes: .concurrent)
    private var stopped = Set<ObjectIdentifier>()

    func allow(_ root: URL) { lock.lock(); roots.insert(root.standardizedFileURL.path); lock.unlock() }
    private func isAllowed(_ path: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let p = URL(fileURLWithPath: path).standardizedFileURL.path
        return roots.contains { p.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        if url.host == "thumb" {
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let path = q.first { $0.name == "path" }?.value ?? ""
            let size = Int(q.first { $0.name == "s" }?.value ?? "") ?? 160
            guard isAllowed(path) else { return respond(task, url, 403, "text/plain", Data()) }
            let id = ObjectIdentifier(task)
            queue.async {
                let data = Self.thumbnail(path, size: size)
                DispatchQueue.main.async {
                    if self.stopped.remove(id) != nil { return }
                    if let d = data { self.respond(task, url, 200, "image/jpeg", d) }
                    else { self.respond(task, url, 404, "text/plain", Data()) }
                }
            }
            return
        }
        var rel = url.path
        if rel.isEmpty || rel == "/" { rel = "/index.html" }
        let file = AppResources.ui.appendingPathComponent(String(rel.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(AppResources.ui.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            return respond(task, url, 404, "text/plain", Data())
        }
        let mime: String
        switch file.pathExtension {
        case "html": mime = "text/html; charset=utf-8"
        case "js": mime = "text/javascript; charset=utf-8"
        case "css": mime = "text/css; charset=utf-8"
        case "svg": mime = "image/svg+xml"
        case "png": mime = "image/png"
        default: mime = "application/octet-stream"
        }
        respond(task, url, 200, mime, data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { stopped.insert(ObjectIdentifier(task)) }

    private func respond(_ task: WKURLSchemeTask, _ url: URL, _ status: Int, _ mime: String, _ data: Data) {
        let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-store"])!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    static func thumbnail(_ path: String, size: Int) -> Data? {
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                     kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: max(32, min(size, 800))]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let data = NSMutableData()
        guard let dst = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        return CGImageDestinationFinalize(dst) ? data as Data : nil
    }
}
