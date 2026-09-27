import AppKit

// Com argumentos de linha de comando (--csv, --images…) roda o modo CLI;
// sem eles, abre a janela do app.
let args = Array(CommandLine.arguments.dropFirst())
if CLI.shouldRun(args) {
    exit(CLI.run(args))
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
