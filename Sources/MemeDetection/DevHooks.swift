import AppKit
import WebKit

/// Gancho de teste para desenvolvimento, inativo no uso normal.
/// MD_AUTOTEST="<csv>|<pasta>|<saída.png>[|<id do elemento a mostrar>]" faz o app carregar os dois pelo mesmo
/// caminho do arrastar do Finder, rodar a análise, imprimir um resumo em JSON,
/// salvar um snapshot da janela e encerrar. Serve para testar a ponte JS↔Swift
/// sem precisar clicar.
enum DevHooks {
    static func runIfRequested(_ bridge: Bridge, _ webView: WKWebView) {
        guard let spec = ProcessInfo.processInfo.environment["MD_AUTOTEST"] else { return }
        let parts = spec.components(separatedBy: "|")
        guard parts.count >= 3 else { return }
        let scrollTo = parts.count > 3 ? parts[3] : ""
        func js(_ s: String, _ done: @escaping (Any?) -> Void = { _ in }) {
            webView.callAsyncJavaScript(s, arguments: [:], in: nil, in: .page) { r in
                switch r { case .success(let v): done(v); case .failure(let e): print("JS error:", e); done(nil) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            bridge.emit("drop", ["path": parts[0], "isDir": false])
            bridge.emit("drop", ["path": parts[1], "isDir": true])
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                js("""
                   document.getElementById('btn-continue-1').click();
                   await startRun();
                   await new Promise(r => setTimeout(r, 800));
                   const el = document.getElementById(\(Bridge.jsString(scrollTo)));
                   if (el) el.scrollIntoView(); else window.scrollTo(0, 0);
                   await new Promise(r => setTimeout(r, 600));
                   const s = MDCore.summarize(state.rowRes);
                   return JSON.stringify({ step1: document.getElementById('csv-meta').textContent + ' / ' + document.getElementById('folder-meta').textContent,
                     model: document.getElementById('model-line').textContent, summary: s,
                     thumbs: [...document.querySelectorAll('img.thumb')].map(i => i.naturalWidth).slice(0, 8),
                     rows: state.rowRes.map(r => [r.label, r.p, r.level]) });
                   """) { v in
                    print("AUTOTEST", v ?? "nil")
                    let cfg = WKSnapshotConfiguration()
                    webView.takeSnapshot(with: cfg) { img, _ in
                        if let img = img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                           let png = rep.representation(using: .png, properties: [:]) {
                            try? png.write(to: URL(fileURLWithPath: parts[2]))
                        }
                        fflush(stdout)
                        NSApp.terminate(nil)
                    }
                }
            }
        }
    }
}
