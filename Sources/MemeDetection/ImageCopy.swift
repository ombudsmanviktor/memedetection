import Foundation

/// Copia para uma pasta nova só as imagens classificadas como meme, mantendo
/// as subpastas relativas. A pasta original não é tocada. Em volumes APFS a
/// cópia é um clone, que é instantâneo e não ocupa espaço extra até que um dos
/// arquivos seja modificado.
enum ImageCopy {
    struct Outcome { var copied = 0; var failed: [String] = [] }

    /// Confere o destino: não pode ficar dentro da pasta original e, se já
    /// existir, precisa ser uma pasta vazia. Devolve a mensagem de erro, se houver.
    static func validate(source: URL, destination: URL) -> String? {
        let src = canonical(source), dst = canonical(destination)
        if dst == src || dst.hasPrefix(src + "/") {
            return "A pasta nova não pode ficar dentro da pasta original de imagens. Escolha outro lugar."
        }
        if src.hasPrefix(dst + "/") {
            return "A pasta nova não pode conter a pasta original de imagens. Escolha outro lugar."
        }
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: dst, isDirectory: &isDir) {
            if !isDir.boolValue { return "Já existe um arquivo com esse nome. Escolha outro nome para a pasta." }
            let items = (try? FileManager.default.contentsOfDirectory(atPath: dst))?.filter { !$0.hasPrefix(".") } ?? []
            if !items.isEmpty { return "A pasta \"\(destination.lastPathComponent)\" já existe e não está vazia. Escolha outro nome para não misturar arquivos." }
        }
        return nil
    }

    /// Caminho real (sem links simbólicos, como /tmp → /private/tmp) também para
    /// destinos que ainda não existem: resolve o ancestral existente mais próximo.
    static func canonical(_ url: URL) -> String {
        var base = url.standardizedFileURL
        var rest: [String] = []
        while !FileManager.default.fileExists(atPath: base.path), base.path != "/" {
            rest.insert(base.lastPathComponent, at: 0)
            base.deleteLastPathComponent()
        }
        var path = base.path
        if let r = realpath(base.path, nil) { path = String(cString: r); free(r) }
        for c in rest { path = (path as NSString).appendingPathComponent(c) }
        return path
    }

    static func copy(files: [String], from source: URL, to destination: URL,
                     progress: (Int, Int) -> Void = { _, _ in }) throws -> Outcome {
        let fm = FileManager.default
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)
        let srcRoot = source.standardizedFileURL.path + "/"
        var out = Outcome()
        for (i, rel) in files.enumerated() {
            let from = source.appendingPathComponent(rel).standardizedFileURL
            let to = destination.appendingPathComponent(rel).standardizedFileURL
            do {
                guard from.path.hasPrefix(srcRoot) else { throw ClassifyError("caminho fora da pasta original") }
                try fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
                if fm.fileExists(atPath: to.path) { try fm.removeItem(at: to) }
                try fm.copyItem(at: from, to: to)
                out.copied += 1
            } catch {
                out.failed.append("\(rel): \((error as? ClassifyError)?.message ?? error.localizedDescription)")
            }
            if (i + 1) % 25 == 0 || i + 1 == files.count { progress(i + 1, files.count) }
        }
        return out
    }
}
